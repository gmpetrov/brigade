import assert from 'node:assert/strict'
import { test } from 'node:test'

// computers.ts reads the API's config when imported; nothing here reaches a database or the vault.
process.env.DATABASE_URL ??= 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { runnerUpdate } = await import('../src/routes/computers.js')

test('a runner on the served bundle is up to date', () => {
  assert.equal(runnerUpdate('abc123', 'abc123'), 'current')
})

test('a runner on another bundle waits to update', () => {
  assert.equal(runnerUpdate('abc123', 'def456'), 'waiting')
})

test('nothing is said when either bundle is unknown', () => {
  assert.equal(runnerUpdate(null, 'abc123'), null)
  assert.equal(runnerUpdate('abc123', undefined), null)
})
