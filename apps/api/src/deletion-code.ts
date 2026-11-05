// A code mailed to the person before a workspace or their account is deleted for good. Typing
// the workspace's name (or one's email) only guards against a slip: both are on the screen.
// The code proves the person also reads their mail, so a session left open on a laptop, or a
// stolen cookie, cannot delete everything. A code rather than a link, as for signing in
// (src/sign-in-code.ts): it is typed into the same dialog, which shows why a deletion is
// refused (a teammate at work, Brigade Cloud still billed) and lets the person retry.
//
// Kept in better-auth's Verification table, hashed, one per person and target: asking again
// replaces it. It works for CODE_MINUTES and TRIES wrong guesses, and stays usable after a
// refused deletion, until one goes through.
import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import { env } from './config.js'
import { prisma } from './db.js'
import { addressOf } from './mail/names.js'
import { resendConfigured, sendEmail } from './mail/resend.js'

export const CODE_MINUTES = 10
/** Wrong codes before it stops working and a new one must be asked for. */
export const TRIES = 5
/** Seconds before another code can be mailed for the same deletion. */
export const RESEND_SECONDS = 30

/** What the code deletes: one workspace, or the person's account. */
export type DeletionTarget =
  | { kind: 'workspace'; userId: string; workspaceId: string; name: string }
  | { kind: 'account'; userId: string }

type Stored = { hash: string; tries: number }

const identifierOf = (target: DeletionTarget) =>
  target.kind === 'workspace'
    ? `deletion:workspace:${target.workspaceId}:${target.userId}`
    : `deletion:account:${target.userId}`

const hashOf = (identifier: string, code: string) =>
  createHmac('sha256', env.BETTER_AUTH_SECRET).update(`${identifier}\n${code}`).digest('hex')

const sameHash = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

const latest = (identifier: string) =>
  prisma.verification.findFirst({ where: { identifier }, orderBy: { createdAt: 'desc' } })

/** A new code for the deletion, replacing any before it. Returned for the mail (and tests). */
export async function issueDeletionCode(target: DeletionTarget) {
  const identifier = identifierOf(target)
  const before = await latest(identifier)
  if (before && before.createdAt.getTime() > Date.now() - RESEND_SECONDS * 1000)
    throw new HTTPException(429, {
      message: 'A code was just sent: check your mail, or ask again in a few seconds',
    })
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const value: Stored = { hash: hashOf(identifier, code), tries: 0 }
  await prisma.$transaction([
    prisma.verification.deleteMany({ where: { identifier } }),
    prisma.verification.create({
      data: {
        id: randomUUID(),
        identifier,
        value: JSON.stringify(value),
        expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000),
      },
    }),
  ])
  return code
}

export function deletionCodeMail(email: string, target: DeletionTarget, code: string) {
  const what =
    target.kind === 'workspace'
      ? `delete the workspace ${target.name}, for everyone in it`
      : 'delete your Brigade account'
  return {
    from: `Brigade <${addressOf('noreply')}>`,
    to: [email],
    subject:
      target.kind === 'workspace'
        ? `${code} is your code to delete ${target.name}`
        : `${code} is your code to delete your Brigade account`,
    text: [
      `Your code to ${what}: ${code}`,
      '',
      `It works for ${CODE_MINUTES} minutes. Nothing is deleted without it.`,
      '',
      "If you didn't ask for it, don't give it to anyone: someone may be signed in to your Brigade account.",
    ].join('\n'),
  }
}

/** Mail a new code for the deletion to the person. */
export async function sendDeletionCode(email: string, target: DeletionTarget) {
  const code = await issueDeletionCode(target)
  // Locally and in previews no mail leaves: the code is in the API's log.
  if (!resendConfigured()) return console.log(`deletion code for ${email}: ${code}`)
  const key = createHash('sha256')
    .update(`${identifierOf(target)}\n${code}`)
    .digest('hex')
  await sendEmail(deletionCodeMail(email, target, code), `brigade-deletion-${key}`)
}

const WRONG = 'That code is not the right one'
const GONE = 'This code has expired, or was never sent: send a new one'

/**
 * Check the code typed for the deletion, before anything is changed; a wrong one counts as a
 * try. Returns what to call once the deletion went through: the code is then used up. A
 * deletion refused after this (a teammate at work) leaves it usable for another try.
 */
export async function checkDeletionCode(target: DeletionTarget, typed: string) {
  const identifier = identifierOf(target)
  const row = await latest(identifier)
  if (!row || row.expiresAt.getTime() <= Date.now()) throw new HTTPException(400, { message: GONE })
  const stored = JSON.parse(row.value) as Stored
  const code = typed.replace(/\s/g, '')
  if (/^\d{6}$/.test(code) && sameHash(stored.hash, hashOf(identifier, code)))
    return () => prisma.verification.deleteMany({ where: { identifier } }).then(() => undefined)
  const tries = stored.tries + 1
  if (tries >= TRIES) {
    await prisma.verification.deleteMany({ where: { id: row.id } })
    throw new HTTPException(400, { message: 'Too many wrong codes: send a new one' })
  }
  // Only over the value read: two wrong guesses at once still count as two.
  const counted = await prisma.verification.updateMany({
    where: { id: row.id, value: row.value },
    data: { value: JSON.stringify({ ...stored, tries } satisfies Stored) },
  })
  if (counted.count === 0) return checkDeletionCode(target, typed)
  throw new HTTPException(400, { message: WRONG })
}
