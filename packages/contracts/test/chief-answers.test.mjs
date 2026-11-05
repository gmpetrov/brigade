import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CHIEF_ANSWER_RULE,
  chiefAnswerMessage,
  chiefAnswerNote,
  chiefOverruledMessage,
  chiefOverruledNote,
  chiefPassBrief,
  isChiefOperation,
  isChiefPassBrief,
  ScheduleOperation,
  SetChief,
} from '../dist/index.js'

test("Chief's answer reads back: the words a click sends, why, the rule and its decision", () => {
  const text = chiefAnswerMessage({
    decisionId: 'cmabc123',
    answer: 'Build it',
    reason: 'It serves this week’s launch,\nand it is a pull request.',
    basis: 'Admin work: go ahead on next steps.',
  })
  assert.match(text, /^Chief answered for you: Build it\nWhy: It serves this week’s launch, and it/)
  assert.match(text, /\nBy their rule: Admin work: go ahead on next steps\.\n/)
  assert.ok(text.includes(CHIEF_ANSWER_RULE))
  assert.deepEqual(chiefAnswerNote(text), {
    answer: 'Build it',
    reason: 'It serves this week’s launch, and it is a pull request.',
    basis: 'Admin work: go ahead on next steps.',
    decisionId: 'cmabc123',
  })
  const bare = chiefAnswerMessage({ decisionId: 'd1', answer: 'Go with A · Bold', reason: 'r' })
  assert.deepEqual(chiefAnswerNote(bare), {
    answer: 'Go with A · Bold',
    reason: 'r',
    basis: null,
    decisionId: 'd1',
  })
  // An answer from before the rules still reads back.
  assert.equal(
    chiefAnswerNote(text.replace('By their rule: ', 'From the mandate: '))?.basis,
    'Admin work: go ahead on next steps.',
  )
  // A person writing the same words is not Chief.
  assert.equal(chiefAnswerNote('Chief answered for you: Build it'), null)
  assert.equal(chiefAnswerNote(`${bare}\nmore`), null)
})

test('a wrong answer reads back', () => {
  const text = chiefOverruledMessage({ decisionId: 'd2', answer: 'Not yet' })
  assert.deepEqual(chiefOverruledNote(text), { answer: 'Not yet', decisionId: 'd2' })
  assert.equal(chiefOverruledNote('Stop it'), null)
})

test('a pass brief numbers what waits, with the rules, a design as theirs, and says when there are none', () => {
  const brief = chiefPassBrief({
    person: 'Ada',
    day: '2026-11-06',
    rules: null,
    refused: ['Never ask about tests'],
    items: [
      {
        kind: 'question',
        n: 1,
        title: 'Admin page',
        sessionId: 's1',
        teammate: 'Riley',
        teammateId: 't1',
        askSeq: 7,
        options: [
          {
            label: 'A · Bold',
            message: 'Go with A · Bold',
            description: 'Large type',
            design: true,
          },
          { label: 'B · Calm', message: 'Go with B · Calm' },
        ],
        question: 'Here are two cards.',
        cardQuestion: 'Which card should I build?',
      },
      {
        kind: 'failed',
        n: 2,
        title: 'Rollout',
        sessionId: 's2',
        teammate: 'Riley',
        error: 'Timed out',
      },
      {
        kind: 'pull',
        n: 3,
        title: 'Rollout',
        sessionId: 's2',
        pull: 'acme/web#7: Rollout',
        state: 'ready to merge',
      },
    ],
    answers: [
      { thread: 'Admin page', question: 'Shall I? [Build it / Not yet]', picked: 'Build it' },
    ],
  })
  assert.ok(isChiefPassBrief(brief))
  assert.match(brief, /## Ada's rules\n\(None yet\. Answer nothing in their name/)
  assert.match(
    brief,
    /1\. "Admin page": Riley ended its reply on a question\.\n {3}Question: Which card should I build\?/,
  )
  assert.match(
    brief,
    /Answers: 1\) A · Bold \(Large type\) \[a design: theirs to pick\] {2}2\) B · Calm/,
  )
  assert.match(brief, /2\. "Rollout": Riley's turn stopped on an error: Timed out/)
  assert.match(
    brief,
    /3\. "Rollout": pull request acme\/web#7: Rollout \(ready to merge\)\. Theirs to merge\./,
  )
  assert.match(
    brief,
    /## Their answers to questions lately\n- "Admin page": Shall I\? \[Build it \/ Not yet\] → Build it/,
  )
  assert.match(
    brief,
    /## Rules they refused \(never propose these again\)\n- Never ask about tests/,
  )
  assert.ok(!isChiefPassBrief('Add the migration.'))
})

test("Chief's operations go through the schedule calls", () => {
  const answer = ScheduleOperation.parse({
    name: 'chief_answer',
    item: 1,
    option: 2,
    reason: 'It is next.',
    rule: 'Go ahead on next steps',
  })
  assert.ok(isChiefOperation(answer))
  const report = ScheduleOperation.parse({ name: 'chief_report' })
  assert.ok(isChiefOperation(report))
  assert.deepEqual(report, { name: 'chief_report', decisions: [], notes: [], rules: [] })
  assert.ok(isChiefOperation(ScheduleOperation.parse({ name: 'chief_rules', rules: '- x' })))
  assert.ok(
    isChiefOperation(ScheduleOperation.parse({ name: 'chief_retry', item: 2, reason: 'r' })),
  )
  // An answer goes by a rule.
  assert.throws(() =>
    ScheduleOperation.parse({ name: 'chief_answer', item: 1, option: 1, reason: 'r' }),
  )
})

test('a member sends their pass, rules or timezone', () => {
  assert.ok(SetChief.safeParse({ pass: false }).success)
  assert.ok(SetChief.safeParse({ rules: '- Go ahead on fixes' }).success)
  assert.ok(SetChief.safeParse({ pass: true, timezone: 'Europe/Paris' }).success)
  assert.ok(!SetChief.safeParse({}).success)
  assert.ok(!SetChief.safeParse({ rules: 'x'.repeat(4_001) }).success)
})
