import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupWith, holds, subThreadRows } from '../lib/sub-threads'

const child = (id: string, status = 'idle') => ({
  id,
  title: id,
  status,
  updatedAt: '2026-10-29T00:00:00.000Z',
  unread: false,
})

test('a thread holds itself and its child threads, not others', () => {
  const parent = { id: 'p', children: [child('c1'), child('c2')] }
  assert.equal(holds(parent, 'p'), true)
  assert.equal(holds(parent, 'c2'), true)
  assert.equal(holds(parent, 'x'), false)
  assert.equal(holds({ id: 'q' }, 'c1'), false)
})

test('the open child of a sixth idle parent finds that parent among those loaded', () => {
  // Six idle roots, the list shows five: the open child's parent is the one to bring up.
  const roots = Array.from({ length: 6 }, (_, i) => ({
    id: `r${i}`,
    children: [child(`r${i}-c`)],
  }))
  const visible = roots.slice(0, 5)
  assert.equal(
    visible.some((t) => holds(t, 'r5-c')),
    false,
  )
  assert.equal(roots.find((t) => holds(t, 'r5-c'))?.id, 'r5')
})

test('unfolded: waiting, then working, then the latest, capped, with the open one kept', () => {
  const items = [
    child('a'),
    child('b', 'running'),
    child('c'),
    child('d'),
    child('e', 'waiting'),
    child('f'),
    child('g'),
  ]
  const { shown, hidden } = subThreadRows(items, {
    needsYou: { f: 'approve' },
    activeId: 'g',
    all: false,
    cap: 3,
  })
  // f has a ticket for this member: it waits, after e (its own status) in the list's order.
  assert.deepEqual(
    shown.map((c) => c.id),
    ['e', 'f', 'b', 'g'],
  )
  assert.equal(shown.find((c) => c.id === 'f')?.status, 'waiting')
  assert.equal(shown.find((c) => c.id === 'f')?.ask, 'approve')
  assert.equal(hidden, 3)
  const every = subThreadRows(items, { needsYou: {}, activeId: null, all: true, cap: 3 })
  assert.equal(every.shown.length, 7)
  assert.equal(every.hidden, 0)
})

test("a list's row holds its threads' child threads, and keeps the one holding the open one", () => {
  const list = { id: 'list:L', children: [{ ...child('t'), children: [child('t-c')] }] }
  assert.equal(holds(list, 't-c'), true)
  const items = [child('a'), child('b'), { ...child('t'), children: [child('t-c')] }]
  const { shown } = subThreadRows(items, { needsYou: {}, activeId: 't-c', all: false, cap: 1 })
  assert.deepEqual(
    shown.map((c) => c.id),
    ['a', 't'],
  )
})

test('a failed child waiting on the member keeps its red dot, listed with those waiting', () => {
  const items = [child('a'), child('b', 'running'), child('f', 'failed'), child('x', 'failed')]
  const { shown } = subThreadRows(items, {
    needsYou: { f: 'failed' },
    activeId: null,
    all: true,
    cap: 3,
  })
  assert.deepEqual(
    shown.map((c) => c.id),
    ['f', 'b', 'a', 'x'],
  )
  assert.equal(shown[0]?.status, 'failed')
  assert.equal(groupWith('failed', 'failed'), 'waiting')
  // Nobody's to mend (a child's, which its parent's teammate hears of): with the rest.
  assert.equal(groupWith('failed', undefined), 'rest')
  assert.equal(groupWith('idle', 'approve'), 'rest')
})
