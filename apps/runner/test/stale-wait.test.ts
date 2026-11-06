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
const { machineTools } = await import('../src/harness/tools.js')

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
function stuckHarness(
  parts: Record<string, unknown>[],
  played: { emit?: Emit },
  /** Without its answer first: a turn handed over goes on where it was. */
  answer = true,
) {
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
        if (answer) {
          emit({ type: 'text-start', id: 'r' })
          emit({ type: 'text-delta', id: 'r', delta: 'All normal: reported.' })
          emit({ type: 'text-end', id: 'r' })
        }
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
 * `handedOver`: an update handed the turn over (handOver), waiting since `waitingAgo` ms if it waited,
 * with a steered message still to answer if `steered`.
 */
async function stuckTurn(
  parts: Record<string, unknown>[],
  options: { handedOver?: { waitingAgo?: number; steered?: boolean }; signal?: AbortSignal } = {},
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
    harness: stuckHarness(parts, played, !options.handedOver?.steered) as never,
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
        ...(handed.steered ? { steered: true } : {}),
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
    thread,
    /** What the runner keeps on disk for the next one (SavedState). */
    saved: () => internals.saved,
    /** The live session, as an update finds it: its harness in a process group of its own. */
    live: () => internals.live as { sandbox: object; session: object },
    async cleanup() {
      await sandbox.destroy().catch(() => undefined)
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test(
  'an answered turn waiting on background work that is not running ends after the wait',
  { timeout: 20_000 },
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
  { timeout: 20_000 },
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

test('a turn the bridge stopped waiting on stays open', { timeout: 20_000 }, async () => {
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
  { timeout: 20_000 },
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

test('a turn handed over while working is not ended for it', { timeout: 20_000 }, async () => {
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

test(
  'an update hands the wait over with the turn, and leaves ending it to the next runner',
  { timeout: 20_000 },
  async () => {
    const stop = new AbortController()
    const t = await stuckTurn([waitingWord(true)], { signal: stop.signal })
    try {
      await sleep(50)
      const live = t.live()
      Object.assign(live.sandbox, { groups: () => [4242] })
      Object.assign(live.session, {
        detach: async () => ({
          type: 'resume-session',
          harnessId: 'scripted',
          specificationVersion: 'harness-v1',
          data: {},
        }),
      })
      // Work ran and ended; a person's message went in, not answered yet.
      t.played.emit!(agentRuns(true))
      t.played.emit!(agentRuns(false))
      Object.assign((live as unknown as { agent: object }).agent, {
        experimental_steer: async () => {},
      })
      await t.thread.steer('And the disk?', 'member-message-2')
      const groups = await t.thread.handOver()
      assert.deepEqual(groups, [{ pgid: 4242 }])
      const handed = (
        t.saved() as {
          handedOver?: {
            waitingSince?: number
            background?: unknown
            quietSince?: number
            steered?: boolean
          }
        }
      ).handedOver
      assert.ok(handed?.waitingSince && handed.waitingSince <= Date.now(), JSON.stringify(handed))
      assert.deepEqual(handed.background, [])
      assert.ok(
        handed.quietSince && handed.quietSince >= handed.waitingSince,
        JSON.stringify(handed),
      )
      assert.equal(handed.steered, true)
      // Past the wait, this runner ends nothing: the turn is the next one's.
      await sleep(WAIT_MS * 3)
      assert.deepEqual(t.ended(), [])
    } finally {
      stop.abort()
      await t.outcome
      await t.cleanup()
    }
  },
)

// From the review of #767 (Cody's reproductions).
test(
  'a turn whose work just ended gets the whole wait from then',
  { timeout: 20_000 },
  async () => {
    const stop = new AbortController()
    const t = await stuckTurn([agentRuns(true), waitingWord(true)], { signal: stop.signal })
    try {
      while (!t.played.emit) await sleep(1)
      // It has waited longer than the wait while the agent ran: none of that counts.
      await sleep(WAIT_MS * 1.5)
      const ended = Date.now()
      t.played.emit(agentRuns(false))
      const early = await Promise.race([t.outcome, sleep(WAIT_MS * 0.75).then(() => null)])
      assert.equal(early, null, `ended ${Date.now() - ended} ms after the agent, before the wait`)
      // Then the wait is over, and its report never came.
      assert.equal((await t.outcome).status, 'idle')
      assert.ok(Date.now() - ended >= WAIT_MS)
    } finally {
      stop.abort()
      await t.outcome
      await t.cleanup()
    }
  },
)

test(
  'a message steered into the waiting turn gets its answer before the turn ends',
  { timeout: 20_000 },
  async () => {
    const stop = new AbortController()
    const t = await stuckTurn([waitingWord(true)], { signal: stop.signal })
    try {
      while (!t.played.emit) await sleep(1)
      // Claude Code takes the message in at once; its answer starts after the wait is over.
      const live = t.live() as unknown as { agent: { experimental_steer: unknown } }
      live.agent.experimental_steer = async () => {}
      await sleep(WAIT_MS * 0.75)
      await t.thread.steer('Please answer my new question', 'member-message-2')
      await sleep(WAIT_MS * 0.5 + 50)
      assert.deepEqual(t.ended(), [], 'not ended while its answer is to come')
      t.played.emit(waitingWord(false))
      t.played.emit({ type: 'text-start', id: 'r2' })
      t.played.emit({ type: 'text-delta', id: 'r2', delta: 'Answer to the new question.' })
      t.played.emit({ type: 'text-end', id: 'r2' })
      t.played.emit({ type: 'finish-step', finishReason: { unified: 'stop', raw: 'stop' }, usage })
      await sleep(30)
      assert.ok(
        t.events.some((e) => e.type === 'message.done' && e.text.includes('new question')),
        'its answer went out',
      )
    } finally {
      stop.abort()
      await t.outcome
      await t.cleanup()
    }
  },
)

test(
  'a turn handed over with a steered message to answer is not ended before its answer',
  { timeout: 20_000 },
  async () => {
    const stop = new AbortController()
    const t = await stuckTurn([], {
      handedOver: { waitingAgo: 10 * 60_000, steered: true },
      signal: stop.signal,
    })
    try {
      await sleep(WAIT_MS * 3)
      assert.deepEqual(t.ended(), [], 'its answer is still to come')
      // It comes: the turn's wait goes on, and ends it once over.
      while (!t.played.emit) await sleep(1)
      t.played.emit({ type: 'text-start', id: 'r2' })
      t.played.emit({ type: 'text-delta', id: 'r2', delta: 'The disk is fine.' })
      t.played.emit({ type: 'text-end', id: 'r2' })
      assert.equal((await t.outcome).status, 'idle')
    } finally {
      stop.abort()
      await t.outcome
      await t.cleanup()
    }
  },
)

// A message given to the turn ends the waits of its tools on the thread's machine until the turn
// reads it, with the next tool's result (arrivals.ts): only after Claude Code took it.
test(
  'a message steered in ends the waits of the turn until a tool result takes it in',
  { timeout: 20_000 },
  async () => {
    const stop = new AbortController()
    const t = await stuckTurn([waitingWord(true)], { signal: stop.signal })
    try {
      while (!t.played.emit) await sleep(1)
      let taken!: () => void
      const live = t.live() as unknown as { agent: { experimental_steer: unknown } }
      live.agent.experimental_steer = () => new Promise<void>((done) => (taken = done))
      const waiting = t.thread.arrivals.watch()
      const steered = t.thread.steer('Is the render done?', 'member-message-3')
      await sleep(20)
      assert.equal(waiting.signal.aborted, false, 'not before Claude Code took the message')
      taken()
      await steered
      assert.ok(waiting.signal.aborted && waiting.cut === 'message', 'a wait under way ends')
      waiting.release()
      const early = t.thread.arrivals.watch()
      assert.ok(early.signal.aborted, 'one that starts before the turn read it ends at once')
      early.release()
      t.played.emit({
        type: 'tool-call',
        toolCallId: 'b1',
        toolName: 'Bash',
        input: '{"command":"ls"}',
        providerExecuted: true,
      })
      t.played.emit({ type: 'tool-result', toolCallId: 'b1', toolName: 'Bash', result: 'ok' })
      for (let i = 0; i < 200 && !t.events.some((e) => e.type === 'tool.finished'); i++)
        await sleep(10)
      assert.ok(
        t.events.some((e) => e.type === 'tool.finished'),
        'the result went to the model',
      )
      const after = t.thread.arrivals.watch()
      assert.equal(after.signal.aborted, false, 'read with that result: the next wait waits')
      after.release()
      assert.equal(t.thread.arrivals.listening, 0)
    } finally {
      stop.abort()
      await t.outcome
      await t.cleanup()
    }
  },
)

// Nov 6, "Montage énergétique façon YouTuber 2": an update came while run_on_machine waited on a
// render. The harness lets go of a turn only once its host's calls are done, so it held on past
// HAND_OVER_MS; the turn was stopped and started again, and the command's id went with the call.
test(
  'an update during a wait on the machine ends the wait with the command, and hands the turn over',
  { timeout: 30_000 },
  async () => {
    const stop = new AbortController()
    const t = await stuckTurn([waitingWord(true)], { signal: stop.signal })
    try {
      await sleep(50)
      const live = t.live()
      Object.assign(live.sandbox, { groups: () => [4343] })
      // A render on the thread's machine, waited on as MachineRuns does.
      const waitFor = (ms: number, signal?: AbortSignal) =>
        new Promise<void>((done) => {
          if (signal?.aborted) return done()
          const timer = setTimeout(done, ms)
          signal?.addEventListener('abort', () => (clearTimeout(timer), done()), { once: true })
        })
      const view = {
        id: 'r9',
        command: 'npx hyperframes render',
        cwd: 'video',
        status: 'running' as const,
        startedAt: new Date().toISOString(),
        seconds: 1,
        notes: [],
      }
      const runs = {
        run: async (_input: unknown, waitMs: number, signal?: AbortSignal) => {
          await waitFor(waitMs, signal)
          return view
        },
        get: async (_id: string, waitMs: number, _lines?: number, signal?: AbortSignal) => {
          await waitFor(waitMs, signal)
          return view
        },
        stop: async () => assert.fail('the command is not stopped'),
        list: () => [],
      }
      const tools = machineTools(runs, { env: async () => ({ file: '' }) } as never, t.thread.arrivals)
      const call = (name: string, input: object) =>
        tools[name]!.execute!(input as never, { toolCallId: name, messages: [] }) as Promise<{
          id: string
          status: string
          note: string
        }>
      const render = call('run_on_machine', { command: 'npx hyperframes render', cwd: 'video' })
      // As Claude Code's bridge does: the turn is let go of once the host's calls are done.
      Object.assign(live.session, {
        detach: async () => {
          await render
          return {
            type: 'resume-session',
            harnessId: 'scripted',
            specificationVersion: 'harness-v1',
            data: {},
          }
        },
      })
      const started = Date.now()
      const groups = await t.thread.handOver()
      assert.ok(Date.now() - started < 5_000, `not HAND_OVER_MS: ${Date.now() - started} ms`)
      assert.deepEqual(groups, [{ pgid: 4343 }])
      assert.equal((t.thread as unknown as { handOverFailed: boolean }).handOverFailed, false)
      assert.ok((t.saved() as { handedOver?: unknown }).handedOver, 'handed over, not stopped')
      const result = await render
      assert.equal(result.status, 'running')
      assert.equal(result.id, 'r9')
      assert.match(result.note, /Brigade's runner is updating/)
      assert.match(result.note, /machine_run\(\{ id: "r9" \}\)/)
      // A wait that starts while this runner leaves ends at once, as said.
      const begun = Date.now()
      const again = await call('machine_run', { id: 'r9', waitMinutes: 10 })
      assert.ok(Date.now() - begun < 1_000)
      assert.match(again.note, /Brigade's runner is updating/)
      assert.equal(t.thread.arrivals.listening, 0)
    } finally {
      stop.abort()
      await t.outcome
      await t.cleanup()
    }
  },
)
