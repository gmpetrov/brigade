import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ToolAccount, ToolView } from '@brigade/contracts'
import { ApiError } from '../lib/api'
import { accountFor, answer, bridgeRequest, toolMessage, type ToolConfirm } from '../lib/tool-host'

// The dashboard's side of a tool's bridge (lib/tool-host.ts): what a tool's page asks, checked,
// sent to the API, and confirmed by the person before a write or a message goes.
const account = (over: Partial<ToolAccount> = {}): ToolAccount => ({
  connectionId: 'c1',
  kind: 'github',
  app: 'GitHub',
  account: 'acme',
  access: 'read_write',
  usable: true,
  changed: false,
  attachedBy: 'Ada',
  ...over,
})
const view = (accounts: ToolAccount[] = [account()]): ToolView => ({
  url: 'https://designs.example/t/x/index.html',
  folder: 'Film/review.tool',
  manifest: { title: 'Review' },
  toolId: 'doc1',
  thread: { id: 'th1', title: 'Film', mayPrompt: true },
  teammate: null,
  accounts,
  attachable: [],
  mayAttach: true,
  expiresAt: '',
})

function host(options: { accounts?: ToolAccount[]; yes?: boolean; threadId?: string } = {}) {
  const calls: { path: string; body: unknown }[] = []
  const asked: ToolConfirm[] = []
  return {
    calls,
    asked,
    host: {
      view: view(options.accounts),
      threadId: 'threadId' in options ? options.threadId : 'th1',
      me: { memberId: 'm1', name: 'Ada' },
      api: async <T>(path: string, body: unknown) => {
        calls.push({ path, body })
        const b = body as { confirmed?: boolean }
        if (path === '/tools/call' && !b.confirmed)
          throw new ApiError('A person confirms each write first', 428)
        return (path === '/tools/call' ? { ok: true, output: { done: 1 } } : { result: 'r' }) as T
      },
      confirm: async (what: ToolConfirm) => {
        asked.push(what)
        return options.yes ?? true
      },
    },
  }
}
const ask = (method: string, params: Record<string, unknown> = {}) =>
  bridgeRequest({ source: 'brigade-tool', id: 'c1', method, params })!

test('only calls of the bridge count', () => {
  assert.equal(bridgeRequest({ source: 'brigade-design', id: 1, method: 'me' }), null)
  assert.equal(bridgeRequest({ source: 'brigade-tool', id: 1, method: 'eval' }), null)
  assert.equal(bridgeRequest('hello'), null)
  assert.ok(bridgeRequest({ source: 'brigade-tool', id: 'a', method: 'me' }))
})

test('an account by its id or its kind, a usable one first', () => {
  const list = [
    account({ connectionId: 'p', usable: false }),
    account({ connectionId: 'w' }),
    account({ connectionId: 'x', kind: 'posthog' }),
  ]
  assert.equal(accountFor(list, 'github')?.connectionId, 'w')
  assert.equal(accountFor(list, 'p')?.connectionId, 'p')
  assert.equal(accountFor(list, 'stripe'), undefined)
  assert.equal(accountFor(list, 42), undefined)
})

test('a write goes once the person confirms it, and not when they do not', async () => {
  const yes = host()
  const reply = await answer(
    yes.host,
    ask('apps.call', {
      account: 'github',
      operation: 'github_create_issue',
      input: { title: 't' },
    }),
  )
  assert.deepEqual(reply, { source: 'brigade-host', id: 'c1', ok: true, result: { done: 1 } })
  assert.equal(yes.asked.length, 1)
  assert.equal(yes.asked[0]!.kind, 'write')
  assert.deepEqual(
    yes.calls.map((c) => (c.body as { confirmed?: boolean }).confirmed ?? false),
    [false, true],
  )

  const no = host({ yes: false })
  const refused = await answer(
    no.host,
    ask('apps.call', { account: 'github', operation: 'github_create_issue', input: {} }),
  )
  assert.equal(refused.ok, false)
  assert.equal(!refused.ok && refused.code, 'declined')
  assert.equal(no.calls.length, 1, 'never sent confirmed')
})

test('an account changed, personal to someone else or missing is refused before the API', async () => {
  for (const [over, code] of [
    [{ changed: true }, 'tool_changed'],
    [{ usable: false }, 'not_usable'],
  ] as const) {
    const h = host({ accounts: [account(over)] })
    const reply = await answer(h.host, ask('apps.call', { account: 'github', operation: 'x' }))
    assert.equal(!reply.ok && reply.code, code)
    assert.equal(h.calls.length, 0)
  }
  const none = host({ accounts: [] })
  const reply = await answer(none.host, ask('apps.operations', { account: 'github' }))
  assert.equal(!reply.ok && reply.code, 'no_account')
})

test('a message to the thread goes as the person, said to come from the tool, once confirmed', async () => {
  const h = host()
  const reply = await answer(h.host, ask('thread.send', { text: ' Approved: a.mp4 ' }))
  assert.equal(reply.ok, true)
  assert.deepEqual(h.asked, [{ kind: 'message', thread: 'Film', text: 'Approved: a.mp4' }])
  assert.deepEqual(h.calls, [
    { path: '/threads/th1/messages', body: { text: toolMessage(view(), 'Approved: a.mp4') } },
  ])
  assert.match(toolMessage(view(), 'x'), /^From the tool @\[Film\/review\.tool\]\(document:doc1\):/)

  const declined = host({ yes: false })
  await answer(declined.host, ask('thread.send', { text: 'hi' }))
  assert.equal(declined.calls.length, 0)

  const nowhere = host({ threadId: undefined })
  const refused = await answer(nowhere.host, ask('thread.send', { text: 'hi' }))
  assert.equal(!refused.ok && refused.code, 'no_thread')
  assert.equal(nowhere.asked.length, 0)
})

test('state and files go to the API for this tool, whatever path the page names', async () => {
  const h = host()
  await answer(h.host, ask('state.set', { shared: true, key: 'k', value: [1], version: 2 }))
  await answer(h.host, ask('state.list', { shared: false, prefix: 'clip:' }))
  await answer(h.host, ask('files.list', { folder: 'Film/clips', path: 'Other/evil.tool' }))
  assert.deepEqual(h.calls, [
    {
      path: '/tools/state',
      body: { op: 'set', path: 'Film/review.tool', shared: true, key: 'k', value: [1], version: 2 },
    },
    {
      path: '/tools/state',
      body: { op: 'list', path: 'Film/review.tool', shared: false, prefix: 'clip:' },
    },
    { path: '/tools/files', body: { path: 'Film/review.tool', folder: 'Film/clips' } },
  ])
})
