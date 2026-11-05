import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stepTo, walkKey, type Relation } from '../lib/sidebar-keys'

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
const stops = ['today', 'inbox', 'pinned-a', 'thread-a', 'thread-b', '+3 more']
const at =
  (start: string) =>
  (s: string): Relation => {
    const i = stops.indexOf(s)
    const j = stops.indexOf(start)
    return i === j ? 'same' : i > j ? 'after' : 'before'
  }

test('the walk goes to the next stop down or the previous one up', () => {
  assert.equal(stepTo(stops, at('inbox'), 1), 'pinned-a')
  assert.equal(stepTo(stops, at('pinned-a'), -1), 'inbox')
  assert.equal(stepTo(stops, at('thread-b'), 1), '+3 more')
})

test('it stops at either end, without going round', () => {
  assert.equal(stepTo(stops, at('today'), -1), undefined)
  assert.equal(stepTo(stops, at('+3 more'), 1), undefined)
})

test('from no row (a page not in the sidebar), down starts at the top and up at the bottom', () => {
  assert.equal(stepTo(stops, undefined, 1), 'today')
  assert.equal(stepTo(stops, undefined, -1), '+3 more')
})

test('from a row that is no stop (a section unfolded with Enter), the walk goes on past it', () => {
  // The Pinned label sits between Inbox and the pinned thread once unfolded.
  const label = (s: string): Relation => (stops.indexOf(s) >= 2 ? 'after' : 'before')
  assert.equal(stepTo(stops, label, 1), 'pinned-a')
  assert.equal(stepTo(stops, label, -1), 'inbox')
})
