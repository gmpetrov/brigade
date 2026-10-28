// A person writes to a teammate whose turn waits on its ticket, to ask about it rather than
// answer it: the teammate reads the message at once, as the ticket call's result, and the
// ticket stays open; answered later, it comes as a message of its own. The harness is
// scripted, the session the runner's own (HarnessThread), so what goes in is what Claude
// Code would read.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import type { AgentEvent, ThreadSpec } from '@brigade/contracts'
import { answerLater, asideAfterRestart } from '../src/harness/aside.js'
import { HarnessThread } from '../src/harness/index.js'
import { createLocalSandboxSession } from '../src/harness/local-sandbox.js'
import { OPEN_TICKET_TOOL, openTicketTool } from '../src/harness/tools.js'

type Emit = (part: Record<string, unknown>) => void

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0 },
}

const TICKET = {
  title: 'Hyperdrive permission',
  asks: [{ id: 'perm', type: 'action', title: 'Add Hyperdrive: Edit to the token' }],
}

/**
 * Claude Code as a thread sees it: its first turn opens a ticket and waits on its result; a
 * result, or any later prompt, gets a reply. What it was given is kept, in order.
 */
function scriptedHarness(heard: string[]) {
  let replies = 0
  const reply = (emit: Emit) => {
    const id = `reply-${++replies}`
    emit({ type: 'text-start', id })
    emit({ type: 'text-delta', id, delta: `Reply ${replies}` })
    emit({ type: 'text-end', id })
    emit({ type: 'finish-step', finishReason: { unified: 'stop', raw: 'stop' }, usage })
  }
  let prompts = 0
  return {
    harnessId: 'scripted',
    specificationVersion: 'harness-v1',
    builtinTools: {},
    supportsBuiltinToolApprovals: true,
    doStart: async ({ sessionId }: { sessionId: string }) => ({
      sessionId,
      isResume: false,
      doPromptTurn: async ({ emit, prompt }: { emit: Emit; prompt: unknown }) => {
        heard.push(`prompt: ${typeof prompt === 'string' ? prompt : JSON.stringify(prompt)}`)
        let finish!: () => void
        const done = new Promise<void>((resolve) => (finish = resolve))
        emit({ type: 'stream-start', modelId: 'scripted' })
        if (prompts++ === 0) {
          emit({
            type: 'tool-call',
            toolCallId: 'ticket-1',
            toolName: OPEN_TICKET_TOOL,
            input: JSON.stringify(TICKET),
            providerExecuted: false,
          })
          emit({
            type: 'finish-step',
            finishReason: { unified: 'tool-calls', raw: 'host-input' },
            usage,
          })
          // Claude Code then waits on the ticket's result: no `finish` until it comes.
        } else {
          reply(emit)
          finish()
        }
        return { submitToolResult: async () => {}, done }
      },
      // The paused turn goes on with the result it waited on.
      doContinueTurn: async ({ emit }: { emit: Emit }) => {
        let finish!: () => void
        const done = new Promise<void>((resolve) => (finish = resolve))
        return {
          submitToolResult: async (input: { toolCallId: string; output?: unknown }) => {
            heard.push(`result ${input.toolCallId}: ${JSON.stringify(input.output)}`)
            reply(emit)
            finish()
          },
          done,
        }
      },
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

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'brigade-aside-'))
  const heard: string[] = []
  const events: AgentEvent[] = []
  const spec = {
    sessionId: 'aside',
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
    harness: scriptedHarness(heard) as never,
    tools: { [OPEN_TICKET_TOOL]: openTicketTool },
    permissionMode: 'allow-all',
    sandboxConfig: { workDir: '.' },
  })
  const sandbox = createLocalSandboxSession({
    id: 'aside',
    workingDirectory: dir,
    port: 0,
    env: {},
  })
  const session = await agent.createSession({ sandboxSession: sandbox })
  // The session the thread would have started itself (attach), made with the spec's tools
  // and effort as agentKey says.
  Object.assign(thread, {
    live: {
      agent,
      session,
      sandbox,
      account: spec.account,
      credentials: { cleanup: async () => {} },
      made: JSON.stringify([null, [], undefined]),
    },
  })
  const run = (input: Parameters<HarnessThread['run']>[0]) =>
    thread.run(input, spec, new AbortController().signal)
  const done = async () => {
    await sandbox.destroy()
    await rm(dir, { recursive: true, force: true })
  }
  return { thread, run, heard, events, done }
}

const completions = (events: AgentEvent[]) =>
  events.flatMap((e) => (e.type === 'turn.completed' ? [e.waiting ? 'waiting' : 'idle'] : []))

test('a message while a teammate waits on its ticket reaches it now, and the ticket stays open', async () => {
  const t = await setup()
  try {
    assert.equal((await t.run({ kind: 'prompt', text: 'Set up Hyperdrive' })).status, 'waiting')
    assert.ok(t.events.some((e) => e.type === 'ticket.opened' && e.requestId === 'ticket-1'))
    assert.equal(await t.thread.awaitingPerson(), true)
    // Waiting only on its own ticket: a message is not held for it.
    assert.equal(await t.thread.holdsMessages(), false)
    // Nor does a decision on an approval it never asked for go on with it.
    assert.equal(t.thread.decidesNothing('approval-decided-twice'), true)
    assert.equal(await t.thread.awaitsApproval('approval-decided-twice'), false)

    const asked = await t.run({ kind: 'prompt', text: 'Which token is it?' })
    assert.equal(asked.status, 'idle')
    // The ticket call's result carries the message, and says the ticket is still open.
    const result = t.heard.find((h) => h.startsWith('result ticket-1'))
    assert.match(result ?? '', /"answered":false/)
    assert.match(result ?? '', /Which token is it\?/)
    assert.match(result ?? '', /stays open/)
    assert.ok(t.events.some((e) => e.type === 'message.done' && e.text === 'Reply 1'))
    // Answered, the teammate still waits on the person: the thread shows it.
    assert.deepEqual(completions(t.events), ['waiting'])
    assert.equal(await t.thread.awaitingPerson(), false)

    // The person answers the ticket later: it comes as a message, and the wait is over.
    const answered = await t.run({
      kind: 'ticket',
      requestId: 'ticket-1',
      answer: { action: 'answered', replies: { perm: { type: 'action', done: true } } },
    })
    assert.equal(answered.status, 'idle')
    const later = t.heard.at(-1) ?? ''
    assert.match(later, /^prompt: The person answered your ticket "Hyperdrive permission"/)
    assert.match(later, /"done":true/)
    assert.deepEqual(completions(t.events), ['waiting', 'idle'])
  } finally {
    await t.done()
  }
})

test('a ticket declined after it was set aside comes as a message too, once', async () => {
  const t = await setup()
  try {
    await t.run({ kind: 'prompt', text: 'Set up Hyperdrive' })
    await t.run({ kind: 'prompt', text: 'Why this token?' })
    const decline = {
      kind: 'ticket' as const,
      requestId: 'ticket-1',
      answer: { action: 'declined' as const, note: 'Use the other one' },
    }
    await t.run(decline)
    assert.match(t.heard.at(-1) ?? '', /Use the other one/)
    assert.deepEqual(completions(t.events), ['waiting', 'idle'])
  } finally {
    await t.done()
  }
})

test("a closed turn's set-aside ask says it is still open, and its answer names it", () => {
  const call = { toolCallId: 'ticket-1', toolName: OPEN_TICKET_TOOL, input: TICKET }
  const note = asideAfterRestart([call], 'Which token is it?')
  assert.match(note, /cut off your ticket "Hyperdrive permission" above/)
  assert.match(note, /still open for them/)
  assert.match(note, /Which token is it\?/)
  assert.match(answerLater(call, { done: true }), /answered your ticket "Hyperdrive permission"/)
  assert.match(
    answerLater({ toolName: 'ask_user', input: {} }, { answers: [] }),
    /answered your question/,
  )
})
