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
const { mcpAppKey, toolPrefix } = await import('../src/mcp-servers.js')

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
  assert.equal(nameFromHost('127.0.0.1'), '127.0.0.1')
})

test("tool prefixes stay apart from other Apps' and the built-in kinds", () => {
  assert.equal(toolPrefix("Nevo's Brain", []), 'nevo_s_brain')
  assert.equal(toolPrefix('Notes', ['notes']), 'notes_2')
  assert.equal(toolPrefix('Notes', ['notes', 'notes_2']), 'notes_3')
  assert.equal(toolPrefix('Cloudflare', []), 'cloudflare_2')
  assert.equal(toolPrefix('!!!', []), 'mcp')
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

test('a page that is not an MCP server is not taken for one', async () => {
  const origin = await serve((_req, res) => {
    res.writeHead(404, { 'content-type': 'text/html' })
    res.end('<h1>Not found</h1>')
  })
  await assert.rejects(inspectMcp(`${origin}/`), /does not answer as an MCP server/)
})
