// Mail a thread sends from Brigade's own addresses: checked before anyone is asked, sent through
// Resend 30 seconds later (the window to cancel it) or at the time it was set to leave, followed
// through Resend's events (sent, delivered, bounced), and its conversation watched so a reply
// wakes the thread.
import { SEND_LATER_MAX_DAYS } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit } from '../audit.js'
import { attachmentKey, presignGet } from '../bucket.js'
import { prisma, scoped, type Scope, type ScopedDb } from '../db.js'
import { watchReplies } from '../replies.js'
import { fireNow } from '../wakeups.js'
import { boxKey, senderOfBox } from './addresses.js'
import { contactFor } from './identity.js'
import { bareAddress } from './names.js'
import { cancelEmail, sendEmail, sentEmail, type SendInput } from './resend.js'
import { secretIn } from './text.js'
import { triggerEventText } from '@brigade/contracts'

/** The time a person (or the teammate) has to cancel a mail, before Resend sends it. */
export const UNDO_SECONDS = 30
/** Mails one address sends in a day, at most. */
export const SENDS_PER_DAY = 100
export const RECIPIENTS_MAX = 50
export const FILES_MAX = 10
export const FILES_BYTES_MAX = 25 * 1024 * 1024

export type Draft = {
  to: string[]
  cc?: string[]
  subject: string
  text: string
  /** The id of the box's email it answers: threaded, and its participants are the recipients. */
  replyTo?: string
  /** Recipients the conversation did not have, added on purpose. */
  newRecipients?: boolean
  /** Ids of the files the teammate uploaded with the call. */
  attachments?: string[]
  /** When it leaves, if later than its window to cancel: Resend holds it until then. */
  sendAt?: Date
}

/** When a mail leaves: in its window to cancel it, or later when it was set to. */
export const leavingAt = (draft: Pick<Draft, 'sendAt'>, now = Date.now()) =>
  new Date(Math.max(now + UNDO_SECONDS * 1000, draft.sendAt?.getTime() ?? 0))

export type SendingThread = {
  id: string
  projectId: string | null
  teammateId: string
  origin: string
  status: string
}

type Address = Parameters<typeof senderOfBox>[1] & { id: string }

/** The box a thread's mail lives in: its project's variant of an agent's address, or the inbox. */
export const threadBox = (
  address: { id: string; kind: 'agent' | 'inbox' },
  projectId: string | null,
) => ({
  projectId: address.kind === 'inbox' ? null : projectId,
  key: boxKey(address.id, address.kind === 'inbox' ? null : projectId),
})

/**
 * What stops a mail before anyone is asked, or null: the recipients (a reply goes to its
 * conversation's people unless newRecipients says otherwise), the files (this thread's own),
 * secrets in the text, the day's cap, and a reply someone already sent from Gmail.
 */
export async function checkDraft(
  db: ScopedDb,
  input: { address: Address; thread: SendingThread; draft: Draft },
): Promise<string | null> {
  const { address, thread, draft } = input
  const box = threadBox(address, thread.projectId)
  const recipients = [...draft.to, ...(draft.cc ?? [])].map(bareAddress)
  if (!recipients.length) return 'An email needs at least one recipient'
  if (recipients.length > RECIPIENTS_MAX)
    return `An email goes to ${RECIPIENTS_MAX} recipients at most`
  if ((draft.attachments?.length ?? 0) > FILES_MAX)
    return `An email carries ${FILES_MAX} files at most`
  if (draft.sendAt && draft.sendAt.getTime() > Date.now() + SEND_LATER_MAX_DAYS * 86_400_000)
    return `An email can be set to leave up to ${SEND_LATER_MAX_DAYS} days ahead`
  const secret = secretIn(`${draft.subject}\n${draft.text}`)
  if (secret)
    return `The email holds what looks like ${secret}. Never mail a secret: remove it, or ask the person to send it themselves.`
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const sentToday = await db.mailMessage.count({
    where: {
      addressId: address.id,
      direction: 'out',
      status: { not: 'cancelled' },
      createdAt: { gte: today },
    },
  })
  if (sentToday >= SENDS_PER_DAY)
    return `${SENDS_PER_DAY} emails went out from this address today: that is its cap. Try again tomorrow.`
  if (draft.attachments?.length) {
    const files = await db.attachment.findMany({
      where: {
        id: { in: draft.attachments },
        source: 'teammate',
        sessionId: thread.id,
        status: 'ready',
      },
      select: { id: true, size: true },
    })
    if (files.length !== draft.attachments.length)
      return 'Only files from this thread can be attached'
    if (files.reduce((sum, f) => sum + f.size, 0) > FILES_BYTES_MAX)
      return 'Files can be up to 25 MB in all'
  }
  if (draft.replyTo) {
    const original = await db.mailMessage.findFirst({ where: { id: draft.replyTo, box: box.key } })
    if (!original) return 'No such email in this thread’s mailbox to reply to'
    const conversation = await db.mailMessage.findMany({
      where: { conversationId: original.conversationId, box: box.key },
      select: {
        fromAddress: true,
        to: true,
        cc: true,
        replyTo: true,
        route: true,
        receivedAt: true,
        fromName: true,
      },
    })
    const people = new Set(
      conversation.flatMap((m) => [m.fromAddress, ...m.to, ...m.cc, ...m.replyTo]).map(bareAddress),
    )
    const outsiders = recipients.filter((r) => !people.has(r))
    if (outsiders.length && !draft.newRecipients)
      return `${outsiders.join(', ')} ${outsiders.length > 1 ? 'are' : 'is'} not in this conversation. To add ${outsiders.length > 1 ? 'them' : 'them'} on purpose, send again with newRecipients: true.`
    // Someone answered from the address itself (Gmail) after the email this one replies to.
    const human = conversation.find(
      (m) => m.route === 'own_copy' && m.receivedAt > original.receivedAt,
    )
    if (human)
      return `Someone already replied in this conversation from the mailbox itself, at ${human.receivedAt.toISOString()}. Read the conversation (email_read) before replying, and tell the person rather than answer twice.`
  }
  return null
}

/**
 * A thread that reads or answers a mail left in its mailbox takes it: the Inbox shows it with that
 * thread and its teammate, no longer To do. The mails of its conversation that waited until it go
 * too; a later one waits on its own.
 */
export async function takeFromBox(
  db: ScopedDb,
  sessionId: string,
  m: { box: string; conversationId: string; receivedAt: Date },
) {
  const waiting = {
    box: m.box,
    conversationId: m.conversationId,
    direction: 'in' as const,
    sessionId: null,
    doneAt: null,
    route: { in: ['box', 'cap', 'loop'] },
    receivedAt: { lte: m.receivedAt },
  }
  const rows = await db.mailMessage.findMany({
    where: waiting,
    select: {
      id: true,
      receivedAt: true,
      alias: { select: { sessionId: true, waitUntil: true } },
    },
  })
  // Never another thread's sign-up mail (its code) that waited in the box: only what this
  // thread may read (connectors/email.ts).
  const ids = rows
    .filter((r) => !r.alias || r.alias.sessionId === sessionId || r.receivedAt > r.alias.waitUntil)
    .map((r) => r.id)
  if (!ids.length) return
  await db.mailMessage.updateMany({
    where: { ...waiting, id: { in: ids } },
    // Kept with its thread, as a hand-over's: no longer the box's to clean up after 30 days.
    data: { sessionId, route: 'read', expiresAt: null },
  })
}

/** Hand a checked (and maybe approved) mail to Resend, to leave in UNDO_SECONDS. */
export async function sendDraft(
  db: ScopedDb,
  scope: Scope,
  input: {
    address: Address
    thread: SendingThread
    teammateId: string
    draft: Draft
    callId: string
    approvedByMemberId?: string
  },
) {
  const { address, thread, draft } = input
  const problem = await checkDraft(db, { address, thread, draft })
  if (problem) throw new HTTPException(400, { message: problem })
  const box = threadBox(address, thread.projectId)
  const from = await senderOfBox(db, address, box.projectId)
  const original = draft.replyTo
    ? await db.mailMessage.findFirst({ where: { id: draft.replyTo, box: box.key } })
    : null
  const headers: Record<string, string> = {}
  let subject = draft.subject
  if (original?.messageId) {
    headers['In-Reply-To'] = original.messageId
    headers.References = [...original.references.slice(-20), original.messageId].join(' ')
    if (!subject)
      subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`
  }
  const files = draft.attachments?.length
    ? await db.attachment.findMany({
        where: { id: { in: draft.attachments }, sessionId: thread.id },
        select: { id: true, name: true, contentType: true },
      })
    : []
  const attachments = await Promise.all(
    files.map(async (f) => ({
      filename: f.name,
      content_type: f.contentType,
      // Resend fetches the file itself: the API never holds it.
      path: (
        await presignGet(attachmentKey(scope, f.id), {
          contentType: f.contentType,
          disposition: `attachment; filename="${f.name.replace(/"/g, '')}"`,
        })
      ).url,
    })),
  )
  const sendAt = leavingAt(draft)
  const row = await db.mailMessage.create({
    data: {
      addressId: address.id,
      projectId: box.projectId,
      box: box.key,
      direction: 'out',
      status: 'scheduled',
      conversationId: original?.conversationId ?? `out:${input.callId}`,
      inReplyTo: original?.messageId ?? null,
      references: original
        ? [...original.references.slice(-20), ...(original.messageId ? [original.messageId] : [])]
        : [],
      fromAddress: from.address,
      fromName: from.name,
      to: draft.to.map(bareAddress),
      cc: (draft.cc ?? []).map(bareAddress),
      subject: subject.slice(0, 1000),
      text: draft.text,
      sessionId: thread.id,
      teammateId: input.teammateId,
      approvedByMemberId: input.approvedByMemberId ?? null,
      sendAt,
      attachments: files.map((f) => ({ id: f.id, filename: f.name, contentType: f.contentType })),
    } as never,
  })
  // A new conversation is its own first mail's.
  if (!original)
    await db.mailMessage.updateMany({ where: { id: row.id }, data: { conversationId: row.id } })
  const message: SendInput = {
    from: `${from.name.replace(/[<>"]/g, '')} <${from.address}>`,
    to: draft.to,
    ...(draft.cc?.length ? { cc: draft.cc } : {}),
    subject,
    text: draft.text,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(attachments.length ? { attachments } : {}),
    tags: [{ name: 'brigade_mail', value: row.id }],
    scheduled_at: sendAt.toISOString(),
  }
  try {
    const { id } = await sendEmail(message, `brigade-${row.id}`)
    await db.mailMessage.updateMany({ where: { id: row.id }, data: { resendId: id } })
  } catch (error) {
    await db.mailMessage.updateMany({
      where: { id: row.id },
      data: {
        status: 'cancelled',
        error: error instanceof Error ? error.message.slice(0, 500) : String(error),
      },
    })
    throw error
  }
  // Answered once Resend has it: a reply that failed leaves the mail To do.
  if (original) await takeFromBox(db, thread.id, original)
  for (const recipient of [...draft.to, ...(draft.cc ?? [])])
    await contactFor(db, recipient).catch(() => undefined)
  await audit({
    ...scope,
    actor: { type: 'teammate', id: input.teammateId },
    action: 'email.sent',
    target: { type: 'mail_message', id: row.id },
    data: { to: draft.to, subject, threadId: thread.id },
  })
  const conversationId = original?.conversationId ?? row.id
  // A reply in its conversation wakes this thread (a person's thread or a child); a rule's
  // thread follows its conversation already.
  const watch = address.connectionId
    ? await watchReplies(
        db,
        scope,
        {
          session: thread,
          teammateId: input.teammateId,
          connectionId: address.connectionId,
          conversationKey: conversationId,
          to: draft.to,
          subject,
        },
        // From when it leaves: one set for next week is followed the days after it.
        sendAt,
      )
    : null
  return { id: row.id, sendAt, conversationId, watch, from }
}

/** Cancel a mail still in its window, from the thread (a person) or by the teammate. */
export async function cancelMail(
  db: ScopedDb,
  scope: Scope,
  id: string,
  actor: { type: 'member' | 'teammate'; id: string },
) {
  const row = await db.mailMessage.findFirst({ where: { id, direction: 'out' } })
  if (!row) throw new HTTPException(404, { message: 'No such email' })
  if (row.status !== 'scheduled' || !row.sendAt || row.sendAt <= new Date())
    throw new HTTPException(409, { message: 'It has left already: it cannot be cancelled' })
  if (row.resendId) await cancelEmail(row.resendId)
  await db.mailMessage.updateMany({ where: { id: row.id }, data: { status: 'cancelled' } })
  await audit({
    ...scope,
    actor,
    action: 'email.cancelled',
    target: { type: 'mail_message', id: row.id },
  })
  return { cancelled: true }
}

type StatusEvent = {
  email_id: string
  message_id?: string | null
  bounce?: { message?: string; type?: string; subType?: string }
  failed?: { reason?: string }
  tags?: Record<string, string> | { name: string; value: string }[]
}

/**
 * Resend's events about a mail Brigade sent: its Message-ID (for the replies that will quote
 * it), delivered, or bounced and failed, which go back to the thread that sent it.
 */
export async function statusChanged(type: string, data: StatusEvent) {
  const row = await prisma.mailMessage.findFirst({
    where: { resendId: data.email_id, direction: 'out' },
    include: { address: true },
  })
  if (!row) return false
  const scope: Scope = { organizationId: row.organizationId, workspaceId: row.workspaceId }
  const db = scoped(scope)
  const messageId = data.message_id ?? row.messageId
  if (type === 'email.sent' || type === 'email.delivered') {
    await db.mailMessage.updateMany({
      where: { id: row.id, status: { in: ['scheduled', 'sent'] } },
      data: { status: type === 'email.sent' ? 'sent' : 'delivered', messageId },
    })
    if (messageId && messageId !== row.messageId)
      await db.mailMessage.updateMany({ where: { id: row.id }, data: { messageId } })
    return true
  }
  if (type === 'email.bounced' || type === 'email.failed') {
    const reason =
      data.bounce?.message ??
      data.failed?.reason ??
      (type === 'email.bounced' ? 'it bounced' : 'it failed')
    await db.mailMessage.updateMany({
      where: { id: row.id },
      data: { status: 'bounced', error: reason.slice(0, 500), messageId },
    })
    if (row.sessionId) await tellThread(db, row, reason)
    return true
  }
  return false
}

/** A sent mail that failed: the thread that sent it hears it, once. */
async function tellThread(
  db: ScopedDb,
  row: {
    id: string
    sessionId: string | null
    teammateId: string | null
    to: string[]
    subject: string
    fromAddress: string
  },
  reason: string,
) {
  const session = await db.session.findFirst({
    where: { id: row.sessionId! },
    select: { id: true, teammateId: true },
  })
  if (!session) return
  const note = triggerEventText({
    summary:
      `The email you sent from this thread to ${row.to.join(', ')} ("${row.subject}") could not be delivered: ${reason}. ` +
      'Tell the person, and check the address before sending again.',
    trigger: 'Delivery failure',
    definition: 'An email sent from this thread could not be delivered',
    source: row.fromAddress,
    type: 'email_status',
    id: row.id,
    received: new Date().toISOString(),
    payload: { to: row.to, subject: row.subject, reason },
  })
  try {
    const wakeup = await db.wakeup.create({
      data: {
        sessionId: session.id,
        teammateId: row.teammateId ?? session.teammateId,
        kind: 'reply',
        note,
        wakeAt: new Date(),
        sourceId: `email-status:${row.id}`,
      } as never,
    })
    await fireNow(wakeup.id)
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error
  }
}

/** A sent mail whose Message-ID Resend has not reported yet: asked for, once it has left. */
export async function fillMessageIds() {
  const rows = await prisma.mailMessage.findMany({
    where: {
      direction: 'out',
      messageId: null,
      resendId: { not: null },
      status: { in: ['scheduled', 'sent', 'delivered'] },
      sendAt: { lt: new Date(Date.now() - 60_000) },
    },
    take: 20,
  })
  for (const row of rows) {
    try {
      const got = await sentEmail(row.resendId!)
      // Scoped, so dashboards showing it hear of it (src/hub.ts).
      await scoped(row).mailMessage.updateMany({
        where: { id: row.id },
        data: {
          ...(got.message_id ? { messageId: got.message_id } : {}),
          ...(got.last_event === 'delivered'
            ? { status: 'delivered' }
            : got.last_event === 'sent'
              ? { status: 'sent' }
              : {}),
        },
      })
    } catch (error) {
      console.warn(`mail ${row.id}: no message id yet`, error)
    }
  }
}
