import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chaseStep, followIn, glides, leavesEnd } from '../lib/end-follow'

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

test('a few lines glide to the end; a thread opening or a whole page jumps there', () => {
  // A new line or a card, the thread in: glided.
  assert.equal(glides(120, 800, true), true)
  // Its pages coming in after a reload, thousands of pixels away: jumped, not scrolled through.
  assert.equal(glides(6_000, 800, true), false)
  // The thread still opening: jumped.
  assert.equal(glides(120, 800, false), false)
})

test('following text that grows, the view eases along it, never stalling nor jumping', () => {
  // 300 px a second of text growing under the view, 60 frames a second, for two seconds.
  let end = 0
  let top = 0
  let most = 0
  let jump = 0
  for (let frame = 0; frame < 120; frame++) {
    end += 5
    const step = chaseStep(end - top, 1 / 60)
    top += step
    jump = Math.max(jump, step)
    most = Math.max(most, end - top)
  }
  // Never more than a line behind, and never more than a few pixels a frame.
  assert.ok(most < 40, `${most}px behind`)
  assert.ok(jump < 10, `${jump}px in a frame`)
  // There, it stops.
  assert.equal(chaseStep(0, 1 / 60), 0)
  // The same pace at 30 frames a second.
  assert.ok(
    Math.abs(
      chaseStep(100, 1 / 30) -
        (chaseStep(100, 1 / 60) + chaseStep(100 - chaseStep(100, 1 / 60), 1 / 60)),
    ) < 1,
  )
})
