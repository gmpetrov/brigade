// Guests (docs/guests.md): Brigade.app's window starts without a sign-in. Its sign-in page makes
// a guest, a user with a placeholder address and `guest` set, signs the window in as them, and
// onboarding goes on as for anyone: a project, this computer linked, an AI login. Nothing a
// guest does runs on Brigade's money: teammates run on their own computer and subscription, and
// what costs Brigade (Brigade Cloud, its email addresses, dictation) comes only with a plan,
// which a guest cannot buy. What would reach other people (inviting someone) waits until they
// save the account with an email of their own, the same code a sign-in mails. A guest left
// unsaved and unused for GUEST_IDLE_DAYS is deleted with their project (sweepIdleGuests).
//
// The feature flag `guest_mode` opens it (to everyone only: a guest has no address yet).
import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import type { BetterAuthPlugin } from 'better-auth'
import { createAuthEndpoint, sessionMiddleware } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { HTTPException } from 'hono/http-exception'
import * as z from 'zod'
import { recordGuestSaved } from './analytics.js'
import { prisma } from './db.js'
import { featuresOf } from './features.js'
import { CODE_MINUTES, sendSignInCode } from './sign-in-code.js'

/** The placeholder addresses' domain: `.invalid` never receives mail, nor matches a flag's. */
export const GUEST_EMAIL_DOMAIN = 'guest.brigade.invalid'
/** A guest the sweep took this long ago and still has: the run that took it died. */
const SWEPT_STALE_MS = 60 * 60_000
/** A guest's name until they give one or save the account. */
const GUEST_NAME = 'Guest'
/** Unsaved and unused this long, a guest goes, with their project. */
export const GUEST_IDLE_DAYS = 14
/** How long a guest's session lasts: better-auth's refresh would cut it to a week. */
const GUEST_SESSION_DAYS = 400
/** Wrong codes before a saving code is used up. */
const CODE_TRIES = 5
/** Saving codes a guest may have mailed, in all. */
const CODES_SENT = 5

export const isGuestEmail = (email: string) =>
  email.toLowerCase().endsWith(`@${GUEST_EMAIL_DOMAIN}`)

/** Whether Brigade.app may start without a sign-in: the `guest_mode` flag, open to everyone. */
export async function guestsOpen() {
  return (await featuresOf({ email: '', workspaceId: null })).has('guest_mode')
}

/** Whether this user is a guest. */
export async function isGuest(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { guest: true } })
  return user?.guest ?? false
}

/** A 403 for a guest, for what waits until the account is saved. */
export async function requireSavedAccount(userId: string, what: string) {
  if (await isGuest(userId))
    throw new HTTPException(403, {
      message: `Save your account with your email first: ${what} needs an account you can sign in to again`,
    })
}

/** What a guest's project may store of its threads' work before they save the account. */
export const GUEST_STORAGE_BYTES = 50 * 1024 * 1024

/**
 * A 402 for a guest whose project's threads have stored GUEST_STORAGE_BYTES (counted as stored,
 * src/event-volume.ts): new work waits until they save the account, which lifts it.
 */
export async function requireGuestRoom(userId: string, workspaceId: string) {
  if (!(await isGuest(userId))) return
  const { _sum } = await prisma.workspaceEventDay.aggregate({
    where: { workspaceId },
    _sum: { bytes: true },
  })
  if (Number(_sum.bytes ?? 0) < GUEST_STORAGE_BYTES) return
  throw new HTTPException(402, {
    message:
      'Your teammates have done a lot here already. Save your account with your email to keep going',
  })
}

const savingIdentifier = (userId: string) => `guest-save:${userId}`
const digest = (code: string) => createHash('sha256').update(code).digest('hex')

type Saving = { email: string; code: string; tries: number; sent?: number }

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email())
  .refine((e) => !isGuestEmail(e), 'Use your own email')

export const guestSignIn = () =>
  ({
    id: 'guest-sign-in',
    endpoints: {
      guestAvailable: createAuthEndpoint('/guest/available', { method: 'GET' }, async (c) =>
        c.json({ available: await guestsOpen() }),
      ),
      startAsGuest: createAuthEndpoint(
        '/guest',
        {
          method: 'POST',
          // Where they came from, as the sign-up page sends it (src/signup-source.ts).
          // The computer's account's full name, as Brigade.app reads it (its system-name.ts).
          body: z.object({
            signupSource: z.unknown().optional(),
            name: z.string().trim().min(1).max(100).optional(),
          }),
        },
        async (c) => {
          if (!(await guestsOpen())) throw c.error('NOT_FOUND', { message: 'Not found' })
          const id = crypto.randomUUID()
          // Through better-auth, so its hooks run: src/auth.ts records the sign-up.
          const user = await c.context.internalAdapter.createUser(
            {
              name: c.body.name ?? GUEST_NAME,
              email: `guest-${id}@${GUEST_EMAIL_DOMAIN}`,
              emailVerified: false,
              guest: true,
            },
            { method: 'guest' },
          )
          // Signed out, a guest could never sign in again: their session lasts, in the window's
          // cookie, until they save the account or are swept.
          const expiresAt = new Date(Date.now() + GUEST_SESSION_DAYS * 24 * 60 * 60_000)
          const session = await c.context.internalAdapter.createSession(
            user.id,
            false,
            { expiresAt },
            true,
          )
          await setSessionCookie(c, { session, user }, false, {
            maxAge: GUEST_SESSION_DAYS * 24 * 60 * 60,
          })
          return c.json({ ok: true })
        },
      ),
      sendGuestSavingCode: createAuthEndpoint(
        '/guest/save/code',
        { method: 'POST', body: z.object({ email }), use: [sessionMiddleware] },
        async (c) => {
          const userId = c.context.session.user.id
          if (!(await isGuest(userId)))
            throw c.error('BAD_REQUEST', { message: 'This account is saved already' })
          const taken = await prisma.user.count({ where: { email: c.body.email } })
          if (taken)
            throw c.error('CONFLICT', {
              message:
                'This email has a Brigade account already. Use another email, or sign in with it in a new project',
            })
          // One code at a time: a new one replaces the last, and counts with it. A guest is made
          // without a check that a person is there, so a guest mails a few codes at most.
          const last = await prisma.verification.findFirst({
            where: { identifier: savingIdentifier(userId) },
          })
          const sent = last ? ((JSON.parse(last.value) as Saving).sent ?? 1) : 0
          if (sent >= CODES_SENT)
            throw c.error('TOO_MANY_REQUESTS', {
              message: 'Too many codes for this account. Write to support@brigade.lol to save it',
            })
          const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
          const saving: Saving = {
            email: c.body.email,
            code: digest(code),
            tries: 0,
            sent: sent + 1,
          }
          await prisma.verification.deleteMany({ where: { identifier: savingIdentifier(userId) } })
          await c.context.internalAdapter.createVerificationValue({
            identifier: savingIdentifier(userId),
            value: JSON.stringify(saving),
            expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000),
          })
          await sendSignInCode(c.body.email, code)
          return c.json({ ok: true })
        },
      ),
      saveGuest: createAuthEndpoint(
        '/guest/save',
        {
          method: 'POST',
          body: z.object({
            email,
            code: z
              .string()
              .trim()
              .regex(/^\d{6}$/),
          }),
          use: [sessionMiddleware],
        },
        async (c) => {
          const userId = c.context.session.user.id
          const wrong = () =>
            c.error('BAD_REQUEST', { message: 'This code is wrong or has expired' })
          // A try counts before it is checked, in one statement: tries sent at once each count,
          // and none past the last.
          const [row] = await prisma.$queryRaw<{ id: string; value: string }[]>`
            UPDATE "Verification"
            SET "value" = jsonb_set(
                  "value"::jsonb,
                  '{tries}',
                  to_jsonb(coalesce(("value"::jsonb ->> 'tries')::int, 0) + 1)
                )::text,
                "updatedAt" = now()
            WHERE "identifier" = ${savingIdentifier(userId)}
              AND "expiresAt" > now()
              AND coalesce(("value"::jsonb ->> 'tries')::int, 0) < ${CODE_TRIES}
            RETURNING "id", "value"`
          if (!row) throw wrong()
          const saving = JSON.parse(row.value) as Saving
          const given = Buffer.from(digest(c.body.code))
          if (saving.email !== c.body.email || !timingSafeEqual(given, Buffer.from(saving.code)))
            throw wrong()
          // The right code works once: only the request that removes it goes on.
          const used = await prisma.verification.deleteMany({ where: { id: row.id } })
          if (!used.count) throw wrong()
          // Only a guest becomes saved, and only with an address nobody took meanwhile.
          const saved = await prisma
            .$transaction(async (tx) => {
              if (await tx.user.count({ where: { email: saving.email } })) return 0
              const user = await tx.user.findUnique({ where: { id: userId } })
              const { count } = await tx.user.updateMany({
                // Not one the sweep has taken to delete (its address is a swept one then).
                where: { id: userId, guest: true, email: { startsWith: 'guest-' } },
                // The placeholder name goes, as a sign-up with a code has none; one they gave stays.
                data: {
                  email: saving.email,
                  emailVerified: true,
                  guest: false,
                  ...(user?.name === GUEST_NAME && { name: '' }),
                },
              })
              return count
            })
            .catch(() => 0)
          if (!saved)
            throw c.error('CONFLICT', {
              message: 'This account could not be saved with this email',
            })
          recordGuestSaved(userId, saving.email)
          return c.json({ ok: true })
        },
      ),
    },
  }) satisfies BetterAuthPlugin

/**
 * Delete the guests left unsaved and unused for GUEST_IDLE_DAYS, with their projects (as
 * deleting an account does: src/account-delete.ts): no thread of their projects moved since,
 * and no runner of theirs, which Brigade.app keeps running, answered since. One still at work is refused there, and left for a later run.
 */
export async function sweepIdleGuests(now = new Date(), limit = 10) {
  const since = new Date(now.getTime() - GUEST_IDLE_DAYS * 24 * 60 * 60_000)
  const guests = await prisma.user.findMany({
    where: {
      guest: true,
      createdAt: { lt: since },
      // Not one another run holds (its address swapped), unless that run died holding it: a run
      // ends within minutes (JOB_DEADLINE_MS), so a swept one untouched for an hour is left over.
      OR: [
        { email: { startsWith: 'guest-' } },
        {
          email: { startsWith: 'swept-' },
          updatedAt: { lt: new Date(now.getTime() - SWEPT_STALE_MS) },
        },
      ],
      members: {
        none: {
          organization: {
            workspaces: {
              some: {
                OR: [
                  { sessions: { some: { updatedAt: { gte: since } } } },
                  // Brigade.app keeps its runner running: open at all, the guest is around.
                  { runners: { some: { lastSeenAt: { gte: since } } } },
                ],
              },
            },
          },
        },
      },
    },
    select: { id: true, email: true, updatedAt: true },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })
  // Not at the top: deleting an account reaches much of the API, which reaches this file.
  const { deleteAccount } = await import('./account-delete.js')
  const deleted: string[] = []
  for (const guest of guests) {
    // Taken first, in one statement: a guest saving their account at this moment is either
    // saved (and left alone here) or refused (src/guests.ts's saveGuest wants a guest's address).
    // Two runs that read the same row: the one that changes it first (and so its updatedAt) holds
    // it, the other finds it changed.
    const swept = `swept-${guest.id}@${GUEST_EMAIL_DOMAIN}`
    const taken = await prisma.user.updateMany({
      where: { id: guest.id, guest: true, email: guest.email, updatedAt: guest.updatedAt },
      data: { email: swept },
    })
    if (!taken.count) continue
    try {
      await deleteAccount(guest.id)
      deleted.push(guest.id)
    } catch (error) {
      // Still at work: it stays a guest, with its address back, for a later run.
      await prisma.user
        .updateMany({
          where: { id: guest.id, email: swept },
          data: { email: `guest-${guest.id}@${GUEST_EMAIL_DOMAIN}` },
        })
        .catch(() => {})
      console.warn(`idle guest ${guest.id} not deleted yet: ${String(error)}`)
    }
  }
  return deleted
}
