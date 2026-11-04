import assert from 'node:assert/strict'
import { test } from 'node:test'
import { messageRuns, type RunEntry } from '../lib/message-runs'

const riley = { author: 'riley' }
const sam = { author: 'sam' }

test('a teammate’s messages in a row show its avatar on the first only', () => {
  const { follows, close } = messageRuns([riley, riley, riley])
  assert.deepEqual([...follows], [1, 2])
  assert.deepEqual([...close], [1, 2])
})

test('steps between keep the run, without drawing the messages close', () => {
  const { follows, close } = messageRuns([riley, 'step', riley, riley])
  assert.deepEqual([...follows], [2, 3])
  assert.deepEqual([...close], [3])
})

test('another teammate, a person’s message or a card starts a new run', () => {
  const entries: RunEntry[] = [riley, sam, riley, 'break', riley, riley]
  assert.deepEqual([...messageRuns(entries).follows], [5])
})

test('a run never starts on a step', () => {
  assert.deepEqual([...messageRuns(['step', riley, 'break', 'step', riley]).follows], [])
})

test('the first message of each run shown names its author, whatever a fold hides', () => {
  // Two finished turns, each folded under its Worked line: only their answers show, each after
  // a person's message and before its turn's line (both breaks). The commentary they folded,
  // by the same teammate, is not among the entries.
  const entries: RunEntry[] = ['break', riley, 'break', 'break', sam, 'break']
  assert.deepEqual([...messageRuns(entries).starts], [1, 4])
  // Within a run, only its first; another teammate starts a run of its own.
  assert.deepEqual([...messageRuns([riley, 'step', riley, sam, riley]).starts], [0, 3, 4])
})
