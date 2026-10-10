// Stripe: Brigade registers one webhook endpoint per connection, listing the
// event types its triggers need, and keeps that list current. Stripe returns
// the signing secret, which goes into the vault.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '../config.js'
import { authorisedFetch } from '../connector-calls.js'
import { API, form, VERSION } from '../connectors/stripe.js'
import { json } from '../connectors/types.js'
import { deleteSecret, sealSecret } from '../vault.js'
import { reachable, SubscribeError, vendorEvents, type Target } from './common.js'

const RESOURCE = 'account'
/** Stripe's default tolerance for a signature's timestamp. */
const TOLERANCE_S = 300

export async function syncStripe(target: Target) {
  const { db, scope, connection } = target
  const events = vendorEvents(target)
  const existing = await db.subscription.findFirst({
    where: { connectionId: connection.id, resource: RESOURCE },
  })
  const fetch = await authorisedFetch(db, scope, connection)
  const call = (path: string, method: string, body?: Record<string, unknown>) =>
    fetch(`${API}${path}`, {
      method,
      headers: {
        'stripe-version': VERSION,
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(body ? { body: form(body) } : {}),
    })

  if (events.length === 0) {
    if (!existing) return
    if (existing.externalId) {
      const response = await call(`/webhook_endpoints/${existing.externalId}`, 'DELETE')
      if (response.status !== 404) await json(response)
    }
    await db.subscription.deleteMany({ where: { id: existing.id } })
    if (existing.secretId) await deleteSecret(db, existing.secretId)
    return
  }

  if (!reachable())
    throw new SubscribeError(
      `Stripe can only send events to a public HTTPS address, and this server is ${env.API_URL}`,
    )
  const row =
    existing ??
    (await db.subscription.create({
      data: { connectionId: connection.id, resource: RESOURCE, mode: 'push', events: [] } as never,
    }))
  const refused = (error: unknown) =>
    new SubscribeError(
      `Stripe refused to register Brigade's webhook endpoint (${error instanceof Error ? error.message : error}). A restricted key needs write access to Webhook Endpoints.`,
    )

  if (row.externalId) {
    const response = await call(`/webhook_endpoints/${row.externalId}`, 'POST', {
      enabled_events: events,
      disabled: false,
    })
    // Deleted in Stripe's dashboard: register a new one below.
    if (response.status !== 404) {
      await json(response).catch((error) => {
        throw refused(error)
      })
      await db.subscription.updateMany({ where: { id: row.id }, data: { events, error: null } })
      return
    }
  }
  const endpoint = await json<{ id: string; secret: string }>(
    await call('/webhook_endpoints', 'POST', {
      url: `${env.API_URL}/events/stripe/${row.id}`,
      enabled_events: events,
      api_version: VERSION,
      description: 'Brigade: starts threads for your teammates',
    }),
  ).catch((error) => {
    throw refused(error)
  })
  const secretId = await sealSecret(db, scope, { secret: endpoint.secret })
  await db.subscription.updateMany({
    where: { id: row.id },
    data: { externalId: endpoint.id, secretId, events, error: null },
  })
  if (row.secretId) await deleteSecret(db, row.secretId)
}

const hmacHex = (secret: string, data: string) =>
  createHmac('sha256', secret).update(data).digest('hex')
const equal = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Stripe-Signature: t=<unix>,v1=<hex HMAC of "t.body">, possibly several v1. */
export function verifyStripe(header: string | undefined, body: string, secret: string) {
  if (!header) return false
  const parts = header.split(',').map((p) => p.split('=') as [string, string])
  const t = Number(parts.find(([k]) => k === 't')?.[1])
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > TOLERANCE_S) return false
  const expected = hmacHex(secret, `${t}.${body}`)
  return parts.some(([k, v]) => k === 'v1' && equal(v, expected))
}
