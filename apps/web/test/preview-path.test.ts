import assert from 'node:assert/strict'
import { test } from 'node:test'
import { typedPath, withPath } from '../lib/preview-path'

test('what a person types is a path on the preview', () => {
  assert.equal(typedPath('/app'), '/app')
  assert.equal(typedPath('  app/settings '), '/app/settings')
  assert.equal(typedPath(''), '/')
  assert.equal(typedPath('/app?tab=2#top'), '/app?tab=2#top')
  // Another host is not reached: its path is kept on the preview's own.
  assert.equal(typedPath('https://example.com/login'), '/login')
  assert.equal(typedPath('//example.com/login'), '/example.com/login')
})

test('the address keeps its token on the new path', () => {
  const url = 'https://box-1.on.boat.dev/?token=abc'
  assert.equal(withPath(url, '/app'), 'https://box-1.on.boat.dev/app?token=abc')
  assert.equal(withPath(url, '/app?tab=2#top'), 'https://box-1.on.boat.dev/app?tab=2&token=abc#top')
  assert.equal(withPath('http://localhost:3000', '/app'), 'http://localhost:3000/app')
})
