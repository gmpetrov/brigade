// Where vendors deliver events. Each request is verified (Stripe's signature
// with the endpoint's secret, Pub/Sub's Google-signed token, a Calendar
// channel's token, a custom app's URL and signature) before anything is read.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { prisma, scoped, type Scope } from '../db.js'
import { fromPubSub, inboxChanged } from '../subscriptions/gmail.js'
import { calendarChanged } from '../subscriptions/google-calendar.js'
import { verifyStripe } from '../subscriptions/stripe.js'
import { dispatch, findTrigger } from '../triggers.js'
import { openSecret } from '../vault.js'

const MAX_BODY = 1024 * 1024
type SigningSecret = { secret: string }

export const events = new Hono()
  /** Stripe, to the endpoint Brigade registered for the connection. */
  .post('/stripe/:id', async (c) => {
    const sub = await prisma.subscription.findUnique({
      where: { id: c.req.param('id') },
      include: { connection: true },
    })
    if (!sub?.secretId || sub.connection.kind !== 'stripe')
      return c.json({ error: 'Unknown endpoint' }, 404)
    const body = await c.req.text()
    if (body.length > MAX_BODY) return c.json({ error: 'Payload too large' }, 413)
    const scope: Scope = { organizationId: sub.organizationId, workspaceId: sub.workspaceId }
    const { secret } = await openSecret<SigningSecret>(scoped(scope), scope, sub.secretId)
    if (!verifyStripe(c.req.header('stripe-signature'), body, secret))
      return c.json({ error: 'Bad signature' }, 401)
    const event = JSON.parse(body) as { id: string; type: string }
    const { failed } = await dispatch(sub.connection, {
      id: event.id,
      type: event.type,
      payload: event,
    })
    // Stripe retries for three days.
    return failed ? c.json({ error: 'Could not start a thread yet' }, 503) : c.json({ ok: true })
  })

  /** Gmail, through the Pub/Sub push subscription: a mailbox changed. */
  .post('/gmail', async (c) => {
    if (!(await fromPubSub(c.req.header('authorization'))))
      return c.json({ error: 'Not from Pub/Sub' }, 401)
    // Acknowledge at once; the inbox's history says what is new, and its reader retries.
    await inboxChanged(await c.req.json().catch(() => ({})))
    return c.body(null, 204)
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
  // Senders retry; one thread per event id.
  const id =
    (typeof fields.id === 'string' && fields.id) ||
    c.req.header('x-request-id') ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const { failed, started } = await dispatch(
    trigger.connection,
    { id, type: 'received', payload },
    trigger,
  )
  if (failed)
    return c.json({ error: 'Could not start a thread yet' }, 503, { 'retry-after': '300' })
  return c.json({ ok: true, duplicate: started === 0 }, started ? 202 : 200)
})
