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
  } finally {
    await sandbox.destroy()
    await rm(dir, { recursive: true, force: true })
  }
})
