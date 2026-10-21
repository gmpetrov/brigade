import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROJECT_LOGO_MAX } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'

// logos.ts reads the API's config when imported (through bucket.ts); nothing here reaches it.
process.env.DATABASE_URL ??= 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { decodeLogo } = await import('../src/logos.js')

const dataUrl = (bytes: Uint8Array, type = 'image/png') =>
  `data:${type};base64,${Buffer.from(bytes).toString('base64')}`
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

test('a logo takes its type from its bytes, not from its URL', () => {
  const logo = decodeLogo(dataUrl(PNG, 'image/svg+xml'))
  assert.equal(logo.type, 'image/png')
  assert.equal(logo.extension, 'png')
  assert.deepEqual(logo.bytes, PNG)
})

test('an SVG is kept as one', () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  assert.equal(decodeLogo(dataUrl(svg, 'image/svg+xml')).extension, 'svg')
})

test('what is not an image is refused', () => {
  const html = new TextEncoder().encode('<html><script>alert(1)</script></html>')
  assert.throws(
    () => decodeLogo(dataUrl(html)),
    (e: unknown) => e instanceof HTTPException && e.status === 400,
  )
})

test('a logo past the limit is refused', () => {
  const big = new Uint8Array(PROJECT_LOGO_MAX + 1)
  big.set(PNG)
  assert.throws(
    () => decodeLogo(dataUrl(big)),
    (e: unknown) => e instanceof HTTPException && e.status === 413,
  )
})
