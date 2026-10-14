import assert from 'node:assert/strict'
import { test } from 'node:test'

// bucket.ts reads the API's config when imported; nothing here reaches a database or the vault.
process.env.DATABASE_URL ??= 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { exactBytes } = await import('../src/bucket.js')

test('a small file uploads its own bytes, not the Buffer pool around them', () => {
  // How a teammate's save arrives: base64, decoded into a pooled Buffer.
  for (const size of [1, 226, 1394, 4095, 4096, 20_000]) {
    const bytes = Buffer.alloc(size, 'x')
    const body = Buffer.from(bytes.toString('base64'), 'base64')
    const uploaded = new Uint8Array(exactBytes(body))
    assert.equal(uploaded.byteLength, size)
    assert.deepEqual(Buffer.from(uploaded), bytes)
  }
})
