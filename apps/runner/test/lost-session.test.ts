// A thread quiet for longer than Claude Code keeps its conversations (cleanupPeriodDays, 30 days
// by default): resumed, Claude Code no longer has the conversation and answers so. The turn goes
// on in a new session, told the thread so far, instead of failing on every message after. What
// Claude Code answers goes through the real bridge first; then the harness is scripted, the
// session the runner's own (HarnessThread), so what goes in is what Claude Code would read.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import type { AgentEvent, ThreadSpec } from '@brigade/contracts'
import { claudeSettingsEnv } from '../src/harness/claude-settings.js'
import { EventMapper } from '../src/harness/events.js'
import { HarnessThread } from '../src/harness/index.js'
import { createLocalSandboxSession } from '../src/harness/local-sandbox.js'
import { bridgeTurn } from './fixtures/claude-bridge.js'

type Emit = (part: Record<string, unknown>) => void

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0 },
}

/** What the runner kept of the thread's session, as Claude Code's adapter writes it on a stop. */
const RESUME = {
  type: 'resume-session',
  harnessId: 'claude-code',
  specificationVersion: 'harness-v1',
  data: { claudeSessionId: 'deleted-conversation' },
}

/** Claude Code's own words (its CLI, through the bridge's terminal error). */
const LOST = 'No conversation found with session ID: deleted-conversation'

/**
 * Claude Code as a thread sees it. A session that resumes a conversation finds it deleted and
 * fails its turn, as Claude Code does; one started anew answers. `always`: a new one fails too.
 * What each session was given is kept, in order.
 */
function scriptedHarness(heard: string[], next: { resumes: boolean }, always = false) {
  return {
    harnessId: 'scripted',
    specificationVersion: 'harness-v1',
    builtinTools: {},
    supportsBuiltinToolApprovals: true,
    doStart: async ({ sessionId }: { sessionId: string }) => {
      const resumes = next.resumes
      return {
        sessionId,
        isResume: resumes,
        doPromptTurn: async ({ emit, prompt }: { emit: Emit; prompt: unknown }) => {
          heard.push(typeof prompt === 'string' ? prompt : JSON.stringify(prompt))
          emit({ type: 'stream-start', modelId: 'scripted' })
          if (resumes || always) {
            emit({ type: 'error', error: LOST })
            return { submitToolResult: async () => {}, done: Promise.resolve() }
          }
          emit({ type: 'text-start', id: 'r' })
          emit({ type: 'text-delta', id: 'r', delta: 'Done' })
          emit({ type: 'text-end', id: 'r' })
          emit({ type: 'finish-step', finishReason: { unified: 'stop', raw: 'stop' }, usage })
          return { submitToolResult: async () => {}, done: Promise.resolve() }
        },
        doContinueTurn: async () => ({ submitToolResult: async () => {}, done: Promise.resolve() }),
        // The adapter keeps naming the conversation it was given, found or not.
        doStop: async () => (resumes ? RESUME : { ...RESUME, data: { claudeSessionId: 'new' } }),
        doDestroy: async () => {},
      }
    },
  }
}

async function setup(always = false) {
  const dir = await mkdtemp(join(tmpdir(), 'brigade-lost-session-'))
  // Parked a month ago, after a turn, with what was said then.
  await writeFile(
    join(dir, 'lost-session.json'),
    JSON.stringify({
      accountId: 'acct',
      resume: RESUME,
      transcript: [
        { role: 'user', text: 'Add the caches to the cleanup' },
        { role: 'assistant', text: 'Opened PR #660.' },
      ],
    }),
  )
  const heard: string[] = []
  const events: AgentEvent[] = []
  const spec = {
    sessionId: 'lost-session',
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
  const next = { resumes: false }
  const agent = new HarnessAgent({
    // The harness interface is the SDK's internal one; this plays only what a thread uses.
    harness: scriptedHarness(heard, next, always) as never,
    tools: {},
    permissionMode: 'allow-all',
    sandboxConfig: { workDir: '.' },
  })
  const sandboxes: ReturnType<typeof createLocalSandboxSession>[] = []
  /** The saved session each new harness process started from (attach). */
  const resumedFrom: unknown[] = []
  Object.assign(thread, {
    attach: async function (this: { live?: unknown; saved?: { resume?: unknown } }) {
      if (this.live) return this.live
      resumedFrom.push(this.saved?.resume)
      // As the real one: a saved session is resumed (createSession's resumeFrom).
      next.resumes = this.saved?.resume !== undefined
      const sandbox = createLocalSandboxSession({
        id: `lost-session-${sandboxes.length}`,
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
  const saved = async () => JSON.parse(await readFile(join(dir, 'lost-session.json'), 'utf8'))
  const done = async () => {
    for (const sandbox of sandboxes) await Promise.resolve(sandbox.destroy()).catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  }
  return { run, heard, events, resumedFrom, saved, done }
}

/**
 * Claude Code resuming a conversation it deleted, as its CLI answers (stream-json, then exit 1),
 * for the bridge (fixtures/claude-bridge.ts). The stand-in writes down what it was to resume.
 */
const DELETED_SDK = `import { appendFileSync } from 'node:fs'
export function query({ prompt, options }) {
  const input = prompt[Symbol.asyncIterator]()
  async function* run() {
    await input.next()
    appendFileSync(process.env.FAKE_SDK_RECORD, JSON.stringify({ resume: options.resume ?? null }) + '\\n')
    yield { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, session_id: options.resume, errors: ['No conversation found with session ID: ' + options.resume] }
    throw new Error('Claude Code process exited with code 1')
  }
  const messages = run()
  messages.interrupt = async () => {}
  return messages
}
`

test("the bridge passes Claude Code's answer on, in words the thread recognises", async () => {
  const { parts, record } = await bridgeTurn(DELETED_SDK, {
    permissionMode: 'allow-all',
    env: claudeSettingsEnv(),
    resumeFrom: RESUME,
  })
  assert.deepEqual(record, [{ resume: 'deleted-conversation' }])
  const errors = parts.filter((p) => p.type === 'error').map((p) => String(p.error))
  assert.deepEqual(errors, [LOST])
  assert.ok(EventMapper.sessionLost(errors[0]!))
  // Any other failure stays one.
  assert.equal(
    EventMapper.sessionLost('claude-code bridge closed before the turn finished.'),
    false,
  )
})

test('a conversation Claude Code deleted goes on in a new session, told the thread so far', async () => {
  const t = await setup()
  try {
    const outcome = await t.run({ kind: 'prompt', text: 'Fix the resume' })
    assert.deepEqual(outcome, { status: 'idle' })
    // Resumed first, then started anew: nothing of the lost conversation is named again.
    assert.deepEqual(t.resumedFrom, [RESUME, undefined])
    assert.equal(t.heard[0], 'Fix the resume')
    const handoff = t.heard[1] ?? ''
    assert.match(handoff, /^This conversation continues in a new session because the previous/)
    assert.match(
      handoff,
      /User: Add the caches to the cleanup\n\nYou: Opened PR #660\.\n\nUser: Fix the resume/,
    )
    assert.ok(handoff.endsWith('Continue with the latest request if it is not finished yet.'))
    assert.equal(t.heard.length, 2, 'the message is not told twice')
    // The person sees no error, only that the teammate carries on.
    assert.deepEqual(
      t.events.filter((e) => e.type === 'error'),
      [],
    )
    const notice = t.events.find((e) => e.type === 'raw' && e.source === 'runner')
    assert.match(String(notice?.type === 'raw' && notice.value), /no longer on this computer/)
    assert.ok(t.events.some((e) => e.type === 'message.done' && e.text === 'Done'))
    assert.equal((await t.saved()).resume, undefined, 'the deleted conversation is forgotten')

    // The next message goes to the new session as it is.
    assert.deepEqual(await t.run({ kind: 'prompt', text: 'Thanks' }), { status: 'idle' })
    assert.equal(t.heard[2], 'Thanks')
    assert.equal(t.resumedFrom.length, 2)
  } finally {
    await t.done()
  }
})

test(
  'a new session that fails the same way fails the turn once, with the error',
  { timeout: 10_000 },
  async () => {
    const t = await setup(true)
    try {
      const outcome = await t.run({ kind: 'prompt', text: 'Fix the resume' })
      assert.deepEqual(outcome, { status: 'failed', error: LOST })
      assert.equal(t.heard.length, 2, 'started anew once, not again and again')
      assert.deepEqual(
        t.events.filter((e) => e.type === 'error').map((e) => e.type === 'error' && e.message),
        [LOST],
      )
    } finally {
      await t.done()
    }
  },
)
