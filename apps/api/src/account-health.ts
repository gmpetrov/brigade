// Whether an account's login still works, as its turns tell. A harness that lost its login
// (Claude Code's "Not logged in · Please run /login", Codex's expired refresh token) fails every
// turn while the account still looks ready, so its threads fail one after another and nobody
// knows why. A couple of such failures in a row, with no turn that worked between them, mark the
// account needs_sign_in: its member gets a ticket (and its push) and their accounts page updates,
// and operators hear of it (ops rule account-signed-out). Usage and rate limits are not this:
// those switch accounts (account.switched, exhaustedUntil) and never count here.
import type { SequencedEvent } from '@brigade/contracts'
import { prisma, scoped, type Prisma } from './db.js'
import { hubs } from './hub.js'
import { noteFailure } from './ops/failures.js'

/** Turns failing for want of a login, in a row, before the account needs signing in again. */
export const SIGN_IN_AFTER = 2

/** Out of usage, rate-limited or out of credits: never a login that stopped working. */
const LIMITED =
  /usage limit|limit reached|hit your (usage )?limit|out of (usage|credits)|quota|rate.?limit|too many requests|\b429\b|credit balance|billing|overloaded/i

/** What harnesses say when they have no working login, and nothing else says. */
const SIGNED_OUT = [
  /not logged in/i,
  /please run \/login/i,
  /invalid api key/i,
  /oauth token (has )?(expired|been revoked|revoked|is invalid)/i,
  /authentication_error/i,
  /\b401\b[^\n]{0,80}(unauthori[sz]ed|authenticat|invalid[^\n]{0,20}(token|key|credential))/i,
  /(unauthori[sz]ed|authenticat)[^\n]{0,80}\b401\b/i,
  /refresh token (has )?(expired|was revoked|been revoked|is invalid|was already used|already been used)/i,
  /access token could not be refreshed/i,
  /authentication token is expired/i,
  /please (sign|log) ?in again/i,
]

/** Whether a harness's error says its login is gone. */
export const signedOut = (message: string) =>
  !LIMITED.test(message) && SIGNED_OUT.some((pattern) => pattern.test(message))

/**
 * Claude Code without a login answers each prompt with its refusal as the reply itself, then
 * fails the turn with it ("Not logged in · Please run /login"): that reply proves nothing. Only a
 * short reply that is all refusal: a teammate writing about /login in a longer one is not.
 */
const refusal = (text: string) => text.trim().length <= 200 && signedOut(text)

/** By account: its turns that failed signed out since one last worked (thread:seq of each error). */
const failures = new Map<string, Set<string>>()

/** Only for tests. */
export const clearAccountHealth = () => failures.clear()

/**
 * Keep each account's usage snapshot, and notice when its login stopped working. In a thread
 * with several teammates, each turn says its account; a run that starts within a turn is that
 * turn's account's, as its turn.started or a switch since (stored before it) says.
 */
export async function noteAccountState(
  session: { id: string; organizationId: string; workspaceId: string; accountId: string | null },
  events: SequencedEvent[],
) {
  let accountId = session.accountId
  const first = events.findIndex((e) =>
    ['turn.started', 'account.switched', 'error', 'message.done', 'usage.updated'].includes(
      e.event.type,
    ),
  )
  if (first !== -1 && !['turn.started', 'account.switched'].includes(events[first]!.event.type)) {
    // The account of the turn under way: its start, or a switch since (out of usage mid-turn).
    const latest = await prisma.sessionEvent.findFirst({
      where: {
        sessionId: session.id,
        type: { in: ['turn.started', 'account.switched'] },
        seq: { lt: events[0]!.seq },
      },
      orderBy: { seq: 'desc' },
      select: { data: true },
    })
    const event = latest?.data as { accountId?: string; toAccountId?: string | null } | undefined
    accountId = event?.accountId ?? event?.toAccountId ?? accountId
  }
  const byAccount = new Map<string, SequencedEvent[]>()
  for (const e of events) {
    if (e.event.type === 'turn.started') accountId = e.event.accountId
    // Limits read after a turn (Codex's) say whose they are.
    const owner = (e.event.type === 'usage.updated' && e.event.accountId) || accountId
    if (owner) byAccount.set(owner, [...(byAccount.get(owner) ?? []), e])
    // What follows a switch is the new account's.
    if (e.event.type === 'account.switched' && e.event.toAccountId) accountId = e.event.toAccountId
  }
  for (const [id, list] of byAccount) await noteOneAccount(session, id, list)
}

/**
 * A run of one account's events. Noted again when a run is tried again (src/hub.ts's
 * noteEvents): each failed turn counts once, by its error event.
 */
export async function noteOneAccount(
  session: { id: string; organizationId: string; workspaceId: string },
  accountId: string,
  events: SequencedEvent[],
) {
  const usage = events.findLast((e) => e.event.type === 'usage.updated' && e.event.limits?.length)
  // In order: a turn that worked clears the failures before it, one that failed adds to them.
  let worked = false
  let failure: string | null = null
  const counted = failures.get(accountId) ?? new Set<string>()
  for (const { seq, event } of events) {
    if (event.type === 'error' && signedOut(event.message)) {
      counted.add(`${session.id}:${seq}`)
      failure = event.message
      worked = false
    } else if (event.type === 'message.done' && !refusal(event.text)) {
      // Only an actual reply proves the login works; a turn can complete after an error.
      counted.clear()
      failure = null
      worked = true
    }
  }
  if (counted.size) failures.set(accountId, counted)
  else failures.delete(accountId)
  if (!usage && !worked && !failure) return

  const before = await prisma.account.findFirst({
    where: { id: accountId, workspaceId: session.workspaceId },
  })
  if (!before) return
  if (usage?.event.type === 'usage.updated' || worked)
    await prisma.account.update({
      where: { id: accountId },
      data: {
        ...(usage?.event.type === 'usage.updated'
          ? { lastUsage: usage.event.limits as Prisma.InputJsonValue, lastUsageAt: new Date() }
          : {}),
        // A reply also proves usage is back, sooner than the reset said (a plan upgraded).
        ...(worked ? { status: 'ready', exhaustedUntil: null } : {}),
      },
    })
  if (!failure || counted.size < SIGN_IN_AFTER || before.status === 'needs_sign_in') return
  // An expired login is a ticket for the member who owns the account: it notifies them. First,
  // so a run noted again after it failed still opens it.
  const open = await prisma.ticket.count({
    where: { type: 'sign_in', status: 'open', payload: { path: ['accountId'], equals: accountId } },
  })
  if (!open)
    await scoped(session).ticket.create({
      data: {
        organizationId: session.organizationId,
        workspaceId: session.workspaceId,
        sessionId: session.id,
        type: 'sign_in',
        title: `Sign in again: ${before.label}`,
        payload: { accountId, memberId: before.memberId },
      },
    })
  // Told once, by whoever marks it first.
  const { count } = await prisma.account.updateMany({
    where: { id: accountId, status: { not: 'needs_sign_in' } },
    data: { status: 'needs_sign_in' },
  })
  if (!count) return
  const message = failure.replace(/\s+/g, ' ').trim().slice(0, 200)
  console.warn(`account ${accountId}: ${counted.size} turns in a row failed signed out: ${message}`)
  noteFailure('account-signed-out', `${before.label}: ${message}`, {
    workspaceId: session.workspaceId,
  })
  // Their accounts page, if open, shows it needs signing in.
  await hubs.get(session.workspaceId).sendToMember(before.memberId, {
    type: 'account.login',
    accountId,
    state: 'failed',
    error: `Its login stopped working (“${message}”). Sign in again.`,
  })
}
