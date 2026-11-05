import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ONBOARDING_QUESTIONS, OnboardingAnswers, setupMessage } from '../dist/index.js'

// Onboarding's questions (src/onboarding.ts): the chief's first message says what was
// answered, and only answers of the closed lists are kept.

const PLAIN = 'Hi Chief, I just started on Brigade. Help me set up my team.'

test('nothing answered, all skipped or only Other: the plain first message', () => {
  assert.equal(setupMessage(null), PLAIN)
  assert.equal(setupMessage({}), PLAIN)
  assert.equal(
    setupMessage({ role: { id: 'other', position: 9 }, firstWork: { id: 'other', position: 6 } }),
    PLAIN,
  )
  // Where they heard of Brigade is for us, never in the message.
  assert.equal(setupMessage({ heardFrom: { id: 'twitter', position: 1 } }), PLAIN)
})

test('the first message says who they are and what to start with', () => {
  assert.equal(
    setupMessage({
      role: { id: 'founder', position: 3 },
      teamSize: { id: '2-10', position: 2 },
      firstWork: { id: 'support', position: 1 },
      heardFrom: { id: 'friend', position: 4 },
    }),
    "Hi Chief, I just started on Brigade. I'm a founder, on a team of 2–10. I'd like my team to start with customer support. Help me set up my team.",
  )
  assert.equal(
    setupMessage({ teamSize: { id: 'solo', position: 1 } }),
    "Hi Chief, I just started on Brigade. I'm working solo. Help me set up my team.",
  )
  assert.equal(
    setupMessage({ role: { id: 'marketing', position: 1 } }),
    'Hi Chief, I just started on Brigade. I work in marketing. Help me set up my team.',
  )
  assert.equal(
    setupMessage({ firstWork: { id: 'code', position: 2 } }),
    "Hi Chief, I just started on Brigade. I'd like my team to start with code. Help me set up my team.",
  )
})

test('only answers of the lists are kept', () => {
  assert.deepEqual(OnboardingAnswers.parse({}), {})
  assert.equal(OnboardingAnswers.safeParse({ role: { id: 'ceo', position: 1 } }).success, false)
  assert.equal(
    OnboardingAnswers.safeParse({ teamSize: { id: 'solo', position: 0 } }).success,
    false,
  )
  assert.equal(OnboardingAnswers.safeParse({ role: { id: 'founder' } }).success, false)
})

test('each question has its own ids, Other last, and a phrase for every option said', () => {
  for (const question of ONBOARDING_QUESTIONS) {
    const ids = question.options.map((o) => o.id)
    assert.equal(new Set(ids).size, ids.length, question.key)
    const other = ids.indexOf('other')
    assert.ok(other === -1 || other === ids.length - 1, `${question.key}: Other last`)
    // Every id must be a word PostHog's person properties take as it is.
    for (const id of ids) assert.match(id, /^[a-z0-9][a-z0-9_-]{0,39}$/)
  }
})
