import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CHIEF_ANSWER_RULE,
  chiefAnswerMessage,
  chiefAnswerNote,
  chiefDecisionBrief,
  chiefOverruledMessage,
  chiefOverruledNote,
  isChiefDecisionBrief,
  isChiefOperation,
  ScheduleOperation,
  SetChief,
} from '../dist/index.js'

test("Chief's answer reads back: the words a click sends, why, the mandate line and its decision", () => {
  const text = chiefAnswerMessage({
    decisionId: 'cmabc123',
    answer: 'Build it',
    reason: 'It serves this week’s launch,\nand it is a pull request.',
    basis: 'This week: the launch.',
  })
  assert.match(text, /^Chief answered for you: Build it\nWhy: It serves this week’s launch, and it/)
  assert.ok(text.includes(CHIEF_ANSWER_RULE))
  assert.deepEqual(chiefAnswerNote(text), {
    answer: 'Build it',
    reason: 'It serves this week’s launch, and it is a pull request.',
    basis: 'This week: the launch.',
    decisionId: 'cmabc123',
  })
  const bare = chiefAnswerMessage({ decisionId: 'd1', answer: 'Go with A · Bold', reason: 'r' })
  assert.deepEqual(chiefAnswerNote(bare), {
    answer: 'Go with A · Bold',
    reason: 'r',
    basis: null,
    decisionId: 'd1',
  })
  // A person writing the same words is not Chief.
  assert.equal(chiefAnswerNote('Chief answered for you: Build it'), null)
  assert.equal(chiefAnswerNote(`${bare}\nmore`), null)
})

test('a wrong answer reads back', () => {
  const text = chiefOverruledMessage({ decisionId: 'd2', answer: 'Not yet' })
  assert.deepEqual(chiefOverruledNote(text), { answer: 'Not yet', decisionId: 'd2' })
  assert.equal(chiefOverruledNote('Stop it'), null)
})

test('a decision brief numbers the answers and says when there is no mandate', () => {
  const brief = chiefDecisionBrief({
    person: 'Ada',
    teammate: 'Riley',
    threadTitle: 'Admin page',
    request: 'Add the migration.',
    question: 'The migration is ready. Shall I build the admin page too?',
    options: [
      { label: 'Build it', message: 'Build it' },
      { label: 'Not yet', message: 'Not yet' },
    ],
    mandate: null,
    earlier: [],
  })
  assert.ok(isChiefDecisionBrief(brief))
  assert.match(brief, /## The answers it offers\n1\. Build it\n2\. Not yet/)
  assert.match(brief, /## Ada's mandate\n\(None yet:/)
  assert.ok(!isChiefDecisionBrief('Add the migration.'))
})

test("Chief's operations go through the schedule calls", () => {
  const op = ScheduleOperation.parse({
    name: 'chief_decide',
    verdict: 'answer',
    option: 1,
    kind: 'next_step',
    reason: 'It is next.',
  })
  assert.ok(isChiefOperation(op))
  assert.ok(isChiefOperation(ScheduleOperation.parse({ name: 'chief_decisions' })))
  assert.throws(() =>
    ScheduleOperation.parse({
      name: 'chief_decide',
      verdict: 'maybe',
      kind: 'next_step',
      reason: 'r',
    }),
  )
})

test('a member sends on, or a kind alone, not both', () => {
  assert.ok(SetChief.safeParse({ on: false }).success)
  assert.ok(SetChief.safeParse({ alone: { kind: 'approach', on: true } }).success)
  assert.ok(!SetChief.safeParse({}).success)
  assert.ok(!SetChief.safeParse({ on: true, alone: { kind: 'approach', on: true } }).success)
  assert.ok(!SetChief.safeParse({ alone: { kind: 'taste', on: true } }).success)
})
