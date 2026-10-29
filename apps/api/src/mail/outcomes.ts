// What a thread did with a mail it did not answer, so the Inbox can say it without anyone opening
// the thread: email_no_reply keeps its reason on the conversation's received mails. no_reply puts
// the conversation To do, handled leaves it with the teammate. A turn that ends with a mail of the
// thread neither answered nor accounted for gets asked once what it did with it.
import { prisma, scoped, type Scope, type ScopedDb } from '../db.js'
import { fireNow } from '../wakeups.js'

export type MailOutcome = 'no_reply' | 'handled'

/** Routes whose mail a thread took to answer: what it did with it is worth asking. */
const ANSWERABLE = ['conversation', 'rule', 'handed', 'read']

/** Keep what a thread did with a conversation's mail, on its mails received so far. */
export async function recordOutcome(
  db: ScopedDb,
  mail: { box: string; conversationId: string },
  outcome: { kind: MailOutcome; note: string },
) {
  await db.mailMessage.updateMany({
    where: {
      box: mail.box,
      conversationId: mail.conversationId,
      direction: 'in',
      receivedAt: { lte: new Date() },
    },
    data: { outcome: outcome.kind, outcomeNote: outcome.note, outcomeAt: new Date() },
  })
}

/** A person asked its thread to reply after all: the conversation is with the teammate again. */
export async function clearOutcome(db: ScopedDb, mail: { box: string; conversationId: string }) {
  await db.mailMessage.updateMany({
    where: { box: mail.box, conversationId: mail.conversationId, direction: 'in' },
    // Should its next turn end without a reply again, it is asked again.
    data: { outcome: null, outcomeNote: null, outcomeAt: null, outcomeAskedAt: null },
  })
}

/**
 * The mails of this thread its turn left without an answer or a word on them: the latest of each
 * conversation, delivered to it, not asked about yet, with nothing sent since, no reply waiting
 * for approval, and no wake-up still to bring it in (it would come in the next turn).
 */
export async function unaccounted(db: ScopedDb, sessionId: string) {
  const mails = await db.mailMessage.findMany({
    where: {
      sessionId,
      direction: 'in',
      addressId: { not: null },
      status: 'done',
      route: { in: ANSWERABLE },
      doneAt: null,
      outcome: null,
      outcomeAskedAt: null,
      receivedAt: { gt: new Date(Date.now() - 7 * 86_400_000) },
    },
    orderBy: { receivedAt: 'desc' },
    take: 20,
  })
  const found: typeof mails = []
  for (const m of mails) {
    if (found.some((x) => x.box === m.box && x.conversationId === m.conversationId)) continue
    const conversation = { box: m.box, conversationId: m.conversationId }
    const [newer, sent, wakeups, drafts] = await Promise.all([
      db.mailMessage.count({
        where: { ...conversation, direction: 'in', receivedAt: { gt: m.receivedAt } },
      }),
      db.mailMessage.count({
        where: {
          ...conversation,
          direction: 'out',
          status: { not: 'cancelled' },
          receivedAt: { gt: m.receivedAt },
        },
      }),
      db.wakeup.count({ where: { sessionId, sourceId: `email:${m.id}`, status: 'pending' } }),
      db.ticket.count({
        where: {
          sessionId,
          status: 'open',
          type: 'approval',
          payload: { path: ['input', 'replyTo'], equals: m.id },
        },
      }),
    ])
    if (!newer && !sent && !wakeups && !drafts) found.push(m)
  }
  return found
}

/** What the thread is told, about the mails it left without a word. */
export function askText(
  mails: { id: string; fromAddress: string; fromName: string; subject: string }[],
) {
  const list = mails
    .map(
      (m) =>
        `- ${m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress}: "${m.subject || '(no subject)'}" (id ${m.id})`,
    )
    .join('\n')
  return [
    `Your turn ended without a reply to ${mails.length > 1 ? 'these emails' : 'this email'}, nor a word on why:`,
    list,
    'For each, reply with email_send (replyTo its id), or call email_no_reply with its id and one line a person ' +
      'will read in the Inbox: why you did not reply, or what you did instead (handled: true). Do nothing else.',
  ].join('\n\n')
}

/**
 * Once a turn ended with the thread idle: ask it, once per mail, what it did with the mails it
 * left without a reply or a word. Through a wake-up, so it reaches the thread even when its
 * computer is offline now.
 */
export async function askOutcomes(scope: Scope, session: { id: string; teammateId: string }) {
  const db = scoped(scope)
  const found = await unaccounted(db, session.id)
  // Each claimed first, so two ends of turn at once ask about it once.
  const mails: typeof found = []
  for (const m of found) {
    const claimed = await db.mailMessage.updateMany({
      where: { id: m.id, outcomeAskedAt: null },
      data: { outcomeAskedAt: new Date() },
    })
    if (claimed.count) mails.push(m)
  }
  if (!mails.length) return
  try {
    const wakeup = await db.wakeup.create({
      data: {
        sessionId: session.id,
        teammateId: session.teammateId,
        kind: 'reply',
        note: askText(mails),
        wakeAt: new Date(),
        // Asked again after a person asked for a reply (clearOutcome): a new one.
        sourceId: `outcome:${Date.now()}:${mails.map((m) => m.id).join(',')}`.slice(0, 500),
      } as never,
    })
    await fireNow(wakeup.id)
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error
  }
}

/** Called once a thread's events are kept: a turn that ended with it idle may have left mail. */
export async function noteMailLeft(
  session: { id: string; organizationId: string; workspaceId: string; teammateId: string },
  ended: boolean,
) {
  if (!ended) return
  const holds = await prisma.mailMessage.count({
    where: { sessionId: session.id, direction: 'in', outcome: null, outcomeAskedAt: null },
  })
  if (!holds) return
  await askOutcomes(
    { organizationId: session.organizationId, workspaceId: session.workspaceId },
    session,
  )
}
