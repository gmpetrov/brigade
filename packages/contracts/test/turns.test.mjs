import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LINE_CHARS, turnAnswer, visibleChars } from '../dist/events.js'

const message = (chars) => ({ kind: 'message', chars })
const step = { kind: 'step' }
const other = { kind: 'other' }

test('the answer is every message after the last step of work', () => {
  // "Checking the tests", a command, the answer, a card refused and called again, a last line.
  assert.deepEqual(turnAnswer([message(30), step, message(1200), other, other, message(60)]), {
    first: 2,
    messages: [2, 5],
  })
})

test('with nothing after the last step, the last message answers', () => {
  assert.deepEqual(turnAnswer([other, message(900), step]), { first: 1, messages: [1] })
  assert.deepEqual(turnAnswer([other, step]), { first: -1, messages: [] })
})

test('a long answer followed by a step and a short line stays an answer', () => {
  // The answer, then git push, then "Pushed."
  assert.deepEqual(turnAnswer([step, message(1500), step, message(7)]), {
    first: 3,
    messages: [1, 3],
  })
  // Two sentences, a command, then the line the runner asked for on what it did.
  assert.deepEqual(turnAnswer([other, message(270), step, other, message(40)]), {
    first: 4,
    messages: [1, 4],
  })
})

test('a short line before the last step is no answer of its own', () => {
  // "Running the tests", the tests, "All pass."
  assert.deepEqual(turnAnswer([message(LINE_CHARS - 1), step, message(9)]), {
    first: 2,
    messages: [2],
  })
  // A long answer after the last step needs nothing before it.
  assert.deepEqual(turnAnswer([message(900), step, message(600)]), { first: 2, messages: [2] })
})

test('before a steered message, only a message after the last step answers', () => {
  // It answered, then only waited on a server it left running: the message went in.
  assert.deepEqual(turnAnswer([message(30), step, message(1200)], true), {
    first: 2,
    messages: [2],
  })
  // It was still at work: its last line is no answer.
  assert.deepEqual(turnAnswer([other, message(900), step], true), { first: -1, messages: [] })
})

test('counts only the characters a person sees', () => {
  assert.equal(visibleChars(' a b\n\u200b'), 2)
  assert.equal(visibleChars('\u200b\ufeff '), 0)
})
