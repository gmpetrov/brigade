import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ticketAsks, ticketResult } from '../src/harness/events.js'

test('an App access ask keeps its App and access, and is named after it', () => {
  const ticket = ticketAsks({
    title: 'Cloudflare',
    asks: [{ type: 'access', kind: 'connection', app: { kind: 'cloudflare', scope: 'read' } }],
  })
  assert.deepEqual(ticket?.asks[0], {
    id: 'a1',
    type: 'access',
    kind: 'connection',
    what: 'cloudflare',
    app: { kind: 'cloudflare', scope: 'read' },
  })
})

test('an MCP server named by its id goes by it, with an url no server has for older APIs', () => {
  const ticket = ticketAsks({
    title: 'Team Notes',
    asks: [
      {
        type: 'access',
        kind: 'connection',
        what: 'Team Notes',
        app: { kind: 'mcp', scope: 'read', server: 'app-1', account: 'notes-production' },
      },
    ],
  })
  assert.deepEqual(ticket?.asks[0], {
    id: 'a1',
    type: 'access',
    kind: 'connection',
    what: 'Team Notes',
    app: {
      kind: 'mcp',
      scope: 'read',
      server: 'app-1',
      account: 'notes-production',
      // An API that drops app.server finds no server by it, rather than the first "Team Notes".
      url: 'https://brigade.invalid/mcp-servers/app-1',
    },
  })
  // Only an MCP server goes by one.
  assert.equal(
    ticketAsks({
      title: 'Notion',
      asks: [
        { type: 'access', kind: 'connection', app: { kind: 'notion', scope: 'read', server: 'x' } },
      ],
    }),
    undefined,
  )
  // Without one, its url stays as given.
  assert.equal(
    (
      ticketAsks({
        title: 'Sentry',
        asks: [
          {
            type: 'access',
            kind: 'connection',
            app: { kind: 'mcp', scope: 'read', url: 'https://mcp.sentry.dev/mcp' },
          },
        ],
      })!.asks[0] as { app: { url: string } }
    ).app.url,
    'https://mcp.sentry.dev/mcp',
  )
})

test('a granted App tells the teammate its tools are there', () => {
  const asks = ticketAsks({
    title: 't',
    asks: [
      {
        type: 'access',
        kind: 'connection',
        what: 'Cloudflare',
        app: { kind: 'cloudflare', scope: 'read' },
      },
    ],
  })!.asks
  const granted = ticketResult(asks, {
    action: 'answered',
    replies: { a1: { type: 'access', granted: true, connectionId: 'c1' } },
  }) as unknown as { answers: { granted: boolean; note?: string }[] }
  const text = JSON.stringify(granted)
  assert.match(text, /cloudflare_/)
  assert.match(text, /read access to Cloudflare/)
  const declined = JSON.stringify(
    ticketResult(asks, { action: 'answered', replies: { a1: { type: 'access', granted: false } } }),
  )
  assert.doesNotMatch(declined, /cloudflare_/)
})

test('a permission the account lacks stays on the ask, and the teammate tries again once given', () => {
  const asks = ticketAsks({
    title: 'Cloudflare token',
    asks: [
      {
        type: 'access',
        kind: 'connection',
        what: 'Cloudflare',
        app: { kind: 'cloudflare', scope: 'read_write', permission: 'Account API Tokens: Write' },
      },
    ],
  })!.asks
  assert.equal(
    (asks[0] as { app?: { permission?: string } }).app?.permission,
    'Account API Tokens: Write',
  )
  const text = JSON.stringify(
    ticketResult(asks, {
      action: 'answered',
      replies: { a1: { type: 'access', granted: true, connectionId: 'c1' } },
    }),
  )
  assert.match(text, /allow Account API Tokens: Write: try the refused call again/)
})

test('something else in place of a ticket reaches the teammate as what to do instead', () => {
  const asks = ticketAsks({
    title: 'R2 key',
    asks: [{ type: 'access', kind: 'credential', what: 'R2 key' }],
  })!.asks
  const result = ticketResult(asks, {
    action: 'declined',
    note: 'Use the Cloudflare App instead',
  }) as { declined: boolean; instead?: string; note: string }
  assert.equal(result.declined, true)
  assert.equal(result.instead, 'Use the Cloudflare App instead')
  assert.match(result.note, /do what they say/)
  assert.equal(
    (ticketResult(asks, { action: 'declined' }) as { instead?: string }).instead,
    undefined,
  )
})
