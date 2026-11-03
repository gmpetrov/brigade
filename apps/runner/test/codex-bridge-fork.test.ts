import assert from 'node:assert/strict'
import { test } from 'node:test'
import { codexBridgeTurn } from './fixtures/codex-bridge.js'

// The Codex bridge (patched) for a side reply (side-replies.ts): it forks the thread its folder's
// turn runs in, without saving the copy, and the turn only reads. Runs through the bridge with a
// stand-in for codex app-server (fixtures/codex-bridge.ts).

const FORK = { BRIGADE_FORK_SESSION: '1', FAKE_CODEX_REPLY: 'It is in exportRows.\nROUTE: answer' }

test('a side reply forks the newest thread in its folder, unsaved, and its turn only reads', async () => {
  const { text, requests, work } = await codexBridgeTurn({ env: FORK })
  const methods = requests.map((r) => r.method)
  assert.ok(!methods.includes('thread/start') && !methods.includes('thread/resume'))
  const list = requests.find((r) => r.method === 'thread/list')!
  assert.equal(list.params.cwd, work)
  assert.equal(list.params.sortKey, 'updated_at')
  assert.equal(list.params.limit, 1)
  const fork = requests.find((r) => r.method === 'thread/fork')!
  assert.equal(fork.params.threadId, 'main-thread')
  assert.equal(fork.params.ephemeral, true)
  const turn = requests.find((r) => r.method === 'turn/start')!
  assert.equal(turn.params.threadId, 'forked-thread')
  assert.deepEqual(turn.params.sandboxPolicy, { type: 'readOnly', networkAccess: false })
  assert.match(text, /exportRows/)
})

test('it forks the thread the runner names, when it names one', async () => {
  const { requests } = await codexBridgeTurn({
    env: FORK,
    resumeFrom: {
      type: 'resume-session',
      specificationVersion: 'harness-v1',
      harnessId: 'codex',
      data: { threadId: 'named-thread' },
    },
  })
  assert.equal(requests.some((r) => r.method === 'thread/list'), false)
  assert.equal(requests.find((r) => r.method === 'thread/fork')?.params.threadId, 'named-thread')
})

test('with no thread in its folder there is nothing to answer from: the turn fails', async () => {
  const { error, requests } = await codexBridgeTurn({ env: { ...FORK, FAKE_CODEX_EMPTY: '1' } })
  assert.match(error ?? '', /No conversation in this folder/)
  assert.equal(requests.some((r) => r.method === 'turn/start' || r.method === 'thread/start'), false)
})

test("a thread's own turn starts or resumes its thread as before, and is not made read-only", async () => {
  const { requests } = await codexBridgeTurn({ env: {} })
  const methods = requests.map((r) => r.method)
  assert.ok(methods.includes('thread/start'))
  assert.equal(methods.includes('thread/fork'), false)
  assert.equal(methods.includes('thread/list'), false)
  const turn = requests.find((r) => r.method === 'turn/start')!
  assert.equal(turn.params.sandboxPolicy.type, 'externalSandbox')
})
