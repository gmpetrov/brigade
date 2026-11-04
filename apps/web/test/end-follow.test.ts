import assert from 'node:assert/strict'
import { test } from 'node:test'
import { followIn, leavesEnd } from '../lib/end-follow'

test('scrolling up, by wheel or keys, leaves the end; down or a touch does not on its own', () => {
  assert.equal(leavesEnd({ type: 'wheel', deltaY: -300 }), true)
  assert.equal(leavesEnd({ type: 'wheel', deltaY: 120 }), false)
  assert.equal(leavesEnd({ type: 'keydown', key: 'PageUp' }), true)
  assert.equal(leavesEnd({ type: 'keydown', key: 'ArrowDown' }), false)
  // A touch says where it goes only as it scrolls: the scroll it makes decides.
  assert.equal(leavesEnd({ type: 'touchstart' }), false)
})

test('what comes while the person scrolls is followed once they stop, unless they left the end', () => {
  // Following, nobody scrolling: now.
  assert.equal(followIn(true, 10_000, -Infinity, 600), 0)
  // They scrolled 100 ms ago, still at the end, and a last update comes: followed in 500 ms,
  // with nothing else coming to follow it then.
  assert.equal(followIn(true, 10_000, 9_900, 600), 500)
  // A moment later: now.
  assert.equal(followIn(true, 10_700, 9_900, 600), 0)
  // They left the end: never.
  assert.equal(followIn(false, 20_000, 9_900, 600), undefined)
})
