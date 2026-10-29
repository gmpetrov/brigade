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
