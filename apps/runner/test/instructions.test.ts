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
  // Not on a cloud computer (instructions-cloud.test.ts): a member's machine is theirs.
  assert.doesNotMatch(text, /## Your files/)
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

test('an account it cannot use now is named, with the ticket that reconnects it', () => {
  const grant = (connectionId: string, kind: string, label: string, account: string | null) => ({
    connectionId,
    kind,
    label,
    externalAccount: account,
    scope: 'read_write',
    operations: [],
  })
  const spec = ThreadSpec.parse({
    ...testSpec(''),
    connectors: [
      { ...grant('c1', 'openrouter', 'OpenRouter', 'Personal account'), unavailable: 'signed_out' },
      // An MCP server added by its URL goes by its tools' prefix: its ticket names it as mcp.
      { ...grant('c2', 'notes', 'Team Notes', null), unavailable: 'signed_out' },
      { ...grant('c3', 'linear', 'Linear', 'Acme'), unavailable: 'unreachable' },
      grant('c4', 'gmail', 'Gmail', 'ada@acme.com'),
    ],
  })
  const text = instructions(
    spec,
    threadMemory(spec, { workspace: '', teammate: '', lines: {} }, '/threads/s1', now),
    '/library',
    { ready: true },
  )
  const section = text.slice(text.indexOf('## Accounts you cannot use now'))
  assert.ok(text.includes('## Accounts you cannot use now'))
  assert.match(
    section,
    /- OpenRouter: Personal account: the provider refused its sign-in.*`kind` openrouter, `account` "Personal account", `scope` read_write\./,
  )
  assert.match(
    section,
    /- Team Notes: the provider refused.*`kind` mcp, `server` its id as `list_apps` gives it, `account` "Team Notes"/,
  )
  assert.match(section, /- Linear: Acme: its server did not answer/)
  assert.doesNotMatch(section.split('## Credentials')[0]!, /Gmail/)
  assert.match(section, /do not do it another way without a word/)

  // Every account usable: no such section.
  assert.doesNotMatch(
    textFor({ connectors: [grant('c4', 'gmail', 'Gmail', 'ada@acme.com')] }),
    /cannot use now/,
  )
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
  assert.doesNotMatch(run, /## Done|`complete_thread`|`done` block/)
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

test('work goes on in a thread of its own with start_thread; no Tasks board is left to tell of', () => {
  const top = textFor({})
  assert.match(top, /## Threads of their own/)
  assert.match(top, /Call `start_thread` only to start work in a thread of its own/)
  assert.match(top, /## Big goals[\s\S]*give it a thread of its own: `start_thread`/)
  assert.match(top, /To add to it later, `message_thread`/)
  for (const text of [top, textFor({ origin: 'child', parent: { id: 'p', title: 'Parent' } })])
    assert.doesNotMatch(text, /create_task|list_tasks|complete_task|Tasks board/)
  // A child does its part: the thread that started it plans the big goal.
  const child = textFor({ origin: 'child', parent: { id: 'p', title: 'Parent' } })
  assert.match(child, /## Threads of their own/)
  assert.doesNotMatch(child, /## Big goals/)
})

test("a playbook's run keeps a customer's idea with file_idea, and starts no thread outside it", () => {
  const playbook = { installationId: 'i', runId: 'r', name: 'Support', apps: ['gmail'] }
  const live = textFor({ origin: 'trigger', playbook })
  assert.match(live, /## Ideas/)
  assert.match(live, /call `file_idea` with one line/)
  assert.match(live, /starts no thread outside it and writes in none/)
  assert.doesNotMatch(live, /## Threads of their own|`start_thread`|create_task|Tasks board/)
  const dry = textFor({ origin: 'trigger', playbook: { ...playbook, dryRun: true } })
  assert.match(dry, /in a dry run, it only says where the line would go/)
})

test('a teammate calls child threads sub-threads, as people see them, in a parent and in a child', () => {
  for (const extra of [{}, { origin: 'child', parent: { id: 'p', title: 'Parent' } }]) {
    assert.match(textFor(extra), /call them sub-threads when you write to people/)
  }
})

test("brigade-library comes with the library's write access, unless an admin turned it off", async () => {
  const { builtinSkills } = await import('../src/instructions.js')
  const names = (extra: Record<string, unknown>) =>
    builtinSkills(ThreadSpec.parse({ ...testSpec(''), ...extra }), '/library').map((s) => s.name)
  const writer = { library: 'read_write' }
  assert.ok(names(writer).includes('brigade-library'))
  assert.match(textFor(writer), /## Project documents[\s\S]*read the `brigade-library` skill/)
  // Off for the workspace: neither the skill nor the line pointing to it.
  const off = { ...writer, builtinSkillsOff: ['brigade-library'] }
  assert.ok(!names(off).includes('brigade-library'))
  assert.doesNotMatch(textFor(off), /brigade-library|## Project documents/)
  // The other skills stay: they cannot be turned off.
  assert.ok(
    names({ ...writer, builtinSkillsOff: ['brigade-previews'] }).includes('brigade-previews'),
  )
  // A teammate that only reads the library files nothing.
  assert.ok(!names({ library: 'read' }).includes('brigade-library'))
  assert.doesNotMatch(textFor({ library: 'read' }), /brigade-library/)
  // An API from before leaves the field out: on.
  assert.ok(names(writer).includes('brigade-library'))
})

test('a teammate knows a thread mention, and names a thread by the one search_workspace gives', () => {
  const text = textFor({})
  assert.match(text, /A message mentions a thread as `@\[title\]\(thread:id\)`/)
  assert.match(
    text,
    /Name a thread in your reply by its mention \(`search_workspace` gives it with its summary\), never by its id alone\./,
  )
})

test('a thread’s list items come with the files under them, and a document’s files are found beside it', () => {
  const spec = ThreadSpec.parse({
    ...testSpec(''),
    items: [
      {
        id: 'aaaaaaaaaaaaaaaa',
        path: 'Projects/Brigade/launch.md',
        text: 'Fix the dialog',
        done: false,
        files: ['Projects/Brigade/launch.md.files/cmshot/Screenshot 1.png'],
      },
      { id: 'bbbbbbbbbbbbbbbb', path: 'Projects/Brigade/launch.md', text: 'Pricing', done: true },
    ],
  })
  const text = instructions(
    spec,
    threadMemory(spec, { workspace: '', teammate: '' }, '/threads/s1', now),
    '/library',
    {
      ready: true,
    },
  )
  assert.ok(
    text.includes(
      '- [ ] Fix the dialog (id `aaaaaaaaaaaaaaaa`, in Projects/Brigade/launch.md)\n' +
        '  - File in the library: Projects/Brigade/launch.md.files/cmshot/Screenshot 1.png\n' +
        '- [x] Pricing (id `bbbbbbbbbbbbbbbb`, in Projects/Brigade/launch.md)',
    ),
  )
  assert.ok(
    text.includes(
      "A file put in a document, written `asset:<id>` in its text, is at /library/<the document's path>.files/<id>/<its name>.",
    ),
  )
})
