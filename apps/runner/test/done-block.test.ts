// A thread declared done in the reply (docs/board.md, Done): a done block at its end, which the
// runner sends to Brigade as complete_thread as the reply ends, rather than the teammate call it
// and wait for its answer. The turn's end, and Claude Code's guess at the next message, wait for
// Brigade's answer, so the thread reads as when the teammate called it. The harness is
// scripted, the session the runner's own (HarnessThread), as in retry-context.test.ts.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { ScheduleOperation, type AgentEvent, type ThreadSpec } from '@brigade/contracts'
import { declaredDone, EventMapper } from '../src/harness/events.js'
import { HarnessThread } from '../src/harness/index.js'
import { createLocalSandboxSession } from '../src/harness/local-sandbox.js'
import { declareDone, Outbox } from '../src/harness/outbox.js'
import type { ScheduleCaller } from '../src/harness/tools.js'

const REPLY = 'The CSV export is merged and live.'
const DONE = '```done\nCSV export merged (#412) and live\n```'

const stripped = (events: AgentEvent[]) => events.map(({ at: _, ...event }) => event)

function mapped(closes: boolean, text: string) {
  const events: AgentEvent[] = []
  const mapper = new EventMapper(
    (event) => events.push(event),
    undefined,
    undefined,
    undefined,
    closes,
  )
  mapper.map({ type: 'text-start', id: 'r1' })
  mapper.map({ type: 'text-delta', id: 'r1', text })
  mapper.map({ type: 'text-end', id: 'r1' })
  // What the reply streamed meanwhile is not at issue here.
  return stripped(events.filter((event) => event.type !== 'message.delta'))
}

test('a done block ends the reply as complete_thread, after the reply and its buttons', () => {
  const buttons = '```replies\nOpen the export\n```'
  assert.deepEqual(mapped(true, `${REPLY}\n\n${buttons}\n${DONE}`), [
    { type: 'message.done', id: 'r1', text: REPLY },
    {
      type: 'tool.started',
      toolCallId: 'r1:suggest_replies',
      toolName: 'suggest_replies',
      input: { replies: ['Open the export'] },
    },
    {
      type: 'tool.finished',
      toolCallId: 'r1:suggest_replies',
      toolName: 'suggest_replies',
      output: { shown: 1 },
      isError: false,
    },
    {
      type: 'tool.started',
      toolCallId: 'r1:complete_thread',
      toolName: 'complete_thread',
      input: { summary: 'CSV export merged (#412) and live' },
    },
  ])
  // Where the thread may not be declared done (a child, a run beside the turn): only taken out.
  assert.deepEqual(mapped(false, `${REPLY}\n${DONE}`), [
    { type: 'message.done', id: 'r1', text: REPLY },
  ])
  // An empty block declares done all the same, with the reply's first line.
  const [, call] = mapped(true, `${REPLY}\n\`\`\`done\n\`\`\``)
  assert.deepEqual((call as { input: unknown }).input, { summary: REPLY })
})

test('only the call a done block stands for is the runner’s to send', () => {
  const at = '2026-11-04T14:00:00.000Z'
  const block = {
    at,
    type: 'tool.started',
    toolCallId: 'r1:complete_thread',
    toolName: 'complete_thread',
    input: {},
  } as const
  assert.ok(declaredDone(block))
  // The teammate's own call goes to Brigade through its tool, as before.
  assert.ok(
    !declaredDone({
      ...block,
      toolCallId: 'toolu_01',
      toolName: 'mcp__harness-tools__complete_thread',
    }),
  )
  assert.ok(
    !declaredDone({ ...block, toolCallId: 'r1:suggest_replies', toolName: 'suggest_replies' }),
  )
})

test('what is sent after a held answer goes out after it, in order', async () => {
  const out: string[] = []
  const outbox = new Outbox((event) => out.push(event.type))
  const at = '2026-11-04T14:00:00.000Z'
  outbox.send({ at, type: 'message.done', id: 'r1', text: REPLY })
  assert.deepEqual(out, ['message.done'], 'out at once while nothing holds the line')
  let answer!: () => void
  outbox.hold(
    new Promise<AgentEvent[]>((resolve) => {
      answer = () =>
        resolve([
          {
            at,
            type: 'tool.finished',
            toolCallId: 'c',
            toolName: 'complete_thread',
            output: {},
            isError: false,
          },
        ])
    }),
  )
  outbox.send({ at, type: 'turn.completed', finishReason: 'stop' })
  outbox.send({ at, type: 'message.suggested', text: 'Thanks' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(out, ['message.done'], 'the turn’s end waits for the answer')
  answer()
  await outbox.flushed()
  assert.deepEqual(out, ['message.done', 'tool.finished', 'turn.completed', 'message.suggested'])
  outbox.send({ at, type: 'usage.updated' } as AgentEvent)
  assert.equal(out.at(-1), 'usage.updated', 'and at once again once it is out')
})

test('Brigade’s answer, its refusal, a failure and no answer in time each end the call', async () => {
  const at = '2026-11-04T14:00:00.000Z'
  const started = {
    at,
    type: 'tool.started',
    toolCallId: 'r1:complete_thread',
    toolName: 'complete_thread',
    input: { summary: 'Shipped' },
  } as const
  const sent: Parameters<ScheduleCaller>[0][] = []
  const done = { done: { summary: 'Shipped', at }, next: 'The thread is done.' }
  const closed = await declareDone(async (call) => (sent.push(call), done), started)
  assert.deepEqual(ScheduleOperation.parse(sent[0]!.operation), {
    name: 'complete_thread',
    summary: 'Shipped',
  })
  assert.deepEqual(
    { ...closed, at },
    {
      at,
      type: 'tool.finished',
      toolCallId: 'r1:complete_thread',
      toolName: 'complete_thread',
      output: done,
      isError: false,
    },
  )
  const open = { error: 'Not done yet: something is still open in this thread.' }
  const refused = await declareDone(async () => open, started)
  assert.deepEqual([refused.output, refused.isError], [open, true])
  const failed = await declareDone(async () => {
    throw new Error('The API is restarting')
  }, started)
  assert.deepEqual([failed.output, failed.isError], [{ error: 'The API is restarting' }, true])
  const late = await declareDone(() => new Promise(() => {}), started, 30)
  assert.equal(late.isError, true)
  assert.match((late.output as { error: string }).error, /did not answer in time/)
})

type Emit = (part: Record<string, unknown>) => void

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0 },
}

/** Claude Code writing `text`; `answered`: the bridge then says so, and guesses the next message. */
function scriptedHarness(text: string, answered: boolean) {
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
        emit({ type: 'text-start', id: 'r' })
        emit({ type: 'text-delta', id: 'r', delta: text })
        emit({ type: 'text-end', id: 'r' })
        if (answered) {
          emit({ type: 'raw', rawValue: { type: 'system', subtype: 'brigade_answered' } })
          emit({ type: 'raw', rawValue: { type: 'prompt_suggestion', suggestion: 'Thanks' } })
        }
        emit({ type: 'finish-step', finishReason: { unified: 'stop', raw: 'stop' }, usage })
        return { submitToolResult: async () => {}, done: Promise.resolve() }
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

/** A turn of a thread whose teammate writes `text`, Brigade answering complete_thread after a while. */
async function turn(
  text: string,
  options: { answered?: boolean; child?: boolean; answer?: unknown },
) {
  const dir = await mkdtemp(join(tmpdir(), 'brigade-done-block-'))
  const events: AgentEvent[] = []
  const calls: Parameters<ScheduleCaller>[0][] = []
  const spec = {
    sessionId: 'done-block',
    starter: true,
    teammate: { id: 'riley', name: 'Riley', harness: 'claude-code', kind: 'teammate' },
    account: { id: 'acct' },
    connectors: [],
    fallbacks: [],
    ...(options.child ? { parent: { id: 'p1', title: 'Launch' } } : {}),
  } as unknown as ThreadSpec
  const callSchedule: ScheduleCaller = async (call) => {
    calls.push(call)
    await new Promise((resolve) => setTimeout(resolve, 80))
    return (
      options.answer ?? { done: { summary: 'x', at: '2026-11-04T14:00:00.000Z' }, next: 'Done.' }
    )
  }
  const thread = new HarnessThread(
    spec,
    dir,
    dir,
    (event) => events.push(event),
    async () => ({ output: null, attachments: [] }),
    async () => null,
    { callSchedule } as never,
  )
  const agent = new HarnessAgent({
    // The harness interface is the SDK's internal one; this plays only what a thread uses.
    harness: scriptedHarness(text, !!options.answered) as never,
    tools: {},
    permissionMode: 'allow-all',
    sandboxConfig: { workDir: '.' },
  })
  const sandbox = createLocalSandboxSession({
    id: 'done-block',
    workingDirectory: dir,
    port: 0,
    env: {},
  })
  Object.assign(thread, {
    attach: async function (this: { live?: unknown }) {
      if (this.live) return this.live
      const session = await agent.createSession({ sandboxSession: sandbox })
      this.live = {
        agent,
        session,
        sandbox,
        account: spec.account,
        credentials: { cleanup: async () => {} },
        made: JSON.stringify([null, [], undefined]),
      }
      return this.live
    },
  })
  try {
    const outcome = await thread.run(
      { kind: 'prompt', text: 'Ship the CSV export' },
      spec,
      new AbortController().signal,
    )
    // What the thread saw by the time the turn's outcome came back.
    const seen = events.map((e) =>
      e.type === 'tool.started' || e.type === 'tool.finished' ? `${e.type}:${e.toolName}` : e.type,
    )
    return { outcome, events, calls, seen }
  } finally {
    await sandbox.destroy().catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  }
}

const shown = (seen: string[]) =>
  seen.filter((s) => !['usage.updated', 'raw', 'message.delta'].includes(s))

test('the turn ends once Brigade declared the thread done, the reply before it', async () => {
  const t = await turn(`${REPLY}\n\n${DONE}`, {})
  assert.equal(t.outcome.status, 'idle')
  assert.deepEqual(
    t.calls.map((c) => c.operation),
    [{ name: 'complete_thread', summary: 'CSV export merged (#412) and live' }],
  )
  assert.deepEqual(shown(t.seen), [
    'message.done',
    'tool.started:complete_thread',
    'tool.finished:complete_thread',
    'turn.completed',
  ])
  const reply = t.events.find((e) => e.type === 'message.done') as { text: string }
  assert.equal(reply.text, REPLY, 'the person never sees the block')
})

test('answered early, the turn’s end and the guess at the next message wait for Brigade’s answer', async () => {
  const t = await turn(`${REPLY}\n\n${DONE}`, { answered: true })
  assert.equal(t.outcome.status, 'idle')
  assert.equal(t.calls.length, 1)
  // The guess stays the thread's last event, as the message box reads it (suggestionFor).
  assert.deepEqual(shown(t.seen), [
    'message.done',
    'tool.started:complete_thread',
    'tool.finished:complete_thread',
    'turn.completed',
    'message.suggested',
  ])
})

test('refused, the turn still ends, with what is open under the reply', async () => {
  const open = {
    error:
      'Not done yet: something is still open in this thread. Deal with each:\n- Pull request #9 is still open: merge it.',
  }
  const t = await turn(`${REPLY}\n\n${DONE}`, { answer: open })
  assert.equal(t.outcome.status, 'idle')
  const finished = t.events.find((e) => e.type === 'tool.finished') as {
    output: unknown
    isError: boolean
  }
  assert.deepEqual([finished.output, finished.isError], [open, true])
  assert.equal(shown(t.seen).at(-1), 'turn.completed')
})

test('a child’s done block is only taken out of its reply: a child reports', async () => {
  const t = await turn(`${REPLY}\n\n${DONE}`, { child: true })
  assert.equal(t.calls.length, 0)
  assert.deepEqual(shown(t.seen), ['message.done', 'turn.completed'])
  assert.equal((t.events.find((e) => e.type === 'message.done') as { text: string }).text, REPLY)
})
