// Where vendors deliver events. Each request is verified (Stripe's signature
// with the endpoint's secret, or the event read again from Stripe, Pub/Sub's
// Google-signed token, a Calendar channel's token, a custom app's URL and
// signature) before anything is read.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { prisma, scoped, type Scope } from '../db.js'
import { fromPubSub, inboxChanged } from '../subscriptions/gmail.js'
import { calendarChanged } from '../subscriptions/google-calendar.js'
import { stripeAccountOf } from '../connectors/stripe.js'
import { accountKey, readStripeEvent, verifyStripe } from '../subscriptions/stripe.js'
import { dispatch, findTrigger } from '../triggers.js'
import { keepInbound, onInbound } from '../inbound.js'
import { openSecret } from '../vault.js'
import { received as mailReceived } from '../mail/inbound.js'
import { statusChanged as mailStatus } from '../mail/outbound.js'
import { verifyWebhook } from '../mail/resend.js'
import { noteFailure } from '../ops/failures.js'

const MAX_BODY = 1024 * 1024
type SigningSecret = { secret: string }

/**
 * At most `limit` takes per key in any `windowMs`, in this process: how many events an
 * endpoint may have read again from Stripe, so posting made-up ones cannot flood it.
 */
export function rateLimit(limit: number, windowMs: number, now = () => Date.now()) {
  const used = new Map<string, number[]>()
  return {
    take(key: string) {
      const since = now() - windowMs
      const recent = (used.get(key) ?? []).filter((t) => t > since)
      if (recent.length >= limit) {
        used.set(key, recent)
        return false
      }
      recent.push(now())
      used.set(key, recent)
      // Keys that went quiet are forgotten as others come.
      if (used.size > 10_000)
        for (const [k, times] of used) if (!times.some((t) => t > since)) used.delete(k)
      return true
    },
  }
}
const stripeReads = rateLimit(120, 60_000)

export const events = new Hono()
  /** Stripe, to the endpoint Brigade registered for one Stripe account of the connection. */
  .post('/stripe/:id', async (c) => {
    const sub = await prisma.subscription.findUnique({
      where: { id: c.req.param('id') },
      include: { connection: true },
    })
    if (!sub || sub.connection.kind !== 'stripe') return c.json({ error: 'Unknown endpoint' }, 404)
    const body = await c.req.text()
    if (body.length > MAX_BODY) return c.json({ error: 'Payload too large' }, 413)
    const scope: Scope = { organizationId: sub.organizationId, workspaceId: sub.workspaceId }
    // An endpoint on another account than the one the row is (left from a sign-in that stood for
    // several): its events start nothing, until the next sync turns it off. A row that names no
    // account yet (one of those sign-ins, until its owner signs in again) keeps its endpoints.
    const own = stripeAccountOf(sub.connection.externalAccount)
    if (own && sub.resource !== 'account' && accountKey(own) !== sub.resource)
      return c.json({ ok: true })
    let event: { id: string; type: string }
    if (sub.secretId) {
      const { secret } = await openSecret<SigningSecret>(scoped(scope), scope, sub.secretId)
      if (!verifyStripe(c.req.header('stripe-signature'), body, secret))
        return c.json({ error: 'Bad signature' }, 401)
      event = JSON.parse(body) as typeof event
    } else {
      // No signing secret (Stripe's MCP server did not show it): it counts only as Stripe has it.
      if (sub.connection.status === 'removed') return c.json({ ok: true })
      let posted: unknown
      try {
        posted = JSON.parse(body)
      } catch {
        return c.json({ error: 'Not a Stripe event' }, 400)
      }
      const id = (posted as { id?: unknown } | null)?.id
      if (typeof id !== 'string' || !/^evt_\w{1,255}$/.test(id))
        return c.json({ error: 'Not a Stripe event' }, 400)
      // Each event is a request to Stripe: past a few a second, Stripe sends them again later.
      if (!stripeReads.take(sub.id)) return c.json({ error: 'Too many events' }, 429)
      let read: Awaited<ReturnType<typeof readStripeEvent>>
      try {
        read = await readStripeEvent(scoped(scope), scope, sub.connection, sub.resource, id)
      } catch (error) {
        // Signed out or Stripe is down: Stripe retries for three days.
        console.error(`stripe event ${id}:`, error instanceof Error ? error.message : error)
        return c.json({ error: 'Could not read the event from Stripe yet' }, 503)
      }
      if (!read) return c.json({ error: 'Stripe has no such event' }, 401)
      event = read
    }
    // Kept, then processed from its row (src/inbound.ts), again until its threads started.
    await keepInbound({
      source: `stripe:${sub.id}`,
      externalId: event.id,
      type: event.type,
      payload: event,
    })
    return c.json({ ok: true })
  })

  /** Gmail, through the Pub/Sub push subscription: a mailbox changed. */
  .post('/gmail', async (c) => {
    if (!(await fromPubSub(c.req.header('authorization'))))
      return c.json({ error: 'Not from Pub/Sub' }, 401)
    // Acknowledge at once; the inbox's history says what is new, and its reader retries.
    await inboxChanged(await c.req.json().catch(() => ({})))
    return c.body(null, 204)
  })

  /**
   * Resend: Brigade's own addresses (the Email App). Mail is kept at once and delivered in the
   * background; mail to other products' domains on the shared account is left alone, unread.
   */
  .post('/resend', async (c) => {
    const body = await c.req.text()
    if (body.length > MAX_BODY) return c.json({ error: 'Payload too large' }, 413)
    const signed = verifyWebhook(body, {
      id: c.req.header('svix-id'),
      timestamp: c.req.header('svix-timestamp'),
      signature: c.req.header('svix-signature'),
    })
    if (!signed) {
      noteFailure('resend-webhook', 'bad signature: is RESEND_WEBHOOK_SECRET the webhook’s?')
      return c.json({ error: 'Bad signature' }, 401)
    }
    let event: { type?: string; data?: Record<string, unknown> }
    try {
      event = JSON.parse(body)
    } catch {
      return c.json({ error: 'Not JSON' }, 400)
    }
    if (!event.data || typeof event.data.email_id !== 'string') return c.json({ ok: true })
    try {
      if (event.type === 'email.received') await mailReceived(event.data as never)
      else if (event.type?.startsWith('email.')) await mailStatus(event.type, event.data as never)
    } catch (error) {
      console.error('resend webhook failed:', error)
      noteFailure('resend-webhook', error)
      // Resend tries again.
      return c.json({ error: 'Not kept yet' }, 503)
    }
    return c.json({ ok: true })
  })

  /** Google Calendar, on a channel Brigade opened. */
  .post('/google-calendar', async (c) => {
    const ok = await calendarChanged({
      channelId: c.req.header('x-goog-channel-id'),
      token: c.req.header('x-goog-channel-token'),
      state: c.req.header('x-goog-resource-state'),
    })
    // Not ours, or no longer: tell Google to stop sending.
    return ok ? c.body(null, 200) : c.json({ error: 'Unknown channel' }, 404)
  })

const equal = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** X-Brigade-Signature: sha256=<hex HMAC of the body>. */
const verifyHmac = (header: string | undefined, body: string, secret: string) =>
  Boolean(header) &&
  equal(header!, `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`)

/** A custom app's trigger URL. No session: the URL and signature identify it. */
export const customApps = new Hono().post('/:token', async (c) => {
  const trigger = await findTrigger(c.req.param('token'))
  if (!trigger) return c.json({ error: 'Unknown webhook' }, 404)
  const scope: Scope = { organizationId: trigger.organizationId, workspaceId: trigger.workspaceId }
  const body = await c.req.text()
  if (body.length > MAX_BODY) return c.json({ error: 'Payload too large' }, 413)
  if (trigger.verification === 'hmac') {
    if (!trigger.verificationSecretId) return c.json({ error: 'No signing secret' }, 401)
    const { secret } = await openSecret<SigningSecret>(
      scoped(scope),
      scope,
      trigger.verificationSecretId,
    )
    if (!verifyHmac(c.req.header('x-brigade-signature'), body, secret))
      return c.json({ error: 'Bad signature' }, 401)
  }
  if (trigger.teammate.archivedAt || trigger.connection.status === 'removed')
    return c.json({ error: 'This webhook is no longer active' }, 410)

  let payload: unknown = body
  try {
    payload = JSON.parse(body)
  } catch {
    // Not JSON: passed on as text.
  }
  const fields = typeof payload === 'object' && payload ? (payload as Record<string, unknown>) : {}
  // Senders retry; one thread per event id. Without one, the same body within the same five
  // minutes is the same event: a retry starts nothing, a resend later starts a thread again.
  const id =
    (typeof fields.id === 'string' && fields.id) ||
    c.req.header('x-request-id') ||
    `body:${createHash('sha256')
      .update(`${Math.floor(Date.now() / BODY_BUCKET_MS)}:${body}`)
      .digest('hex')}`
  // Kept, then processed from its row (src/inbound.ts), again until its thread started.
  const { duplicate } = await keepInbound({
    source: `hook:${trigger.id}`,
    externalId: id,
    type: 'received',
    payload,
  })
  return c.json({ ok: true, duplicate }, duplicate ? 200 : 202)
})

/** Custom apps' events without an id: one body counts once within this window. */
const BODY_BUCKET_MS = 5 * 60_000

/** A Stripe event, from its row: offered to the triggers of its endpoint's connection. */
onInbound('stripe', async ({ source, externalId, type, payload }) => {
  const sub = await prisma.subscription.findUnique({
    where: { id: source.slice('stripe:'.length) },
    include: { connection: true },
  })
  // Its account is gone since: nothing to start.
  if (!sub) return 'done'
  const { failed } = await dispatch(sub.connection, { id: externalId, type, payload })
  if (failed) noteFailure('trigger-webhook', `stripe ${type}: could not start a thread yet`)
  return failed ? 'retry' : 'done'
})

/** A custom app's event, from its row: offered to its trigger. */
onInbound('hook', async ({ source, externalId, type, payload }) => {
  const trigger = await prisma.trigger.findUnique({
    where: { id: source.slice('hook:'.length) },
    include: { teammate: true, connection: true },
  })
  if (!trigger || trigger.teammate.archivedAt || trigger.connection.status === 'removed')
    return 'done'
  const { failed } = await dispatch(trigger.connection, { id: externalId, type, payload }, trigger)
  if (failed) noteFailure('trigger-webhook', 'custom app: could not start a thread yet')
  return failed ? 'retry' : 'done'
})
