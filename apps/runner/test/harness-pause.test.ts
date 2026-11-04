import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { jsonSchema, tool } from 'ai'
import { createLocalSandboxSession } from '../src/harness/local-sandbox.js'

type Emit = (part: Record<string, unknown>) => void

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0 },
}

/**
 * A harness that plays one turn as Claude Code's bridge did in a thread that stopped answering
 * its ticket: a host tool called with input its MCP schema refuses, which the bridge settles
 * on its own at once, then a call to a tool a person answers (open_ticket).
 */
function scriptedHarness(submitted: string[]) {
  return {
    harnessId: 'scripted',
    specificationVersion: 'harness-v1',
    builtinTools: {},
    supportsBuiltinToolApprovals: true,
    doStart: async ({ sessionId }: { sessionId: string }) => ({
      sessionId,
      isResume: false,
      doPromptTurn: async ({ emit }: { emit: Emit }) => {
        let finish!: () => void
        const done = new Promise<void>((resolve) => (finish = resolve))
        const play = async () => {
          emit({ type: 'stream-start', modelId: 'scripted' })
          emit({
            type: 'tool-call',
            toolCallId: 'bad',
            toolName: 'read_message',
            input: '{"id":"1"}',
            providerExecuted: false,
          })
          // The bridge's own answer, before the host's result for the same call can go in.
          emit({
            type: 'tool-result',
            toolCallId: 'bad',
            toolName: 'read_message',
            result: 'MCP error -32602: Input validation error',
            isError: true,
          })
          emit({ type: 'finish-step', finishReason: { unified: 'stop', raw: 'stop' }, usage })
          await sleep(20)
          emit({
            type: 'tool-call',
            toolCallId: 'ticket',
            toolName: 'open_ticket',
            input: '{"title":"Sign in"}',
            providerExecuted: false,
          })
          emit({
            type: 'finish-step',
            finishReason: { unified: 'tool-calls', raw: 'host-input' },
            usage,
          })
          // Claude Code then waits on the ticket's result: no `finish` until it comes.
        }
        void play()
        return {
          submitToolResult: async (input: { toolCallId: string }) => {
            submitted.push(input.toolCallId)
          },
          done,
          finish,
        }
      },
      doContinueTurn: async () => ({ submitToolResult: async () => {}, done: Promise.resolve() }),
      doSuspendTurn: async () => ({
        type: 'continue-turn',
        harnessId: 'scripted',
        specificationVersion: 'harness-v1',
        data: {},
      }),
      doStop: async () => ({
        type: 'resume-session',
        harnessId: 'scripted',
        specificationVersion: 'harness-v1',
        data: {},
      }),
      doDestroy: async () => {},
    }),
  }
}

test('a turn pauses on a ticket even after the harness settled a host call on its own', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-pause-'))
  const submitted: string[] = []
  const agent = new HarnessAgent({
    // The harness interface is the SDK's internal one; this plays only what a turn uses.
    harness: scriptedHarness(submitted) as never,
    tools: {
      read_message: tool({
        inputSchema: jsonSchema<{ messageId: string }>({
          type: 'object',
          properties: { messageId: { type: 'string' } },
          required: ['messageId'],
        }),
        execute: async () => 'never',
      }),
      open_ticket: tool({
        inputSchema: jsonSchema<{ title: string }>({
          type: 'object',
          properties: { title: { type: 'string' } },
        }),
      }),
    },
    permissionMode: 'allow-all',
    sandboxConfig: { workDir: '.' },
  })
  const sandbox = createLocalSandboxSession({
    id: 'pause',
    workingDirectory: dir,
    port: 0,
    env: {},
  })
  try {
    const session = await agent.createSession({ sandboxSession: sandbox })
    const result = await agent.stream({ session, prompt: 'go' })
    const parts: string[] = []
    const consumed = (async () => {
      for await (const part of result.fullStream) parts.push(part.type)
    })()
    const ended = await Promise.race([consumed.then(() => true), sleep(2000).then(() => false)])
    assert.ok(ended, `the turn did not pause for the ticket (saw ${parts.join(', ')})`)
    assert.ok(session.hasUnfinishedTurn())
    // The host's own result for the refused call still went in; the bridge ignores it.
    assert.ok(submitted.includes('bad'))
    // The turn, saved to go on later, waits on the ticket alone: the call the harness settled
    // is not one to give a result again when it goes on.
    const saved = (await session.suspendTurn()) as { pendingToolResults?: { toolCallId: string }[] }
    assert.deepEqual(
      saved.pendingToolResults?.map((p) => p.toolCallId),
      ['ticket'],
    )
  } finally {
    await sandbox.destroy()
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * A harness that plays one turn as Claude Code's bridge did in a thread whose ticket was answered
 * and never reached it: open_ticket and a host tool the runner runs itself (checkout_repository)
 * called in one step. Claude Code runs them one after the other, so the bridge echoes the
 * checkout's result only once the ticket's result came, which only a pause lets a person give.
 */
function ticketBesideHostCall(submitted: string[], continued: string[]) {
  return {
    harnessId: 'scripted',
    specificationVersion: 'harness-v1',
    builtinTools: {},
    supportsBuiltinToolApprovals: true,
    doStart: async ({ sessionId }: { sessionId: string }) => ({
      sessionId,
      isResume: false,
      doPromptTurn: async ({ emit }: { emit: Emit }) => {
        emit({ type: 'stream-start', modelId: 'scripted' })
        emit({
          type: 'tool-call',
          toolCallId: 'ticket',
          toolName: 'open_ticket',
          input: '{"title":"Access"}',
          providerExecuted: false,
        })
        emit({
          type: 'tool-call',
          toolCallId: 'checkout',
          toolName: 'checkout_repository',
          input: '{"repository":"acme/web"}',
          providerExecuted: false,
        })
        // The bridge waits on the ticket's MCP call: the step ends early for host input.
        emit({
          type: 'finish-step',
          finishReason: { unified: 'tool-calls', raw: 'host-input' },
          usage,
        })
        // Claude Code then waits on the ticket's result: no echo of the checkout, no `finish`.
        return {
          submitToolResult: async (input: { toolCallId: string }) => {
            submitted.push(input.toolCallId)
          },
          done: new Promise<void>(() => {}),
        }
      },
      // Given the answer, Claude Code takes both results and ends the turn.
      doContinueTurn: async ({ emit }: { emit: Emit }) => {
        let finish!: () => void
        const done = new Promise<void>((resolve) => (finish = resolve))
        return {
          submitToolResult: async (input: { toolCallId: string }) => {
            continued.push(input.toolCallId)
            if (continued.includes('ticket') && continued.includes('checkout')) {
              emit({ type: 'finish-step', finishReason: { unified: 'stop', raw: 'stop' }, usage })
              emit({
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                totalUsage: usage,
              })
              finish()
            }
          },
          done,
        }
      },
      doSuspendTurn: async () => ({
        type: 'continue-turn',
        harnessId: 'scripted',
        specificationVersion: 'harness-v1',
        data: {},
      }),
      doStop: async () => ({
        type: 'resume-session',
        harnessId: 'scripted',
        specificationVersion: 'harness-v1',
        data: {},
      }),
      doDestroy: async () => {},
    }),
  }
}

test('a turn pauses on a ticket called beside a host tool whose result Claude Code holds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-pause-'))
  const submitted: string[] = []
  const continued: string[] = []
  const agent = new HarnessAgent({
    harness: ticketBesideHostCall(submitted, continued) as never,
    tools: {
      open_ticket: tool({
        inputSchema: jsonSchema<{ title: string }>({
          type: 'object',
          properties: { title: { type: 'string' } },
        }),
      }),
      checkout_repository: tool({
        inputSchema: jsonSchema<{ repository: string }>({
          type: 'object',
          properties: { repository: { type: 'string' } },
          required: ['repository'],
        }),
        execute: async () => ({ directory: 'web' }),
      }),
    },
    permissionMode: 'allow-all',
    sandboxConfig: { workDir: '.' },
  })
  const sandbox = createLocalSandboxSession({
    id: 'pause-beside',
    workingDirectory: dir,
    port: 0,
    env: {},
  })
  try {
    const session = await agent.createSession({ sandboxSession: sandbox })
    const result = await agent.stream({ session, prompt: 'go' })
    const parts: { type: string; toolCallId?: string }[] = []
    const consumed = (async () => {
      for await (const part of result.fullStream)
        parts.push({ type: part.type, toolCallId: (part as { toolCallId?: string }).toolCallId })
    })()
    const ended = await Promise.race([
      consumed.then(() => true),
      sleep(15_000, false, { ref: false }),
    ])
    assert.ok(
      ended,
      `the turn did not pause for the ticket (saw ${parts.map((p) => p.type).join(', ')})`,
    )
    assert.ok(session.hasUnfinishedTurn())
    // The checkout ran, and its result went to the harness once.
    assert.deepEqual(submitted, ['checkout'])
    // Shown done, though the harness never echoed it.
    assert.ok(parts.some((p) => p.type === 'tool-result' && p.toolCallId === 'checkout'))
    // Waiting: the ticket on a person; the checkout's result, known already, goes in again with
    // the answer, for a harness that may not have taken it yet.
    assert.deepEqual(
      session.getPendingToolResults().map((p) => [p.toolCallId, p.completedResult !== undefined]),
      [
        ['ticket', false],
        ['checkout', true],
      ],
    )
    // The person answers: the turn goes on with both results, and ends.
    const answered = await agent.continueStream({
      session,
      toolResultContinuations: [
        {
          type: 'tool-result',
          toolCallId: 'ticket',
          toolName: 'open_ticket',
          output: { type: 'json', value: { granted: true } },
        },
      ],
    })
    const finished = (async () => {
      for await (const _ of answered.fullStream);
    })()
    const over = await Promise.race([
      finished.then(() => true),
      sleep(5_000, false, { ref: false }),
    ])
    assert.ok(over, 'the answer did not end the turn')
    assert.deepEqual([...continued].sort(), ['checkout', 'ticket'])
    assert.ok(!session.hasUnfinishedTurn())
  } finally {
    await sandbox.destroy()
    await rm(dir, { recursive: true, force: true })
  }
})
