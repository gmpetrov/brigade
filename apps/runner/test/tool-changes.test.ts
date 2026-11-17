// A thread resumed after a runner update that changed one of Brigade's tools (computer_act's
// `steps`, Nov 15). Claude Code keeps sending a deferred tool's definition as it first sent it,
// in each new process too, and Codex keeps a thread's dynamic tools from its thread/start: so the
// next message tells the teammate what changed, in the same conversation. Each runner here is a
// HarnessThread of its own on the same state folder, its sessions through the real patched
// bridges with their stand-ins for Claude Code and `codex app-server`.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, delimiter } from 'node:path'
import { test } from 'node:test'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { createClaudeCode } from '@ai-sdk/harness-claude-code'
import { createCodex } from '@ai-sdk/harness-codex'
import type { ThreadSpec } from '@brigade/contracts'
import { jsonSchema, tool, type ToolSet } from 'ai'
import { claudeSettingsEnv } from '../src/harness/claude-settings.js'
import { agentKey, HarnessThread } from '../src/harness/index.js'
import { createLocalSandboxSession, freePort } from '../src/harness/local-sandbox.js'
import {
  changedTools,
  toolChangesNote,
  toolDigests,
  toolSpecs,
  toolsOfUnknownAge,
} from '../src/harness/tool-changes.js'
import { fakeInstall as fakeClaudeInstall } from './fixtures/claude-bridge.js'
import { toNative } from '../src/windows.js'
import { fakeInstall as fakeCodexInstall } from './fixtures/codex-bridge.js'

const OLD_ACT = 'Act on an element by its ref. Then take a new snapshot to check it worked.'
const NEW_ACT = 'Act on an element by its ref, or on several with steps. The window is read after.'

/** computer_act as the runner before the update served it, and as the one after does. */
const toolsOf = (updated: boolean, granted = false): ToolSet => ({
  // An App granted since (from a ticket, say): a tool the conversation never had.
  ...(granted
    ? {
        neon_run_sql: tool({
          description: 'Run one SQL statement on a Neon database.',
          inputSchema: jsonSchema({ type: 'object', properties: { sql: { type: 'string' } } }),
          execute: async () => 'ok',
        }),
      }
    : {}),
  computer_act: tool({
    description: updated ? NEW_ACT : OLD_ACT,
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        ref: { type: 'string' },
        action: { type: 'string' },
        ...(updated ? { steps: { type: 'array', items: { type: 'object' } } } : {}),
      },
    }),
    execute: async () => 'ok',
  }),
  open_ticket: tool({
    description: 'Open a ticket for a person.',
    inputSchema: jsonSchema({ type: 'object', properties: { title: { type: 'string' } } }),
    execute: async () => 'ok',
  }),
})

/**
 * Claude Code: it writes down each process (query) with the conversation it resumes, the
 * definitions the bridge serves it, and each message it reads, which it answers.
 */
const CLAUDE_SDK = `import { appendFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
const note = (what) => appendFileSync(process.env.FAKE_SDK_RECORD, JSON.stringify(what) + '\\n')
export function query({ prompt, options }) {
  async function* run() {
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'claude-code', version: '0' })
    await Promise.all([options.mcpServers['harness-tools'].instance.connect(serverSide), client.connect(clientSide)])
    const { tools } = await client.listTools()
    note({ what: 'query', resume: options.resume ?? null, continue: options.continue ?? null, served: tools.map((t) => [t.name, t.description]) })
    const base = { session_id: 'conversation-1', usage: { input_tokens: 1, output_tokens: 1 } }
    yield { type: 'system', subtype: 'init', session_id: 'conversation-1' }
    for await (const message of prompt) {
      const text = message.message.content.map((c) => c.text ?? '').join('')
      note({ what: 'message', text })
      const said = 'Done'
      const ev = (event) => ({ type: 'stream_event', parent_tool_use_id: null, session_id: 'conversation-1', event })
      yield ev({ type: 'message_start', message: { id: 'm-' + text.length, role: 'assistant', content: [], usage: base.usage } })
      yield ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      yield ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: said } })
      yield ev({ type: 'content_block_stop', index: 0 })
      yield ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: base.usage })
      yield ev({ type: 'message_stop' })
      yield { type: 'assistant', parent_tool_use_id: null, session_id: 'conversation-1', message: { id: 'm-' + Math.random(), role: 'assistant', content: [{ type: 'text', text: said }] } }
      yield { type: 'result', subtype: 'success', is_error: false, result: said, user_message_uuid: message.uuid, ...base }
    }
  }
  const messages = run()
  messages.interrupt = async () => {}
  return messages
}
`

type Harness = 'claude-code' | 'codex'

/** A computer: its state folder and home, kept from one runner to the next. */
async function computer(harness: Harness) {
  const home = await mkdtemp(join(tmpdir(), `tool-changes-${harness}-`))
  const work = join(home, 'work')
  await mkdir(work, { recursive: true })
  const record = join(home, 'record.jsonl')
  const spec = {
    sessionId: `tool-changes-${harness}`,
    starter: true,
    teammate: { id: 'riley', name: 'Riley', harness, kind: 'teammate' },
    account: { id: 'acct' },
    connectors: [],
    fallbacks: [],
  } as unknown as ThreadSpec
  const sandboxes: ReturnType<typeof createLocalSandboxSession>[] = []

  /** A runner, with its version of Brigade's tools: its sessions start as the real one's (begin). */
  const runner = (updated: boolean, granted = false) => {
    const thread = new HarnessThread(
      spec,
      work,
      home,
      () => {},
      async () => ({ output: null, attachments: [] }),
      async () => null,
      {} as never,
    )
    const tools = toolsOf(updated, granted)
    Object.assign(thread, {
      attach: async function (this: {
        live?: unknown
        saved?: { resume?: unknown; accountId?: string }
        begin: (live: unknown, specs: unknown, resume: unknown) => unknown
      }) {
        if (this.live) return this.live
        const sandbox = createLocalSandboxSession({
          id: `${spec.sessionId}-${sandboxes.length}`,
          workingDirectory: work,
          port: await freePort(),
          env: {
            ...(process.platform === 'win32' ? (process.env as Record<string, string>) : {}),
            PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
            HOME: home,
            USERPROFILE: home,
            CODEX_HOME: join(home, '.codex'),
            FAKE_SDK_RECORD: record,
            FAKE_CODEX_RECORD: record,
            ...(harness === 'claude-code' ? claudeSettingsEnv() : {}),
          },
        })
        sandboxes.push(sandbox)
        // The bootstraps install nothing: the stand-ins take their place.
        const run = sandbox.run
        const bootstrapRun: typeof run = async (input) => {
          if (input.command.startsWith('pnpm install')) {
            const dir = toNative(input.workingDirectory ?? '.', work)
            if (harness === 'codex') await fakeCodexInstall(dir)
            else await fakeClaudeInstall(dir, CLAUDE_SDK)
            return { exitCode: 0, stdout: '', stderr: '' }
          }
          if (input.command.includes('claude --version'))
            return { exitCode: 0, stdout: '2.1.319 (Claude Code)', stderr: '' }
          return run(input)
        }
        const restricted = { ...sandbox.restricted(), run: bootstrapRun }
        const sandboxSession = { ...sandbox, run: bootstrapRun, restricted: () => restricted }
        const agent = new HarnessAgent({
          harness: harness === 'codex' ? createCodex({ auth: {} }) : createClaudeCode({ auth: {} }),
          tools,
          toolApproval: Object.fromEntries(
            Object.keys(tools).map((name) => [name, 'not-applicable' as const]),
          ),
          permissionMode: 'allow-all',
          sandboxConfig: { workDir: '.' },
        })
        const resume = this.saved?.accountId === spec.account.id ? this.saved.resume : undefined
        const session = await agent.createSession({
          sandboxSession: sandboxSession as never,
          ...(resume ? { resumeFrom: resume as never } : {}),
        })
        return this.begin(
          {
            agent,
            session,
            sandbox,
            account: spec.account,
            credentials: { cleanup: async () => {} },
            made: agentKey(spec),
          },
          toolSpecs(tools),
          resume,
        )
      },
    })
    return {
      say: async (text: string) => {
        const outcome = await thread.run(
          { kind: 'prompt', text },
          spec,
          new AbortController().signal,
        )
        assert.equal(outcome.status, 'idle', JSON.stringify(outcome))
      },
      // The runner stops for the update: the session parks, its conversation saved.
      stop: async () => {
        await thread.park()
      },
    }
  }
  const recorded = async () =>
    (await readFile(record, 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  const done = async () => {
    for (const sandbox of sandboxes) await Promise.resolve(sandbox.destroy()).catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  }
  /** The thread's saved state, as the runners keep it. */
  const stateFile = join(home, `${spec.sessionId}.json`)
  return { runner, recorded, done, stateFile }
}

test('Claude Code: after an update that changed a tool, the next message says what changed, in the same conversation', async () => {
  const machine = await computer('claude-code')
  try {
    const before = machine.runner(false)
    await before.say('Click Save')
    await before.stop()
    const after = machine.runner(true)
    await after.say('Now fill the form')
    await after.say('And send it')
    // Restarted again, with nothing changed since: told nothing more.
    await after.stop()
    await machine.runner(true).say('Thanks')
    const record = await machine.recorded()
    const messages = record.filter((r) => r.what === 'message').map((r) => r.text as string)
    assert.equal(messages.length, 4, JSON.stringify(record))
    assert.equal(messages[3], 'Thanks')
    assert.equal(messages[0], 'Click Save')
    // The first message after the update: computer_act as it is now, its new input included.
    assert.match(messages[1]!, /<brigade-tool-changes>/)
    assert.ok(messages[1]!.includes(NEW_ACT), messages[1])
    assert.match(messages[1]!, /"steps"/)
    assert.ok(messages[1]!.endsWith('Now fill the form'), messages[1])
    // Only the tool that changed.
    assert.doesNotMatch(messages[1]!, /open_ticket/)
    // Told once.
    assert.equal(messages[2], 'And send it')
    // The conversation goes on: the session after the update resumes Claude Code's.
    const queries = record.filter((r) => r.what === 'query')
    assert.equal(queries.at(-1).resume, 'conversation-1', JSON.stringify(queries))
    assert.ok(!messages.includes('Continue.'))
  } finally {
    await machine.done()
  }
})

test('Codex: after an update that changed a tool, the next message says what changed, in the same Codex thread', async () => {
  const machine = await computer('codex')
  try {
    const before = machine.runner(false)
    await before.say('Click Save')
    await before.stop()
    const after = machine.runner(true)
    await after.say('Now fill the form')
    await after.say('And send it')
    const requests = await machine.recorded()
    // One thread, started once with the tools of then, resumed after the update: never a new
    // thread seeded with "Continue." alone.
    const threads = requests.filter((r) => r.method === 'thread/start')
    assert.equal(threads.length, 1, JSON.stringify(requests.map((r) => r.method)))
    const resumed = requests.filter((r) => r.method === 'thread/resume')
    assert.equal(resumed.length, 1)
    assert.equal(resumed[0].params.threadId, 'new-thread')
    // thread/resume takes no tools: Codex keeps those its thread started with.
    assert.equal(resumed[0].params.dynamicTools, undefined)
    const inputs = requests
      .filter((r) => r.method === 'turn/start')
      .map((r) => JSON.stringify(r.params.input))
    assert.equal(inputs.length, 3)
    assert.doesNotMatch(inputs[0]!, /brigade-tool-changes/)
    assert.match(inputs[1]!, /brigade-tool-changes/)
    assert.ok(inputs[1]!.includes(NEW_ACT), inputs[1])
    assert.match(inputs[1]!, /steps/)
    assert.match(inputs[1]!, /Now fill the form/)
    assert.doesNotMatch(inputs[2]!, /brigade-tool-changes/)
    for (const input of inputs) assert.doesNotMatch(input, /"text":"Continue\."/)
  } finally {
    await machine.done()
  }
})

test('Codex: an App granted since its thread started goes on in a new session told the thread so far, never in a blank thread', async () => {
  const machine = await computer('codex')
  try {
    const before = machine.runner(true)
    await before.say('Investigate the stuck resume')
    // The runner parks the session to give it the App's tools (agentKey), as after a ticket.
    await before.stop()
    await machine.runner(true, true).say('Neon is granted: read the thread events')
    const requests = await machine.recorded()
    const methods = requests.map((r) => r.method)
    // Codex cannot give a thread new tools (thread/resume takes none): a new thread, with them.
    const threads = requests.filter((r) => r.method === 'thread/start')
    assert.equal(threads.length, 2, JSON.stringify(methods))
    assert.ok(
      threads[1].params.dynamicTools.some((t: { name: string }) => t.name === 'neon_run_sql'),
      JSON.stringify(threads[1].params.dynamicTools),
    )
    const inputs = requests
      .filter((r) => r.method === 'turn/start')
      .map((r) => JSON.stringify(r.params.input))
    assert.equal(inputs.length, 2, JSON.stringify(methods))
    // That thread is told the conversation so far, then the message: not the message alone.
    assert.match(
      inputs[1]!,
      /continues in a new session because your tools, skills or instructions changed/,
    )
    assert.match(inputs[1]!, /User: Investigate the stuck resume/)
    assert.match(inputs[1]!, /Neon is granted: read the thread events/)
  } finally {
    await machine.done()
  }
})

test('Codex: a thread saved before this change (a "v2:" fingerprint, which covered each tool\'s definition) is resumed, not started anew', async () => {
  const machine = await computer('codex')
  try {
    const before = machine.runner(false)
    await before.say('Click Save')
    await before.stop()
    const state = JSON.parse(await readFile(machine.stateFile, 'utf8'))
    // As the adapter wrote it before: a hash of the instructions and each tool's whole definition.
    state.resume.data.turnConfigurationFingerprint = `v2:${'0'.repeat(64)}`
    delete state.tools
    await writeFile(machine.stateFile, JSON.stringify(state))
    const after = machine.runner(true)
    await after.say('Now fill the form')
    await after.stop()
    await machine.runner(true).say('Thanks')
    const requests = await machine.recorded()
    assert.deepEqual(
      requests
        .filter((r) => r.method === 'thread/start' || r.method === 'thread/resume')
        .map((r) => [r.method, r.params.threadId ?? null]),
      [
        ['thread/start', null],
        ['thread/resume', 'new-thread'],
        ['thread/resume', 'new-thread'],
      ],
    )
    // Saved before the runner kept its tools: told Brigade's own as they are now, once.
    const inputs = requests
      .filter((r) => r.method === 'turn/start')
      .map((r) => JSON.stringify(r.params.input))
    assert.match(inputs[1]!, /may have updated/)
    assert.ok(inputs[1]!.includes(NEW_ACT), inputs[1])
    assert.match(inputs[1]!, /steps/)
    assert.doesNotMatch(inputs[2]!, /brigade-tool-changes/)
  } finally {
    await machine.done()
  }
})

test('Claude Code: a conversation saved before the runner kept its tools is told their current definitions once', async () => {
  const machine = await computer('claude-code')
  try {
    const before = machine.runner(false)
    await before.say('Click Save')
    await before.stop()
    // As main saved it: no tools.
    const state = JSON.parse(await readFile(machine.stateFile, 'utf8'))
    delete state.tools
    await writeFile(machine.stateFile, JSON.stringify(state))
    const after = machine.runner(true)
    await after.say('Now fill the form')
    await after.stop()
    await machine.runner(true).say('Thanks')
    const record = await machine.recorded()
    const messages = record.filter((r) => r.what === 'message').map((r) => r.text as string)
    assert.equal(messages.length, 3, JSON.stringify(record))
    assert.match(messages[1]!, /may have updated/)
    assert.ok(messages[1]!.includes(NEW_ACT), messages[1])
    assert.match(messages[1]!, /"steps"/)
    assert.ok(messages[1]!.endsWith('Now fill the form'))
    assert.equal(messages[2], 'Thanks')
    const queries = record.filter((r) => r.what === 'query')
    assert.deepEqual(
      queries.map((q) => q.resume),
      [null, 'conversation-1', 'conversation-1'],
    )
  } finally {
    await machine.done()
  }
})

test("a conversation of unknown age is given Brigade's own tools, not the Apps', smallest first", () => {
  const specs = toolSpecs(toolsOf(true))
  assert.deepEqual(
    toolsOfUnknownAge(specs, new Set()).map((t) => t.name),
    ['open_ticket', 'computer_act'],
  )
  assert.deepEqual(
    toolsOfUnknownAge(specs, new Set(['open_ticket'])).map((t) => t.name),
    ['computer_act'],
  )
  const note = toolChangesNote(toolsOfUnknownAge(specs, new Set()), { unsure: true })!
  assert.match(note, /may have updated/)
})

test('a new conversation is told nothing, nor are unchanged, added or removed tools', () => {
  const specs = toolSpecs(toolsOf(true))
  assert.deepEqual(changedTools(undefined, specs), [])
  // Unchanged, added and removed tools are no change of definition.
  const known = toolDigests(toolSpecs(toolsOf(true)))
  assert.deepEqual(changedTools({ ...known, gone: 'x' }, specs), [])
  assert.deepEqual(changedTools({ computer_act: known.computer_act! }, specs), [])
  assert.equal(toolChangesNote([]), undefined)
})

test("changed tools past the note's room are named, not lost", () => {
  const old = toolDigests(toolSpecs(toolsOf(false)))
  const changed = changedTools({ ...old, open_ticket: 'changed' }, toolSpecs(toolsOf(true)))
  assert.deepEqual(
    changed.map((t) => t.name),
    ['computer_act', 'open_ticket'],
  )
  const note = toolChangesNote(changed, { max: 300 })!
  assert.ok(note.includes(NEW_ACT))
  assert.match(note, /did not fit here: open_ticket\./)
})
