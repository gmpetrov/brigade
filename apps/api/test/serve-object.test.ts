import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// Served from the local bucket folder (no R2 here); nothing reaches a database or the vault.
process.env.DATABASE_URL ??= 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
process.env.BUCKET_DIR = await mkdtemp(join(tmpdir(), 'serve-object-'))
const { Hono } = await import('hono')
const { putObject } = await import('../src/bucket.js')
const { headOf, serveObject } = await import('../src/serve-object.js')

const bytes = new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 251))
await putObject('org/ws/file', bytes, 'application/octet-stream')
const app = new Hono().get('/:key', (c) =>
  serveObject(c, c.req.param('key') === 'file' ? 'org/ws/file' : 'org/ws/none', 1000, {
    'content-type': 'application/octet-stream',
  }),
)
const get = (key: string, range?: string) =>
  app.request(`/${key}`, range ? { headers: { range } } : {})

test('a file streams whole, and answers the ranges a video player asks for', async () => {
  const whole = await get('file')
  assert.equal(whole.status, 200)
  assert.equal(whole.headers.get('accept-ranges'), 'bytes')
  assert.deepEqual(new Uint8Array(await whole.arrayBuffer()), bytes)

  const part = await get('file', 'bytes=10-19')
  assert.equal(part.status, 206)
  assert.equal(part.headers.get('content-range'), 'bytes 10-19/1000')
  assert.deepEqual(new Uint8Array(await part.arrayBuffer()), bytes.subarray(10, 20))

  const tail = await get('file', 'bytes=-5')
  assert.deepEqual(new Uint8Array(await tail.arrayBuffer()), bytes.subarray(995))

  const beyond = await get('file', 'bytes=2000-')
  assert.equal(beyond.status, 416)
  assert.equal(beyond.headers.get('content-range'), 'bytes */1000')
})

test('a file missing from storage is a 404', async () => {
  assert.equal((await get('none')).status, 404)
})

test('a look at a file reads its beginning only', async () => {
  assert.deepEqual(await headOf('org/ws/file', 1000, 100), bytes.subarray(0, 100))
  assert.deepEqual(await headOf('org/ws/file', 1000, 5000), bytes)
  assert.equal((await headOf('org/ws/file', 0, 100)).byteLength, 0)
})
