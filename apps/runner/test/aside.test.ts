// A person writes to a teammate whose turn waits on its ticket, to ask about it rather than
// answer it: the teammate reads the message at once, as the ticket call's result, and the
// ticket stays open; answered later, it comes as a message of its own. The harness is
// scripted, the session the runner's own (HarnessThread), so what goes in is what Claude
// Code would read.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
 * Claude Code as a thread sees it: asked to set something up, it opens a ticket (ticket-1,
 * ticket-2…) and waits on its result; a result, or any other prompt, gets a reply. It never
 * echoes a result back. What it was given is kept, in order.
 */
function scriptedHarness(heard: string[], prefix: string, onResult?: () => Promise<void>) {
  let replies = 0
  const reply = (emit: Emit) => {
    const id = `reply-${++replies}`
    emit({ type: 'text-start', id })
    emit({ type: 'text-delta', id, delta: `Reply ${replies}` })
    emit({ type: 'text-end', id })
    emit({ type: 'finish-step', finishReason: { unified: 'stop', raw: 'stop' }, usage })
  }
  let tickets = 0
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
        if (String(typeof prompt === 'string' ? prompt : '').startsWith('Set up')) {
          emit({
            type: 'tool-call',
            toolCallId: `${prefix}-${++tickets}`,
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
        } else if (String(prompt).startsWith('Publish')) {
          // A built-in tool call it asks a person to approve first.
          emit({
            type: 'tool-call',
            toolCallId: 'bash-1',
            toolName: 'bash',
            input: '{"command":"publish"}',
            providerExecuted: true,
            dynamic: true,
          })
          emit({ type: 'tool-approval-request', approvalId: 'approval-1', toolCallId: 'bash-1' })
          emit({
            type: 'finish-step',
            finishReason: { unified: 'tool-calls', raw: 'host-input' },
            usage,
          })
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
            await onResult?.()
            reply(emit)
            finish()
          },
          submitToolApproval: async (input: { approvalId: string }) => {
            heard.push(`approved ${input.approvalId}`)
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

/**
 * A thread whose session is the scripted harness. `prefix`: its tickets' ids. `onResult`: what
 * the harness does once a result reaches it. `saved`: the state a process before it left.
 */
async function setup({
  prefix = 'ticket',
  onResult,
  saved,
}: { prefix?: string; onResult?: () => Promise<void>; saved?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'brigade-aside-'))
  if (saved) await writeFile(join(dir, 'aside-riley.json'), saved)
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
    harness: scriptedHarness(heard, prefix, onResult) as never,
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
  return { thread, run, heard, events, done, dir, spec }
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

test('a ticket answered before is not set aside with the next one', async () => {
  const t = await setup()
  try {
    await t.run({ kind: 'prompt', text: 'Set up Hyperdrive' })
    await t.run({
      kind: 'ticket',
      requestId: 'ticket-1',
      answer: { action: 'answered', replies: { perm: { type: 'action', done: true } } },
    })
    assert.equal((await t.run({ kind: 'prompt', text: 'Set up the alerts' })).status, 'waiting')
    await t.run({ kind: 'prompt', text: 'Which page is it on?' })
    // Only the open ticket takes the message.
    const results = t.heard.filter((h) => h.startsWith('result '))
    assert.equal(results.length, 2)
    assert.match(results[1]!, /^result ticket-2: .*Which page is it on\?/)
    await t.run({
      kind: 'ticket',
      requestId: 'ticket-2',
      answer: { action: 'answered', replies: { perm: { type: 'action', done: true } } },
    })
    // Its answer ends the wait: nothing else is left asked.
    assert.deepEqual(completions(t.events), ['idle', 'waiting', 'idle'])
  } finally {
    await t.done()
  }
})

const done = (ticket: string) => ({
  kind: 'ticket' as const,
  requestId: ticket,
  answer: {
    action: 'answered' as const,
    replies: { perm: { type: 'action' as const, done: true } },
  },
})

test('a process that stops while the teammate answers keeps the ask set aside', async () => {
  // The harness holds its reply once the message reached it: the process stops there.
  let reached!: () => void
  const atReply = new Promise<void>((resolve) => (reached = resolve))
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  const before = await setup({
    prefix: 'old-ticket',
    onResult: async () => {
      reached()
      await held
    },
  })
  let after: Awaited<ReturnType<typeof setup>> | undefined
  try {
    await before.run({ kind: 'prompt', text: 'Set up Hyperdrive' })
    const answering = before.run({ kind: 'prompt', text: 'Which token is it?' })
    await atReply
    // What the next process finds on disk.
    const saved = await readFile(join(before.dir, 'aside-riley.json'), 'utf8')
    // It says the ticket is set aside, and no longer that the turn waits on it.
    const state = JSON.parse(saved) as { later?: { toolCallId: string }[]; waiting?: unknown[] }
    assert.deepEqual(
      state.later?.map((c) => c.toolCallId),
      ['old-ticket-1'],
    )
    assert.deepEqual(state.waiting ?? [], [])
    release()
    await answering
    after = await setup({ prefix: 'new-ticket', saved })
    // It carries on from the cut turn, then opens another ticket.
    await after.run({ kind: 'resume', text: '' })
    assert.equal((await after.run({ kind: 'prompt', text: 'Set up the alerts' })).status, 'waiting')
    // The first ticket is answered: a message, not a result for the turn waiting on the other.
    const answered = await Promise.race([
      after.run(done('old-ticket-1')).then(() => 'answered'),
      new Promise((resolve) => setTimeout(() => resolve('stuck'), 1000)),
    ])
    assert.equal(answered, 'answered')
    // The other ticket stays open: it took the answer as a message, set aside in turn.
    const message = after.heard.at(-1) ?? ''
    assert.match(message, /^result new-ticket-1: /)
    assert.match(message, /The person answered your ticket \\"Hyperdrive permission\\"/)
    assert.match(message, /\\"done\\":true/)
    assert.deepEqual(completions(after.events).at(-1), 'waiting')
  } finally {
    release()
    await before.done()
    await after?.done()
  }
})

test('an answer to a call the turn no longer waits on comes as a message, never stuck', async () => {
  // State a process left with a ticket it saw and nothing saying it was set aside.
  const saved = JSON.stringify({
    accountId: 'acct',
    transcript: [],
    waiting: [{ toolCallId: 'old-ticket-1', toolName: OPEN_TICKET_TOOL, input: TICKET }],
  })
  const t = await setup({ prefix: 'new-ticket', saved })
  try {
    assert.equal((await t.run({ kind: 'prompt', text: 'Set up the alerts' })).status, 'waiting')
    const answered = await Promise.race([
      t.run(done('old-ticket-1')).then(() => 'answered'),
      new Promise((resolve) => setTimeout(() => resolve('stuck'), 1000)),
    ])
    assert.equal(answered, 'answered')
    assert.match(
      t.heard.at(-1) ?? '',
      /^result new-ticket-1: .*answered your ticket \\"Hyperdrive permission\\"/,
    )
  } finally {
    await t.done()
  }
})

test('an answer while the teammate waits on an approval is kept, and goes in once decided', async () => {
  const t = await setup()
  try {
    await t.run({ kind: 'prompt', text: 'Set up Hyperdrive' })
    await t.run({ kind: 'prompt', text: 'Which token is it?' })
    assert.equal((await t.run({ kind: 'prompt', text: 'Publish it' })).status, 'waiting')
    assert.ok(t.events.some((e) => e.type === 'approval.requested'))
    const answer = {
      kind: 'ticket' as const,
      requestId: 'ticket-1',
      answer: {
        action: 'answered' as const,
        replies: { perm: { type: 'action' as const, done: true, note: 'Added it to token 84219' } },
      },
    }
    // Known before its turn starts: the thread waits on the person still.
    assert.equal(t.thread.holdsAnswer(answer), true)
    assert.equal((await t.run(answer)).status, 'waiting')
    // Kept on disk with its ask, nothing given while the approval waits.
    const saved = JSON.parse(await readFile(join(t.dir, 'aside-riley.json'), 'utf8')) as {
      later?: { toolCallId: string; answer?: unknown }[]
    }
    assert.deepEqual(
      saved.later?.map((c) => [c.toolCallId, !!c.answer]),
      [['ticket-1', true]],
    )
    assert.deepEqual(await t.thread.answersToGive(), [])
    await t.run({ kind: 'approval', approvalId: 'approval-1', approved: true })
    assert.ok(t.heard.includes('approved approval-1'))
    // Decided: the answer is given once, and comes as a message.
    const given = await t.thread.answersToGive()
    assert.deepEqual(given, [answer])
    assert.deepEqual(await t.thread.answersToGive(), [])
    await t.run(given[0]!)
    assert.match(t.heard.at(-1) ?? '', /^prompt: The person answered your ticket "Hyperdrive/)
    assert.match(t.heard.at(-1) ?? '', /Added it to token 84219/)
    assert.deepEqual(await t.thread.answersToGive(), [])
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
