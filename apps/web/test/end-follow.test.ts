import assert from 'node:assert/strict'
import { test } from 'node:test'
import { leavesEnd, mayFollow } from '../lib/end-follow'

test('scrolling up, by wheel or keys, leaves the end; down or a touch does not on its own', () => {
  assert.equal(leavesEnd({ type: 'wheel', deltaY: -300 }), true)
  assert.equal(leavesEnd({ type: 'wheel', deltaY: 120 }), false)
  assert.equal(leavesEnd({ type: 'keydown', key: 'PageUp' }), true)
  assert.equal(leavesEnd({ type: 'keydown', key: 'ArrowDown' }), false)
  // A touch says where it goes only as it scrolls: the scroll it makes decides.
  assert.equal(leavesEnd({ type: 'touchstart' }), false)
})

test('nothing glides to the end while the person scrolls, nor once they left it', () => {
  // Following, nobody scrolling: it glides.
  assert.equal(mayFollow(true, 10_000, -Infinity, 600), true)
  // They scrolled 100 ms ago: their scroll decides, the text growing does not pull them back.
  assert.equal(mayFollow(true, 10_000, 9_900, 600), false)
  // A moment later, still at the end: it follows again.
  assert.equal(mayFollow(true, 10_700, 9_900, 600), true)
  // They left the end: never.
  assert.equal(mayFollow(false, 20_000, 9_900, 600), false)
})
