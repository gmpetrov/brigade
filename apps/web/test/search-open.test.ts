import assert from 'node:assert/strict'
import { test } from 'node:test'
import { libraryFile } from '../lib/search-open'

test('a Markdown file found by search opens in the file panel, in the editor', () => {
  assert.deepEqual(
    libraryFile({
      kind: 'file',
      key: 'file:doc1',
      title: 'Projects/Brigade/why-brigade.md',
      editor: true,
    }),
    { id: 'doc1', path: 'Projects/Brigade/why-brigade.md', editable: true },
  )
  assert.deepEqual(
    libraryFile({ kind: 'file', key: 'file:doc2', title: 'notes.MARKDOWN', editor: true }),
    { id: 'doc2', path: 'notes.MARKDOWN', editable: true },
  )
})

test('a Markdown file the editor does not take opens in the panel as a preview', () => {
  // Too big for the editor: the API says so.
  assert.deepEqual(
    libraryFile({ kind: 'file', key: 'file:big', title: 'notes/huge.md', editor: false }),
    { id: 'big', path: 'notes/huge.md', editable: false },
  )
  // A recent row saved before the API said: the panel asks the API what it is.
  assert.deepEqual(libraryFile({ kind: 'file', key: 'file:old', title: 'notes/plan.md' }), {
    id: 'old',
    path: 'notes/plan.md',
  })
})

test('any other library file opens in the panel too; the panel asks what it is', () => {
  assert.deepEqual(libraryFile({ kind: 'file', key: 'file:a', title: 'brand/logo.png' }), {
    id: 'a',
    path: 'brand/logo.png',
  })
  // `editor` says only whether the document editor takes it: not passed on for other files.
  assert.deepEqual(
    libraryFile({ kind: 'file', key: 'file:b', title: 'specs/plan.pdf', editor: false }),
    { id: 'b', path: 'specs/plan.pdf' },
  )
})

test("a design's files and other kinds go to their page", () => {
  assert.equal(
    libraryFile({
      kind: 'file',
      key: 'file:c',
      title: 'designs/pricing.design/notes.md',
      editor: true,
    }),
    undefined,
  )
  assert.equal(
    libraryFile({ kind: 'file', key: 'file:e', title: 'designs/pricing.design/index.html' }),
    undefined,
  )
  assert.equal(libraryFile({ kind: 'memory', key: 'memory:d', title: 'Workspace.md' }), undefined)
  assert.equal(libraryFile({ kind: 'thread', key: 'thread:t', title: 'notes.md' }), undefined)
})
