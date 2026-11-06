import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ScheduleOperation, type ThreadSpec } from '@brigade/contracts'
import { childTools, reviewTools, type ScheduleCaller } from '../src/harness/tools.js'
import { instructions } from '../src/instructions.js'

// Reviews of a thread's pull requests (src/reviews.ts in the API), as its instructions and
// tools put them: the project says who decides, in a child thread too, which handles its review
// itself and reports once it is done; a playbook's run decides none.
const project = (reviewPolicy: 'teammate' | 'manual') => ({
  id: 'p1',
  name: 'Web',
  brief: '',
  memory: '',
  folder: null,
  repositories: ['acme/web'],
  connections: [],
  reviewPolicy,
})
const spec = (extra: Partial<Record<keyof ThreadSpec, unknown>>) =>
  ({
    sessionId: 's1',
    teammate: { id: 'riley', name: 'Riley', harness: 'claude_code', kind: 'teammate' },
    teammates: [],
    projects: [],
    skills: [],
    connectors: [],
    git: { token: 'x' },
    ...extra,
  }) as unknown as ThreadSpec
const text = (s: ThreadSpec) =>
  instructions(s, { workspace: '', teammate: '' }, '/library', { ready: true })

test('where the teammate decides, it says so when it opens a pull request, and checks its review before handing over', () => {
  for (const s of [spec({ project: project('teammate') }), spec({})]) {
    const said = text(s)
    assert.match(said, /You decide whether a pull request you open gets a review/)
    assert.match(said, /`github_create_pull_request`'s `review`/)
    assert.match(said, /Ask again while the review converges/)
    assert.match(said, /Stop when it goes in circles/)
    assert.match(said, /A review takes 8 looks at most/)
    assert.match(said, /the review came back and you fixed what it found/)
  }
})

test('where reviews are manual, it asks for one only when the person does', () => {
  const said = text(spec({ project: project('manual') }))
  assert.match(said, /only when someone asks/)
  assert.match(said, /call `request_review`/)
  assert.doesNotMatch(said, /You decide whether a pull request/)
  assert.doesNotMatch(said, /the review came back/)
})

test('a child thread decides as its project says, handles its review itself and reports once it is done', () => {
  const parent = { id: 'p', title: 'Parent' }
  const child = text(spec({ project: project('teammate'), parent }))
  assert.match(child, /You decide whether a pull request you open gets a review/)
  assert.match(child, /Brigade starts it in a child thread of this one/)
  assert.match(child, /While its review runs, do not call `report`/)
  assert.match(child, /Report once the review approves, or once you stopped it/)
  assert.match(child, /Stop when it goes in circles .* and report where it stands/)
  assert.match(child, /the one thread Brigade starts under this one/)
  assert.doesNotMatch(child, /starts no review|A child thread of yours handles/)
  // Where reviews are manual, it tells its parent there is none.
  const manual = text(spec({ project: project('manual'), parent }))
  assert.match(manual, /Say in your report that a pull request you opened has none/)
  assert.doesNotMatch(manual, /You decide whether a pull request/)
  // The thread that starts children leaves their reviews to them.
  const top = text(spec({ project: project('teammate') }))
  assert.match(top, /A child thread of yours handles the review of a pull request it opens/)
  assert.doesNotMatch(top, /While its review runs, do not call `report`/)
  // A child without a repository hears nothing of reviews.
  assert.doesNotMatch(
    text(spec({ parent, git: undefined })),
    /request_review|the one thread Brigade starts under this one|While its review runs/,
  )
})

test("a child thread's tools: its report, and the review under it to list and read", () => {
  const nothing: ScheduleCaller = async () => ({})
  assert.deepEqual(Object.keys(childTools(nothing, { child: true })).sort(), [
    'list_children',
    'read_child',
    'report',
  ])
  const report = childTools(nothing, { child: true }).report as { description?: string }
  assert.match(report.description ?? '', /Not while a review of a pull request you opened runs/)
})

test('a playbook run hears nothing of reviews', () => {
  const run = text(
    spec({
      project: project('teammate'),
      playbook: { name: 'Support', dryRun: false, teammates: [], apps: [] },
    }),
  )
  assert.doesNotMatch(run, /request_review|starts no review|You decide whether a pull request/)
})

test('request_review asks for the review of a pull request by number, and a reviewer when named', async () => {
  const sent: Parameters<ScheduleCaller>[0][] = []
  const tools = reviewTools(async (call) => {
    sent.push(call)
    return { ok: true }
  })
  const options = { toolCallId: 'call-1', messages: [] } as never
  await tools.request_review!.execute!({ repository: 'Acme/Web', number: 12.0 }, options)
  await tools.request_review!.execute!(
    { repository: 'acme/web', number: 7, reviewer: 'Kai' },
    options,
  )
  assert.deepEqual(ScheduleOperation.parse(sent[0]!.operation), {
    name: 'request_review',
    repository: 'acme/web',
    number: 12,
  })
  assert.deepEqual(ScheduleOperation.parse(sent[1]!.operation), {
    name: 'request_review',
    repository: 'acme/web',
    number: 7,
    reviewer: 'Kai',
  })
})
