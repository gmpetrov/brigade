import assert from 'node:assert/strict'
import { test } from 'node:test'
import { answeredSinceStep, quickReplies, type ChatEntry } from '../lib/chat-turn'

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
