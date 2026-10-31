// Gmail's sending, held by Brigade as Resend holds Brigade's addresses' (src/mail/outbound.ts), so
// both kinds of mailbox send the same way: gmail_send (or a person's Reply myself) keeps the email
// as a scheduled out MailMessage in the account's box, which leaves UNDO_SECONDS later or at its
// sendAt, and can be cancelled until then (cancelMail). Gmail's API has no scheduled send, so a
// job sends what is due (sendDueGmail, every 30 seconds). Each held email is claimed before it is
// sent (attempts 1), so it leaves once at most; one that cannot leave goes back to its thread, as
// a bounce. One whose sending was cut off (the API restarted between its claim and Gmail's answer)
// is not sent again, as it may have left: after CUT_OFF_MS its thread is told to check, as a held
// call cut off is (src/held-calls.ts).
import { randomUUID } from 'node:crypto'
import { SEND_LATER_MAX_DAYS } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { readAttachment } from '../attachments.js'
import { authorisedFetch } from '../connector-calls.js'
import { sendComposed, type GmailCompose } from '../connectors/gmail.js'
import type { ConnectorContext } from '../connectors/types.js'
import { prisma, scoped, type Scope, type ScopedDb } from '../db.js'
import { endWatch, watchingNote, watchReplies } from '../replies.js'
import { syncConnection } from '../subscriptions/index.js'
import { bareAddress } from './names.js'
import { failSent, leavingAt, takeFromBox } from './outbound.js'

/**
 * What a held Gmail email keeps to be sent as asked: the fields its row has no column for, and
 * the playbook run its leaving times as answered (firstResponseAt).
 */
type Held = {
  replyToMessageId?: string
  from?: string
  attachments?: string[]
  firstResponseOf?: string
}

/** A playbook's first response, held: its run is timed when it leaves, not when it was written. */
export async function timeWhenSent(db: ScopedDb, id: unknown, runId: string) {
  if (typeof id !== 'string') return
  const row = await db.mailMessage.findFirst({ where: { id, direction: 'out' } })
  if (!row) return
  const held = ((row.headers as { gmail?: Held } | null)?.gmail ?? {}) as Held
  await db.mailMessage.updateMany({
    where: { id },
    data: { headers: { gmail: { ...held, firstResponseOf: runId } } },
  })
}

const boxOf = (connectionId: string) => `gmail:${connectionId}`

/** How long a claimed email may take to leave before it counts as cut off. */
const CUT_OFF_MS = 10 * 60_000

/**
 * Why a Gmail email cannot go, before anyone is asked about it: too far ahead, or a teammate's
 * reply in a conversation a person already answered from the Inbox (a person may write again).
 * Null when it can.
 */
export async function checkGmail(
  db: ScopedDb,
  connectionId: string,
  input: GmailCompose,
  options: { byPerson?: boolean } = {},
) {
  if (input.sendAt) {
    const at = new Date(input.sendAt).getTime()
    if (at > Date.now() + SEND_LATER_MAX_DAYS * 86_400_000)
      return `An email can be set to leave up to ${SEND_LATER_MAX_DAYS} days ahead.`
  }
  if (!input.replyToMessageId || options.byPerson) return null
  const original = await db.mailMessage.findFirst({
    where: { box: boxOf(connectionId), sourceId: input.replyToMessageId },
  })
  if (!original) return null
  const person = await db.mailMessage.findFirst({
    where: {
      box: original.box,
      conversationId: original.conversationId,
      direction: 'out',
      sentByMemberId: { not: null },
      status: { notIn: ['cancelled', 'bounced'] },
      receivedAt: { gt: original.receivedAt },
    },
  })
  return person
    ? `A person already replied in this conversation from the Inbox, at ${person.receivedAt.toISOString()}. Read the conversation (gmail_read_thread) before replying, and tell the person rather than answer twice.`
    : null
}

/**
 * An email from a Gmail account, kept to leave in its window to cancel it, or at its sendAt.
 * A reply in a conversation Brigade keeps joins it (the Inbox shows it), and a thread waiting
 * for its answer is woken by it from when it leaves.
 */
export async function holdGmail(
  db: ScopedDb,
  scope: Scope,
  input: {
    connection: { id: string; externalAccount: string | null }
    session: { id: string; origin: string; status: string }
    /** The teammate that wrote it; none when a person did (sentByMemberId). */
    teammateId: string | null
    approvedByMemberId?: string
    sentByMemberId?: string
    email: GmailCompose
  },
) {
  const { connection, session, email } = input
  const problem = await checkGmail(db, connection.id, email, {
    byPerson: !!input.sentByMemberId,
  })
  if (problem) throw new HTTPException(400, { message: problem })
  const box = boxOf(connection.id)
  const original = email.replyToMessageId
    ? await db.mailMessage.findFirst({ where: { box, sourceId: email.replyToMessageId } })
    : null
  const files = email.attachments?.length
    ? await db.attachment.findMany({
        where: { id: { in: email.attachments }, sessionId: session.id },
        select: { id: true, name: true, contentType: true, size: true },
      })
    : []
  const sendAt = leavingAt({ ...(email.sendAt ? { sendAt: new Date(email.sendAt) } : {}) })
  const held: Held = {
    ...(email.replyToMessageId ? { replyToMessageId: email.replyToMessageId } : {}),
    ...(email.from ? { from: email.from } : {}),
    ...(email.attachments?.length ? { attachments: email.attachments } : {}),
  }
  const row = await db.mailMessage.create({
    data: {
      connectionId: connection.id,
      box,
      direction: 'out',
      status: 'scheduled',
      // Its Gmail thread once it leaves; a reply's is known now.
      conversationId: original?.conversationId ?? `out:${randomUUID()}`,
      fromAddress: bareAddress(email.from ?? connection.externalAccount ?? ''),
      to: email.to.map(bareAddress),
      cc: (email.cc ?? []).map(bareAddress),
      subject: (email.subject || (original ? reSubject(original.subject) : '')).slice(0, 1000),
      text: email.body.slice(0, 100_000),
      headers: { gmail: held },
      sessionId: session.id,
      teammateId: input.sentByMemberId ? null : input.teammateId,
      approvedByMemberId: input.approvedByMemberId ?? null,
      sentByMemberId: input.sentByMemberId ?? null,
      sendAt,
      attachments: files.map((f) => ({
        id: f.id,
        filename: f.name,
        contentType: f.contentType,
        size: f.size,
      })),
    } as never,
  })
  // A mail left in the account's box that this answers is the thread's now.
  if (original) await takeFromBox(db, session.id, original)
  const watch = original
    ? await watchGmail(db, scope, {
        session,
        teammateId: input.teammateId,
        connectionId: connection.id,
        conversationKey: original.conversationId,
        to: email.to,
        subject: row.subject,
        from: sendAt,
      })
    : null
  return { id: row.id, sendAt, conversationId: original?.conversationId ?? null, watch }
}

const reSubject = (subject: string) => (/^re:/i.test(subject) ? subject : `Re: ${subject}`)

/**
 * A reply in the email's Gmail thread wakes its thread (src/replies.ts), and the account is read
 * for it if nothing reads it yet. What the teammate is told, if anything.
 */
async function watchGmail(
  db: ScopedDb,
  scope: Scope,
  sent: {
    session: { id: string; origin: string; status: string }
    teammateId: string | null
    connectionId: string
    conversationKey: string
    to: string[]
    subject: string
    from: Date
  },
) {
  if (!sent.teammateId) return null
  const watch = await watchReplies(
    db,
    scope,
    {
      session: sent.session,
      teammateId: sent.teammateId,
      connectionId: sent.connectionId,
      conversationKey: sent.conversationKey,
      to: sent.to,
      subject: sent.subject,
    },
    sent.from,
  )
  if (!watch) return null
  if (!(await db.subscription.count({ where: { connectionId: sent.connectionId } })))
    try {
      await syncConnection(scope, sent.connectionId)
    } catch (error) {
      await endWatch(db, watch.id)
      return `A reply cannot wake you here (its inbox could not be watched: ${error instanceof Error ? error.message : String(error)}). Set a wake-up to check for it.`
    }
  return watchingNote(watch.until)
}

/** Held Gmail email due to leave, not claimed yet, of one workspace or all. */
const due = (now: Date, workspaceId?: string) => ({
  direction: 'out' as const,
  status: 'scheduled' as const,
  connectionId: { not: null },
  attempts: 0,
  sendAt: { lte: now },
  ...(workspaceId ? { workspaceId } : {}),
})

/** Claimed Gmail email that never got Gmail's answer: its sending was cut off. */
const cutOff = (now: Date, workspaceId?: string) => ({
  direction: 'out' as const,
  status: 'scheduled' as const,
  connectionId: { not: null },
  attempts: { gt: 0 },
  updatedAt: { lt: new Date(now.getTime() - CUT_OFF_MS) },
  ...(workspaceId ? { workspaceId } : {}),
})

/** Workspaces with held Gmail email due to leave, or cut off while it left (src/jobs.ts). */
export async function dueGmailSends(now = new Date()) {
  const rows = await prisma.mailMessage.findMany({
    where: { OR: [due(now), cutOff(now)] },
    distinct: ['workspaceId'],
    select: { workspaceId: true },
  })
  return rows.map((r) => r.workspaceId)
}

/**
 * Held Gmail email whose sending was cut off: never sent again, as it may have left. It is
 * marked failed and its thread told to check the account's sent mail, once.
 */
async function settleCutOff(now: Date, workspaceId?: string) {
  const rows = await prisma.mailMessage.findMany({
    where: cutOff(now, workspaceId),
    take: 20,
    select: { id: true, organizationId: true, workspaceId: true },
  })
  for (const row of rows) {
    const db = scoped({ organizationId: row.organizationId, workspaceId: row.workspaceId })
    const reason =
      'Brigade was cut off while sending it, so it may or may not have left: check the account’s sent mail before sending it again'
    // Marked, given back and told in one transaction: once marked it is no longer cut off. One
    // that fails stays cut off, and is settled on a later tick.
    await failSent(db, row.id, reason, {
      guard: { status: 'scheduled', attempts: { gt: 0 } },
    }).catch((error) => console.warn(`mail ${row.id}: cut off, not settled yet`, error))
  }
}

/** Send the held Gmail email that is due, of one workspace or all: each once at most. */
export async function sendDueGmail(now = new Date(), workspaceId?: string) {
  await settleCutOff(now, workspaceId)
  const rows = await prisma.mailMessage.findMany({
    where: due(now, workspaceId),
    orderBy: { sendAt: 'asc' },
    take: 20,
    select: { id: true, organizationId: true, workspaceId: true },
  })
  let sent = 0
  for (const row of rows) {
    const scope: Scope = { organizationId: row.organizationId, workspaceId: row.workspaceId }
    const db = scoped(scope)
    // Claimed: another run, or a retry of this one, never sends it again. Still scheduled until
    // Gmail answers; cut off before then, settleCutOff says so.
    const claimed = await db.mailMessage.updateMany({
      where: { id: row.id, status: 'scheduled', attempts: 0, sendAt: { lte: now } },
      data: { attempts: 1 },
    })
    if (!claimed.count) continue
    if (await sendOne(db, scope, row.id)) sent++
  }
  return sent
}

/** One held email, claimed: sent through its account, or back to its thread as a failure. */
async function sendOne(db: ScopedDb, scope: Scope, id: string) {
  const row = await db.mailMessage.findFirstOrThrow({
    where: { id },
    include: { session: { select: { id: true, origin: true, status: true } } },
  })
  const held = ((row.headers as { gmail?: Held } | null)?.gmail ?? {}) as Held
  try {
    const connection = await db.connection.findFirst({
      where: { id: row.connectionId!, status: { not: 'removed' } },
    })
    if (!connection) throw new Error('its Gmail account was removed')
    const fetch = await authorisedFetch(db, scope, connection)
    const ctx = {
      fetch,
      callId: row.id,
      keepFile: () => Promise.reject(new Error('Sending keeps no file')),
      readFile: async (fileId: string) => {
        const file = await db.attachment.findFirst({
          where: { id: fileId, sessionId: row.sessionId, status: 'ready' },
        })
        if (!file) throw new Error(`a file it attaches (${fileId}) is gone`)
        return {
          name: file.name,
          contentType: file.contentType,
          bytes: await readAttachment(scope, file.id),
        }
      },
    } as ConnectorContext
    const { firstResponseOf, ...asked } = held
    const out = await sendComposed(ctx, {
      to: row.to,
      ...(row.cc.length ? { cc: row.cc } : {}),
      subject: row.subject,
      body: row.text,
      ...asked,
    })
    if (firstResponseOf)
      await db.playbookRun.updateMany({
        where: { id: firstResponseOf, firstResponseAt: null },
        data: { firstResponseAt: new Date() },
      })
    // A reply stays in its conversation; a new email's is Gmail's thread from now on.
    const known = !row.conversationId.startsWith('out:')
    await db.mailMessage.updateMany({
      where: { id: row.id },
      data: {
        status: 'sent',
        sourceId: out.id,
        ...(known ? {} : { conversationId: out.threadId }),
      },
    })
    // A new conversation: its answer wakes the thread from now on.
    if (!known && row.session)
      await watchGmail(db, scope, {
        session: row.session,
        teammateId: row.teammateId,
        connectionId: row.connectionId!,
        conversationKey: out.threadId,
        to: row.to,
        subject: row.subject,
        from: new Date(),
      }).catch((error) => console.warn(`mail ${row.id}: reply watch failed`, error))
    return true
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 500)
    console.warn(`mail ${row.id}: Gmail could not send it`, error)
    await failSent(db, row.id, reason)
    return false
  }
}
