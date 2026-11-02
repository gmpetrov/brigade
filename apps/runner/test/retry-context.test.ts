// A turn whose harness process died (the memory guard killed it) before anything kept its
// conversation, as on a thread's very first turn: tried again, the teammate still has the
// message it was answering. The harness is scripted, the session the runner's own
// (HarnessThread), so what goes in is what Claude Code would read.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import type { AgentEvent, ThreadSpec } from '@brigade/contracts'
import { HarnessThread } from '../src/harness/index.js'
import { createLocalSandboxSession } from '../src/harness/local-sandbox.js'

type Emit = (part: Record<string, unknown>) => void

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0 },
}

/**
 * Claude Code as a thread sees it. `dies`: its process is killed during its first turn, so the
 * turn fails, and a stop finds no process to answer it. What it was given is kept, in order.
 */
function scriptedHarness(heard: string[], dies: boolean) {
  let turns = 0
  return {
    harnessId: 'scripted',
    specificationVersion: 'harness-v1',
    builtinTools: {},
    supportsBuiltinToolApprovals: true,
    doStart: async ({ sessionId }: { sessionId: string }) => ({
      sessionId,
      isResume: false,
      doPromptTurn: async ({ emit, prompt }: { emit: Emit; prompt: unknown }) => {
        heard.push(typeof prompt === 'string' ? prompt : JSON.stringify(prompt))
        emit({ type: 'stream-start', modelId: 'scripted' })
        if (dies && ++turns === 1) {
          emit({ type: 'error', error: 'claude-code bridge closed before the turn finished.' })
          return { submitToolResult: async () => {}, done: Promise.resolve() }
        }
        emit({ type: 'text-start', id: 'r' })
        emit({ type: 'text-delta', id: 'r', delta: 'Done' })
        emit({ type: 'text-end', id: 'r' })
        emit({ type: 'finish-step', finishReason: { unified: 'stop', raw: 'stop' }, usage })
        return { submitToolResult: async () => {}, done: Promise.resolve() }
      },
      doContinueTurn: async () => ({ submitToolResult: async () => {}, done: Promise.resolve() }),
      doStop: async () => {
        if (dies) throw new Error('claude-code session is already stopped; cannot stop.')
        return {
          type: 'resume-session',
          harnessId: 'scripted',
          specificationVersion: 'harness-v1',
          data: {},
        }
      },
      doDestroy: async () => {},
    }),
  }
}

async function setup(dies: boolean) {
  const dir = await mkdtemp(join(tmpdir(), 'brigade-retry-context-'))
  const heard: string[] = []
  const events: AgentEvent[] = []
  const spec = {
    sessionId: 'retry-context',
    starter: true,
    teammate: { id: 'riley', name: 'Riley', harness: 'claude-code', kind: 'teammate' },
    account: { id: 'acct' },
    connectors: [],
    fallbacks: [],
  } as unknown as ThreadSpec
  const thread = new HarnessThread(
    spec,
    dir,
    dir,
    (event) => events.push(event),
    async () => ({ output: null, attachments: [] }),
    async () => null,
    {} as never,
  )
  const agent = new HarnessAgent({
    // The harness interface is the SDK's internal one; this plays only what a thread uses.
    harness: scriptedHarness(heard, dies) as never,
    tools: {},
    permissionMode: 'allow-all',
    sandboxConfig: { workDir: '.' },
  })
  const sandboxes: { destroy: () => Promise<void> }[] = []
  /** The session the thread would start itself (attach): each a new harness process. */
  const resumedFrom: unknown[] = []
  Object.assign(thread, {
    attach: async function (this: { live?: unknown; saved?: { resume?: unknown } }) {
      if (this.live) return this.live
      resumedFrom.push(this.saved?.resume)
      const sandbox = createLocalSandboxSession({
        id: `retry-context-${sandboxes.length}`,
        workingDirectory: dir,
        port: 0,
        env: {},
      })
      sandboxes.push(sandbox)
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
  const run = (input: Parameters<HarnessThread['run']>[0]) =>
    thread.run(input, spec, new AbortController().signal)
  const done = async () => {
    for (const sandbox of sandboxes) await sandbox.destroy().catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  }
  return { run, heard, events, resumedFrom, dir, done }
}

const RETRY =
  'Your last turn in this thread stopped on an error: Stopped to give the computer memory back: pressure.'

test("a thread's first turn killed mid-way is tried again with its message and its conversation", async () => {
  const t = await setup(true)
  try {
    const brief = 'Scheduled run of "Weekly review": review the recommendations.'
    assert.equal((await t.run({ kind: 'prompt', text: brief })).status, 'failed')
    // The stop found no process: the conversation the harness wrote is continued all the same.
    const saved = JSON.parse(await readFile(join(t.dir, 'retry-context.json'), 'utf8'))
    assert.deepEqual(saved.resume, {
      type: 'resume-session',
      specificationVersion: 'harness-v1',
      harnessId: 'claude-code',
      data: {},
    })

    assert.equal((await t.run({ kind: 'prompt', text: RETRY, retry: true })).status, 'idle')
    assert.deepEqual(t.resumedFrom, [undefined, saved.resume])
    const retried = t.heard[1] ?? ''
    assert.match(retried, /this is the latest message you were answering:\n\nScheduled run of/)
    assert.ok(retried.endsWith(RETRY), 'the error and what to do come after it')

    // Tried again once more: still told the brief, not the retry before.
    await t.run({ kind: 'prompt', text: RETRY, retry: true })
    assert.match(t.heard[2] ?? '', /answering:\n\nScheduled run of/)
    // A message of a person's own is not a retry: nothing told again.
    await t.run({ kind: 'prompt', text: 'Thanks' })
    assert.equal(t.heard[3], 'Thanks')
  } finally {
    await t.done()
  }
})

test('a long message is told again whole, its request at the end included', async () => {
  const t = await setup(true)
  try {
    const request = 'REQUEST: only inspect issue 599; do not modify files.'
    const brief = `Context: ${'x'.repeat(41_000)}\n${request}`
    await t.run({ kind: 'prompt', text: brief })
    // Tried again after the memory guard stopped it.
    await t.run({ kind: 'prompt', text: RETRY, retry: true })
    assert.ok(t.heard[1]?.includes(brief), 'the retry has the whole message')
    // Then the computer restarts during a turn: continued, told the whole message again.
    await t.run({ kind: 'resume', text: '' })
    assert.ok(t.heard[2]?.includes(request), 'the restart has the request at its end')
  } finally {
    await t.done()
  }
})
