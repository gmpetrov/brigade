import assert from 'node:assert/strict'
import { test } from 'node:test'
import { byteRange } from '../src/byte-range.js'

test('reads the ranges a video player asks for', () => {
  assert.deepEqual(byteRange('bytes=0-', 100), [0, 99])
  assert.deepEqual(byteRange('bytes=0-1', 100), [0, 1])
  assert.deepEqual(byteRange('bytes=10-500', 100), [10, 99])
  assert.deepEqual(byteRange('bytes=-20', 100), [80, 99])
  assert.deepEqual(byteRange('bytes=-500', 100), [0, 99])
})

test('refuses ranges it cannot serve', () => {
  assert.equal(byteRange('bytes=100-', 100), null)
  assert.equal(byteRange('bytes=5-2', 100), null)
  assert.equal(byteRange('bytes=-', 100), null)
  assert.equal(byteRange('bytes=0-1,5-6', 100), null)
  assert.equal(byteRange('items=0-1', 100), null)
})
