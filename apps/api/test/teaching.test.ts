import assert from 'node:assert/strict'
import { test } from 'node:test'
import { endRecording, holdRecording, LEASE_MS, recorder } from '../src/teaching.js'

test('one member records on a computer at a time', () => {
  assert.equal(holdRecording('c1', 'ada', 0), undefined)
  assert.equal(holdRecording('c1', 'bob', 1), 'ada')
  // Another computer is free.
  assert.equal(holdRecording('c2', 'bob', 1), undefined)
  endRecording('c1', 'bob')
  assert.equal(recorder('c1', 2), 'ada')
  endRecording('c1', 'ada')
  assert.equal(holdRecording('c1', 'bob', 3), undefined)
  endRecording('c1', 'bob')
  endRecording('c2', 'bob')
})

test('a recording nobody renews lets go of the computer', () => {
  holdRecording('c1', 'ada', 0)
  // Renewed: still held past the first lease.
  holdRecording('c1', 'ada', LEASE_MS - 1)
  assert.equal(recorder('c1', LEASE_MS + 1), 'ada')
  assert.equal(recorder('c1', 2 * LEASE_MS), undefined)
  assert.equal(holdRecording('c1', 'bob', 2 * LEASE_MS), undefined)
  endRecording('c1', 'bob')
})
