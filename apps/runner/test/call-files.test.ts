import assert from 'node:assert/strict'
import { test } from 'node:test'
import { callFiles } from '../src/harness/call-files.js'

test("a single path (Drive's upload file) is uploaded and replaced by its id, not a list", () => {
  const { paths, place } = callFiles('out/report.xlsx')
  assert.deepEqual(paths, ['out/report.xlsx'])
  assert.equal(place(['att-1']), 'att-1')
})

test("a list of paths (an email's attachments) becomes the list of their ids", () => {
  const { paths, place } = callFiles(['a.pdf', 'b.png'])
  assert.deepEqual(paths, ['a.pdf', 'b.png'])
  assert.deepEqual(place(['att-1', 'att-2']), ['att-1', 'att-2'])
})

test('no files: nothing to upload', () => {
  assert.deepEqual(callFiles(undefined).paths, [])
  assert.deepEqual(callFiles([]).paths, [])
})
