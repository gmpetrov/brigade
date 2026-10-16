import assert from 'node:assert/strict'
import { test } from 'node:test'
import { oomReason, PressureWatch, previewBudget } from '../src/preview-cgroup.js'

const GiB = 1024 ** 3

test('previews get what the computer has, less 1.5 GiB and an eighth for the rest', () => {
  // A 4x8 computer: 7.75 GiB visible.
  const small = previewBudget(7.75 * GiB, {})
  assert.equal(small.high.toFixed(0), (7.75 * GiB - (1.5 * GiB + (7.75 * GiB) / 8)).toFixed(0))
  assert.equal((small.high / GiB).toFixed(2), '5.28')
  assert.equal((small.max / GiB).toFixed(2), '6.52')
  // One preview alone: half the computer.
  assert.equal(small.each, 3.875 * GiB)

  const big = previewBudget(16 * GiB, {})
  assert.deepEqual([big.high / GiB, big.max / GiB, big.each / GiB], [12.5, 14.25, 8])
})

test('on a tiny computer previews still get 1 GiB, and one preview no more than all of them', () => {
  const tiny = previewBudget(2 * GiB, {})
  assert.equal(tiny.high, GiB)
  assert.equal(tiny.max, 1.125 * GiB)
  assert.equal(tiny.each, GiB)
  assert.ok(tiny.each <= tiny.max)
})

test('the reserve and one preview’s ceiling can be set', () => {
  const set = previewBudget(8 * GiB, {
    BRIGADE_PREVIEWS_RESERVE: '2G',
    BRIGADE_PREVIEW_MEMORY_MAX: '1536M',
  })
  assert.deepEqual([set.high / GiB, set.max / GiB, set.each / GiB], [6, 7, 1.5])
  // More than all previews may take together: all of it.
  assert.equal(previewBudget(8 * GiB, { BRIGADE_PREVIEW_MEMORY_MAX: '20G' }).each, 6.75 * GiB)
  // Unreadable: the default.
  assert.equal(previewBudget(8 * GiB, { BRIGADE_PREVIEWS_RESERVE: 'lots' }).high, 5.5 * GiB)
})

const budget = { max: 6.52 * GiB, each: 3.875 * GiB }
const none = { kills: 0, atCeiling: 0, together: 0 }

test('a preview the kernel did not kill has no memory reason', () => {
  assert.equal(oomReason(none, none, budget), undefined)
  // Counts from an earlier run of the same cgroup do not count again.
  const before = { kills: 1, atCeiling: 1, together: 0 }
  assert.equal(oomReason(before, before, budget), undefined)
})

test('a preview killed at its own ceiling says how much one may use', () => {
  assert.equal(
    oomReason(none, { kills: 1, atCeiling: 1, together: 0 }, budget),
    'ran out of memory: a preview may use 3.9 GB here',
  )
  assert.equal(
    oomReason(
      { kills: 1, atCeiling: 1, together: 0 },
      { kills: 2, atCeiling: 2, together: 3 },
      budget,
    ),
    'ran out of memory: a preview may use 3.9 GB here',
  )
})

test('a preview killed when previews together reached theirs says so', () => {
  assert.equal(
    oomReason(none, { kills: 1, atCeiling: 0, together: 1 }, budget),
    'was killed: previews here may use 6.5 GB together',
  )
})

test('a preview killed with neither ceiling reached was the whole computer running out', () => {
  assert.equal(
    oomReason(undefined, { kills: 3, atCeiling: 0, together: 0 }, budget),
    'was killed: the computer ran out of memory',
  )
  // previews/ reached its ceiling for another preview, before this one started.
  assert.equal(
    oomReason(
      { kills: 0, atCeiling: 0, together: 2 },
      { kills: 1, atCeiling: 0, together: 2 },
      budget,
    ),
    'was killed: the computer ran out of memory',
  )
})

test('a preview stalled on memory long enough is stopped, not one that stalls briefly', () => {
  const watch = new PressureWatch<string>(60, 30_000)
  const at = (s: number) => s * 1000
  assert.equal(watch.observe([{ key: 'a', pressure: 90, memory: 1 }], at(0)), undefined)
  assert.equal(watch.observe([{ key: 'a', pressure: 80, memory: 1 }], at(25)), undefined)
  assert.equal(watch.observe([{ key: 'a', pressure: 70, memory: 1 }], at(30)), 'a')
  // Started over: a dip below the limit resets it.
  assert.equal(watch.observe([{ key: 'b', pressure: 99, memory: 1 }], at(40)), undefined)
  assert.equal(watch.observe([{ key: 'b', pressure: 59, memory: 1 }], at(60)), undefined)
  assert.equal(watch.observe([{ key: 'b', pressure: 99, memory: 1 }], at(65)), undefined)
  assert.equal(watch.observe([{ key: 'b', pressure: 99, memory: 1 }], at(90)), undefined)
  assert.equal(watch.observe([{ key: 'b', pressure: 99, memory: 1 }], at(95)), 'b')
})

test('of previews stalled together, the biggest goes, and the others get a new while', () => {
  const watch = new PressureWatch<string>(60, 30_000)
  const both = (s: number) =>
    watch.observe(
      [
        { key: 'small', pressure: 90, memory: 300 },
        { key: 'big', pressure: 90, memory: 2000 },
      ],
      s * 1000,
    )
  assert.equal(both(0), undefined)
  assert.equal(both(30), 'big')
  // The small one was stalled as long, but what weighed on it may be gone.
  assert.equal(watch.observe([{ key: 'small', pressure: 90, memory: 300 }], 35_000), undefined)
  assert.equal(watch.observe([{ key: 'small', pressure: 90, memory: 300 }], 60_000), 'small')
})

test('a preview gone or frozen between readings is forgotten', () => {
  const watch = new PressureWatch<string>(60, 30_000)
  watch.observe([{ key: 'a', pressure: 90, memory: 1 }], 0)
  watch.observe([], 20_000)
  assert.equal(watch.observe([{ key: 'a', pressure: 90, memory: 1 }], 30_000), undefined)
})
