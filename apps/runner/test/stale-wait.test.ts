// A turn the bridge says only waits on work in the background, while none runs as the runner
// sees it (the 2026-11-06 health check's run: a command run in the foreground taken for
// background work kept its turn open for 7 hours, and through each update of the runner). The
// runner ends it, answered, once the wait has lasted STALE_WAIT_MS; one whose work still runs
// stays open. The harness is scripted, the session the runner's own (HarnessThread), as in
// done-block.test.ts.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import type { AgentEvent, ThreadSpec } from '@brigade/contracts'
import { createLocalSandboxSession } from '../src/harness/local-sandbox.js'

// Read as the harness module loads: a wait of a fraction of a second, for the test.
const WAIT_MS = 300
process.env.BRIGADE_STALE_WAIT_MS = String(WAIT_MS)
const { HarnessThread } = await import('../src/harness/index.js')

type Emit = (part: Record<string, unknown>) => void

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0 },
}

const waitingWord = (waiting: boolean) => ({
  type: 'raw',
  rawValue: { type: 'system', subtype: 'brigade_waiting', waiting },
})
const agentRuns = (running: boolean) => ({
  type: 'raw',
  rawValue: {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: running ? [{ task_id: 'a1', task_type: 'local_agent', description: 'Research' }] : [],
  },
})

/**
 * Claude Code answering, then the bridge holding the turn open as a stuck one does: its stream
 * ends only once the runner stops it. `parts` come after the answer; `emit` plays more later.
 */
function stuckHarness(parts: Record<string, unknown>[], played: { emit?: Emit }) {
  return {
    harnessId: 'scripted',
    specificationVersion: 'harness-v1',
    builtinTools: {},
    supportsBuiltinToolApprovals: true,
    doStart: async ({ sessionId }: { sessionId: string }) => ({
      sessionId,
      isResume: false,
      doPromptTurn: async ({ emit, abortSignal }: { emit: Emit; abortSignal?: AbortSignal }) => {
        played.emit = emit
        emit({ type: 'stream-start', modelId: 'scripted' })
        emit({ type: 'text-start', id: 'r' })
        emit({ type: 'text-delta', id: 'r', delta: 'All normal: reported.' })
        emit({ type: 'text-end', id: 'r' })
        emit({ type: 'finish-step', finishReason: { unified: 'stop', raw: 'stop' }, usage })
        for (const part of parts) emit(part)
        const done = new Promise<void>((resolve) => {
          if (abortSignal?.aborted) return resolve()
          abortSignal?.addEventListener('abort', () => resolve(), { once: true })
        })
        return { submitToolResult: async () => {}, done }
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

/**
 * A turn of a thread whose bridge plays `parts` after the answer, then holds the turn open.
 * `handedOver`: an update handed the turn over (handOver), waiting since `waitingAgo` ms if it waited.
 */
async function stuckTurn(
  parts: Record<string, unknown>[],
  options: { handedOver?: { waitingAgo?: number }; signal?: AbortSignal } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'brigade-stale-wait-'))
  const events: AgentEvent[] = []
  const played: { emit?: Emit } = {}
  const spec = {
    sessionId: 'stale-wait',
    starter: true,
    teammate: { id: 'riley', name: 'Riley', harness: 'claude-code', kind: 'teammate' },
    account: { id: 'acct' },
    connectors: [],
    fallbacks: [],
    parent: { id: 'p1', title: 'Grokbot' },
  } as unknown as ThreadSpec
  const thread = new HarnessThread(
    spec,
    dir,
    dir,
    (event) => events.push(event),
    async () => ({ output: null, attachments: [] }),
    async () => null,
    { callSchedule: async () => ({}) } as never,
  )
  const agent = new HarnessAgent({
    // The harness interface is the SDK's internal one; this plays only what a thread uses.
    harness: stuckHarness(parts, played) as never,
    tools: {},
    permissionMode: 'allow-all',
    sandboxConfig: { workDir: '.' },
  })
  const sandbox = createLocalSandboxSession({
    id: 'stale-wait',
    workingDirectory: dir,
    port: 0,
    env: {},
  })
  const internals = thread as unknown as {
    live?: unknown
    saved?: Record<string, unknown>
    takeHandedOver: (account: unknown) => Promise<number[]>
  }
  Object.assign(thread, {
    // The handed-over harness answers on its port.
    bridgeAnswers: async () => true,
    attach: async function (this: typeof internals) {
      if (this.live) return this.live
      // As a session starting under the harness an update handed over (start).
      await this.takeHandedOver(spec.account)
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
  const handed = options.handedOver
  if (handed) {
    // What the runner before wrote as it handed the turn over.
    await (thread as unknown as { load: () => Promise<void> }).load()
    internals.saved = {
      accountId: 'acct',
      transcript: [],
      handedOver: {
        groups: [999_999],
        calls: [],
        ...(handed.waitingAgo !== undefined
          ? { waitingSince: Date.now() - handed.waitingAgo, background: [] }
          : {}),
      },
    }
  }
  const started = Date.now()
  const outcome = thread.run(
    { kind: 'prompt', text: 'Daily health check' },
    spec,
    options.signal ?? new AbortController().signal,
  )
  const ended = () => events.filter((e) => e.type === 'turn.completed')
  return {
    outcome,
    events,
    ended,
    played,
    started,
    async cleanup() {
      await sandbox.destroy().catch(() => undefined)
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test(
  'an answered turn waiting on background work that is not running ends after the wait',
  { timeout: 10_000 },
  async () => {
    const t = await stuckTurn([waitingWord(true)])
    try {
      const outcome = await t.outcome
      assert.equal(outcome.status, 'idle')
      // Once, answered: as at its end, not as a stop.
      assert.deepEqual(
        t.ended().map((e) => (e as { finishReason: string }).finishReason),
        ['stop'],
      )
      const after = Date.now() - t.started
      assert.ok(after >= WAIT_MS, `ended after the wait (${after} ms)`)
      assert.ok(
        t.events.some((e) => e.type === 'message.done'),
        'its reply went out',
      )
    } finally {
      await t.cleanup()
    }
  },
)

test(
  'a turn whose work still runs in the background stays open until it ends',
  { timeout: 10_000 },
  async () => {
    const t = await stuckTurn([agentRuns(true), waitingWord(true)])
    try {
      await sleep(WAIT_MS * 3)
      assert.deepEqual(t.ended(), [], 'still open while the agent runs')
      // The agent ends; its report never comes: the wait counts from then on, and ends the turn.
      t.played.emit!(agentRuns(false))
      const outcome = await t.outcome
      assert.equal(outcome.status, 'idle')
      assert.equal(t.ended().length, 1)
    } finally {
      await t.cleanup()
    }
  },
)

test('a turn the bridge stopped waiting on stays open', { timeout: 10_000 }, async () => {
  const stop = new AbortController()
  // Claude Code at it again: a turn of its own, reading the report.
  const t = await stuckTurn([waitingWord(true), waitingWord(false)], { signal: stop.signal })
  try {
    await sleep(WAIT_MS * 3)
    assert.deepEqual(t.ended(), [], 'it works: nothing ends it')
    stop.abort()
    await t.outcome
  } finally {
    await t.cleanup()
  }
})

test(
  'a turn an update handed over while it waited ends in the next runner, without a word',
  { timeout: 10_000 },
  async () => {
    // The bridge said it waits before the update, never again: this runner only has what the
    // runner before kept.
    const t = await stuckTurn([], { handedOver: { waitingAgo: 10 * 60_000 } })
    try {
      const outcome = await t.outcome
      assert.equal(outcome.status, 'idle')
      assert.deepEqual(
        t.ended().map((e) => (e as { finishReason: string }).finishReason),
        ['stop'],
      )
    } finally {
      await t.cleanup()
    }
  },
)

test('a turn handed over while working is not ended for it', { timeout: 10_000 }, async () => {
  const stop = new AbortController()
  const t = await stuckTurn([], { handedOver: {}, signal: stop.signal })
  try {
    await sleep(WAIT_MS * 3)
    assert.deepEqual(t.ended(), [])
    stop.abort()
    await t.outcome
  } finally {
    await t.cleanup()
  }
})
