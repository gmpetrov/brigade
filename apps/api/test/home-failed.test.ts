import assert from 'node:assert/strict'
import { test } from 'node:test'

// home.ts reads the API's config when imported; nothing here reaches a database or the vault.
process.env.DATABASE_URL ??= 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { failedLooseEnds } = await import('../src/home.js')

const thread = {
  id: 't1',
  title: 'Playbooks',
  lastSeq: 42,
  updatedAt: new Date('2026-10-19T10:00:00Z'),
  teammate: { id: 'riley', name: 'Riley' },
}

test('a failed thread is a loose end, with its last error', () => {
  const at = new Date('2026-10-19T09:58:00Z')
  const [end] = failedLooseEnds(
    [thread],
    [{ sessionId: 't1', at, data: { type: 'error', message: '  API Error: 500  ' } }],
    new Set(),
  )
  assert.deepEqual(end, {
    kind: 'failed',
    key: 'failed:t1:42',
    at: at.toISOString(),
    thread: { id: 't1', title: 'Playbooks' },
    teammate: { id: 'riley', name: 'Riley' },
    error: 'API Error: 500',
  })
})

test('one that failed without an error event (it never ran) dates from its last change', () => {
  const [end] = failedLooseEnds([thread], [], new Set())
  assert.equal(end?.at, thread.updatedAt.toISOString())
  assert.equal(end?.kind === 'failed' && end.error, null)
})

test('set aside, it stays gone until the thread fails again', () => {
  assert.deepEqual(failedLooseEnds([thread], [], new Set(['failed:t1:42'])), [])
  assert.equal(
    failedLooseEnds([{ ...thread, lastSeq: 45 }], [], new Set(['failed:t1:42'])).length,
    1,
  )
})
