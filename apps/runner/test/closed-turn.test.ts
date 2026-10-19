import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  answerAfterRestart,
  closeTurn,
  withoutBridge,
  withTools,
} from '../src/harness/closed-turn.js'

// What Claude Code's harness saves when a turn waiting on open_ticket stops.
const waiting = {
  type: 'resume-session',
  harnessId: 'claude-code',
  specificationVersion: 'harness-v1',
  data: { bridge: { port: 41000, token: 't' }, claudeSessionId: 'c1' },
  continueFrom: {
    type: 'continue-turn',
    harnessId: 'claude-code',
    specificationVersion: 'harness-v1',
    data: { bridge: { port: 41000, token: 't', lastSeenEventId: 9 }, claudeSessionId: 'c1' },
    turnSettings: { skills: [], tools: [{ name: 'open_ticket' }] },
    pendingToolResults: [
      { toolCallId: 'toolu_1', toolName: 'open_ticket', input: '{"title":"Access to Vault"}' },
    ],
  },
}

test('a turn waiting on a person resumes as its conversation, without the turn or its bridge', () => {
  assert.deepEqual(closeTurn(waiting), {
    resume: {
      type: 'resume-session',
      harnessId: 'claude-code',
      specificationVersion: 'harness-v1',
      data: { claudeSessionId: 'c1' },
    },
    waiting: [
      { toolCallId: 'toolu_1', toolName: 'open_ticket', input: { title: 'Access to Vault' } },
    ],
    approvals: [],
  })
})

test('a turn frozen mid-run, waiting on nobody, is left to go on', () => {
  const frozen = { ...waiting, continueFrom: { ...waiting.continueFrom, pendingToolResults: [] } }
  assert.equal(closeTurn(frozen), undefined)
})

test('a parked session keeps its conversation and frozen turn, without the bridge that stopped', () => {
  const frozen = { ...waiting, continueFrom: { ...waiting.continueFrom, pendingToolResults: [] } }
  assert.deepEqual(withoutBridge(frozen), {
    ...frozen,
    data: { claudeSessionId: 'c1' },
    continueFrom: { ...frozen.continueFrom, data: { claudeSessionId: 'c1' } },
  })
  // Between turns, or with nothing saved, there is no bridge to drop.
  const between = { type: 'resume-session', harnessId: 'codex', data: { threadId: 't1' } }
  assert.deepEqual(withoutBridge(between), between)
  assert.equal(withoutBridge(undefined), undefined)
})

test('no turn is left as it is', () => {
  assert.equal(closeTurn(undefined), undefined)
  assert.equal(closeTurn({ ...waiting, continueFrom: undefined }), undefined)
})

test("a thread's first turn, with no conversation id yet, resumes the folder's newest one", () => {
  const first = {
    ...waiting,
    continueFrom: { ...waiting.continueFrom, data: { bridge: waiting.continueFrom.data.bridge } },
  }
  assert.deepEqual(closeTurn(first)?.resume, {
    type: 'resume-session',
    harnessId: 'claude-code',
    specificationVersion: 'harness-v1',
    data: {},
  })
})

test('the answer names the call it answers', () => {
  const text = answerAfterRestart({
    toolName: 'open_ticket',
    output: { value: { replies: [{ ask: 'Access to Vault', granted: true }] } },
  })
  assert.match(text, /your open_ticket call above/)
  assert.match(text, /"granted":true/)
})

test('the calls a turn waits on a person for are kept, and nothing else', async () => {
  const { waitingOn } = await import('../src/harness/closed-turn.js')
  const calls = new Map([
    ['toolu_1', { toolName: 'open_ticket', input: { title: 'Connect Neon' } }],
    ['toolu_2', { toolName: 'Bash', input: { command: 'ls' } }],
  ])
  assert.deepEqual(waitingOn(calls, new Set(['open_ticket'])), [
    { toolCallId: 'toolu_1', toolName: 'open_ticket', input: { title: 'Connect Neon' } },
  ])
})

test('a turn waiting on an approval is closed too, keeping the call it would have made', async () => {
  const { closeTurn, approvalAfterRestart, sameCall } =
    await import('../src/harness/closed-turn.js')
  const closed = closeTurn({
    type: 'resume-session',
    harnessId: 'claude-code',
    specificationVersion: 'harness-v1',
    data: {},
    continueFrom: {
      type: 'continue-turn',
      harnessId: 'claude-code',
      specificationVersion: 'harness-v1',
      data: { bridge: { port: 1, token: 't' } },
      pendingToolApprovals: [
        {
          approvalId: 'toolu_9',
          toolCallId: 'toolu_9',
          toolName: 'bash',
          input: '{"command":"ls","description":"List"}',
        },
      ],
    },
  })
  assert.deepEqual(closed?.approvals, [
    { approvalId: 'toolu_9', toolName: 'bash', input: { command: 'ls', description: 'List' } },
  ])
  assert.deepEqual(closed?.waiting, [])
  // Made again, the same call in another key order is still the one approved.
  assert.ok(
    sameCall(closed!.approvals[0]!, {
      toolName: 'Bash',
      input: { description: 'List', command: 'ls' },
    }),
  )
  assert.ok(
    !sameCall(closed!.approvals[0]!, {
      toolName: 'bash',
      input: { command: 'rm -rf /', description: 'List' },
    }),
  )
  assert.match(
    approvalAfterRestart(closed!.approvals[0], true),
    /never ran\. They approved it: make the same call again/,
  )
  assert.match(
    approvalAfterRestart(closed!.approvals[0], false, 'not now'),
    /They declined it: not now\. Do not make it/,
  )
})

test("a frozen turn whose tools changed since goes on with the agent's own", () => {
  const frozen = {
    ...waiting,
    continueFrom: {
      ...waiting.continueFrom,
      turnSettings: {
        skills: [],
        tools: [{ name: 'open_ticket' }, { name: 'github_list_repositories' }],
      },
      pendingToolResults: [],
    },
  }
  // A second GitHub account renamed that kind's tools.
  const { turnSettings: _settings, ...rest } = frozen.continueFrom
  assert.deepEqual(withTools(frozen, ['open_ticket', 'github_list_repositories_acme']), {
    ...frozen,
    continueFrom: rest,
  })
  // An App granted since: the turn gets its tools too.
  assert.deepEqual(
    withTools(frozen, ['open_ticket', 'github_list_repositories', 'linear_list_issues']),
    { ...frozen, continueFrom: rest },
  )
  // The same tools, in any order: kept as saved.
  assert.equal(withTools(frozen, ['github_list_repositories', 'open_ticket']), frozen)
  // Between turns, or with nothing saved, there is no turn to change.
  const between = { type: 'resume-session', harnessId: 'codex', data: { threadId: 't1' } }
  assert.equal(withTools(between, ['open_ticket']), between)
  assert.equal(withTools(undefined, ['open_ticket']), undefined)
})
