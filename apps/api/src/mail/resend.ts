// Resend, as Brigade's own mail provider (the Email App): its key stays in the API, never in a
// teammate's tools. The account is shared with other products, so every call goes through one
// queue that keeps Brigade well under the account's 10 requests a second, and waits out a 429.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '../config.js'

const API = 'https://api.resend.com'
/** Brigade's share of the account's limit: the other products keep the rest. */
const PER_SECOND = 4
const TOLERANCE_S = 5 * 60

export class ResendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export const resendConfigured = () => Boolean(env.RESEND_API_KEY)

let queue: Promise<unknown> = Promise.resolve()
const sent: number[] = []
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A turn in the queue: at most PER_SECOND calls start in any second. */
function slot() {
  const turn = queue.then(async () => {
    for (;;) {
      const now = Date.now()
      while (sent.length && now - sent[0]! >= 1000) sent.shift()
      if (sent.length < PER_SECOND) {
        sent.push(now)
        return
      }
      await sleep(1000 - (now - sent[0]!) + 5)
    }
  })
  queue = turn.catch(() => undefined)
  return turn
}

/** One call to Resend's API, as JSON. Retries a 429 or a 5xx a few times. */
export async function resend<T>(
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  if (!env.RESEND_API_KEY) throw new ResendError('Brigade has no Resend key (RESEND_API_KEY)', 503)
  for (let attempt = 0; ; attempt++) {
    await slot()
    const response = await fetch(`${API}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'user-agent': 'brigade',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.idempotencyKey ? { 'idempotency-key': init.idempotencyKey } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    const text = await response.text()
    if (response.ok) return (text ? JSON.parse(text) : {}) as T
    const retry = response.status === 429 || response.status >= 500
    if (retry && attempt < 3) {
      const after = Number(response.headers.get('retry-after'))
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 500 * 2 ** attempt)
      continue
    }
    let message = text.slice(0, 300)
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? message
    } catch {
      // not JSON
    }
    throw new ResendError(`Resend ${response.status}: ${message}`, response.status)
  }
}

export type ResendAttachment = {
  id: string
  filename: string
  content_type: string
  content_disposition?: string | null
  content_id?: string | null
  size?: number
}

export type ReceivedEmail = {
  id: string
  to: string[]
  from: string
  created_at: string
  subject: string | null
  html: string | null
  text: string | null
  headers: Record<string, string | string[]> | null
  bcc?: string[]
  cc?: string[]
  reply_to?: string[]
  received_for?: string[]
  authentication?: { spf?: string; dkim?: string; dmarc?: string } | null
  message_id: string | null
  attachments?: ResendAttachment[]
}

export const receivedEmail = (id: string) =>
  resend<ReceivedEmail>(`/emails/receiving/${encodeURIComponent(id)}?html_format=cid`)

export const receivedAttachment = (emailId: string, id: string) =>
  resend<ResendAttachment & { download_url: string; expires_at: string }>(
    `/emails/receiving/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(id)}`,
  )

export type SendInput = {
  from: string
  to: string[]
  cc?: string[]
  reply_to?: string[]
  subject: string
  text: string
  headers?: Record<string, string>
  attachments?: { filename: string; path: string; content_type?: string }[]
  tags?: { name: string; value: string }[]
  scheduled_at?: string
}

export const sendEmail = (input: SendInput, idempotencyKey: string) =>
  resend<{ id: string }>('/emails', { body: input, idempotencyKey })

export const cancelEmail = (id: string) =>
  resend<{ id: string }>(`/emails/${encodeURIComponent(id)}/cancel`, { method: 'POST' })

export const sentEmail = (id: string) =>
  resend<{ id: string; message_id?: string | null; last_event?: string }>(
    `/emails/${encodeURIComponent(id)}`,
  )

export type ResendDomain = {
  id: string
  name: string
  status: string
  records?: {
    record: string
    name: string
    type: string
    value: string
    priority?: number
    status: string
    ttl?: string
  }[]
}

export const createDomain = (name: string) =>
  resend<ResendDomain>('/domains', {
    body: { name, capabilities: { sending: 'enabled', receiving: 'disabled' } },
  })
export const getDomain = (id: string) => resend<ResendDomain>(`/domains/${encodeURIComponent(id)}`)
export const verifyDomain = (id: string) =>
  resend<{ id: string }>(`/domains/${encodeURIComponent(id)}/verify`, { method: 'POST' })
export const deleteDomain = (id: string) =>
  resend<{ id: string }>(`/domains/${encodeURIComponent(id)}`, { method: 'DELETE' })

/**
 * A Resend webhook's signature (Svix): an HMAC-SHA256, keyed by the secret after its whsec_
 * prefix, of "<svix-id>.<svix-timestamp>.<body>", in base64, one of the space-separated v1
 * signatures. Old timestamps are refused, so a captured delivery cannot be replayed later.
 */
export function verifyWebhook(
  body: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  secret = env.RESEND_WEBHOOK_SECRET,
  now = Date.now(),
) {
  if (!secret || !headers.id || !headers.timestamp || !headers.signature) return false
  const timestamp = Number(headers.timestamp)
  if (!Number.isFinite(timestamp) || Math.abs(now / 1000 - timestamp) > TOLERANCE_S) return false
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const expected = createHmac('sha256', key)
    .update(`${headers.id}.${headers.timestamp}.${body}`)
    .digest()
  return headers.signature.split(' ').some((part) => {
    const [version, value] = part.split(',')
    if (version !== 'v1' || !value) return false
    const given = Buffer.from(value, 'base64')
    return given.length === expected.length && timingSafeEqual(given, expected)
  })
}
