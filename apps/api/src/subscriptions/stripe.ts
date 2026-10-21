// Stripe, through its MCP server with the account's sign-in. A sign-in may reach several Stripe
// accounts (a live account and its sandboxes): each gets one webhook endpoint listing the event
// types the connection's triggers need, kept current. The server creates, updates and disables
// endpoints but deletes none. It shows a new endpoint's signing secret to a sign-in (it hides it
// from keys): kept in the vault, it checks the endpoint's events. An endpoint without one has
// each event read again from Stripe before it starts anything (readStripeEvent).
import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '../config.js'
import { authorisedFetch } from '../connector-calls.js'
import { callMcpTool } from '../connectors/mcp.js'
import { stripe, stripeAccounts, type StripeAccount } from '../connectors/stripe.js'
import type { ApiKeyCredential, ConnectorKind } from '../connectors/types.js'
import type { Scope, ScopedDb } from '../db.js'
import { deleteSecret, openSecret, sealSecret } from '../vault.js'
import { reachable, SubscribeError, vendorEvents, type Target } from './common.js'

/** Stripe's default tolerance for a signature's timestamp. */
const TOLERANCE_S = 300
/** Where an account connected with a key, before Stripe signed in, had its endpoint. */
const LEGACY = 'account'
const server = stripe.mcp!
type Fetch = Awaited<ReturnType<typeof authorisedFetch>>

/** A subscription's resource: the account and its mode, e.g. acct_123:live. */
export const accountKey = (a: Pick<StripeAccount, 'stripe_context' | 'livemode'>) =>
  `${a.stripe_context}:${a.livemode ? 'live' : 'test'}`
export function accountOf(resource: string) {
  const m = /^(acct_\w+):(live|test)$/.exec(resource)
  return m ? { stripe_context: m[1]!, livemode: m[2] === 'live' } : null
}

/** One Stripe API request through the server, on one account. */
const api = (
  fetch: Fetch,
  account: Pick<StripeAccount, 'stripe_context' | 'livemode'>,
  write: boolean,
  operation: string,
  parameters: Record<string, unknown>,
) =>
  callMcpTool(fetch, server, write ? 'stripe_api_write' : 'stripe_api_read', {
    stripe_api_operation_id: operation,
    parameters,
    stripe_context: account.stripe_context,
    livemode: account.livemode,
  })

/** Stripe no longer has the endpoint (deleted in its dashboard). */
const gone = (error: unknown) =>
  /no such webhook|resource_missing/i.test(error instanceof Error ? error.message : String(error))

/** The key of an account connected before Stripe signed in, which only its owner's sign-in replaces. */
async function legacyKey(db: ScopedDb, scope: Scope, connection: { vaultSecretId: string | null }) {
  if (!connection.vaultSecretId) return null
  const secret = await openSecret<Partial<ApiKeyCredential>>(
    db,
    scope,
    connection.vaultSecretId,
  ).catch(() => null)
  return typeof secret?.apiKey === 'string' ? secret.apiKey : null
}

export async function syncStripe(target: Target) {
  const { db, scope, connection } = target
  const events = vendorEvents(target)
  const rows = await db.subscription.findMany({ where: { connectionId: connection.id } })
  // Nothing listens and no endpoint is on: nothing to tell Stripe.
  if (!events.length && rows.every((r) => !r.events.length && r.resource !== LEGACY)) return

  const key = await legacyKey(db, scope, connection)
  if (key) {
    if (events.length)
      throw new SubscribeError(
        'Brigade now signs in to Stripe instead of using a key: reconnect this account to change its triggers',
      )
    // Removed before its owner signed in again: its key still deletes the endpoint.
    for (const row of rows) {
      if (row.externalId)
        await fetch(`https://api.stripe.com/v1/webhook_endpoints/${row.externalId}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${key}` },
        }).then((r) => r.body?.cancel())
      await dropRow(db, row)
    }
    return
  }

  const signedIn = await authorisedFetch(db, scope, connection)
  const accounts = stripeAccounts(
    await callMcpTool(signedIn, server, 'list_available_accounts_or_orgs', {}),
  )

  // The endpoint registered with this account's key, before its owner signed in: kept, with its
  // signing secret, as the endpoint of the account that has it.
  for (const row of rows.filter((r) => r.resource === LEGACY)) {
    let owner: StripeAccount | undefined
    for (const account of row.externalId ? accounts : []) {
      const found = await api(signedIn, account, false, 'GetWebhookEndpointsWebhookEndpoint', {
        id: row.externalId,
      }).catch((error) => {
        // Another account's endpoint is no such endpoint on this one.
        if (gone(error)) return null
        throw error
      })
      if (found) {
        owner = account
        break
      }
    }
    const taken = owner && rows.some((r) => r.resource === accountKey(owner))
    if (owner && !taken) {
      row.resource = accountKey(owner)
      await db.subscription.updateMany({ where: { id: row.id }, data: { resource: row.resource } })
    } else await dropRow(db, row)
  }

  if (events.length && !reachable())
    throw new SubscribeError(
      `Stripe can only send events to a public HTTPS address, and this server is ${env.API_URL}`,
    )
  const refused = (error: unknown) =>
    new SubscribeError(
      `Stripe refused to register Brigade's webhook endpoint (${error instanceof Error ? error.message : error})`,
    )

  for (const account of accounts) {
    const resource = accountKey(account)
    const existing = rows.find((r) => r.resource === resource)
    if (!events.length) {
      // Stripe's server deletes no endpoint: it is turned off, and on again with the next trigger.
      if (existing?.externalId && existing.events.length)
        await api(signedIn, account, true, 'PostWebhookEndpointsWebhookEndpoint', {
          id: existing.externalId,
          disabled: true,
        }).catch((error) => {
          if (!gone(error)) throw error
        })
      if (existing)
        await db.subscription.updateMany({ where: { id: existing.id }, data: { events: [] } })
      continue
    }
    if (existing?.externalId) {
      const updated = await api(signedIn, account, true, 'PostWebhookEndpointsWebhookEndpoint', {
        id: existing.externalId,
        enabled_events: events,
        disabled: false,
      }).then(
        () => true,
        (error) => {
          // Deleted in Stripe's dashboard: register a new one below.
          if (gone(error)) return false
          throw refused(error)
        },
      )
      if (updated) {
        await db.subscription.updateMany({
          where: { id: existing.id },
          data: { events, error: null },
        })
        continue
      }
    }
    const row =
      existing ??
      (await db.subscription.create({
        data: { connectionId: connection.id, resource, mode: 'push', events: [] } as never,
      }))
    const endpoint = (await api(signedIn, account, true, 'PostWebhookEndpoints', {
      url: `${env.API_URL}/events/stripe/${row.id}`,
      enabled_events: events,
      description: 'Brigade: starts threads for your teammates',
    }).catch((error) => {
      throw refused(error)
    })) as { id?: unknown; secret?: unknown }
    if (typeof endpoint.id !== 'string') throw refused('no endpoint id in its answer')
    // Shown to a sign-in; "[REDACTED]" to a key, and then each event is read again instead.
    const secret =
      typeof endpoint.secret === 'string' && endpoint.secret.startsWith('whsec_')
        ? endpoint.secret
        : null
    const secretId = secret ? await sealSecret(db, scope, { secret }) : null
    await db.subscription.updateMany({
      where: { id: row.id },
      data: { externalId: endpoint.id, secretId, events, error: null },
    })
    if (row.secretId) await deleteSecret(db, row.secretId)
  }

  // Accounts the sign-in no longer reaches: Brigade cannot turn their endpoints off, and stops
  // taking their events (Stripe disables an endpoint that keeps failing).
  const reached = new Set(accounts.map(accountKey))
  for (const row of rows)
    if (row.resource !== LEGACY && !reached.has(row.resource)) await dropRow(db, row)
}

async function dropRow(db: ScopedDb, row: { id: string; secretId: string | null }) {
  await db.subscription.deleteMany({ where: { id: row.id } })
  if (row.secretId) await deleteSecret(db, row.secretId)
}

/**
 * An event posted to an endpoint with no signing secret, as Stripe has it: read again from
 * Stripe on the endpoint's account, so that only events Stripe really sent start anything,
 * with what Stripe says rather than what was posted. Null when Stripe has no such event.
 */
export async function readStripeEvent(
  db: ScopedDb,
  scope: Scope,
  connection: { id: string; kind: ConnectorKind; vaultSecretId: string | null },
  resource: string,
  eventId: string,
): Promise<{ id: string; type: string } | null> {
  const account = accountOf(resource)
  if (!account) return null
  const signedIn = await authorisedFetch(db, scope, connection)
  let event: { id?: unknown; object?: unknown; type?: unknown; data?: unknown }
  try {
    event = (await api(signedIn, account, false, 'GetEventsId', { id: eventId })) as typeof event
  } catch (error) {
    if (/no such (notification|event)|resource_missing/i.test(String(error))) return null
    throw error
  }
  if (event?.id !== eventId || event.object !== 'event' || typeof event.type !== 'string')
    return null
  // A sign-in with a key gets the event's data hidden: that is no event to start a thread with.
  if (typeof event.data !== 'object' || event.data === null)
    throw new Error("Stripe hid the event's data")
  return event as { id: string; type: string }
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
