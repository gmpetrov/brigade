import assert from 'node:assert/strict'
import { test } from 'node:test'
import { viewerMay } from '../src/viewers.js'

// What a viewer may send (src/viewers.ts): reads, and writes that only keep their own place.
test('a viewer reads everything', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) assert.ok(viewerMay(method, '/api/threads'))
})

test('a viewer keeps their own place: read marks, pins, later, sidebar order', () => {
  assert.ok(viewerMay('POST', '/api/threads/t1/read'))
  assert.ok(viewerMay('POST', '/api/threads/t1/pin'))
  assert.ok(viewerMay('DELETE', '/api/threads/t1/later'))
  assert.ok(viewerMay('PUT', '/api/threads/pins/order'))
  assert.ok(viewerMay('POST', '/api/library/d1/pin'))
  assert.ok(viewerMay('PUT', '/api/me/sidebar-order'))
  assert.ok(viewerMay('POST', '/api/home/dismiss'))
})

test('a viewer starts, writes and changes nothing', () => {
  assert.equal(viewerMay('POST', '/api/threads'), false)
  assert.equal(viewerMay('POST', '/api/threads/t1/messages'), false)
  assert.equal(viewerMay('POST', '/api/threads/t1/takeover'), false)
  assert.equal(viewerMay('POST', '/api/threads/t1/read/extra'), false)
  assert.equal(viewerMay('PATCH', '/api/teammates/t1'), false)
  assert.equal(viewerMay('POST', '/api/library/edit'), false)
  assert.equal(viewerMay('PUT', '/api/me/auto-merge'), false)
  assert.equal(viewerMay('POST', '/api/accounts'), false)
})
