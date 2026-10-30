import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveConflictsMessage, resolveConflictsNote } from '../dist/index.js'

test('a merge’s ask to resolve conflicts reads back', () => {
  const text = resolveConflictsMessage({
    number: 522,
    title: 'Keep "design" options after a pick',
    repository: 'gmpetrov/brigade',
    url: 'https://github.com/gmpetrov/brigade/pull/522',
    base: 'main',
    head: 'brigade/riley-r9q685bp',
    author: 'Riley',
    method: 'squash',
  })
  assert.deepEqual(resolveConflictsNote(text), {
    number: 522,
    title: 'Keep "design" options after a pick',
    repository: 'gmpetrov/brigade',
    base: 'main',
  })
})

test('a person’s text is not an ask to resolve conflicts', () => {
  assert.equal(
    resolveConflictsNote('Pull request #522 conflicts with `main`, can you fix it?'),
    null,
  )
  assert.equal(resolveConflictsNote('hello'), null)
})
