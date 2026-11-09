import assert from 'node:assert/strict'
import { test } from 'node:test'
import { windowStart } from '../lib/thread-window'

// A thread as its items: a person's message (its seq), then the teammate's work and reply.
const turn = (seq: number) => [
  { kind: 'user', seq },
  { kind: 'start' },
  { kind: 'tool', seq: seq + 1 },
  { kind: 'assistant', seq: seq + 2 },
  { kind: 'turn' },
]
const thread = (messages: number) =>
  Array.from({ length: messages }, (_, i) => turn(i * 10 + 1)).flat()

test('a long thread opens on its last messages', () => {
  // Ten messages, at seqs 1, 11, … 91: from the third last (71).
  assert.equal(windowStart(thread(10), 3), 71)
  // Reading up: three more before it.
  assert.equal(windowStart(thread(10), 3, 71), 41)
  // Fewer left above than asked: all of it.
  assert.equal(windowStart(thread(10), 5, 41), null)
})

test('a short thread shows all of it', () => {
  assert.equal(windowStart(thread(3), 5), null)
  // As many as it opens on: nothing above to hold back.
  assert.equal(windowStart(thread(5), 5), null)
  assert.equal(windowStart([], 5), null)
})

test('it starts only where a turn starts', () => {
  const items = [
    ...thread(4),
    { kind: 'user', seq: 41 },
    { kind: 'start' },
    // Answered on the side, or given to the running turn: part of that turn.
    { kind: 'user', seq: 43, side: { status: 'answered' } },
    { kind: 'user', seq: 44, steeredTo: 'riley' },
    { kind: 'assistant', seq: 45 },
    { kind: 'turn' },
  ]
  assert.equal(windowStart(items, 1), 41)
  assert.equal(windowStart(items, 2), 31)
})
