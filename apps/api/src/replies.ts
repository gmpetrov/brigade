// Replies: a teammate that sends an email from a thread is woken there when a reply comes in
// the email's conversation, rather than setting a wake-up to check its inbox. Sending
// (gmail_send, src/connector-calls.ts) starts a watch on the conversation, or moves its end
// on; the inbox reader (subscriptions/gmail.ts) offers it each new email, and a reply is a
// wake-up of kind reply, fired at once, that waits like any wake-up when the computer is
// offline. Only threads a person started and their children: a trigger's thread already
// follows its own conversations (src/triggers.ts).
import { AWAITED_REPLY, triggerEventText, WAKEUPS_IN_A_ROW } from '@brigade/contracts'
import { audit } from './audit.js'
import type { ReceivedEmail } from './connectors/gmail.js'
import { prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { broadcastThreadStatus } from './hub.js'
import { firedInARow, fireNow } from './wakeups.js'

/** Replies wake the thread for this long after the last email it sent in the conversation. */
export const REPLY_WATCH_DAYS = 14

const WATCHED_ORIGINS = new Set(['member', 'child'])

/**
 * After a teammate sent an email from a thread: watch its conversation for replies, or keep
 * watching it longer (again, when it had ended). Until when; null when replies do not wake
 * this thread.
 */
export async function watchReplies(
  db: ScopedDb,
  scope: Scope,
  sent: {
    session: { id: string; origin: string; status: string }
    teammateId: string
    connectionId: string
    conversationKey: string
    to: string[]
    subject: string
  },
  now = new Date(),
): Promise<{ id: string; until: Date } | null> {
  if (!WATCHED_ORIGINS.has(sent.session.origin) || !sent.conversationKey) return null
  const until = new Date(now.getTime() + REPLY_WATCH_DAYS * 86_400_000)
  const data = {
    teammateId: sent.teammateId,
    to: sent.to.join(', ').slice(0, 500),
    // A reply sent without a subject keeps the conversation's, which Gmail added.
    subject: (sent.subject || '(reply)').slice(0, 500),
    until,
  }
  const where = {
    sessionId: sent.session.id,
    connectionId: sent.connectionId,
    conversationKey: sent.conversationKey,
  }
  const existing = await db.replyWatch.findFirst({ where, select: { id: true } })
  const { id } = existing
    ? await db.replyWatch.update({ where: { id: existing.id }, data, select: { id: true } })
    : await db.replyWatch.create({ data: { ...where, ...data } as never, select: { id: true } })
  broadcastThreadStatus(scope.workspaceId, sent.session.id, sent.session.status)
  return { id, until }
}

/** A watch that cannot work (its mailbox could not be subscribed to): it ends now. */
export const endWatch = (db: ScopedDb, id: string) =>
  db.replyWatch.updateMany({ where: { id }, data: { until: new Date() } })

/** The few words the teammate reads after sending, beside the email's ids. */
export const watchingNote = (until: Date) =>
  `A reply in this email's conversation wakes you in this thread until ${until.toISOString()}, with the reply: ` +
  'do not set a wake-up to check the inbox for it, nor promise the person a check. Set one only as a deadline, ' +
  'if it matters that no reply came by then.'

// A machine's email (an out-of-office, a ticket's acknowledgement) wakes nobody; Gmail's trigger
// can leave it out too, so the test lives with Gmail's code.
export { automatic } from './connectors/gmail.js'

/**
 * A new email in a mailbox: wake each thread waiting on its conversation. Each email wakes a
 * thread once, even when read again. A thread woken too often with no word from a person stops
 * waiting, as its wake-ups do (a teammate and an autoresponder answering each other); replies
 * still waiting for an offline computer count toward it. How many threads took the email, now
 * or on an earlier read: the triggers do not get it then, so that one reply is answered once.
 */
export async function wakeOnReply(
  connection: {
    id: string
    organizationId: string
    workspaceId: string
    externalAccount: string | null
    label: string
  },
  email: ReceivedEmail,
  now = new Date(),
) {
  if (!email.threadId) return 0
  // Ended ones too: an email read again after a failed read stays the thread's it woke, even
  // when that thread stopped waiting meanwhile.
  const watches = await prisma.replyWatch.findMany({
    where: { connectionId: connection.id, conversationKey: email.threadId },
  })
  let taken = 0
  for (const watch of watches) {
    const scope: Scope = { organizationId: watch.organizationId, workspaceId: watch.workspaceId }
    const db = scoped(scope)
    const sourceId = `gmail:${email.id}`
    if (await db.wakeup.count({ where: { sessionId: watch.sessionId, sourceId } })) {
      taken++
      continue
    }
    if (watch.until <= now) continue
    const queued = await db.wakeup.count({
      where: { sessionId: watch.sessionId, kind: 'reply', status: 'pending' },
    })
    if ((await firedInARow(db, watch.sessionId)) + queued >= WAKEUPS_IN_A_ROW) {
      await db.replyWatch.updateMany({ where: { id: watch.id }, data: { until: now } })
      await audit({
        ...scope,
        actor: { type: 'system', id: 'brigade' },
        action: 'reply_watch.stopped',
        target: { type: 'thread', id: watch.sessionId },
        data: { replyWatchId: watch.id, emailId: email.id, reason: 'woken too often in a row' },
      })
      continue
    }
    let id: string
    try {
      ;({ id } = await db.wakeup.create({
        data: {
          sessionId: watch.sessionId,
          teammateId: watch.teammateId,
          kind: 'reply',
          note: replyMessage(connection, watch, email, now),
          wakeAt: now,
          sourceId,
        } as never,
      }))
    } catch (error) {
      // Two reads of the same email at once: the other one woke it.
      if ((error as { code?: string }).code === 'P2002') {
        taken++
        continue
      }
      throw error
    }
    await fireNow(id)
    taken++
  }
  return taken
}

/** The reply as the thread gets it: a trigger's email message, which the dashboard shows as a mail. */
export function replyMessage(
  connection: { externalAccount: string | null; label: string },
  watch: { to: string; subject: string },
  email: ReceivedEmail,
  now: Date,
) {
  const account = connection.externalAccount ?? connection.label
  return triggerEventText({
    summary:
      `A reply came in the conversation of the email you sent from this thread to ${watch.to} ` +
      `("${watch.subject}"), on ${account}. Read it, with gmail_read_thread for the whole conversation, ` +
      'then tell the person what it says and what you do next. If you set a wake-up to check for this reply, ' +
      'cancel it.',
    trigger: AWAITED_REPLY,
    definition: 'Reply to an email sent from this thread',
    source: account,
    type: 'email',
    id: email.id,
    received: now.toISOString(),
    payload: email,
  })
}

/** A member stops a thread waiting on a conversation, from the thread's panel. */
export async function stopWatching(
  db: ScopedDb,
  scope: Scope & { memberId: string },
  session: { id: string; status: string },
  id: string,
) {
  const { count } = await db.replyWatch.updateMany({
    where: { id, sessionId: session.id, until: { gt: new Date() } },
    data: { until: new Date() },
  })
  if (!count) return false
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'reply_watch.stopped',
    target: { type: 'thread', id: session.id },
    data: { replyWatchId: id },
  })
  broadcastThreadStatus(scope.workspaceId, session.id, session.status)
  return true
}
