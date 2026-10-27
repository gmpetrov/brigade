// Where an alert goes: a webhook (Slack's incoming webhooks, a Brigade custom app's URL, or
// anything that takes JSON) and email, each optional. Kept free of the API's config and
// database: the Worker's cron (src/worker.ts) sends with it too when the Api object is down.
import { createHmac, timingSafeEqual } from 'node:crypto'

export type Severity = 'critical' | 'warning'

/** firing: it started; reminder: it still lasts; resolved: it is over. */
export type Notice = {
  kind: 'firing' | 'reminder' | 'resolved'
  key: string
  severity: Severity
  title: string
  detail: string
  firstAt: Date
  at: Date
}

export type Destinations = {
  webhookUrl?: string | undefined
  /** Signs the webhook's body: x-brigade-signature: sha256=<hex HMAC>, as Brigade's own custom apps check. */
  webhookSecret?: string | undefined
  emails?: string[] | undefined
  /** Resend, with the address it sends from. */
  resendKey?: string | undefined
  from?: string | undefined
}

/** Compares secrets in constant time. */
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export const anyDestination = (to: Destinations) =>
  Boolean(to.webhookUrl || (to.emails?.length && to.resendKey && to.from))

const LABEL = { firing: '🔴', reminder: '🟠 Still', resolved: '✅ Resolved:' } as const

/** An alert email's subject, by which it is known again should it come back in (src/triggers.ts). */
export const alertSubject = (notice: Notice) =>
  `[Brigade ${notice.severity}] ${notice.kind === 'resolved' ? 'Resolved: ' : ''}${notice.title}`
export const ALERT_SUBJECT = /\[Brigade (critical|warning)\] /

export function noticeText(notice: Notice) {
  const head = `${LABEL[notice.kind]} ${notice.title}`
  const since =
    notice.kind === 'firing' ? '' : `\nSince ${notice.firstAt.toISOString().slice(0, 16)}Z`
  return `${head}${notice.detail ? `\n\n${notice.detail}` : ''}${since}`
}

/** One notice to every destination. Throws when none took it, so it is tried again. */
export async function sendNotice(to: Destinations, notice: Notice) {
  const text = noticeText(notice)
  const tries: Promise<unknown>[] = []
  if (to.webhookUrl) {
    const body = JSON.stringify({
      // Senders retry: one id per notice, so a receiver keeps one of each.
      id: `brigade-ops:${notice.key}:${notice.firstAt.getTime()}:${notice.kind}:${notice.at.getTime()}`,
      source: 'brigade-ops',
      kind: notice.kind,
      key: notice.key,
      severity: notice.severity,
      title: notice.title,
      detail: notice.detail,
      firstAt: notice.firstAt.toISOString(),
      at: notice.at.toISOString(),
      // Slack's and Discord's incoming webhooks show this.
      text,
      content: text.slice(0, 2000),
    })
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (to.webhookSecret)
      headers['x-brigade-signature'] =
        `sha256=${createHmac('sha256', to.webhookSecret).update(body).digest('hex')}`
    tries.push(
      fetch(to.webhookUrl, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      }).then(async (response) => {
        if (!response.ok)
          throw new Error(`webhook ${response.status}: ${(await response.text()).slice(0, 200)}`)
      }),
    )
  }
  if (to.emails?.length && to.resendKey && to.from) {
    tries.push(
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${to.resendKey}`,
          'content-type': 'application/json',
          'idempotency-key': `ops-${notice.key}-${notice.kind}-${notice.at.getTime()}`.slice(
            0,
            256,
          ),
          'user-agent': 'brigade',
        },
        body: JSON.stringify({
          from: to.from,
          to: to.emails,
          // A machine's mail: a mailbox rule set to skip automatic mail starts no thread for it.
          headers: { 'Auto-Submitted': 'auto-generated' },
          subject: alertSubject(notice),
          text,
        }),
        signal: AbortSignal.timeout(10_000),
      }).then(async (response) => {
        if (!response.ok)
          throw new Error(`Resend ${response.status}: ${(await response.text()).slice(0, 200)}`)
      }),
    )
  }
  const results = await Promise.allSettled(tries)
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  for (const f of failed) console.error(`ops: alert ${notice.key} not sent: ${String(f.reason)}`)
  if (tries.length && failed.length === tries.length)
    throw new Error(`ops: alert ${notice.key} reached no destination`)
}
