import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agendaOf, agendaTime } from '../lib/routine-agenda'

// Thursday 5 November 2026, 10:44 in the browser's own timezone.
const now = new Date('2026-11-05T10:44:00')
const at = (day: string, time: string) => new Date(`${day}T${time}`).toISOString()
const schedule = (title: string, nextRunAt: string | null, pausedAt: string | null = null) => ({
  title,
  nextRunAt,
  pausedAt,
})

test('each routine shows once, under the day of its next run, in time order', () => {
  const { groups, rest } = agendaOf(
    [
      schedule('Monthly check', at('2026-12-01', '09:00')),
      schedule('Daily triage', at('2026-11-06', '07:00')),
      schedule('Every 3 hours', at('2026-11-05', '12:00')),
      schedule('Weekly Askli', at('2026-11-09', '08:00')),
      schedule('Tender watch', at('2026-11-05', '15:00')),
      schedule('Weekly Lovarank', at('2026-11-09', '08:00')),
    ],
    now,
  )
  assert.deepEqual(
    groups.map((g) => [g.label, g.items.map((s) => s.title)]),
    [
      ['Today', ['Every 3 hours', 'Tender watch']],
      ['Tomorrow', ['Daily triage']],
      ['Monday', ['Weekly Askli', 'Weekly Lovarank']],
      ['Later', ['Monthly check']],
    ],
  )
  assert.deepEqual(rest, [])
})

test('paused routines and those that never run again go to the end', () => {
  const { groups, rest } = agendaOf(
    [
      schedule('Paused', at('2026-11-05', '12:00'), at('2026-11-01', '09:00')),
      schedule('Done for good', null),
      schedule('Live', at('2026-11-05', '12:00')),
    ],
    now,
  )
  assert.deepEqual(
    groups.flatMap((g) => g.items.map((s) => s.title)),
    ['Live'],
  )
  assert.deepEqual(
    rest.map((s) => s.title),
    ['Done for good', 'Paused'],
  )
})

test('a run due already but not yet started stays under Today', () => {
  const { groups } = agendaOf([schedule('Late', at('2026-11-05', '10:40'))], now)
  assert.equal(groups[0]?.label, 'Today')
})

test('rows show the hour within the week, the date after it', () => {
  assert.equal(agendaTime(at('2026-11-05', '12:00'), now), '12:00')
  assert.equal(agendaTime(at('2026-11-11', '08:00'), now), '08:00')
  assert.equal(agendaTime(at('2026-11-16', '07:00'), now), '16 Nov')
})
