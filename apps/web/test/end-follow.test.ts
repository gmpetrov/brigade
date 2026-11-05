import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EndFollower, chaseStep, followIn, glides, leavesEnd } from '../lib/end-follow'

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

/** A scroll box and a clock made up for EndFollower: frames every 16 ms, scroll events at once. */
function setup(given: { height?: number; viewport?: number; top?: number } = {}) {
  const height = given.height ?? 3000
  const viewport = given.viewport ?? 700
  const top = given.top ?? height - viewport
  let now = 0
  let frames: { id: number; run: (now: number) => void }[] = []
  let timers: { id: number; at: number; run: () => void }[] = []
  let ids = 0
  const atEnd: boolean[] = []
  const view = {
    height,
    top,
    clientHeight: viewport,
    get scrollHeight() {
      return this.height
    },
    get scrollTop() {
      return this.top
    },
    set scrollTop(to: number) {
      const was = this.top
      this.top = Math.max(0, Math.min(to, this.height - this.clientHeight))
      // The browser tells of the scroll: the follower reads where the view is.
      if (this.top !== was) follower.measure()
    },
  }
  const follower = new EndFollower(
    () => view,
    {
      now: () => now,
      frame: (run) => {
        frames.push({ id: ++ids, run })
        return ids
      },
      cancelFrame: (id) => void (frames = frames.filter((f) => f.id !== id)),
      after: (run, ms) => {
        timers.push({ id: ++ids, at: now + ms, run })
        return ids as unknown as ReturnType<typeof setTimeout>
      },
      cancel: (handle) => void (timers = timers.filter((t) => t.id !== (handle as unknown))),
    },
    (at) => atEnd.push(at),
    48,
    600,
  )
  follower.settle(true)
  /** Time going on by `ms`, a frame every 16 ms; `each` runs before each frame. */
  const run = (ms: number, each?: (t: number) => void) => {
    const end = now + ms
    while (now < end) {
      now += 16
      each?.(now)
      for (const t of timers.filter((t) => t.at <= now)) {
        timers = timers.filter((x) => x !== t)
        t.run()
      }
      const due = frames
      frames = []
      for (const f of due) f.run(now)
    }
  }
  const behind = () => view.height - view.clientHeight - view.top
  return { view, follower, run, behind, atEnd }
}

test('text growing at the end is followed down to it, then the follower rests', () => {
  const { view, follower, run, behind } = setup()
  run(1000, () => {
    view.height += 5
    follower.follow()
  })
  assert.ok(behind() < 40, `${behind()}px behind while growing`)
  run(500)
  assert.equal(behind(), 0)
  assert.equal(follower.following, true)
})

test('a jump to an earlier message is never pulled back to the end', () => {
  const { view, follower, run } = setup()
  view.height += 300
  follower.follow()
  run(64)
  // The timeline goes to a message far up.
  follower.leave()
  view.scrollTop = 300
  run(500, () => follower.follow())
  assert.equal(view.top, 300)
  assert.equal(follower.following, false)
})

test('back to the end by its button, what comes while on the way is followed too', () => {
  const { view, follower, run, behind, atEnd } = setup({ top: 2000 })
  follower.measure()
  assert.equal(follower.following, false)
  follower.toEnd(true)
  run(540)
  // A card comes in as it gets there.
  view.height += 300
  follower.follow()
  run(1000)
  assert.equal(behind(), 0)
  assert.equal(follower.following, true)
  assert.equal(atEnd.at(-1), true)
})

test('back to the end by its button while text keeps growing, it gets there', () => {
  const { view, follower, run, behind } = setup({ top: 1000 })
  follower.measure()
  follower.toEnd(true)
  run(1500, () => {
    view.height += 8
    follower.follow()
  })
  run(600)
  assert.equal(behind(), 0)
  assert.equal(follower.following, true)
})

test('the person scrolling up while text grows stays where they took it', () => {
  const { view, follower, run } = setup()
  run(300, () => {
    view.height += 5
    follower.follow()
  })
  follower.theirs({ type: 'wheel', deltaY: -300 })
  view.scrollTop = view.top - 300
  const where = view.top
  run(1000, () => {
    view.height += 5
    follower.follow()
  })
  assert.equal(view.top, where)
  assert.equal(follower.following, false)
})

test('a last update while the person scrolls down is followed once they stop', () => {
  const { view, follower, run, behind } = setup()
  follower.theirs({ type: 'wheel', deltaY: 120 })
  run(100)
  view.height += 200
  follower.follow()
  run(300)
  // Their scroll decides for now.
  assert.equal(behind(), 200)
  run(800)
  assert.equal(behind(), 0)
})

test('a thread opening, or its pages coming in far below, jumps to the end at once', () => {
  const { view, follower, run, behind } = setup({ top: 0 })
  follower.settle(false)
  follower.toEnd(false)
  follower.settle(true)
  view.height += 6000
  follower.follow()
  // Not eased over all of it: there at once.
  assert.equal(behind(), 0)
  run(16)
  assert.equal(behind(), 0)
})
