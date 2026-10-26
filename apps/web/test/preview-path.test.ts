import assert from 'node:assert/strict'
import { test } from 'node:test'
import { previewOrigin, typedPath, withPath } from '../lib/preview-path'

test("a page at a grant of the preview's address is the preview's", () => {
  const origin = `https://${'a'.repeat(26)}.brigade.surf`
  const grant = `https://${'a'.repeat(26)}-${'b'.repeat(36)}.brigade.surf`
  assert.equal(previewOrigin(origin, origin), true)
  assert.equal(previewOrigin(grant, origin), true)
  // Another preview's grant, another domain, a grant too short, plain HTTP, a deeper host.
  const other = `https://${'c'.repeat(26)}-${'b'.repeat(36)}.brigade.surf`
  assert.equal(previewOrigin(other, origin), false)
  assert.equal(previewOrigin(grant.replace('brigade.surf', 'evil.example'), origin), false)
  assert.equal(previewOrigin(`https://${'a'.repeat(26)}-bbb.brigade.surf`, origin), false)
  assert.equal(previewOrigin(grant.replace('https:', 'http:'), origin), false)
  assert.equal(previewOrigin(grant.replace('https://', 'https://x.'), origin), false)
  assert.equal(previewOrigin('null', origin), false)
  assert.equal(previewOrigin('http://localhost:3000', 'http://localhost:3000'), true)
})

test('what a person types is a path on the preview', () => {
  assert.equal(typedPath('/app'), '/app')
  assert.equal(typedPath('  app/settings '), '/app/settings')
  assert.equal(typedPath(''), '/')
  assert.equal(typedPath('/app?tab=2#top'), '/app?tab=2#top')
  // Another host is not reached: its path is kept on the preview's own.
  assert.equal(typedPath('https://example.com/login'), '/login')
  assert.equal(typedPath('//example.com/login'), '/example.com/login')
  assert.equal(typedPath('/\\evil.example/'), '/evil.example/')
  assert.equal(typedPath('\\\\evil.example/x'), '/evil.example/x')
  assert.equal(typedPath('https:\\\\evil.example/x'), '/x')
  assert.equal(typedPath('/\t/evil.example/'), '/evil.example/')
  assert.equal(typedPath('/a/..//evil.example/'), '/evil.example/')
})

test('the address keeps its token on the new path', () => {
  const url = 'https://box-1.on.boat.dev/?token=abc'
  assert.equal(withPath(url, '/app'), 'https://box-1.on.boat.dev/app?token=abc')
  assert.equal(withPath(url, '/app?tab=2#top'), 'https://box-1.on.boat.dev/app?tab=2&token=abc#top')
  assert.equal(withPath('http://localhost:3000', '/app'), 'http://localhost:3000/app')
  // Never on another address.
  for (const path of ['/\\evil.example/', '//evil.example/', 'https://evil.example/'])
    assert.equal(new URL(withPath(url, path)).origin, 'https://box-1.on.boat.dev')
})
