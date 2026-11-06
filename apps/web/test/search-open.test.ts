import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markdownFile } from '../lib/search-open'

test('a Markdown file found by search opens in the document panel', () => {
  assert.deepEqual(
    markdownFile({ kind: 'file', key: 'file:doc1', title: 'Projects/Brigade/why-brigade.md' }),
    { id: 'doc1', path: 'Projects/Brigade/why-brigade.md' },
  )
  assert.deepEqual(markdownFile({ kind: 'file', key: 'file:doc2', title: 'notes.MARKDOWN' }), {
    id: 'doc2',
    path: 'notes.MARKDOWN',
  })
})

test('other files, design files and other kinds go to their page', () => {
  assert.equal(markdownFile({ kind: 'file', key: 'file:a', title: 'brand/logo.png' }), undefined)
  assert.equal(markdownFile({ kind: 'file', key: 'file:b', title: 'specs/plan.pdf' }), undefined)
  assert.equal(
    markdownFile({ kind: 'file', key: 'file:c', title: 'designs/pricing.design/notes.md' }),
    undefined,
  )
  assert.equal(markdownFile({ kind: 'memory', key: 'memory:d', title: 'Workspace.md' }), undefined)
})
