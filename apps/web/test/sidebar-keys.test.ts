import assert from 'node:assert/strict'
import { test } from 'node:test'
import { enterAt, stepTo, walkKey, type Relation } from '../lib/sidebar-keys'

const key = (
  key: string,
  mods: Partial<Record<'alt' | 'meta' | 'ctrl' | 'shift', boolean>> = {},
) => ({
  key,
  altKey: !!mods.alt,
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  shiftKey: !!mods.shift,
})

test('⌥↑ and ⌥↓ walk the sidebar; the arrows alone or with another modifier do not', () => {
  assert.equal(walkKey(key('ArrowUp', { alt: true })), -1)
  assert.equal(walkKey(key('ArrowDown', { alt: true })), 1)
  assert.equal(walkKey(key('ArrowDown')), undefined)
  assert.equal(walkKey(key('ArrowDown', { alt: true, shift: true })), undefined)
  assert.equal(walkKey(key('ArrowUp', { alt: true, meta: true })), undefined)
  assert.equal(walkKey(key('ArrowLeft', { alt: true })), undefined)
})

// The sidebar's stops in order, and where each is from the row the walk starts at.
const stops = ['+', 'pinned-a', 'pinned-b', 'thread-a', 'thread-b', '+3 more']
const at =
  (start: string) =>
  (s: string): Relation => {
    const i = stops.indexOf(s)
    const j = stops.indexOf(start)
    return i === j ? 'same' : i > j ? 'after' : 'before'
  }

test('the walk goes to the next stop down or the previous one up', () => {
  assert.equal(stepTo(stops, at('pinned-a'), 1), 'pinned-b')
  assert.equal(stepTo(stops, at('pinned-a'), -1), '+')
  assert.equal(stepTo(stops, at('thread-b'), 1), '+3 more')
})

test('it stops at either end, without going round', () => {
  assert.equal(stepTo(stops, at('+'), -1), undefined)
  assert.equal(stepTo(stops, at('+3 more'), 1), undefined)
})

test('from a page the walk does not reach, down opens the first conversation and up the +', () => {
  const isTop = (s: string) => s === '+'
  assert.equal(enterAt(stops, isTop, 1), 'pinned-a')
  assert.equal(enterAt(stops, isTop, -1), '+')
  // A viewer has no +: down is the first stop, up the last.
  const viewer = stops.slice(1)
  assert.equal(enterAt(viewer, isTop, 1), 'pinned-a')
  assert.equal(enterAt(viewer, isTop, -1), '+3 more')
})

test('from a row that is no stop (a section unfolded with Enter), the walk goes on past it', () => {
  // The Threads label sits between the last pinned row and the first thread once unfolded.
  const label = (s: string): Relation => (stops.indexOf(s) >= 3 ? 'after' : 'before')
  assert.equal(stepTo(stops, label, 1), 'thread-a')
  assert.equal(stepTo(stops, label, -1), 'pinned-b')
})
