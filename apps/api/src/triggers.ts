// Triggers: something outside starts a thread for a teammate. An inbound
// webhook (see routes/webhooks.ts) or new mail in a Gmail connection's inbox,
// polled here. Either way the event is untrusted: it summons nobody, and every
// change its thread makes through a connector waits for a person.
import { HTTPException } from 'hono/http-exception'
import { audit } from './audit.js'
import { authorisedFetch } from './connector-calls.js'
import { API as GMAIL, full, type Message } from './connectors/gmail.js'
import { json } from './connectors/types.js'
import { prisma, scoped, type Scope } from './db.js'
import { startThread } from './work.js'

type Trigger = NonNullable<Awaited<ReturnType<typeof loadTrigger>>>

const loadTrigger = (where: { id: string } | { pathToken: string }) =>
  prisma.webhook.findUnique({ where, include: { teammate: true, connection: true } })

export const findWebhook = (pathToken: string) => loadTrigger({ pathToken })

const noun = (trigger: { source: 'http' | 'gmail' }) =>
  trigger.source === 'gmail' ? 'Gmail trigger' : 'Webhook'

/** A fenced block that the content cannot close early. */
export function fenced(content: string, lang = '') {
  const longest = Math.max(2, ...(content.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}${lang}\n${content}\n${fence}`
}

export type Delivery =
  { ok: true; threadId: string; paused: boolean } | { duplicate: true } | { error: string }

/**
 * Start a thread for one event, once per event id. When it cannot start, a
 * ticket tells the member who set the trigger up; the caller retries later.
 */
export async function deliver(
  trigger: Trigger,
  event: { eventId: string | null; eventType: string; title: string; text: string },
): Promise<Delivery> {
  const scope: Scope = { organizationId: trigger.organizationId, workspaceId: trigger.workspaceId }
  const db = scoped(scope)
  if (event.eventId) {
    const seen = await db.auditEntry.findFirst({
      where: {
        action: 'webhook.received',
        targetId: trigger.id,
        data: { path: ['eventId'], equals: event.eventId },
      },
    })
    if (seen) return { duplicate: true }
  }

  const failed = async (message: string): Promise<Delivery> => {
    // Never silent: a ticket for the member who set the trigger up.
    const open = await db.ticket.count({
      where: {
        type: 'question',
        status: 'open',
        payload: { path: ['webhookId'], equals: trigger.id },
      },
    })
    if (!open)
      await db.ticket.create({
        data: {
          type: 'question',
          title: `${noun(trigger)} "${trigger.label}" could not start a thread: ${message}`,
          payload: { webhookId: trigger.id, memberId: trigger.createdByMemberId },
        } as never,
      })
    return { error: message }
  }

  // The workspace computer, or else the member who set it up's own machine.
  const computer =
    (await db.computer.findFirst({
      where: { kind: 'cloud', status: { not: 'destroyed' } },
    })) ??
    (await db.computer.findFirst({
      where: { kind: 'member_machine', memberId: trigger.createdByMemberId },
      orderBy: { updatedAt: 'desc' },
    }))
  if (!computer) return failed('the workspace has no computer')

  try {
    const { thread, outcome } = await startThread(db, scope, {
      teammate: trigger.teammate,
      computer,
      memberId: trigger.createdByMemberId,
      title: event.title,
      text: event.text,
      origin: { webhookId: trigger.id },
    })
    if (outcome === 'offline') return failed('the computer is offline')
    await audit({
      ...scope,
      actor: { type: 'system', id: `webhook:${trigger.id}` },
      action: 'webhook.received',
      target: { type: 'webhook', id: trigger.id },
      data: {
        eventId: event.eventId,
        eventType: event.eventType,
        threadId: thread.id,
        outcome,
      },
    })
    return { ok: true, threadId: thread.id, paused: outcome === 'paused' }
  } catch (error) {
    if (error instanceof HTTPException) return failed(error.message)
    throw error
  }
}

// ---------------------------------------------------------------------------
// Gmail: new mail in the inbox, polled with the mailbox's history.
// ---------------------------------------------------------------------------

const POLL_MS = 60_000
/** At most this many emails start threads per trigger per poll; the rest wait for the next. */
const PER_POLL = 10
/** After a thread could not start, wait this long before trying the same trigger again. */
const RETRY_MS = 5 * 60_000

type History = {
  history?: {
    id: string
    messagesAdded?: { message: { id: string; labelIds?: string[] } }[]
  }[]
  historyId: string
  nextPageToken?: string
}

const retryAt = new Map<string, number>()
let polling = false

/** Poll every Gmail trigger once a minute. */
export function watchGmail() {
  const tick = async () => {
    if (polling) return
    polling = true
    try {
      const triggers = await prisma.webhook.findMany({
        where: {
          source: 'gmail',
          connection: { status: 'active' },
          teammate: { archivedAt: null },
        },
        include: { teammate: true, connection: true },
      })
      for (const trigger of triggers) {
        if ((retryAt.get(trigger.id) ?? 0) > Date.now()) continue
        await pollGmail(trigger).catch((error: unknown) =>
          console.error(
            `gmail trigger ${trigger.id}:`,
            error instanceof Error ? error.message : error,
          ),
        )
      }
    } finally {
      polling = false
    }
  }
  setTimeout(() => void tick(), 10_000).unref()
  setInterval(() => void tick(), POLL_MS).unref()
}

async function pollGmail(trigger: Trigger) {
  const scope: Scope = { organizationId: trigger.organizationId, workspaceId: trigger.workspaceId }
  const db = scoped(scope)
  const fetch = await authorisedFetch(db, scope, trigger.connection)
  const save = (cursor: string) =>
    db.webhook.updateMany({ where: { id: trigger.id }, data: { cursor } })
  const now = async () =>
    (await json<{ historyId: string }>(await fetch(`${GMAIL}/profile`))).historyId

  // Only mail that arrives after the trigger is set up.
  if (!trigger.cursor) return save(await now())

  const start = trigger.cursor
  let cursor = start
  let started = 0
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({
      startHistoryId: start,
      historyTypes: 'messageAdded',
      labelId: 'INBOX',
      maxResults: '100',
      ...(pageToken ? { pageToken } : {}),
    })
    const response = await fetch(`${GMAIL}/history?${params}`)
    // Gmail keeps about a week of history. Past that, start again from now.
    if (response.status === 404) return save(await now())
    const page = await json<History>(response)
    for (const record of page.history ?? []) {
      for (const { message } of record.messagesAdded ?? []) {
        // The mailbox's own mail, e.g. a teammate's reply to itself, starts nothing.
        if (message.labelIds?.some((l) => l === 'SENT' || l === 'DRAFT')) continue
        if (started >= PER_POLL) return save(cursor)
        const delivery = await deliverEmail(fetch, trigger, message.id)
        if (delivery && 'error' in delivery) {
          retryAt.set(trigger.id, Date.now() + RETRY_MS)
          return save(cursor)
        }
        if (delivery && 'ok' in delivery) started++
      }
      cursor = record.id
    }
    pageToken = page.nextPageToken
    if (!pageToken) cursor = page.historyId
  } while (pageToken)
  retryAt.delete(trigger.id)
  if (cursor !== trigger.cursor) await save(cursor)
}

/** Start a thread for one email, when it still exists and matches the trigger's search. */
async function deliverEmail(
  fetch: (url: string) => Promise<Response>,
  trigger: Trigger,
  id: string,
): Promise<Delivery | null> {
  const response = await fetch(`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`)
  if (response.status === 404) return null // deleted since
  const message = await json<Message>(response)
  const email = full(message)

  if (trigger.filter) {
    const rfcId = message.payload?.headers?.find(
      (h) => h.name.toLowerCase() === 'message-id',
    )?.value
    const q = rfcId
      ? `(${trigger.filter}) rfc822msgid:${rfcId}`
      : `(${trigger.filter}) newer_than:2d`
    const found = await json<{ messages?: { id: string }[] }>(
      await fetch(`${GMAIL}/messages?${new URLSearchParams({ q, maxResults: '100' })}`),
    )
    if (!found.messages?.some((m) => m.id === id)) return null
  }

  const mailbox = trigger.connection.externalAccount ?? trigger.connection.label
  const headers = [
    `From: ${email.from ?? ''}`,
    `To: ${email.to ?? ''}`,
    ...(email.cc ? [`Cc: ${email.cc}`] : []),
    `Subject: ${email.subject ?? ''}`,
    `Date: ${email.date ?? ''}`,
  ].join('\n')
  const text = [
    `New email in ${mailbox}, matched by Gmail trigger "${trigger.label}"${
      trigger.filter ? ` (${trigger.filter})` : ''
    }. Gmail message id ${email.id}, thread ${email.threadId}.`,
    fenced(`${headers}\n\n${email.body}`),
  ].join('\n')
  return deliver(trigger, {
    eventId: email.id,
    eventType: 'email',
    title: `${trigger.label}: ${email.subject || '(no subject)'}`,
    text,
  })
}
