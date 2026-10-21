import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, beforeEach, test } from 'node:test'
import pg from 'pg'

// Stripe on its MCP server: account names, call targets, and against a real database, the
// webhook endpoints Brigade keeps per Stripe account and the events it reads again from Stripe.
// Stripe's MCP server is played by a fake fetch, answering as the real one does (tools/call
// results with structuredContent; "Stripe API error: No such …" as an error result). The local
// database of apps/api/.env, in an organization of its own removed at the end; without a
// database to reach, those tests are skipped.
const fromEnvFile = () => {
  try {
    const line = readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('DATABASE_URL='))
    return line?.slice('DATABASE_URL='.length).replace(/^"|"$/g, '') || undefined
  } catch {
    return undefined
  }
}
process.env.DATABASE_URL ??= fromEnvFile() ?? 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
// Stripe only sends events to a public HTTPS address.
process.env.API_URL = 'https://api.brigade.test'

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select 1 from "Subscription" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { stripe, stripeAccountName, stripeAccounts } = await import('../src/connectors/stripe.js')
const { rateLimit } = await import('../src/routes/events.js')

test('a Stripe sign-in shows as its account, or its first account and how many more', () => {
  // list_available_accounts_or_orgs' structuredContent, as Stripe answers an OAuth sign-in.
  const one = { accounts: [{ stripe_context: 'acct_1Abc', livemode: true, name: 'Acme' }] }
  assert.equal(stripeAccountName(one), 'Acme (acct_1Abc, live mode)')
  const two = {
    accounts: [
      { stripe_context: 'acct_1Abc', livemode: false, name: 'Acme sandbox' },
      { stripe_context: 'acct_1Def', livemode: true, name: 'Acme' },
    ],
  }
  assert.equal(stripeAccountName(two), 'Acme sandbox (test mode) +1')
  assert.equal(stripeAccountName({ accounts: [] }), null)
  assert.equal(stripeAccountName('nothing'), null)
  // Anything but an account id and a mode is left out.
  assert.deepEqual(
    stripeAccounts({ accounts: [{ stripe_context: 'x', livemode: true }, null] }),
    [],
  )
})

test('a Stripe API call shows in approvals as its operation, parameters and mode', () => {
  const target = stripe.mcp!.target!
  assert.equal(
    target('stripe_api_write', {
      stripe_api_operation_id: 'PostRefunds',
      parameters: { charge: 'ch_1' },
      stripe_context: 'acct_1Abc',
      livemode: false,
    }),
    'PostRefunds {"charge":"ch_1"} (test mode)',
  )
  assert.equal(
    target('stripe_api_read', {
      stripe_api_operation_id: 'GetBalance',
      stripe_context: 'acct_1Abc',
      livemode: true,
    }),
    'GetBalance',
  )
  // Its other tools show their inputs as any MCP tool's.
  assert.equal(target('list_available_accounts_or_orgs', {}), null)
})

test('the rate limit lets a key through so many times a window, then again later', () => {
  let now = 0
  const limit = rateLimit(2, 1000, () => now)
  assert.equal(limit.take('a'), true)
  assert.equal(limit.take('a'), true)
  assert.equal(limit.take('a'), false)
  assert.equal(limit.take('b'), true)
  now = 1001
  assert.equal(limit.take('a'), true)
})

// ---------------------------------------------------------------------------
// Against a database, with Stripe's MCP server played by a fake fetch
// ---------------------------------------------------------------------------

type Endpoint = {
  id: string
  url: string
  enabled_events: string[]
  status: 'enabled' | 'disabled'
}
type Account = { stripe_context: string; livemode: boolean; name: string }
type Fake = {
  accounts: Account[]
  /** Endpoints by account key (acct:live|test). */
  endpoints: Record<string, Endpoint[]>
  events: Record<string, Record<string, unknown>[]>
  calls: { tool: string; operation?: string; key?: string; parameters?: Record<string, unknown> }[]
  /** What the server shows as an endpoint's secret. */
  secret: string
  deletedWithKey: string[]
  tokens: string[]
}
let fake: Fake
const keyOf = (a: { stripe_context: unknown; livemode: unknown }) =>
  `${a.stripe_context}:${a.livemode ? 'live' : 'test'}`
const realFetch = globalThis.fetch
const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
  })
const result = (value: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  structuredContent: value,
})
const stripeError = (message: string) => ({
  content: [{ type: 'text', text: `Stripe API error: ${message}` }],
  isError: true,
})
let endpoints = 0

function stripeTool(name: string, args: Record<string, unknown>) {
  if (name === 'list_available_accounts_or_orgs') return result({ accounts: fake.accounts })
  const operation = args.stripe_api_operation_id as string
  const parameters = (args.parameters ?? {}) as Record<string, unknown>
  const key = keyOf(args as Account)
  fake.calls.push({ tool: name, operation, key, parameters })
  const list = (fake.endpoints[key] ??= [])
  const endpoint = list.find((e) => e.id === parameters.id)
  switch (operation) {
    case 'GetWebhookEndpointsWebhookEndpoint':
      return endpoint
        ? result(endpoint)
        : stripeError(`No such webhook endpoint: '${parameters.id}'`)
    case 'PostWebhookEndpoints': {
      const created: Endpoint = {
        id: `we_${++endpoints}`,
        url: parameters.url as string,
        enabled_events: parameters.enabled_events as string[],
        status: 'enabled',
      }
      list.push(created)
      return result({ ...created, secret: fake.secret })
    }
    case 'PostWebhookEndpointsWebhookEndpoint':
      if (!endpoint) return stripeError(`No such webhook endpoint: '${parameters.id}'`)
      if (parameters.enabled_events) endpoint.enabled_events = parameters.enabled_events as string[]
      if (typeof parameters.disabled === 'boolean')
        endpoint.status = parameters.disabled ? 'disabled' : 'enabled'
      return result(endpoint)
    case 'GetEventsId': {
      const event = fake.events[key]?.find((e) => e.id === parameters.id)
      return event ? result(event) : stripeError(`No such notification: '${parameters.id}'`)
    }
  }
  return stripeError(`unexpected operation ${operation}`)
}

before(() => {
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    if (url.origin === 'https://api.stripe.com' && init.method === 'DELETE') {
      fake.deletedWithKey.push(url.pathname.split('/').pop()!)
      return json({ deleted: true })
    }
    if (url.origin !== 'https://mcp.stripe.com') throw new Error(`unexpected request ${url}`)
    const headers = init.headers as Record<string, string>
    fake.tokens.push(headers.authorization ?? '')
    const message = JSON.parse(String(init.body)) as {
      id?: number
      method: string
      params?: { name: string; arguments: Record<string, unknown> }
    }
    if (message.method === 'initialize')
      return json(
        {
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: {} },
        },
        { 'mcp-session-id': 'session' },
      )
    if (message.id === undefined) return new Response(null, { status: 202 })
    if (message.method !== 'tools/call') throw new Error(`unexpected ${message.method}`)
    return json({
      jsonrpc: '2.0',
      id: message.id,
      result: stripeTool(message.params!.name, message.params!.arguments ?? {}),
    })
  }) as typeof fetch
})

beforeEach(() => {
  fake = {
    accounts: [{ stripe_context: 'acct_1Live', livemode: true, name: 'Acme' }],
    endpoints: {},
    events: {},
    calls: [],
    secret: '[REDACTED]',
    deletedWithKey: [],
    tokens: [],
  }
})

after(() => {
  globalThis.fetch = realFetch
})

const id = randomUUID().slice(0, 8)
const ids = { organization: `org-stripe-${id}`, user: `user-stripe-${id}` }
const member = `mem-stripe-${id}`
let scope: { organizationId: string; workspaceId: string }
let teammateId: string
let appId: string
let db: Awaited<typeof import('../src/db.js')>['prisma']

const setUp = async () => {
  const { prisma } = await import('../src/db.js')
  db = prisma
  await prisma.organization.create({
    data: { id: ids.organization, name: 'Stripe test', slug: ids.organization },
  })
  await prisma.user.create({
    data: { id: ids.user, name: 'Ada', email: `${ids.user}@example.com` },
  })
  await prisma.member.create({
    data: { id: member, organizationId: ids.organization, userId: ids.user, role: 'owner' },
  })
  const workspace = await prisma.workspace.create({
    data: { organizationId: ids.organization, name: 'Stripe test' },
  })
  scope = { organizationId: ids.organization, workspaceId: workspace.id }
  teammateId = (await prisma.teammate.create({ data: { ...scope, name: 'Sam' } })).id
  appId = (
    await prisma.app.create({ data: { ...scope, key: 'stripe', createdByMemberId: member } })
  ).id
}
before(async () => {
  if (!skip) await setUp()
})
after(async () => {
  if (skip) return
  await db.organization.deleteMany({ where: { id: ids.organization } })
  await db.user.deleteMany({ where: { id: ids.user } })
  await db.$disconnect()
})

/** A Stripe account signed in with Stripe, or connected with a key before. */
async function connection(credential: object = signedIn()) {
  const { scoped } = await import('../src/db.js')
  const { sealSecret } = await import('../src/vault.js')
  const sdb = scoped(scope)
  return sdb.connection.create({
    data: {
      appId,
      kind: 'stripe',
      label: 'Stripe',
      externalAccount: 'Acme (acct_1Live, live mode)',
      createdByMemberId: member,
      vaultSecretId: await sealSecret(sdb, scope, credential),
    } as never,
  })
}
const signedIn = () => ({
  accessToken: 'oak_token',
  refreshToken: 'refresh',
  expiresAt: Date.now() + 3600_000,
  clientId: 'oacli_1',
  tokenEndpoint: 'https://access.stripe.com/mcp/oauth2/token',
  resource: 'https://mcp.stripe.com',
})
const trigger = (connectionId: string, event: string) =>
  db.trigger.create({
    data: { ...scope, connectionId, teammateId, label: event, event, createdByMemberId: member },
  })
const sync = async (connectionId: string, options: { removing?: boolean } = {}) => {
  const { syncConnection } = await import('../src/subscriptions/index.js')
  await syncConnection(scope, connectionId, options)
}
const subscriptions = (connectionId: string) =>
  db.subscription.findMany({ where: { connectionId }, orderBy: { resource: 'asc' } })

test(
  "a trigger registers an endpoint on each Stripe account of the sign-in, through Stripe's server",
  { skip },
  async () => {
    fake.accounts.push({ stripe_context: 'acct_1Live', livemode: false, name: 'Acme' })
    const c = await connection()
    await trigger(c.id, 'payment_received')
    await sync(c.id)

    const subs = await subscriptions(c.id)
    assert.deepEqual(
      subs.map((s) => [s.resource, s.events, s.secretId]),
      [
        ['acct_1Live:live', ['payment_intent.succeeded'], null],
        ['acct_1Live:test', ['payment_intent.succeeded'], null],
      ],
    )
    for (const s of subs) {
      const [endpoint] = fake.endpoints[s.resource]!
      assert.equal(endpoint!.id, s.externalId)
      assert.equal(endpoint!.url, `https://api.brigade.test/events/stripe/${s.id}`)
    }
    // Every request carries the account's sign-in.
    assert.ok(fake.tokens.every((t) => t === 'Bearer oak_token'))

    // Another trigger: the same endpoints, listing both events.
    await trigger(c.id, 'payment_failed')
    fake.calls = []
    await sync(c.id)
    assert.deepEqual(
      fake.calls.map((call) => [call.operation, call.key]),
      [
        ['PostWebhookEndpointsWebhookEndpoint', 'acct_1Live:live'],
        ['PostWebhookEndpointsWebhookEndpoint', 'acct_1Live:test'],
      ],
    )
    assert.deepEqual(fake.endpoints['acct_1Live:live']![0]!.enabled_events, [
      'payment_intent.payment_failed',
      'payment_intent.succeeded',
    ])

    // No trigger left: the server deletes no endpoint, so they are turned off and kept.
    await db.trigger.deleteMany({ where: { connectionId: c.id } })
    await sync(c.id)
    assert.deepEqual(
      Object.values(fake.endpoints).map((list) => list.map((e) => e.status)),
      [['disabled'], ['disabled']],
    )
    assert.deepEqual(
      (await subscriptions(c.id)).map((s) => s.events),
      [[], []],
    )

    // A trigger again: the same endpoints, on again.
    await trigger(c.id, 'refund_issued')
    await sync(c.id)
    assert.equal(fake.endpoints['acct_1Live:live']!.length, 1)
    assert.equal(fake.endpoints['acct_1Live:live']![0]!.status, 'enabled')
  },
)

test(
  "an endpoint deleted in Stripe's dashboard is registered again; one the server shows a secret for keeps it",
  { skip },
  async () => {
    const c = await connection()
    await trigger(c.id, 'payment_received')
    await sync(c.id)
    const [before] = await subscriptions(c.id)
    fake.endpoints['acct_1Live:live'] = []
    fake.secret = 'whsec_shown'
    await trigger(c.id, 'payment_failed')
    await sync(c.id)
    const [now] = await subscriptions(c.id)
    assert.equal(now!.id, before!.id)
    assert.notEqual(now!.externalId, before!.externalId)
    assert.ok(now!.secretId, 'the secret it showed is kept in the vault')
  },
)

test(
  'an account connected with a key keeps its endpoint and signing secret once its owner signs in',
  { skip },
  async () => {
    const { scoped } = await import('../src/db.js')
    const { sealSecret, replaceSecret } = await import('../src/vault.js')
    const sdb = scoped(scope)
    const c = await connection({ apiKey: 'rk_live_old' })
    await trigger(c.id, 'payment_received')
    const secretId = await sealSecret(sdb, scope, { secret: 'whsec_old' })
    await sdb.subscription.create({
      data: {
        connectionId: c.id,
        resource: 'account',
        mode: 'push',
        externalId: 'we_old',
        secretId,
        events: ['payment_intent.succeeded'],
      } as never,
    })
    fake.endpoints['acct_1Live:live'] = [
      {
        id: 'we_old',
        url: 'https://api.brigade.test/events/stripe/old',
        enabled_events: ['payment_intent.succeeded'],
        status: 'enabled',
      },
    ]

    // Still on its key: its triggers cannot change until its owner signs in.
    await trigger(c.id, 'payment_failed')
    await assert.rejects(sync(c.id), /reconnect this account/)

    // Signed in (the callback put the sign-in in its vault secret): the old endpoint is found on
    // the account that has it and kept, with its secret, as that account's endpoint.
    await replaceSecret(sdb, scope, c.vaultSecretId!, signedIn())
    fake.accounts.push({ stripe_context: 'acct_1Other', livemode: true, name: 'Other' })
    await sync(c.id)
    const [kept, added] = await subscriptions(c.id)
    assert.deepEqual(
      [kept!.resource, kept!.externalId, kept!.secretId],
      ['acct_1Live:live', 'we_old', secretId],
    )
    assert.equal(added!.resource, 'acct_1Other:live')
    assert.equal(added!.externalId, fake.endpoints['acct_1Other:live']![0]!.id)
    assert.equal(fake.endpoints['acct_1Live:live']!.length, 1)
    assert.deepEqual(fake.endpoints['acct_1Live:live']![0]!.enabled_events, [
      'payment_intent.payment_failed',
      'payment_intent.succeeded',
    ])
  },
)

test(
  'an account connected with a key and removed before its owner signed in: its key deletes the endpoint',
  { skip },
  async () => {
    const { scoped } = await import('../src/db.js')
    const sdb = scoped(scope)
    const c = await connection({ apiKey: 'rk_live_old' })
    await sdb.subscription.create({
      data: {
        connectionId: c.id,
        resource: 'account',
        mode: 'push',
        externalId: 'we_gone',
        events: ['payment_intent.succeeded'],
      } as never,
    })
    await sync(c.id, { removing: true })
    assert.deepEqual(fake.deletedWithKey, ['we_gone'])
    assert.equal((await subscriptions(c.id)).length, 0)
  },
)

const post = async (path: string, body: string, headers: Record<string, string> = {}) => {
  const { events } = await import('../src/routes/events.js')
  return events.request(path, { method: 'POST', body, headers })
}

test(
  'an event posted to an endpoint with no secret counts only as Stripe has it',
  { skip },
  async () => {
    const c = await connection()
    await trigger(c.id, 'payment_received')
    await sync(c.id)
    const [sub] = await subscriptions(c.id)
    const stripeEvent = {
      id: 'evt_1Real',
      object: 'event',
      type: 'payment_intent.succeeded',
      livemode: true,
      data: { object: { id: 'pi_1', object: 'payment_intent', amount: 4900, currency: 'eur' } },
    }
    fake.events['acct_1Live:live'] = [stripeEvent]

    // Not an event, or one Stripe does not have: nothing starts.
    assert.equal((await post(`/stripe/${sub!.id}`, 'nope')).status, 400)
    assert.equal(
      (await post(`/stripe/${sub!.id}`, JSON.stringify({ id: 'evt_1Fake' }))).status,
      401,
    )
    assert.equal(
      await db.ticket.count({ where: { workspaceId: scope.workspaceId } }),
      0,
      'no thread was tried',
    )

    // A real event's id with a made-up type: what Stripe has counts. Its type matches the
    // trigger, which tries to start a thread (this workspace has no computer: a ticket, and
    // Stripe is asked to send it again later).
    const response = await post(
      `/stripe/${sub!.id}`,
      JSON.stringify({ id: 'evt_1Real', type: 'customer.created', data: { object: {} } }),
    )
    assert.equal(response.status, 503)
    const ticket = await db.ticket.findFirstOrThrow({ where: { workspaceId: scope.workspaceId } })
    assert.match(ticket.title, /could not start a thread: the workspace has no computer/)
    // Read again from the account the endpoint belongs to.
    assert.deepEqual(fake.calls.at(-1), {
      tool: 'stripe_api_read',
      operation: 'GetEventsId',
      key: 'acct_1Live:live',
      parameters: { id: 'evt_1Real' },
    })
  },
)

test(
  'an endpoint with a signing secret checks the signature and reads nothing',
  { skip },
  async () => {
    const { scoped } = await import('../src/db.js')
    const { sealSecret } = await import('../src/vault.js')
    const sdb = scoped(scope)
    const c = await connection()
    const sub = await sdb.subscription.create({
      data: {
        connectionId: c.id,
        resource: 'acct_1Live:live',
        mode: 'push',
        externalId: 'we_signed',
        secretId: await sealSecret(sdb, scope, { secret: 'whsec_test' }),
        events: ['customer.subscription.created'],
      } as never,
    })
    const body = JSON.stringify({ id: 'evt_1Signed', type: 'customer.created' })
    const t = Math.floor(Date.now() / 1000)
    const signature = createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex')
    assert.equal(
      (await post(`/stripe/${sub.id}`, body, { 'stripe-signature': `t=${t},v1=bad` })).status,
      401,
    )
    const ok = await post(`/stripe/${sub.id}`, body, {
      'stripe-signature': `t=${t},v1=${signature}`,
    })
    assert.equal(ok.status, 200)
    assert.equal(fake.calls.length, 0)
  },
)

test(
  "an account connected with a key is taken over by its owner's sign-in to the same account and mode",
  { skip },
  async () => {
    const { scoped } = await import('../src/db.js')
    const { adoptStripeKey } = await import('../src/routes/connections.js')
    const sdb = scoped(scope)
    const owner = { ...scope, userId: ids.user, memberId: member, role: 'owner' as const }
    const signedIn = (url: string, init?: RequestInit) => fetch(url, init)
    await sdb.connection.updateMany({ where: { kind: 'stripe' }, data: { status: 'removed' } })
    // Its name then came from the account's settings: not the one Stripe's server gives.
    const legacy = await connection({ apiKey: 'rk_live_old' })
    await sdb.connection.updateMany({
      where: { id: legacy.id },
      data: { externalAccount: 'Acme Inc (acct_1Live, live mode)', status: 'needs_reauth' },
    })

    // The same account in test mode is another one.
    fake.accounts = [{ stripe_context: 'acct_1Live', livemode: false, name: 'Acme' }]
    await adoptStripeKey(sdb, owner, signedIn, 'Acme (acct_1Live, test mode)')
    const kept = await sdb.connection.findFirstOrThrow({ where: { id: legacy.id } })
    assert.equal(kept.externalAccount, 'Acme Inc (acct_1Live, live mode)')

    fake.accounts = [
      { stripe_context: 'acct_1Live', livemode: true, name: 'Acme' },
      { stripe_context: 'acct_1Live', livemode: false, name: 'Acme' },
    ]
    await adoptStripeKey(sdb, owner, signedIn, 'Acme (live mode) +1')
    const taken = await sdb.connection.findFirstOrThrow({ where: { id: legacy.id } })
    assert.equal(taken.externalAccount, 'Acme (live mode) +1')
  },
)
