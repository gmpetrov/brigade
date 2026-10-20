import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ScheduleOperation, type ThreadSpec } from '@brigade/contracts'
import { reviewTools, type ScheduleCaller } from '../src/harness/tools.js'
import { instructions } from '../src/instructions.js'

// Reviews of a thread's pull requests (src/reviews.ts in the API), as its instructions and
// tools put them: the project says who decides; a child thread and a playbook's run decide none.
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
    assert.match(said, /`message_thread` \(2 times at most\)/)
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

test('a child thread starts no review, and a playbook run hears nothing of them', () => {
  const child = text(spec({ project: project('teammate'), parent: { id: 'p', title: 'Parent' } }))
  assert.match(child, /A child thread starts no review/)
  assert.doesNotMatch(child, /You decide whether a pull request/)
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
