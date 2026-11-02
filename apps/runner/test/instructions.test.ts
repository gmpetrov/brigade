import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryLineKey, ThreadSpec } from '@brigade/contracts'
import { instructions } from '../src/instructions.js'
import { threadMemory } from '../src/memory-layers.js'

const now = new Date('2026-10-21T10:00:00Z')
const testSpec = (project: string, isPrivate = false) =>
  ThreadSpec.parse({
    sessionId: 's1',
    teammate: { id: 'riley', name: 'Riley', instructions: '', harness: 'claude_code', model: null },
    permissionMode: 'allow-all',
    account: { id: 'a1', provider: 'claude_code', source: 'machine' },
    fallbacks: [],
    teammates: [{ id: 'riley', name: 'Riley' }],
    private: isPrivate,
    project: {
      id: 'p1',
      name: 'Brigade',
      brief: '',
      memory: project,
      folder: null,
      repositories: [],
      connections: [],
    },
  })

const project = `# Brigade memory

- PRs are squash-merged.

## Sidebar

What the sidebar shows and how it behaves.

- The ⋮ menu shows on hover.
`

test('a thread loads each memory’s dated core, and its topics by name, size and file', () => {
  const spec = testSpec(project)
  const memory = threadMemory(
    spec,
    {
      workspace: '# Workspace memory\n\n- Brand colour is violet.\n',
      teammate: '',
      lines: {
        'projects/p1.md': {
          [memoryLineKey('PRs are squash-merged.')]: { at: '2026-10-19T09:00:00Z' },
        },
      },
    },
    '/threads/s1',
    now,
  )
  const text = instructions(spec, memory, '/library', { ready: true })
  assert.match(text, /## Workspace memory\n\n- Brand colour is violet\.\n/)
  assert.match(
    text,
    /## Project memory: Brigade\n\n- PRs are squash-merged\. \(19 Oct\)\n\nTopics, each in its own file: read one before work it bears on\.\n- Sidebar: What the sidebar shows and how it behaves \(1 line\): `\/threads\/s1\/\.brigade-memory\/project\/sidebar\.md`\n/,
  )
  // Nothing learned yet: no section.
  assert.doesNotMatch(text, /## What you have learned/)
  assert.match(
    text,
    /## Memory\n\nEach memory line ends with the day it was learned or last confirmed/,
  )
  assert.match(text, /the newer one wins/)
  assert.doesNotMatch(text, /this thread is private/)
})

test('a private thread is told it writes only to its own memory', () => {
  const spec = testSpec(project, true)
  const memory = threadMemory(spec, { workspace: '', teammate: '' }, '/threads/s1', now)
  assert.match(
    instructions(spec, memory, '/library', { ready: true }),
    /\(this thread is private: only into your own memory\)/,
  )
})

test('a thread asks for an App account it lacks with a ticket, rather than guessing why it is missing', () => {
  const spec = testSpec('')
  const text = instructions(
    spec,
    threadMemory(spec, { workspace: '', teammate: '', lines: {} }, '/threads/s1', now),
    '/library',
    {
      ready: true,
    },
  )
  assert.match(text, /## App accounts\n\n/)
  assert.match(text, /`app` of that App's kind with the scope you need and `account` naming it/)
  // An App it has no account for at all: list_apps shows which, rather than "does not show at all".
  assert.match(text, /call `list_apps` and propose the App that fits with a ticket/)
  assert.doesNotMatch(text, /does not show at all/)
})

// What a thread is told follows what Brigade lets it do there: schedules, triggers and wake-ups
// only where a person started it, no Done in a schedule's run, no child threads in a dry run, and
// no "see X" pointing to a section the thread does not get.
const textFor = (extra: Record<string, unknown>) => {
  const spec = ThreadSpec.parse({ ...testSpec(''), ...extra })
  const memory = threadMemory(spec, { workspace: '', teammate: '', lines: {} }, '/threads/s1', now)
  return instructions(spec, memory, '/library', { ready: true })
}

test('schedules, triggers and wake-ups are offered only in a thread a person started', () => {
  for (const origin of [undefined, 'member']) {
    const text = textFor(origin ? { origin } : {})
    assert.match(text, /## Schedules/)
    assert.match(text, /`set_wakeup`/)
  }
  for (const extra of [
    { origin: 'trigger' },
    { origin: 'schedule' },
    { origin: 'child', parent: { id: 'p', title: 'Parent' } },
    // An API older than origin: a child is still told none.
    { parent: { id: 'p', title: 'Parent' } },
  ]) {
    const text = textFor(extra)
    assert.doesNotMatch(text, /## Schedules|`set_wakeup`|`create_schedule`|`create_trigger`/)
  }
  assert.match(
    textFor({ parent: { id: 'p', title: 'Parent' } }),
    /cannot start child threads, schedules or wake-ups/,
  )
})

test("a schedule's run declares nothing done, and no merge wakes it", () => {
  const run = textFor({ origin: 'schedule' })
  assert.doesNotMatch(run, /## Done|`complete_thread`/)
  assert.match(run, /the thread notes it once it is merged/)
  const trigger = textFor({ origin: 'trigger' })
  assert.match(trigger, /## Done/)
  assert.match(trigger, /you are woken here once it is merged/)
})

test('a dry run is told of no child threads to start, and a scheduled playbook run of no event', () => {
  const playbook = { installationId: 'i', runId: 'r', name: 'Support', apps: ['gmail'] }
  const dry = textFor({ origin: 'trigger', playbook: { ...playbook, dryRun: true } })
  assert.doesNotMatch(dry, /## Child threads/)
  assert.match(dry, /whatever else these instructions say about them/)
  const live = textFor({ origin: 'trigger', playbook })
  assert.match(live, /## Child threads/)
  assert.match(live, /untrusted input/)
  assert.match(live, /`playbook_triage`/)
  const weekly = textFor({ origin: 'schedule', playbook })
  assert.doesNotMatch(weekly, /untrusted input|`playbook_triage`|fromOtherRuns/)
  assert.match(weekly, /case `scheduled`/)
})

test('no "see X" points to a section the thread does not get', () => {
  const child = textFor({ origin: 'child', parent: { id: 'p', title: 'Parent' } })
  assert.doesNotMatch(child, /## Big goals/)
  assert.doesNotMatch(child, /see Big goals|see Child threads/)
  const top = textFor({})
  assert.match(top, /see Big goals/)
  assert.match(top, /see Child threads/)
  // No projects listed, no Projects section to see.
  assert.doesNotMatch(top, /## Projects|see Projects/)
  const listed = textFor({
    projects: [{ id: 'p1', name: 'Brigade', brief: '', folder: null, repositories: [] }],
  })
  assert.match(listed, /## Projects/)
  assert.match(listed, /see Projects/)
})

test("a task's thread is told to declare itself done too, besides completing the task", () => {
  const task = { id: 't1', title: 'Add CSV export', description: 'Export invoices as CSV.' }
  assert.match(textFor({ task }), /leaves this thread open, so declare the thread done too/)
})
