import assert from 'node:assert/strict'
import { test } from 'node:test'
import { answeredSinceStep, closingStep, quickReplies, type ChatEntry } from '../lib/chat-turn'

// A turn a person wrote into: their messages and what answers them stay in order, its steps
// together (docs/decisions.md, "A person's message during a turn goes into that turn").

test('a reply right after a message steered in, before the next step, answers it', () => {
  const entries: ChatEntry[] = [
    'step',
    'steered',
    'other',
    'message',
    'step',
    'steered',
    'step',
    'message',
  ]
  assert.deepEqual([...quickReplies(entries)], [3])
})

test('a turn answered since its last step starts afresh at the next message; a quick reply does not count', () => {
  // Waiting on its background work after answering: the answer stands.
  assert.equal(answeredSinceStep(['step', 'message']), true)
  // Mid-work, or only a quick reply since the step: the turn goes on as one.
  assert.equal(answeredSinceStep(['step', 'steered', 'step']), false)
  assert.equal(answeredSinceStep(['step', 'steered', 'message']), false)
  assert.equal(answeredSinceStep(['steered', 'message']), false)
  assert.equal(answeredSinceStep([]), false)
})

test('a complete_thread call shows as a step only when it did not close the thread', () => {
  const call = {
    seq: 4,
    toolName: 'mcp__harness-tools__complete_thread',
    input: { summary: 'Done' },
  }
  const closed = {
    done: { summary: 'Done', at: '2026-11-04T13:32:13.785Z' },
    next: 'The thread is done.',
  }
  assert.equal(closingStep(call, closed), undefined)
  const refused = { error: 'Not done yet: pull request #681 is still open.' }
  assert.deepEqual(closingStep(call, refused), { ...call, output: refused, finished: true })
  assert.deepEqual(closingStep(call, 'boom', true), {
    ...call,
    output: 'boom',
    isError: true,
    finished: true,
  })
})
