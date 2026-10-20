import assert from 'node:assert/strict'
import { test } from 'node:test'
import { suggestionFor } from '../dist/suggestions.js'

const at = '2026-10-20T15:00:00.000Z'
const said = (memberId, text = 'Pourquoi le badge reste à 0 ?') => ({
  at,
  type: 'message.user',
  text,
  memberId,
})
const answer = { at, type: 'message.done', id: 't1', text: 'Le service worker ne le recevait pas.' }
const done = { at, type: 'turn.completed', finishReason: 'stop' }
const guess = (text = 'Corrige-le et ouvre une PR') => ({ at, type: 'message.suggested', text })
const card = (toolName) => ({ at, type: 'tool.started', toolCallId: 'c', toolName, input: {} })

test('the member who wrote last sees the guess that ends the thread', () => {
  const events = [said('ada'), answer, done, guess()]
  assert.deepEqual(suggestionFor(events, 'ada'), { index: 3, text: 'Corrige-le et ouvre une PR' })
})

test('nobody else sees it, nor anyone when Brigade wrote last', () => {
  assert.equal(suggestionFor([said('ada'), answer, done, guess()], 'bob'), null)
  assert.equal(suggestionFor([said(null), answer, done, guess()], 'ada'), null)
  assert.equal(suggestionFor([said('ada'), answer, done, guess()], null), null)
})

test('it stays through events nobody did, and goes once anything happens', () => {
  const usage = { at, type: 'usage.updated', inputTokens: 10, outputTokens: 2 }
  const note = { at, type: 'raw', source: 'runner', value: 'A note' }
  assert.equal(suggestionFor([said('ada'), answer, done, guess(), usage, note], 'ada')?.index, 3)
  const started = { at, type: 'turn.started', teammateId: 'riley', accountId: 'a' }
  assert.equal(suggestionFor([said('ada'), answer, done, guess(), started], 'ada'), null)
  assert.equal(
    suggestionFor([said('ada'), answer, done, guess(), said('ada', 'Merci')], 'ada'),
    null,
  )
  const queued = {
    at,
    type: 'message.queued',
    messageId: 'm',
    text: 'x',
    memberId: 'ada',
    waitingFor: 'turn',
  }
  assert.equal(suggestionFor([said('ada'), answer, done, guess(), queued], 'ada'), null)
})

test('the latest guess counts, after the turns of other teammates', () => {
  const started = { at, type: 'turn.started', teammateId: 'sam', accountId: 'a' }
  const events = [said('ada'), answer, done, guess('Old'), started, answer, done, guess('Ship it')]
  assert.deepEqual(suggestionFor(events, 'ada'), { index: 7, text: 'Ship it' })
})

test('reply pills, choices, a team or a question come first', () => {
  for (const toolName of ['suggest_replies', 'offer_choices', 'mcp__harness-tools__propose_team'])
    assert.equal(suggestionFor([said('ada'), answer, card(toolName), done, guess()], 'ada'), null)
  const asked = { at, type: 'question.asked', questionId: 'q', questions: [] }
  assert.equal(suggestionFor([said('ada'), asked, done, guess()], 'ada'), null)
  // Cards from an earlier turn do not count.
  const events = [
    said('ada'),
    card('suggest_replies'),
    done,
    said('ada', 'Non'),
    answer,
    done,
    guess(),
  ]
  assert.equal(suggestionFor(events, 'ada')?.index, 6)
  // A widget is no answer to pick.
  assert.equal(
    suggestionFor([said('ada'), card('show_widget'), answer, done, guess()], 'ada')?.index,
    4,
  )
})

test('an empty guess is none', () => {
  assert.equal(suggestionFor([said('ada'), answer, done, guess('  ')], 'ada'), null)
  assert.equal(suggestionFor([], 'ada'), null)
})
