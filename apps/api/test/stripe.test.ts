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

const { stripe, stripeAccountName, stripeAccountOf, stripeAccounts } =
  await import('../src/connectors/stripe.js')
const { rateLimit } = await import('../src/routes/events.js')

test('a Stripe sign-in shows as its one account and mode, which its row stands for', () => {
  // list_available_accounts_or_orgs' structuredContent, as Stripe answers an OAuth sign-in.
  const one = { accounts: [{ stripe_context: 'acct_1Abc', livemode: true, name: 'Acme' }] }
  assert.equal(stripeAccountName(one), 'Acme (acct_1Abc, live mode)')
  assert.deepEqual(stripeAccountOf('Acme (acct_1Abc, live mode)'), {
    stripe_context: 'acct_1Abc',
    livemode: true,
  })
  // A sign-in to several accounts stands for none of them.
  const two = {
    accounts: [
      { stripe_context: 'acct_1Abc', livemode: false, name: 'Acme sandbox' },
      { stripe_context: 'acct_1Def', livemode: true, name: 'Acme' },
    ],
  }
  assert.equal(stripeAccountName(two), null)
  assert.equal(stripeAccountOf('Acme sandbox (test mode) +1'), null)
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
  /** How many times the server lists the sign-in's accounts before it fails to. */
  lists?: number
}
let fake: Fake
const AUTH = 'https://access.stripe.test'
const account = { stripe_context: { type: 'string' }, livemode: { type: 'boolean' } }
/** Some of the tools the server lists to an OAuth sign-in, as it describes them. */
const TOOLS = [
  {
    name: 'stripe_api_write',
    inputSchema: {
      type: 'object',
      properties: { stripe_api_operation_id: { type: 'string' }, parameters: {}, ...account },
      required: ['stripe_api_operation_id', 'stripe_context', 'livemode'],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'stripe_api_read',
    inputSchema: {
      type: 'object',
      properties: { stripe_api_operation_id: { type: 'string' }, parameters: {}, ...account },
      required: ['stripe_api_operation_id', 'stripe_context', 'livemode'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'search_stripe_documentation',
    inputSchema: { type: 'object', properties: { question: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  { name: 'list_available_accounts_or_orgs', inputSchema: { type: 'object' } },
  { name: 'manage_stripe_accounts', inputSchema: { type: 'object' } },
]
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
  if (name === 'list_available_accounts_or_orgs') {
    if (fake.lists !== undefined && fake.lists-- <= 0) return stripeError('Service unavailable')
    return result({ accounts: fake.accounts })
  }
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
    case 'PostRefunds':
      return result({ id: 're_1', object: 'refund', livemode: args.livemode })
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
    // Stripe's sign-in, as Brigade's OAuth callback asks it: its metadata, then the token.
    if (url.href.includes('/.well-known/oauth-protected-resource'))
      return json({ resource: 'https://mcp.stripe.com', authorization_servers: [AUTH] })
    if (url.origin === AUTH && url.pathname.includes('.well-known'))
      return json({
        issuer: AUTH,
        authorization_endpoint: `${AUTH}/authorize`,
        token_endpoint: `${AUTH}/token`,
        client_id_metadata_document_supported: true,
      })
    if (url.origin === AUTH && url.pathname === '/token')
      return json({
        access_token: `oauth-${new URLSearchParams(String(init.body)).get('code')}`,
        refresh_token: 'refresh',
        expires_in: 3600,
      })
    if (url.origin !== 'https://mcp.stripe.com') throw new Error(`unexpected request ${url}`)
    const headers = init.headers as Record<string, string>
    fake.tokens.push(headers.authorization ?? '')
    const message = JSON.parse(String(init.body)) as {
      id?: number
      method: string
      params?: { name: string; arguments: Record<string, unknown> }
    }
    if (message.method === 'ping') return new Response(null, { status: 401 })
    if (message.method === 'tools/list')
      return json({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } })
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
const post = async (path: string, body: string, headers: Record<string, string> = {}) => {
  const { events } = await import('../src/routes/events.js')
  return events.request(path, { method: 'POST', body, headers })
}

const subscriptions = (connectionId: string) =>
  db.subscription.findMany({ where: { connectionId }, orderBy: { resource: 'asc' } })

test(
  "a trigger registers one endpoint, on the row's own Stripe account and mode, through Stripe's server",
  { skip },
  async () => {
    // The sign-in also reaches the test mode: its row is the live account alone.
    fake.accounts.push({ stripe_context: 'acct_1Live', livemode: false, name: 'Acme' })
    const c = await connection()
    await trigger(c.id, 'payment_received')
    await sync(c.id)

    const subs = await subscriptions(c.id)
    assert.deepEqual(
      subs.map((s) => [s.resource, s.events, s.secretId]),
      [['acct_1Live:live', ['payment_intent.succeeded'], null]],
    )
    const [endpoint] = fake.endpoints['acct_1Live:live']!
    assert.equal(endpoint!.id, subs[0]!.externalId)
    assert.equal(endpoint!.url, `https://api.brigade.test/events/stripe/${subs[0]!.id}`)
    assert.equal(fake.endpoints['acct_1Live:test'], undefined)
    // Every request carries the account's sign-in.
    assert.ok(fake.tokens.every((t) => t === 'Bearer oak_token'))

    // Another trigger: the same endpoint, listing both events.
    await trigger(c.id, 'payment_failed')
    fake.calls = []
    await sync(c.id)
    assert.deepEqual(
      fake.calls.map((call) => [call.operation, call.key]),
      [['PostWebhookEndpointsWebhookEndpoint', 'acct_1Live:live']],
    )
    assert.deepEqual(fake.endpoints['acct_1Live:live']![0]!.enabled_events, [
      'payment_intent.payment_failed',
      'payment_intent.succeeded',
    ])

    // No trigger left: the server deletes no endpoint, so it is turned off and kept.
    await db.trigger.deleteMany({ where: { connectionId: c.id } })
    await sync(c.id)
    assert.equal(fake.endpoints['acct_1Live:live']![0]!.status, 'disabled')
    assert.deepEqual(
      (await subscriptions(c.id)).map((s) => s.events),
      [[]],
    )

    // A trigger again: the same endpoint, on again.
    await trigger(c.id, 'refund_issued')
    await sync(c.id)
    assert.equal(fake.endpoints['acct_1Live:live']!.length, 1)
    assert.equal(fake.endpoints['acct_1Live:live']![0]!.status, 'enabled')
  },
)

test(
  "an endpoint on another account than the row's is turned off, and its events start nothing",
  { skip },
  async () => {
    const { scoped } = await import('../src/db.js')
    const sdb = scoped(scope)
    const c = await connection()
    await trigger(c.id, 'payment_received')
    // Left from when one sign-in stood for several accounts.
    fake.endpoints['acct_1Live:test'] = [
      { id: 'we_other', url: 'x', enabled_events: ['payment_intent.succeeded'], status: 'enabled' },
    ]
    const other = await sdb.subscription.create({
      data: {
        connectionId: c.id,
        resource: 'acct_1Live:test',
        mode: 'push',
        externalId: 'we_other',
        events: ['payment_intent.succeeded'],
      } as never,
    })
    fake.events['acct_1Live:test'] = [
      { id: 'evt_1Other', object: 'event', type: 'payment_intent.succeeded', data: { object: {} } },
    ]
    const response = await post(`/stripe/${other.id}`, JSON.stringify({ id: 'evt_1Other' }))
    assert.equal(response.status, 200)
    assert.equal(fake.calls.length, 0, 'not even read')

    await sync(c.id)
    assert.equal(fake.endpoints['acct_1Live:test']![0]!.status, 'disabled')
    assert.deepEqual(
      (await subscriptions(c.id)).map((s) => s.resource),
      ['acct_1Live:live'],
    )
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
    // the row's account and kept, with its secret, as that account's endpoint.
    await replaceSecret(sdb, scope, c.vaultSecretId!, signedIn())
    await sync(c.id)
    const subs = await subscriptions(c.id)
    assert.deepEqual(
      subs.map((s) => [s.resource, s.externalId, s.secretId]),
      [['acct_1Live:live', 'we_old', secretId]],
    )
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

// Brigade's OAuth callback for Stripe, as the provider's redirect reaches it: only the session
// middleware is left out. Returns the account it connected, or the error it sent back.
async function signIn(code: string, reconnect?: string) {
  const { Hono } = await import('hono')
  const { connections } = await import('../src/routes/connections.js')
  const { hashToken } = await import('../src/hub.js')
  const state = randomUUID()
  await db.verification.create({
    data: {
      id: state,
      identifier: `oauth-state:${hashToken(state)}`,
      expiresAt: new Date(Date.now() + 60_000),
      value: JSON.stringify({
        ...scope,
        userId: ids.user,
        memberId: member,
        kind: 'stripe',
        verifier: 'verifier',
        ...(reconnect ? { reconnect } : {}),
      }),
    },
  })
  const callback = connections.routes.find(
    (r) => r.path === '/oauth/mcp/callback' && r.method === 'GET',
  )!.handler
  const app = new Hono()
    .use('*', async (c, next) => {
      c.set('userId' as never, ids.user as never)
      await next()
    })
    .get('/callback', callback)
  const response = await app.request(
    `https://api.brigade.test/callback?state=${state}&code=${code}`,
  )
  assert.equal(response.status, 302)
  const query = new URL(response.headers.get('location')!, 'https://x.test').searchParams
  return { connected: query.get('connected'), error: query.get('error') }
}
const removeAll = () =>
  db.connection.updateMany({
    where: { workspaceId: scope.workspaceId, kind: 'stripe' },
    data: { status: 'removed' },
  })
const keyRow = async (externalAccount: string) => {
  const row = await connection({ apiKey: 'rk_old' })
  await db.connection.update({
    where: { id: row.id },
    data: { externalAccount, status: 'needs_reauth' },
  })
  return row
}

test(
  'a sign-in to several Stripe accounts is refused, and leaves an account connected with a key as it was',
  { skip },
  async () => {
    const { openSecret } = await import('../src/vault.js')
    const { scoped } = await import('../src/db.js')
    await removeAll()
    const old = await keyRow('Sandbox (acct_1Sandbox, test mode)')
    await db.grant.create({
      data: { ...scope, connectionId: old.id, teammateId, scope: 'read_write' } as never,
    })
    fake.accounts = [
      { stripe_context: 'acct_1Sandbox', livemode: false, name: 'Sandbox' },
      { stripe_context: 'acct_1Live', livemode: true, name: 'Production' },
    ]
    assert.deepEqual(await signIn('several'), { connected: null, error: 'stripe_accounts' })
    const row = await db.connection.findFirstOrThrow({ where: { id: old.id } })
    assert.equal(row.status, 'needs_reauth')
    const secret = await openSecret<{ apiKey?: string }>(scoped(scope), scope, row.vaultSecretId!)
    assert.equal(secret.apiKey, 'rk_old')
    assert.equal(
      await db.connection.count({ where: { workspaceId: scope.workspaceId, status: 'active' } }),
      0,
    )
  },
)

test(
  "a sign-in to the key's account and mode alone takes its row over, and its calls reach that account only",
  { skip },
  async () => {
    const { handleConnectorCall } = await import('../src/connector-calls.js')
    const { mcpOperationSpecs } = await import('../src/mcp-tools.js')
    const { scoped } = await import('../src/db.js')
    await removeAll()
    const old = await keyRow('Sandbox Inc (acct_1Sandbox, test mode)')
    await db.grant.create({
      data: { ...scope, connectionId: old.id, teammateId, scope: 'read_write' } as never,
    })
    fake.accounts = [{ stripe_context: 'acct_1Sandbox', livemode: false, name: 'Sandbox' }]
    assert.deepEqual(await signIn('sandbox'), { connected: old.id, error: null })
    const row = await db.connection.findFirstOrThrow({ where: { id: old.id } })
    assert.equal(row.externalAccount, 'Sandbox (acct_1Sandbox, test mode)')
    assert.equal(row.status, 'active')

    // Later the sign-in reaches a live account too (added on Stripe's Dashboard): not through it.
    fake.accounts.push({ stripe_context: 'acct_1Live', livemode: true, name: 'Production' })
    const specs = await mcpOperationSpecs(scoped(scope), scope, row, 'read_write', [])
    assert.deepEqual(
      specs.map((t) => t.name),
      ['stripe_api_write', 'stripe_api_read', 'stripe_search_stripe_documentation'],
    )
    const write = specs[0]!.inputSchema as { properties: object; required: string[] }
    assert.deepEqual(Object.keys(write.properties), ['stripe_api_operation_id', 'parameters'])
    assert.deepEqual(write.required, ['stripe_api_operation_id'])

    const computer = await db.computer.create({
      data: { ...scope, kind: 'member_machine', name: 'Laptop', memberId: member } as never,
    })
    const session = await db.session.create({
      data: {
        ...scope,
        computerId: computer.id,
        teammateId,
        startedByMemberId: member,
        title: 'Refund',
      } as never,
    })
    const call = async (input: Record<string, unknown>, operation = 'stripe_api_write') => {
      const replies: { ok: boolean; output?: unknown; error?: string }[] = []
      await handleConnectorCall(
        { ...scope, computerId: computer.id },
        {
          type: 'connector.call',
          sessionId: session.id,
          connectionId: old.id,
          callId: randomUUID(),
          operation,
          input,
        } as never,
        (r) => replies.push(r as never),
      )
      return replies.at(-1)!
    }
    const refund = { stripe_api_operation_id: 'PostRefunds', parameters: { charge: 'ch_1' } }
    fake.calls = []
    const live = await call({ ...refund, stripe_context: 'acct_1Live', livemode: true })
    assert.equal(live.ok, false)
    assert.match(live.error!, /stripe_context "acct_1Sandbox"/)
    assert.equal(fake.calls.length, 0)
    const sandbox = await call(refund)
    assert.equal(sandbox.ok, true, sandbox.error)
    assert.deepEqual(fake.calls.at(-1)?.key, 'acct_1Sandbox:test')
    assert.equal((await call({}, 'stripe_manage_stripe_accounts')).ok, false)
    await db.session.deleteMany({ where: { id: session.id } })
    await db.computer.deleteMany({ where: { id: computer.id } })
  },
)

test('each Stripe account and mode is a row of its own, whatever its name', { skip }, async () => {
  await removeAll()
  const live = await keyRow('Acme (acct_1Live, live mode)')
  const sandbox = await keyRow('Acme sandbox (acct_1Sandbox, test mode)')
  // Two sign-ins, each to one account: each takes its own row over.
  fake.accounts = [{ stripe_context: 'acct_1Sandbox', livemode: false, name: 'Acme sandbox' }]
  assert.equal((await signIn('one')).connected, sandbox.id)
  fake.accounts = [{ stripe_context: 'acct_1Live', livemode: true, name: 'Acme' }]
  assert.equal((await signIn('two')).connected, live.id)
  // Another account by the same name: a row of its own.
  fake.accounts = [{ stripe_context: 'acct_1Beta', livemode: true, name: 'Acme' }]
  const beta = (await signIn('three')).connected
  assert.ok(beta && beta !== live.id && beta !== sandbox.id)
  // The same account again: the same row (Reconnect), with the new sign-in.
  fake.accounts = [{ stripe_context: 'acct_1Live', livemode: true, name: 'Acme' }]
  assert.equal((await signIn('four')).connected, live.id)
})

/** A row from #302, when one sign-in could stand for several accounts and its label named none. */
const groupedRow = async (externalAccount: string, resources: string[] = []) => {
  const { scoped } = await import('../src/db.js')
  const row = await connection()
  await db.connection.update({
    where: { id: row.id },
    data: { externalAccount, status: 'needs_reauth' },
  })
  for (const resource of resources)
    await scoped(scope).subscription.create({
      data: {
        connectionId: row.id,
        resource,
        mode: 'push',
        externalId: `we_${resource}`,
        events: ['payment_intent.succeeded'],
      } as never,
    })
  return row
}

test(
  'a row that stood for several accounts is taken over by a sign-in to the account it has an endpoint on, or by its Reconnect',
  { skip },
  async () => {
    await removeAll()
    const withEndpoint = await groupedRow('Acme (live mode) +1', [
      'acct_1Live:live',
      'acct_1Live:test',
    ])
    const without = await groupedRow('Beta (live mode) +1')
    await db.grant.create({
      data: { ...scope, connectionId: withEndpoint.id, teammateId, scope: 'read' } as never,
    })

    // Its events keep starting threads until then: they are not dropped as another account's.
    fake.events['acct_1Live:test'] = [
      { id: 'evt_1Kept', object: 'event', type: 'customer.created', data: { object: {} } },
    ]
    const [testSub] = await db.subscription.findMany({
      where: { connectionId: withEndpoint.id, resource: 'acct_1Live:test' },
    })
    assert.equal(
      (await post(`/stripe/${testSub!.id}`, JSON.stringify({ id: 'evt_1Kept' }))).status,
      200,
    )
    assert.equal(fake.calls.at(-1)?.operation, 'GetEventsId', 'read again from Stripe')

    // A sign-in to an account it has an endpoint on: that row, now that one account alone.
    fake.accounts = [{ stripe_context: 'acct_1Live', livemode: false, name: 'Acme' }]
    assert.equal((await signIn('grouped')).connected, withEndpoint.id)
    const taken = await db.connection.findFirstOrThrow({ where: { id: withEndpoint.id } })
    assert.equal(taken.externalAccount, 'Acme (acct_1Live, test mode)')
    assert.equal(await db.grant.count({ where: { connectionId: withEndpoint.id } }), 1)

    // One with no endpoint to tell: a new sign-in is a row of its own, its Reconnect repairs it.
    fake.accounts = [{ stripe_context: 'acct_1Beta', livemode: true, name: 'Beta' }]
    const fresh = (await signIn('fresh')).connected
    assert.ok(fresh && fresh !== without.id)
    await db.connection.update({ where: { id: fresh! }, data: { status: 'removed' } })
    assert.equal((await signIn('reconnect', without.id)).connected, without.id)
    const repaired = await db.connection.findFirstOrThrow({ where: { id: without.id } })
    assert.equal(repaired.externalAccount, 'Beta (acct_1Beta, live mode)')
    assert.equal(repaired.status, 'active')

    // Reconnecting a row that is another account repairs nothing of it.
    fake.accounts = [{ stripe_context: 'acct_1Gamma', livemode: true, name: 'Gamma' }]
    const gamma = (await signIn('gamma', without.id)).connected
    assert.ok(gamma && gamma !== without.id)
    assert.equal(
      (await db.connection.findFirstOrThrow({ where: { id: without.id } })).externalAccount,
      'Beta (acct_1Beta, live mode)',
    )
  },
)

test(
  'a sign-in names its row from the one answer it checked, even if the server fails to answer again',
  { skip },
  async () => {
    await removeAll()
    const old = await keyRow('Acme (acct_1Live, live mode)')
    fake.accounts = [{ stripe_context: 'acct_1Live', livemode: true, name: 'Acme' }]
    fake.lists = 1
    assert.deepEqual(await signIn('once'), { connected: old.id, error: null })
    const row = await db.connection.findFirstOrThrow({ where: { id: old.id } })
    assert.equal(row.externalAccount, 'Acme (acct_1Live, live mode)')
    assert.equal(row.status, 'active')
  },
)
