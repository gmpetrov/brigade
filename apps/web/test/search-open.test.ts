import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markdownFile } from '../lib/search-open'

test('a Markdown file found by search opens in the document panel', () => {
  assert.deepEqual(
    markdownFile({
      kind: 'file',
      key: 'file:doc1',
      title: 'Projects/Brigade/why-brigade.md',
      editor: true,
    }),
    { id: 'doc1', path: 'Projects/Brigade/why-brigade.md' },
  )
  assert.deepEqual(
    markdownFile({ kind: 'file', key: 'file:doc2', title: 'notes.MARKDOWN', editor: true }),
    {
      id: 'doc2',
      path: 'notes.MARKDOWN',
    },
  )
})

test('a Markdown file the editor does not take opens in the library', () => {
  // Too big for the editor: the API says so.
  assert.equal(
    markdownFile({ kind: 'file', key: 'file:big', title: 'notes/huge.md', editor: false }),
    undefined,
  )
  // A recent row saved before the API said, or an older API: the library, which checks.
  assert.equal(markdownFile({ kind: 'file', key: 'file:old', title: 'notes/plan.md' }), undefined)
})

test('other files, design files and other kinds go to their page', () => {
  assert.equal(markdownFile({ kind: 'file', key: 'file:a', title: 'brand/logo.png' }), undefined)
  assert.equal(markdownFile({ kind: 'file', key: 'file:b', title: 'specs/plan.pdf' }), undefined)
  assert.equal(
    markdownFile({
      kind: 'file',
      key: 'file:c',
      title: 'designs/pricing.design/notes.md',
      editor: true,
    }),
    undefined,
  )
  assert.equal(markdownFile({ kind: 'memory', key: 'memory:d', title: 'Workspace.md' }), undefined)
})
