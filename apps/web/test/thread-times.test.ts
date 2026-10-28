import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PAUSE_MS, pauseLabel, pauses } from '../lib/thread-times'

const at = (iso: string) => Date.parse(iso)
const user = (key: string, iso: string, steeredTo?: string) => ({
  kind: 'user',
  key,
  at: at(iso),
  ...(steeredTo ? { steeredTo } : {}),
})

test('the first message gets its time', () => {
  assert.deepEqual([...pauses([user('u1', '2026-10-28T10:00:00')]).keys()], ['u1'])
})

test('a message soon after the turn before gets none', () => {
  const items = [
    user('u1', '2026-10-28T10:00:00'),
    { kind: 'start', key: 's2', at: at('2026-10-28T10:00:01') },
    { kind: 'assistant', key: 'm3' },
    { kind: 'turn', key: 't4', at: at('2026-10-28T10:40:00') },
    user('u5', '2026-10-28T11:20:00'),
  ]
  assert.deepEqual([...pauses(items).keys()], ['u1'])
})

test('an hour after the turn ended, the message gets its time', () => {
  const items = [
    user('u1', '2026-10-28T10:00:00'),
    { kind: 'turn', key: 't2', at: at('2026-10-28T10:10:00') },
    user('u3', new Date(at('2026-10-28T10:10:00') + PAUSE_MS).toISOString()),
  ]
  assert.deepEqual([...pauses(items).keys()], ['u1', 'u3'])
})

test('another day, even minutes later', () => {
  const items = [user('u1', '2026-10-28T23:55:00'), user('u2', '2026-10-29T00:05:00')]
  assert.deepEqual([...pauses(items).keys()], ['u1', 'u2'])
})

test('a message steered into the running turn gets none', () => {
  const items = [user('u1', '2026-10-28T10:00:00'), user('u2', '2026-10-28T12:00:00', 'riley')]
  assert.deepEqual([...pauses(items).keys()], ['u1'])
})

test('labels by how long ago', () => {
  const now = at('2026-10-28T16:00:00')
  const time = (iso: string) =>
    new Date(at(iso)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  assert.equal(pauseLabel(at('2026-10-28T09:05:00'), now), time('2026-10-28T09:05:00'))
  assert.equal(
    pauseLabel(at('2026-10-27T18:51:00'), now),
    `Yesterday ${time('2026-10-27T18:51:00')}`,
  )
  assert.match(pauseLabel(at('2026-10-23T14:30:00'), now), /^\S+ \S/)
  assert.match(pauseLabel(at('2026-09-14T08:33:00'), now), /, /)
  assert.match(pauseLabel(at('2025-09-14T08:33:00'), now), /2025/)
})
