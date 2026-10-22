// The demo's API in the browser (lib/demo): what it answers from the recorded fixtures, and
// the writes it plays in memory.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SUGGESTED_REPLY_MAX } from '@brigade/contracts'
import { DEMO_API } from '../lib/demo/flag'
import { replyTo, suggestions } from '../lib/demo/scripts'
import { keyOf, reviveDates } from '../lib/demo/shared'

const server = () => import('../lib/demo/server')
const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
  const { handle } = await server()
  const response = await handle(
    new Request(`${DEMO_API}/api${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  )
  return { status: response.status, body: (await response.json()) as any }
}
const until = async (check: () => Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 100))
  }
}

test('a request is keyed by its path and stable query, sorted', () => {
  assert.equal(keyOf('GET', `${DEMO_API}/api/me`), 'GET /me')
  assert.equal(
    keyOf('GET', `${DEMO_API}/api/teammates/t1/timeline?to=2&from=1&b=2&a=1`),
    'GET /teammates/t1/timeline?a=1&b=2',
  )
})

test('recorded dates move to now, and the preview address to the demo', () => {
  const out = reviveDates(
    { at: '2026-10-22T10:00:00.000Z', link: '{{origin}}/hooks/x', n: 3, text: 'not 2026-10-22' },
    60_000,
    'https://demo.brigade.lol',
  )
  assert.deepEqual(out, {
    at: '2026-10-22T10:01:00.000Z',
    link: 'https://demo.brigade.lol/hooks/x',
    n: 3,
    text: 'not 2026-10-22',
  })
})

test('a message the demo knows plays its task; anything else offers what it knows', () => {
  const ctx = {
    threadId: 't',
    thread: {
      title: 'Annual billing toggle on the pricing page',
      teammate: { id: 'r', name: 'Riley' },
    },
    teammates: [{ id: 'r', name: 'Riley' }],
    actions: { openPull: () => ({}) as never, openTickets: () => [], playbook: () => undefined },
  }
  const build = replyTo('Build it and open a PR', ctx)
  assert.ok(build.steps.some((s) => 'tool' in s && s.tool.endsWith('github_create_pull_request')))
  assert.equal(build.merge, 'Merge #152')
  const other = replyTo('Book me a flight to Lisbon', ctx)
  assert.match((other.steps[0] as { say: string }).say, /^In the demo, Riley knows/)
  assert.equal(other.replies?.length, 3)
  for (const reply of [...suggestions(ctx), ...suggestions({})])
    assert.ok(reply.length <= SUGGESTED_REPLY_MAX, reply)
})

test('the recorded workspace answers, and what was not recorded is a 404', async () => {
  const me = await call('/me')
  assert.equal(me.status, 200)
  assert.equal(me.body.user.email, 'ada@example.com')
  assert.equal((await call('/nothing/here')).status, 404)
  // Other writes succeed with no effect.
  assert.deepEqual((await call('/workspace', { method: 'PATCH', body: { name: 'x' } })).body, {
    ok: true,
  })
})

test('approving a ticket closes it and its thread goes on', async () => {
  const tickets = (await call('/tickets')).body as {
    id: string
    type: string
    sessionId: string
    payload: any
  }[]
  const refund = tickets.find((t) => t.payload?.operation === 'stripe_api_write')
  assert.ok(refund, 'the sample workspace has a refund waiting')
  await call(`/tickets/${refund.id}/resolve`, { body: { approved: true } })
  const after = (await call('/tickets')).body as { id: string }[]
  assert.ok(!after.some((t) => t.id === refund.id))
  await until(async () => (await call(`/threads/${refund.sessionId}`)).body.status === 'idle')
  const page = (await call(`/threads/${refund.sessionId}/events`)).body
  const types = [...page.context, ...page.events].map((e: any) => e.event.type)
  assert.ok(types.includes('approval.resolved'))
  assert.equal(types.at(-1), 'turn.completed')
  // The call the approval held is the one that finishes: no second one, none left open.
  const all = [...page.context, ...page.events].map((e: any) => e.event)
  const started = all.filter((e: any) => e.type === 'tool.started').map((e: any) => e.toolCallId)
  const finished = new Set(
    all.filter((e: any) => e.type === 'tool.finished').map((e: any) => e.toolCallId),
  )
  assert.deepEqual(
    started.filter((id: string) => !finished.has(id)),
    [],
  )
  assert.equal(
    all.filter((e: any) => e.type === 'tool.started' && e.toolName.endsWith('stripe_api_write'))
      .length,
    1,
  )
})

test('merging a pull request takes it off what waits on a person', async () => {
  const before = (await call('/pulls/attention')).body
  assert.ok(before.pulls.some((p: any) => p.number === 146))
  assert.equal((await call('/pulls/acme/web/146/state')).body.state, 'open')
  await call('/pulls/acme/web/146/merge', { body: { method: 'squash' } })
  assert.equal((await call('/pulls/acme/web/146/state')).body.state, 'merged')
  const after = (await call('/pulls/attention')).body
  assert.equal(after.count, before.count - 1)
})

test('a new thread opens on the message, and its teammate answers it', async () => {
  const teammates = (await call('/teammates')).body as { id: string; name: string }[]
  const riley = teammates.find((t) => t.name === 'Riley')!
  const { body } = await call('/threads', {
    body: { text: 'What’s waiting on me?', teammateId: riley.id },
  })
  const thread = await call(`/threads/${body.id}`)
  assert.equal(thread.status, 200)
  assert.equal(thread.body.teammate.name, 'Riley')
  assert.ok((await call('/threads')).body.some((t: any) => t.id === body.id))
  await until(async () => (await call(`/threads/${body.id}`)).body.status === 'idle')
  const events = (await call(`/threads/${body.id}/events`)).body.events.map((e: any) => e.event)
  assert.equal(events[0].type, 'message.user')
  assert.ok(events.some((e: any) => e.type === 'message.done' && /wait on you/.test(e.text)))
})

test('an archived thread moves to Archived, and back', async () => {
  const list = (await call('/threads')).body as { id: string }[]
  const id = list.at(-1)!.id
  await call(`/threads/${id}/archive`, { method: 'POST' })
  assert.ok(!(await call('/threads')).body.some((t: any) => t.id === id))
  assert.ok((await call(`/threads/${id}`)).body.archivedAt)
  // In Archived, and only there, until it is brought back.
  const archived = (await call('/threads?archived=1')).body as { id: string }[]
  assert.ok(archived.some((t) => t.id === id))
  assert.ok(!archived.some((t) => list.slice(0, -1).some((l) => l.id === t.id)))
  await call(`/threads/${id}/archive`, { method: 'DELETE' })
  assert.ok((await call('/threads')).body.some((t: any) => t.id === id))
  assert.ok(!(await call('/threads?archived=1')).body.some((t: any) => t.id === id))
})
