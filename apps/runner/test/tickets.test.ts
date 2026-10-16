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
