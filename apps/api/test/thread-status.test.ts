// A thread's status follows from its events (statusAfter). No database: nothing is looked up.
import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.DATABASE_URL ??= 'postgresql://test@127.0.0.1:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { statusAfter } = await import('../src/hub/thread-events.js')

const at = new Date().toISOString()

test('a message its teammate reads only once a person answers leaves the thread waiting', () => {
  const message = { at, type: 'message.user', text: 'Handed back', memberId: 'm1' } as const
  assert.equal(statusAfter('idle', message), 'running')
  assert.equal(statusAfter('idle', { ...message, waiting: true }), 'waiting')
})
