import assert from 'node:assert/strict'
import { test } from 'node:test'
import { storableJson } from '../src/storable-json.js'

test('NULs in a tool output are dropped, wherever they are', () => {
  const event = {
    type: 'tool.finished',
    output: { stdout: 'added 877, done\n\u0000\u0000\u0000tail', lines: ['a\u0000b'] },
  }
  assert.deepEqual(storableJson(event), {
    type: 'tool.finished',
    output: { stdout: 'added 877, done\ntail', lines: ['ab'] },
  })
})

test('a lone surrogate becomes U+FFFD; a pair stays', () => {
  assert.equal(storableJson('a\uD800b'), 'a�b')
  assert.equal(storableJson('😀'), '😀')
})

test('the text \\u0000, numbers, booleans and null are left as they are', () => {
  const value = { code: 'replace(/\\u0000/g, "")', n: 1, ok: true, none: null }
  assert.deepEqual(storableJson(value), value)
})
