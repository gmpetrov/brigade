import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ListItemView } from '@brigade/contracts'
import { recentlyDone } from '../lib/recently-done'

const now = new Date('2026-10-31T15:00:00')
const item = (id: string, at: string | null, extra: Partial<ListItemView> = {}): ListItemView => ({
  id,
  text: id,
  done: true,
  state: 'done',
  missing: false,
  stalled: false,
  section: null,
  doneBy: at ? { name: 'Riley', at: new Date(at).toISOString() } : null,
  threads: [],
  pulls: [],
  ...extra,
})

test('items Brigade ticked show newest first, grouped by day', () => {
  const days = recentlyDone(
    [
      item('a', '2026-10-29T10:00:00'),
      item('b', '2026-10-31T09:00:00'),
      item('c', '2026-10-30T18:00:00'),
      item('d', '2026-10-31T14:00:00'),
    ],
    now,
  )
  assert.deepEqual(
    days.map((d) => d.items.map((i) => i.id)),
    [['d', 'b'], ['c'], ['a']],
  )
})

test('undated, unticked, removed and old items are left to the list', () => {
  const days = recentlyDone(
    [
      item('person', null),
      item('unticked', '2026-10-31T09:00:00', { done: false, state: 'open' }),
      item('gone', '2026-10-31T09:00:00', { missing: true }),
      item('old', '2026-10-01T09:00:00'),
      item('kept', '2026-10-20T09:00:00'),
    ],
    now,
  )
  assert.deepEqual(
    days.flatMap((d) => d.items.map((i) => i.id)),
    ['kept'],
  )
})
