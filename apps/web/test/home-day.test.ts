import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BoardCard, BoardRoutine } from '@brigade/contracts'
import { doneToday, namesInWords, routinesOfToday } from '../lib/home-day'

const now = new Date('2026-11-02T15:00:00')
const local = (time: string, day = '2026-11-02') => new Date(`${day}T${time}`).toISOString()

test('names read as a sentence, and stay short past three', () => {
  assert.equal(namesInWords([]), '')
  assert.equal(namesInWords(['Riley']), 'Riley')
  assert.equal(namesInWords(['Riley', 'Max']), 'Riley and Max')
  assert.equal(namesInWords(['Riley', 'Max', 'Ada']), 'Riley, Max and Ada')
  assert.equal(namesInWords(['Riley', 'Max', 'Ada', 'Bob', 'Eve']), 'Riley, Max and 3 others')
})

const card = (column: BoardCard['column'], doneAt: string | null): BoardCard =>
  ({
    key: Math.random().toString(),
    column,
    at: doneAt ?? local('09:00'),
    done: doneAt ? { at: doneAt, by: null } : null,
  }) as BoardCard

test("counts the Board's done cards of today only", () => {
  const cards = [
    card('done', local('08:00')),
    card('done', local('14:59')),
    card('done', local('23:00', '2026-11-01')),
    card('in_progress', null),
    card('needs_you', null),
  ]
  assert.equal(doneToday({ cards }, now), 2)
})

const routine = (id: string, extra: Partial<BoardRoutine>): BoardRoutine => ({
  id,
  title: id,
  cron: '0 9 * * *',
  timezone: 'Europe/Paris',
  teammate: { id: 't', name: 'Riley' },
  projectId: null,
  health: 'ok',
  week: { runs: 0, failed: 0 },
  today: { runs: 0, nothing: 0, pulls: [] },
  running: null,
  last: null,
  error: null,
  nextRunAt: null,
  listIds: [],
  ...extra,
})

test("lists today's routines in the day's order: ran, running, then still to come", () => {
  const rows = routinesOfToday(
    [
      routine('later', { nextRunAt: local('18:00') }),
      routine('ran', {
        today: { runs: 1, nothing: 0, pulls: [] },
        last: { id: 'r', at: local('09:00'), outcome: 'report', summary: null },
        nextRunAt: local('21:00'),
      }),
      routine('running', {
        today: { runs: 1, nothing: 0, pulls: [] },
        running: { id: 'x', since: local('14:30') },
      }),
      routine('tomorrow', { nextRunAt: local('09:00', '2026-11-03') }),
      routine('paused', { health: 'paused', nextRunAt: local('17:00') }),
      routine('yesterday', {
        last: { id: 'y', at: local('09:00', '2026-11-01'), outcome: 'report', summary: null },
        nextRunAt: local('09:00', '2026-11-03'),
      }),
    ],
    now,
  )
  assert.deepEqual(
    rows.map((r) => [r.routine.id, r.ran, r.next]),
    [
      ['ran', true, local('21:00')],
      ['running', true, null],
      ['later', false, null],
    ],
  )
  assert.equal(rows[0]!.at, local('09:00'))
})
