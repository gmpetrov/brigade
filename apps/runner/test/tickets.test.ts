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
