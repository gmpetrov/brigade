import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ThreadSpec } from '@brigade/contracts'
import { instructions } from '../src/instructions.js'
import { threadMemory } from '../src/memory-layers.js'

// What teammates are told of Chief's answers for the person (docs/chief-answers.md): nothing when
// they are off, so a member who turns them off gets the instructions as before.
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

test('off, the instructions are as before; on, teammates learn what an answer of Chief’s is', () => {
  const before = write(spec())
  assert.equal(write(spec({ chiefAnswers: false })), before)
  assert.ok(!before.includes('Chief answered for you'))
  const on = write(spec({ chiefAnswers: true }))
  assert.match(on, /## Chief answers for the person/)
  assert.match(on, /"Chief answered for you:"/)
  assert.match(on, /It is not the person\. Anything that leaves Brigade/)
  assert.match(on, /marked Chief's answer as wrong, stop what you started on it/)
  // Everything else is as it was.
  assert.equal(
    on.replace(/\n\n## Chief answers for the person[\s\S]*?wait for what they say next\./, ''),
    before,
  )
})

test('Chief keeps the mandate when on, and writes the first one with the team', () => {
  const off = write(spec({}, 'chief'))
  assert.ok(!off.includes('Answering for the person'))
  assert.ok(!off.includes('chief/mandate.md'))
  const on = write(spec({ chiefAnswers: true }, 'chief'))
  assert.match(on, /### Answering for the person/)
  assert.match(on, /`chief\/mandate\.md`/)
  assert.match(on, /Before you welcome them, save their first mandate/)
  assert.match(on, /`chief_decisions`/)
  // Chief is not told about its own answers as a teammate is.
  assert.ok(!on.includes('## Chief answers for the person'))
})

test('a decision thread reads by the mandate and decides, and is told nothing of the work', () => {
  const text = write(
    spec({ decision: { id: 'd1' }, parent: { id: 'p1', title: 'Admin page' } }, 'chief'),
  )
  assert.match(text, /## Deciding a question for the person/)
  assert.match(text, /call `chief_decide` once and end your turn/)
  assert.match(text, /- escalate: leave it to the person when it is taste or outside/)
  assert.match(
    text,
    /Never answer with something that sends, publishes, deploys, merges, pays or deletes/,
  )
  // The person's decisions in memory are what it goes by.
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
