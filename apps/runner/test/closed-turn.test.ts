import assert from 'node:assert/strict'
import { test } from 'node:test'
import { answerAfterRestart, closeTurn } from '../src/harness/closed-turn.js'

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
