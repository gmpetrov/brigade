import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mergedMessage,
  mergedPull,
  resolveConflictsMessage,
  resolveConflictsNote,
} from '../dist/index.js'

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

test("a merge's line and its wake-up name the pull request they tell about", () => {
  const pull = { repository: 'acme/web', number: 698 }
  assert.deepEqual(mergedPull('Pull request #698 in acme/web was merged.'), pull)
  assert.deepEqual(mergedPull('Pull request #698 in acme/web was merged by Ada Lovelace.'), pull)
  assert.deepEqual(mergedPull(mergedMessage(pull)), pull)
  assert.equal(mergedPull('Pull request #698 in acme/web was closed without merging.'), null)
  assert.equal(mergedPull('PR #698 is merged.'), null)
})
