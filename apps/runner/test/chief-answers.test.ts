import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ThreadSpec } from '@brigade/contracts'
import { chiefTools } from '../src/harness/tools.js'
import { instructions } from '../src/instructions.js'
import { threadMemory } from '../src/memory-layers.js'

// What teammates and Chief are told of a person's rules and daily pass (docs/chief-answers.md):
// nothing when they have none, so a member with none gets the instructions as before.
const spec = (extra: Record<string, unknown> = {}, kind: 'teammate' | 'chief' = 'teammate') =>
  ThreadSpec.parse({
    sessionId: 's1',
    teammate: {
      id: kind === 'chief' ? 'chief' : 'riley',
      name: kind === 'chief' ? 'Chief' : 'Riley',
      instructions: '',
      harness: 'claude_code',
      model: null,
      kind,
    },
    permissionMode: 'allow-all',
    account: { id: 'a1', provider: 'claude_code', source: 'machine' },
    fallbacks: [],
    teammates: [{ id: 'riley', name: 'Riley' }],
    ...extra,
  })

const write = (s: ThreadSpec) =>
  instructions(
    s,
    threadMemory(
      s,
      {
        workspace: '# Workspace memory\n\n- By the member’s choice, PRs are squash-merged.\n',
        teammate: '',
        lines: {},
      },
      '/threads/s1',
      new Date('2026-11-05T10:00:00Z'),
    ),
    '/library',
    { ready: true },
  )

test('off, the instructions are as before; with the pass on, teammates learn what an answer of Chief’s is', () => {
  const before = write(spec())
  assert.equal(write(spec({ chiefAnswers: false, rules: null })), before)
  assert.ok(!before.includes('Chief answered for you'))
  const on = write(spec({ chiefAnswers: true }))
  assert.match(on, /## Chief answers for the person/)
  assert.match(
    on,
    /Each morning, Chief, this workspace's chief of staff, goes through what waits on the person/,
  )
  assert.match(on, /"Chief answered for you:"/)
  assert.match(on, /It is not the person\. Anything that leaves Brigade/)
  assert.match(on, /marked Chief's answer as wrong, stop what you started on it/)
  // Everything else is as it was.
  assert.equal(
    on.replace(/\n\n## Chief answers for the person[\s\S]*?wait for what they say next\./, ''),
    before,
  )
})

test('a teammate reads the rules of the person it works for, and asks only the rest', () => {
  const before = write(spec())
  const text = write(
    spec({
      rules: { person: 'Ada', text: '- Admin work: go ahead on next steps\n- Visual: ask me' },
    }),
  )
  assert.match(
    text,
    /## Ada's rules\n\nAda wrote these rules for the work teammates do for them:\n\n> - Admin work: go ahead on next steps\n> - Visual: ask me/,
  )
  assert.match(text, /Decide yourself what they settle instead of asking, and say so in a line/)
  assert.match(text, /They are not Ada's approval for what leaves Brigade/)
  // Everything else is as it was.
  assert.equal(text.replace(/\n\n## Ada's rules[\s\S]*?as it does without rules\./, ''), before)
})

test('Chief writes people’s rules with them, and is not told of its own answers as a teammate is', () => {
  const text = write(spec({ chiefAnswers: true, rulesAct: true }, 'chief'))
  assert.match(text, /### Their rules/)
  assert.match(text, /save them whole with `chief_rules`/)
  assert.match(text, /Every teammate working for them reads them, decides what they settle/)
  assert.match(text, /answer in their name what their rules settle/)
  // While rules are calibrated: its pass only recommends by them, and teammates still ask.
  const calibrating = write(spec({}, 'chief'))
  assert.match(calibrating, /save them whole with `chief_rules`/)
  assert.match(
    calibrating,
    /For now, while they see how you read them, only your daily pass uses them/,
  )
  assert.match(calibrating, /Their teammates still ask them\./)
  assert.ok(!calibrating.includes('Every teammate working for them reads them'))
  assert.ok(!calibrating.includes('answer in their name'))
  assert.ok(!text.includes('## Chief answers for the person'))
  assert.ok(!text.includes('chief/mandate.md'))
  assert.ok(!text.includes('chief_decide'))
})

test('a pass goes through what waits on its person by their rules, and is told nothing of the work', () => {
  const text = write(spec({ pass: { id: 'p1', acts: true } }, 'chief'))
  assert.match(text, /## The person's daily pass/)
  assert.match(text, /answer it in their name with `chief_answer`/)
  assert.match(text, /With no rules, answer nothing\./)
  assert.match(text, /never on taste \(a design, a wording, a name\)/)
  assert.match(text, /try it again with `chief_retry`/)
  assert.match(text, /Tickets and pull requests are always theirs/)
  assert.match(text, /Then call `chief_report` once, last/)
  // What it learned stays what it goes by.
  assert.match(text, /By the member’s choice, PRs are squash-merged\./)
  for (const absent of [
    '## Buttons and choices',
    '## Code',
    '## Previews',
    '## Child threads',
    '## You are the chief',
  ])
    assert.ok(!text.includes(absent), absent)
})

test('a pass that only recommends is told so, answers nothing, and has its report alone', async () => {
  for (const pass of [{ id: 'p1' }, { id: 'p1', acts: false }]) {
    const text = write(spec({ pass }, 'chief'))
    assert.match(text, /## The person's daily pass/)
    assert.match(
      text,
      /For now they want recommendations only, while they see how you read their rules: you answer nothing, try nothing again and start nothing in their name\./,
    )
    assert.match(
      text,
      /the answer you would pick, by its number, and the rule of theirs it goes by/,
    )
    assert.match(text, /whether trying it again is worth it/)
    assert.match(text, /Call `chief_report` once, last: `decisions`, every item/)
    for (const absent of [
      'chief_answer',
      'chief_retry',
      '## Buttons and choices',
      '## You are the chief',
    ])
      assert.ok(!text.includes(absent), absent)
  }
  // Its tools: its report alone, which carries the rule of each pick; with chief_acts, all three.
  const calls: { operation: unknown }[] = []
  const call = async (c: { operation: unknown }) => {
    calls.push(c)
    return { ok: true }
  }
  assert.deepEqual(Object.keys(chiefTools(call, { pass: true })), ['chief_report'])
  assert.deepEqual(Object.keys(chiefTools(call, { pass: true, acts: true })), [
    'chief_answer',
    'chief_retry',
    'chief_report',
  ])
  assert.deepEqual(Object.keys(chiefTools(call, { pass: false })), ['chief_rules'])
  await chiefTools(call, { pass: true }).chief_report!.execute!(
    {
      decisions: [
        { item: 1.2, recommendation: 'Build it.', option: 1, rule: ' Go ahead on next steps ' },
        { item: 2, recommendation: 'Try it again.', rule: '  ' },
      ],
    },
    { toolCallId: 'call-1', messages: [] } as never,
  )
  assert.deepEqual(calls[0]!.operation, {
    name: 'chief_report',
    decisions: [
      { item: 1, recommendation: 'Build it.', option: 1, rule: 'Go ahead on next steps' },
      { item: 2, recommendation: 'Try it again.' },
    ],
    notes: [],
    rules: [],
  })
})
