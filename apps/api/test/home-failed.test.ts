import assert from 'node:assert/strict'
import { test } from 'node:test'

// A failed thread waits on a person (src/failed.ts): since when, and what its error said. Home
// reads the API's config when imported; nothing here reaches a database or the vault.
process.env.DATABASE_URL ??= 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { errorLine, failure } = await import('../src/failed.js')
const { LOOSE_END_KEY } = await import('../src/home.js')
const { RETRY_GRACE_MS } = await import('@brigade/contracts')

const updatedAt = new Date('2026-10-19T10:00:00Z')
const at = new Date('2026-10-19T09:58:00Z')
const error = (message: string) => ({ at, data: { type: 'error', message } })

test('a failed thread waits from its last error, which says why in one line', () => {
  assert.deepEqual(failure(updatedAt, error('  Tool use failed: no such file\n    at x.js:1  ')), {
    at,
    error: 'Tool use failed: no such file',
  })
})

test('one that failed without an error event (it never ran) waits from its last change', () => {
  assert.deepEqual(failure(updatedAt, undefined), { at: updatedAt, error: null })
  assert.equal(failure(updatedAt, error('   ')).error, null)
})

test('after an error its runner tries again on its own, it waits only once those tries are over', () => {
  for (const message of [
    'API Error: 529 overloaded',
    'fetch failed',
    'Stopped to give the computer memory back: 3 turns at once.',
  ])
    assert.equal(
      failure(updatedAt, error(message)).at.getTime(),
      at.getTime() + RETRY_GRACE_MS,
      message,
    )
  // The longest wait before a try (15 minutes) and a minute for it to start.
  assert.equal(RETRY_GRACE_MS, 16 * 60_000)
})

test('an error line is cut short', () => {
  assert.equal(errorLine({ message: 'x'.repeat(2_000) })?.length, 500)
  assert.equal(errorLine({}), null)
  assert.equal(errorLine(null), null)
})

test('Home no longer sets a failed thread or a routine aside: it waits on the member', () => {
  assert.doesNotMatch('failed:t1:42', LOOSE_END_KEY)
  assert.doesNotMatch('routine:s1:t2', LOOSE_END_KEY)
  assert.match('stalled:t1:42', LOOSE_END_KEY)
})
