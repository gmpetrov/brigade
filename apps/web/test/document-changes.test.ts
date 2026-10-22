// The document panel's dot on tabs a teammate changed behind the one in front (lib/document-changes).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LibraryActor } from '@brigade/contracts'
import { changedSince, type Stamps } from '../lib/document-changes'

const teammate: LibraryActor = { type: 'teammate', id: 't1', name: 'Riley', sessionId: null }
const member: LibraryActor = { type: 'member', id: 'm1', name: 'Ada', sessionId: null }
const file = (id: string, updatedAt: string, updatedBy = teammate) => ({ id, updatedAt, updatedBy })

test('a file seen for the first time is only a baseline', () => {
  const stamps: Stamps = new Map()
  assert.deepEqual(changedSince(stamps, [file('a', '1')], ['a', 'b'], 'b'), [])
  assert.equal(stamps.get('a'), '1')
})

test("a teammate's change to a tab behind is marked, not the one in front", () => {
  const stamps: Stamps = new Map([
    ['a', '1'],
    ['b', '1'],
  ])
  assert.deepEqual(changedSince(stamps, [file('a', '2'), file('b', '2')], ['a', 'b'], 'b'), ['a'])
})

test("a person's own change is not marked", () => {
  const stamps: Stamps = new Map([['a', '1']])
  assert.deepEqual(changedSince(stamps, [file('a', '2', member)], ['a', 'b'], 'b'), [])
})

test('a change made while the panel was hidden shows once it is back', () => {
  // The stamps outlive the hidden panel: the look as it shows again compares with them.
  const stamps: Stamps = new Map([
    ['a', '1'],
    ['b', '1'],
  ])
  assert.deepEqual(changedSince(stamps, [file('a', '2'), file('b', '1')], ['a', 'b'], 'b'), ['a'])
})

test('a third tab gets a baseline, so its first change is marked', () => {
  const stamps: Stamps = new Map([
    ['a', '1'],
    ['b', '1'],
  ])
  changedSince(stamps, [file('a', '1'), file('b', '1'), file('c', '1')], ['a', 'b', 'c'], 'c')
  assert.deepEqual(
    changedSince(stamps, [file('a', '1'), file('b', '1'), file('c', '2')], ['a', 'b', 'c'], 'b'),
    ['c'],
  )
})

test('a closed tab is forgotten', () => {
  const stamps: Stamps = new Map([
    ['a', '1'],
    ['b', '1'],
  ])
  changedSince(stamps, [file('b', '1')], ['b'], 'b')
  assert.equal(stamps.has('a'), false)
})
