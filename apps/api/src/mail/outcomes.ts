// What a thread did with a mail it did not answer, so the Inbox can say it without anyone opening
// the thread: email_no_reply keeps its reason on the conversation's received mails. no_reply puts
// the conversation To do, handled leaves it with the teammate. A turn that ends with a mail of the
// thread neither answered nor accounted for gets asked once what it did with it.
import { Prisma, prisma, scoped, type Scope, type ScopedDb } from '../db.js'
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
 * for approval, and no wake-up still to bring it in (it would come in the next turn). In one
 * query, so answered mail, however much, never hides one left unanswered.
 */
export async function unaccounted(db: ScopedDb, sessionId: string) {
  const session = await db.session.findFirst({ where: { id: sessionId }, select: { id: true } })
  if (!session) return []
  const since = new Date(Date.now() - 7 * 86_400_000)
  return prisma.$queryRaw<
    {
      id: string
      box: string
      conversationId: string
      fromAddress: string
      fromName: string
      subject: string
    }[]
  >`
    select m.id, m.box, m."conversationId", m."fromAddress", m."fromName", m.subject
    from "MailMessage" m
    where m."sessionId" = ${session.id} and m.direction = 'in' and m."addressId" is not null
      and m.status = 'done' and m.route in (${Prisma.join(ANSWERABLE)})
      and m."doneAt" is null and m.outcome is null and m."outcomeAskedAt" is null
      and m."receivedAt" > ${since}
      and not exists (select 1 from "MailMessage" x
        where x.box = m.box and x."conversationId" = m."conversationId"
          and x."workspaceId" = m."workspaceId"
          and ((x.direction = 'in' and x."receivedAt" > m."receivedAt")
            or (x.direction = 'out' and x.status <> 'cancelled' and x."receivedAt" > m."receivedAt")))
      and not exists (select 1 from "Wakeup" w
        where w."sessionId" = m."sessionId" and w.status = 'pending'
          and w."sourceId" = 'email:' || m.id)
      and not exists (select 1 from "Ticket" t
        where t."sessionId" = m."sessionId" and t.status = 'open' and t.type = 'approval'
          and t.payload->'input'->>'replyTo' = m.id)
    order by m."receivedAt" desc
    limit 20`
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
  if (!found.length) return
  // Each mail claimed and its question queued together: two ends of turn at once ask about it
  // once, and a failure between the two loses neither (the wake-up is retried until it fires).
  const wakeupId = await prisma.$transaction(async (tx) => {
    const mails: typeof found = []
    for (const m of found) {
      const claimed = await tx.mailMessage.updateMany({
        where: { id: m.id, workspaceId: scope.workspaceId, outcomeAskedAt: null },
        data: { outcomeAskedAt: new Date() },
      })
      if (claimed.count) mails.push(m)
    }
    if (!mails.length) return null
    const wakeup = await tx.wakeup.create({
      data: {
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        sessionId: session.id,
        teammateId: session.teammateId,
        kind: 'reply',
        note: askText(mails),
        wakeAt: new Date(),
        // Asked again after a person asked for a reply (clearOutcome): a new one.
        sourceId: `outcome:${Date.now()}:${mails.map((m) => m.id).join(',')}`.slice(0, 500),
      },
    })
    return wakeup.id
  })
  if (wakeupId) await fireNow(wakeupId)
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
