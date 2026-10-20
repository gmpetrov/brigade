import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryLineKey, NO_MEMORY_EDIT, type ThreadSpec } from '@brigade/contracts'
import { memoryRun } from '../src/memory.js'
import type { MemorySnapshot } from '../src/memory-layers.js'

const now = new Date('2026-10-21T10:00:00Z')
const riley = { id: 'riley', name: 'Riley' }
const spec = (isPrivate = false) =>
  ({
    sessionId: 's1',
    teammate: { ...riley, harness: 'claude_code' },
    teammates: [riley],
    private: isPrivate,
    project: { id: 'p1', name: 'Brigade', memory: '# Brigade memory\n\n- (stale copy)\n' },
  }) as unknown as ThreadSpec
const project = `# Brigade memory

- PRs are squash-merged.
- Esc never stops a run.

## Sidebar

- The ⋮ menu shows on hover.
`
const snapshot = (extra: Partial<MemorySnapshot> = {}): MemorySnapshot => ({
  workspace: '# Workspace memory\n\n- Brand colour is violet.\n',
  teammate: '# What Riley has learned\n\n- Run the typecheck yourself.\n',
  projects: { p1: project },
  lines: {
    'projects/p1.md': {
      [memoryLineKey('Esc never stops a run.')]: { at: '2026-10-19T09:00:00Z', by: 'Ada' },
    },
  },
  ...extra,
})
const entries = [
  { by: null, name: 'Member', text: 'The ⋮ menu should also show on focus.' },
  { by: 'riley', name: 'Riley', text: 'Done.' },
]
const run = (isPrivate = false, extra: Partial<MemorySnapshot> = {}) =>
  memoryRun({
    spec: spec(isPrivate),
    entries,
    summary: undefined,
    memory: () => snapshot(extra),
    speakers: [riley],
    now,
  })

test('the run reads each memory file whole, numbered and dated, under its core and topics', () => {
  const { prompt } = run()
  assert.match(
    prompt,
    /Memory of the project "Brigade" now:\n<<<\nCore:\n\[1\] PRs are squash-merged\.\n\[2\] Esc never stops a run\. \(19 Oct, by Ada\)\n\nTopic "Sidebar"\n\[3\] The ⋮ menu shows on hover\.\n>>>/,
  )
  // The manifest's copy of the project memory, fresher than the spec's.
  assert.doesNotMatch(prompt, /stale copy/)
  assert.match(prompt, /Workspace memory now:\n<<<\nCore:\n\[1\] Brand colour is violet\./)
  assert.match(prompt, /Memory of Riley now:\n<<<\nCore:\n\[1\] Run the typecheck yourself\./)
  assert.match(prompt, /- replace: \{"line": 12, "text": "…"\}/)
})

test('its answer names lines by number; they go to the API as the lines’ text', () => {
  const { parse } = run()
  const update = parse(
    JSON.stringify({
      summary: 'Asked for the menu on focus.',
      workspace: { add: [], replace: [], remove: [], confirm: [] },
      project: {
        add: [{ text: 'Sections collapse by their title.', topic: 'Sidebar' }, 'A core line.'],
        replace: [{ line: 3, text: 'The ⋮ menu shows on hover or focus.' }],
        remove: [{ line: 2, reason: 'Reversed by the member.' }, 99],
        confirm: [1, 'PRs are squash-merged.'],
      },
      teammates: { Riley: { add: ['1', '2', '3', '4'] } },
    }),
  )
  assert.ok(update)
  assert.deepEqual(update.project, {
    ...NO_MEMORY_EDIT,
    lines: [
      { text: 'Sections collapse by their title.', topic: 'Sidebar' },
      { text: 'A core line.', topic: null },
    ],
    replace: [{ from: 'The ⋮ menu shows on hover.', to: 'The ⋮ menu shows on hover or focus.' }],
    // Line 99 does not exist: dropped.
    archive: [{ text: 'Esc never stops a run.', reason: 'Reversed by the member.' }],
    confirm: ['PRs are squash-merged.'],
  })
  assert.equal(update.teammates[0]?.edit.lines.length, 3)
  assert.equal(parse('not json'), null)
})

test('a private thread changes no workspace or project memory', () => {
  const { parse, prompt } = run(true)
  assert.match(prompt, /- workspace: leave every list empty; this thread is private\./)
  const update = parse(
    JSON.stringify({
      summary: 'x',
      workspace: { add: ['Something'] },
      project: { add: ['Something'] },
      teammates: {},
    }),
  )
  assert.deepEqual(update?.workspace, NO_MEMORY_EDIT)
  assert.equal(update?.project, undefined)
})

test('files that need tidying once the update is applied are named, with the new lines dated today', () => {
  const long = Array.from({ length: 60 }, (_, i) => `- Lesson ${i} ${'x'.repeat(60)}`).join('\n')
  const { parse, tidyAfter } = run(false, { teammate: `# What Riley has learned\n\n${long}\n` })
  const update = parse(
    JSON.stringify({
      summary: 'x',
      teammates: { Riley: { add: [{ text: 'A new lesson.', topic: 'Tests' }] } },
    }),
  )!
  const files = tidyAfter(update)
  // Riley's core is past its 3,000 characters; the short workspace and project files are not touched.
  assert.deepEqual(
    files.map((f) => f.ref),
    [{ kind: 'teammate', teammateId: 'riley' }],
  )
  assert.match(files[0]!.text, /## Tests\n\n- A new lesson\.\n$/)
  assert.ok(files[0]!.fresh.has(memoryLineKey('A new lesson.')))
  assert.equal(files[0]!.lastTidied, null)
})
