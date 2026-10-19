import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, test } from 'node:test'

// The MCP client reads the API's config: enough of it for a local Brigade.
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'x'.repeat(32)
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { idTokenEmail, inspectMcp, listMcpTools, callMcpTool, nameFromHost, privateAddress } =
  await import('../src/connectors/mcp.js')
const { inRegion, mcpAppKey, serverOf, toolPrefix } = await import('../src/mcp-servers.js')
const { mcpToolName } = await import('../src/connectors/index.js')
const { notionAccountName } = await import('../src/connectors/notion.js')
const { linearAccountName } = await import('../src/connectors/linear.js')
const { mixpanel, mixpanelAccountName } = await import('../src/connectors/mixpanel.js')
const { resendAccountName } = await import('../src/connectors/resend.js')
const { replicateAccountName } = await import('../src/connectors/replicate.js')
const { openrouterAccountName } = await import('../src/connectors/openrouter.js')
const { posthog } = await import('../src/connectors/posthog.js')
const { mcpOutput } = await import('../src/connectors/mcp-output.js')

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void
const servers: ReturnType<typeof createServer>[] = []
after(() => servers.forEach((s) => s.close()))

/** A local HTTP server for one test; returns its origin. */
async function serve(handler: Handler) {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => handler(req, res, body))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const json = (res: ServerResponse, status: number, value: unknown, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(value))
}

const TOOLS = [
  { name: 'search', description: 'Search the notes', annotations: { readOnlyHint: true } },
  { name: 'save', description: 'Save a note' },
]

/** Answers a JSON-RPC request as a small MCP server would. */
function answer(message: { id?: number; method: string; params?: { name?: string } }) {
  if (message.method === 'initialize')
    return {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'notes', title: 'Team Notes' },
      instructions: 'Notes the team keeps.\nMore.',
    }
  if (message.method === 'tools/list') return { tools: TOOLS }
  if (message.method === 'tools/call')
    return { content: [{ type: 'text', text: `called ${message.params?.name}` }] }
  return {}
}

test('local, private and link-local addresses are not public', () => {
  for (const host of [
    'localhost',
    'api.localhost',
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '[::1]',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    'metadata.google.internal',
  ])
    assert.equal(privateAddress(host), true, host)
  for (const host of ['mcp.nevo.md', '8.8.8.8', '172.32.0.1', '2606:4700::1111'])
    assert.equal(privateAddress(host), false, host)
})

test('a server gets a readable name from its host', () => {
  assert.equal(nameFromHost('mcp.nevo.md'), 'Nevo')
  assert.equal(nameFromHost('mcp.cloudflare.com'), 'Cloudflare')
  assert.equal(nameFromHost('api.acme-tools.com'), 'Acme Tools')
  assert.equal(nameFromHost('localhost'), 'Localhost')
  assert.equal(nameFromHost('bigquery.googleapis.com'), 'Google Bigquery')
  assert.equal(nameFromHost('127.0.0.1'), '127.0.0.1')
})

test("tool prefixes stay apart from other Apps' and the built-in kinds", () => {
  assert.equal(toolPrefix("Nevo's Brain", []), 'nevo_s_brain')
  assert.equal(toolPrefix('Notes', ['notes']), 'notes_2')
  assert.equal(toolPrefix('Notes', ['notes', 'notes_2']), 'notes_3')
  assert.equal(toolPrefix('Cloudflare', []), 'cloudflare_2')
  assert.equal(toolPrefix('!!!', []), 'mcp')
})

test('a tool already named for its server keeps one prefix', () => {
  assert.equal(mcpToolName('notion', 'notion-search'), 'notion_search')
  assert.equal(mcpToolName('notion', 'search'), 'notion_search')
  assert.equal(mcpToolName('cloudflare', 'execute'), 'cloudflare_execute')
})

test('a Notion account shows as its workspace, else its email', () => {
  const user = { type: 'person', name: 'Ada', email: 'ada@acme.com' }
  assert.equal(notionAccountName({ workspace: { name: 'Acme' }, user }), 'Acme')
  assert.equal(notionAccountName({ workspace: {}, user }), 'ada@acme.com')
  assert.equal(notionAccountName({}), null)
})

test("a Linear account shows as its workspace's name", () => {
  const workspace = { id: 'w1', name: 'Unicorn Factory', url: 'https://linear.app/unicorn' }
  assert.equal(linearAccountName(workspace), 'Unicorn Factory')
  assert.equal(linearAccountName({}), null)
})

test('a Mixpanel account shows as its organizations', () => {
  // List-Organizations' reply, as a real account gave it.
  const one = { result: [{ id: 2509503, name: 'Chaindesk', role: 'owner' }] }
  assert.equal(mixpanelAccountName(one), 'Chaindesk')
  const two = {
    result: [
      { id: 1, name: 'Acme' },
      { id: 2, name: 'Beta' },
    ],
  }
  assert.equal(mixpanelAccountName(two), 'Acme +1')
  assert.equal(mixpanelAccountName({ result: [] }), null)
  assert.equal(mixpanelAccountName({}), null)
})

test('a Resend account shows as its domains', () => {
  // list-domains' reply: a text block per domain after a count, as Resend's server sends it.
  const domain = (name: string) => ({
    type: 'text',
    text: `Name: ${name}\nID: 4dd369bc-aa82-4ff3-97de-514ae3000ee0\nStatus: verified\nRegion: us-east-1\nSending: enabled\nReceiving: disabled\nOpen Tracking: false\nClick Tracking: false\nCreated at: 2026-01-12 10:00:00.000000+00`,
  })
  const one = mcpOutput({
    content: [{ type: 'text', text: 'Found 1 domain:' }, domain('lovarank.com')],
  })
  assert.equal(resendAccountName(one.output), 'lovarank.com')
  const two = mcpOutput({
    content: [
      { type: 'text', text: 'Found 2 domains:' },
      domain('acme.com'),
      domain('mail.acme.com'),
    ],
  })
  assert.equal(resendAccountName(two.output), 'acme.com +1')
  const none = mcpOutput({ content: [{ type: 'text', text: 'No domains found.' }] })
  assert.equal(resendAccountName(none.output), null)
  assert.equal(resendAccountName({}), null)
})

test('a Replicate account shows as its username', () => {
  // get_account's reply: Replicate's GET /v1/account as JSON text, which mcpOutput parses.
  const user = mcpOutput({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          type: 'user',
          username: 'zeke',
          name: 'Zeke Sikelianos',
          avatar_url: 'https://github.com/zeke.png',
          github_url: 'https://github.com/zeke',
        }),
      },
    ],
  })
  assert.equal(replicateAccountName(user.output), 'zeke')
  const org = mcpOutput({
    content: [
      { type: 'text', text: '{"type":"organization","username":"acme","name":"Acme Corp, Inc."}' },
    ],
  })
  assert.equal(replicateAccountName(org.output), 'acme')
  assert.equal(replicateAccountName({}), null)
  assert.equal(replicateAccountName(null), null)
})

test('an OpenRouter account shows as personal or an organization’s', () => {
  // GET /api/v1/key with the key OpenRouter's MCP sign-in gave (ids changed).
  const personal = {
    data: {
      label: 'sk-or-v1-123...abc',
      is_management_key: false,
      is_provisioning_key: false,
      limit: 10,
      limit_remaining: 10,
      usage: 0,
      is_free_tier: true,
      expires_at: '2026-10-26T16:07:25.290Z',
      creator_user_id: 'user_2abcdefghijklmnopqrstuvwxyz',
      organization_id: null,
      workspace_id: 'effe5c63-0000-0000-0000-85747179a8a1',
      allowed_data_regions: ['global'],
    },
  }
  assert.equal(openrouterAccountName(personal), 'Personal account')
  const organization = { data: { ...personal.data, organization_id: 'org_2abcdefghijklmnop' } }
  assert.equal(openrouterAccountName(organization), 'Organization account')
  assert.equal(openrouterAccountName({ error: { message: 'Invalid API key', code: 401 } }), null)
  assert.equal(openrouterAccountName(null), null)
})

test('PostHog: each tool on its own, in the chosen areas, an account as its organizations', () => {
  const server = posthog.mcp!
  // Without mode=tools PostHog gives an unknown client one exec tool, all reads and writes.
  const url = new URL(server.url)
  assert.equal(url.searchParams.get('mode'), 'tools')
  assert.ok(url.searchParams.get('features')!.split(',').includes('flags'))
  assert.equal(server.tools['execute-sql']?.write, false)
  assert.equal(server.tools['create-feature-flag']?.write, true)
  assert.equal(server.tools['switch-project']?.write, false)
  // organizations-get answers [{ id, name, slug, membership_level }] (PostHog's MCP source).
  const name = server.account!.name
  const org = { id: '0190-aaaa', name: 'Acme', slug: 'acme', membership_level: 15 }
  assert.equal(name([org]), 'Acme')
  assert.equal(name([org, { ...org, name: 'Beta' }]), 'Acme +1')
  assert.equal(name([]), null)
})

test("a Mixpanel account keeps its region's server", async () => {
  const server = mixpanel.mcp!
  assert.equal(inRegion(server, { id: 'eu' }).url, 'https://mcp-eu.mixpanel.com/mcp')
  assert.equal(inRegion(server, {}).url, 'https://mcp.mixpanel.com/mcp')
  assert.throws(() => inRegion(server, { id: 'mars' }))
  // An account's server, as its tools are called: the URL it kept, never one it did not.
  const db = {} as never
  const eu = await serverOf(db, {
    kind: 'mixpanel',
    appId: 'a',
    mcpUrl: 'https://mcp-eu.mixpanel.com/mcp',
  })
  assert.equal(eu?.server.url, 'https://mcp-eu.mixpanel.com/mcp')
  const odd = await serverOf(db, {
    kind: 'mixpanel',
    appId: 'a',
    mcpUrl: 'https://evil.example/mcp',
  })
  assert.equal(odd?.server.url, 'https://mcp.mixpanel.com/mcp')
  // An App with one server ignores regions altogether.
  assert.equal(
    inRegion({ url: 'https://mcp.linear.app/mcp', tools: {} }, { id: 'eu' }).url,
    'https://mcp.linear.app/mcp',
  )
})

test('one App per server, however its URL was typed', () => {
  assert.equal(mcpAppKey('https://mcp.nevo.md/mcp'), mcpAppKey(' https://mcp.nevo.md/mcp/ '))
  assert.equal(mcpAppKey('https://mcp.nevo.md/mcp'), mcpAppKey('https://MCP.nevo.md/mcp#x'))
  assert.notEqual(mcpAppKey('https://mcp.nevo.md/mcp'), mcpAppKey('https://mcp.nevo.md/sse'))
})

test("an ID token's email names the account", () => {
  const token = (claims: object) =>
    `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`
  assert.equal(idTokenEmail(token({ email: 'ada@example.com' })), 'ada@example.com')
  assert.equal(idTokenEmail(token({ sub: '1' })), null)
  assert.equal(idTokenEmail('not a token'), null)
  assert.equal(idTokenEmail(undefined), null)
})

test('a server that needs no sign-in: its name, description and tools', async () => {
  const origin = await serve((req, res, body) => {
    if (req.method !== 'POST') return json(res, 405, {})
    const message = JSON.parse(body)
    if (message.id === undefined) return json(res, 202, {})
    json(res, 200, { jsonrpc: '2.0', id: message.id, result: answer(message) })
  })
  const found = await inspectMcp(`${origin}/mcp`)
  assert.equal(found.signIn, 'none')
  assert.equal(found.transport, 'streamable')
  assert.equal(found.name, 'Team Notes')
  assert.equal(found.description, 'Notes the team keeps.')
  assert.deepEqual(
    found.tools?.map((t) => [t.name, t.write]),
    [
      ['search', false],
      ['save', true],
    ],
  )
})

test("a server with OAuth that registers clients: the provider's sign-in", async () => {
  const origin = await serve((req, res) => {
    const base = `http://${req.headers.host}`
    if (req.url === '/.well-known/oauth-protected-resource/mcp')
      return json(res, 200, {
        resource: `${base}/mcp`,
        resource_name: "Nevo's Brain",
        authorization_servers: [`${base}/auth`],
      })
    if (req.url === '/.well-known/oauth-authorization-server/auth')
      return json(res, 200, {
        issuer: `${base}/auth`,
        authorization_endpoint: `${base}/auth/authorize`,
        token_endpoint: `${base}/auth/token`,
        registration_endpoint: `${base}/auth/register`,
      })
    json(
      res,
      401,
      { error: 'unauthorized' },
      {
        'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
      },
    )
  })
  const found = await inspectMcp(`${origin}/mcp`)
  assert.equal(found.signIn, 'oauth')
  assert.equal(found.name, "Nevo's Brain")
  assert.equal(found.tools, null)
})

test('a server with OAuth that registers no clients: the member gives one', async () => {
  const origin = await serve((req, res) => {
    const base = `http://${req.headers.host}`
    if (req.url === '/.well-known/oauth-protected-resource')
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] })
    if (req.url === '/.well-known/oauth-authorization-server')
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
      })
    if (req.url?.startsWith('/.well-known')) return json(res, 404, {})
    json(res, 401, {}, { 'www-authenticate': 'Bearer' })
  })
  assert.equal((await inspectMcp(`${origin}/mcp`)).signIn, 'oauth_client')
})

test('a server that lists its tools to anyone but signs in to call them: OAuth', async () => {
  // As Google's: initialize and tools/list answer, tools/call wants a token.
  const origin = await serve((req, res, body) => {
    const base = `http://${req.headers.host}`
    if (req.url === '/.well-known/oauth-protected-resource/mcp')
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] })
    if (req.url === '/.well-known/oauth-authorization-server')
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
      })
    if (req.method !== 'POST') return json(res, 404, {})
    const message = JSON.parse(body)
    if (message.id === undefined) return json(res, 202, {})
    json(res, 200, { jsonrpc: '2.0', id: message.id, result: answer(message) })
  })
  const found = await inspectMcp(`${origin}/mcp`)
  assert.equal(found.signIn, 'oauth_client')
  assert.deepEqual(
    found.tools?.map((t) => t.name),
    ['search', 'save'],
  )
})

test('a server that refuses without OAuth metadata: a key', async () => {
  const origin = await serve((req, res) => {
    if (req.url?.startsWith('/.well-known')) return json(res, 404, {})
    json(res, 401, { error: 'missing api key' })
  })
  assert.equal((await inspectMcp(`${origin}/mcp`)).signIn, 'api_key')
})

test('the older HTTP+SSE transport: found, listed and called', async () => {
  let stream: ServerResponse | undefined
  const origin = await serve((req, res, body) => {
    if (req.method === 'GET' && req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: endpoint\ndata: /messages?session=1\n\n')
      stream = res
      return
    }
    if (req.method === 'POST' && req.url === '/messages?session=1') {
      const message = JSON.parse(body)
      res.writeHead(202).end()
      if (message.id !== undefined)
        stream?.write(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: answer(message) })}\n\n`,
        )
      return
    }
    json(res, 405, {})
  })
  const found = await inspectMcp(`${origin}/sse`)
  assert.equal(found.transport, 'sse')
  assert.equal(found.signIn, 'none')
  assert.equal(found.tools?.length, 2)
  const server = { url: `${origin}/sse`, transport: 'sse' as const }
  const plain = (url: string, init?: RequestInit) => fetch(url, init)
  assert.deepEqual(
    (await listMcpTools(plain, server)).map((t) => t.name),
    ['search', 'save'],
  )
  assert.equal(await callMcpTool(plain, server, 'save', { text: 'hi' }), 'called save')
})

test('an answer sent with an error status still counts', async () => {
  // As Google's: tools/list comes back as a 403 whose body is the JSON-RPC answer.
  const origin = await serve((_req, res, body) => {
    const message = JSON.parse(body)
    if (message.id === undefined) return json(res, 202, {})
    json(
      res,
      message.method === 'initialize' ? 200 : 403,
      { jsonrpc: '2.0', id: message.id, result: answer(message) },
      { 'www-authenticate': 'Bearer error="insufficient_scope"' },
    )
  })
  const server = { url: `${origin}/mcp`, transport: 'streamable' as const }
  const plain = (url: string, init?: RequestInit) => fetch(url, init)
  assert.deepEqual(
    (await listMcpTools(plain, server)).map((t) => t.name),
    ['search', 'save'],
  )
})

test('a refusal with no answer says why', async () => {
  const origin = await serve((_req, res) =>
    json(
      res,
      403,
      { error: 'denied' },
      { 'www-authenticate': 'Bearer error="insufficient_scope"' },
    ),
  )
  const plain = (url: string, init?: RequestInit) => fetch(url, init)
  await assert.rejects(
    listMcpTools(plain, { url: `${origin}/mcp`, transport: 'streamable' }),
    /403 \(error="insufficient_scope"\)/,
  )
})

test('a page that is not an MCP server is not taken for one', async () => {
  const origin = await serve((_req, res) => {
    res.writeHead(404, { 'content-type': 'text/html' })
    res.end('<h1>Not found</h1>')
  })
  await assert.rejects(inspectMcp(`${origin}/`), /does not answer as an MCP server/)
})
