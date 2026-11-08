// How a library file's history folds runs of saves (lib/version-groups).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LibraryActor, LibraryVersion } from '@brigade/contracts'
import { groupVersions } from '../lib/version-groups'

const ada: LibraryActor = { type: 'member', id: 'ada', name: 'Ada', sessionId: null }
const bob: LibraryActor = { type: 'member', id: 'bob', name: 'Bob', sessionId: null }
const scout = (sessionId: string): LibraryActor => ({
  type: 'teammate',
  id: 'scout',
  name: 'Scout',
  sessionId,
})

/** A version saved `minutes` after noon. */
function version(id: string, by: LibraryActor, minutes: number, restored = false): LibraryVersion {
  const at = new Date(Date.UTC(2026, 10, 8, 12, minutes)).toISOString()
  return {
    id,
    path: 'notes.md',
    contentType: 'text/markdown',
    size: 10,
    sha256: id,
    by,
    restoredFromId: restored ? 'older' : null,
    createdAt: at,
    updatedAt: at,
    current: false,
  }
}

const ids = (groups: ReturnType<typeof groupVersions>) =>
  groups.map((g) => [g.versions.map((v) => v.id), g.before?.id ?? null])

test('saves by one person close together fold into one group, measured from the save before', () => {
  const list = [
    version('e', ada, 50),
    version('d', ada, 40),
    version('c', ada, 30),
    version('b', bob, 20),
    version('a', ada, 10),
  ]
  assert.deepEqual(ids(groupVersions(list)), [
    [['e', 'd', 'c'], 'b'],
    [['b'], 'a'],
    [['a'], null],
  ])
})

test('a pause longer than half an hour starts a new group', () => {
  const list = [version('c', ada, 100), version('b', ada, 75), version('a', ada, 44)]
  assert.deepEqual(ids(groupVersions(list)), [
    [['c', 'b'], 'a'],
    [['a'], null],
  ])
})

test('the gap is measured from when a folded save last changed', () => {
  const b = { ...version('b', ada, 0), updatedAt: version('x', ada, 50).updatedAt }
  assert.deepEqual(ids(groupVersions([version('c', ada, 70), b])), [[['c', 'b'], null]])
})

test('a teammate in two threads makes two groups', () => {
  const list = [version('b', scout('t2'), 20), version('a', scout('t1'), 10)]
  assert.equal(groupVersions(list).length, 2)
})

test('a restore stays on a line of its own', () => {
  const list = [version('c', ada, 30), version('b', ada, 20, true), version('a', ada, 10)]
  assert.deepEqual(ids(groupVersions(list)), [
    [['c'], 'b'],
    [['b'], 'a'],
    [['a'], null],
  ])
})

test('no versions, no groups', () => {
  assert.deepEqual(groupVersions([]), [])
})
