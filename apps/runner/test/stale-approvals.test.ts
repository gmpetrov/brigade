// Decisions on approvals and the answers that wait on them. A decision on an approval that no
// turn waits on, such as one a person made twice, starts no turn and shows nothing: continued
// with it, a turn waiting on a ticket would sit on that ticket's call as though it ran. An
// answer to a ticket set aside while the teammate waits on an approval is kept until the
// decision, the thread waiting meanwhile. The harness is a stand-in, so the thread's queue and
// events are the runner's own.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import type { AgentEvent, ThreadSpec } from '@brigade/contracts'

const home = await mkdtemp(join(tmpdir(), 'brigade-stale-approvals-'))
process.env.BRIGADE_HOME = home
await mkdir(join(home, 'state'), { recursive: true })
const { Threads } = await import('../src/threads.js')

/** The runner's timers (parking a session, taking memory) would keep the tests from ending. */
const made: InstanceType<typeof Threads>[] = []
const seats: { parkTimer?: NodeJS.Timeout }[] = []
test.after(async () => {
  for (const threads of made)
    for (const thread of (
      threads as unknown as { threads: Map<string, { quietTimer?: NodeJS.Timeout }> }
    ).threads.values())
      clearTimeout(thread.quietTimer)
  for (const seat of seats) clearTimeout(seat.parkTimer)
  await rm(home, { recursive: true, force: true })
})

/**
 * A thread whose teammate waits on the approvals in `waiting`. `known`: whether it knows so
 * before the turn comes (decidesNothing), as a harness whose state is read already does.
 */
function setup(sessionId: string, waiting: string[], known: boolean) {
  const events: AgentEvent[] = []
  const inputs: string[] = []
  const threads = new Threads({
    concurrency: 2,
    emit: (_, event) => events.push(event),
    folders: {
      arrive: async () => undefined,
      ready: async () => undefined,
      takeNote: async () => '',
      touch: () => undefined,
    },
    previews: { threadBusy: async () => undefined },
    attachments: { deliver: async () => [] },
    context: { memoryFor: () => ({ workspace: '', teammate: '' }) },
  } as unknown as ConstructorParameters<typeof Threads>[0])
  made.push(threads)
  type Input = { kind: string; approvalId?: string; requestId?: string }
  // Answers kept while an approval waits, as the harness keeps them (keepsAnswer).
  const kept: Input[] = []
  const harness = {
    active: false,
    run: async (input: Input) => {
      inputs.push(`${input.kind} ${input.approvalId ?? input.requestId ?? ''}`.trim())
      if (input.kind === 'approval') waiting.splice(waiting.indexOf(input.approvalId!), 1)
      return { status: 'idle' }
    },
    park: async () => undefined,
    backup: async () => undefined,
    awaitingPerson: async () => waiting.length > 0,
    holdsMessages: async () => waiting.length > 0,
    decidesNothing: (id: string) => known && !waiting.includes(id),
    awaitsApproval: async (id: string) => waiting.includes(id),
    holdsAnswer: () => waiting.length > 0,
    keepsAnswer: async (input: Input) => waiting.length > 0 && !!kept.push(input),
    answersToGive: async () => (waiting.length > 0 ? [] : kept.splice(0)),
    cutOff: async () => false,
  }
  // The runner's own seat, with the stand-in in place of a Claude Code session.
  const seat = {
    harness,
    folder: { key: `${sessionId}-mark`, workDir: join(home, sessionId) },
    parkTimer: undefined,
    turn: [],
    waiting: false,
    told: new Set(),
  }
  seats.push(seat)
  ;(threads as unknown as { harness: () => unknown }).harness = () => seat
  const spec = {
    sessionId,
    teammate: { id: 'mark', name: 'Mark', harness: 'claude-code' },
    teammates: [{ id: 'mark', name: 'Mark', harness: 'claude-code' }],
    account: { id: 'acct' },
    attachments: [],
  } as unknown as ThreadSpec
  const decide = (approvalId: string) =>
    threads.handle({
      type: 'thread.approval',
      commandId: approvalId,
      thread: spec,
      approvalId,
      approved: true,
      memberId: 'm1',
    })
  const answer = (requestId: string) =>
    threads.handle({
      type: 'thread.ticket',
      commandId: requestId,
      thread: spec,
      requestId,
      answer: { action: 'answered', replies: { a1: { type: 'action', done: true } } },
      memberId: 'm1',
    })
  // The runner reconnects with the thread in progress and no turn of it running.
  const reconnect = () => threads.resumeLost([spec], [], () => undefined)
  return { events, inputs, decide, answer, kept, reconnect }
}

const shown = (events: AgentEvent[]) =>
  events.flatMap((e) =>
    e.type === 'approval.resolved' || e.type === 'turn.started' ? [e.type] : [],
  )

test('a decision on an approval the turn waits on goes on with it', async () => {
  const t = setup('approval-waited', ['ap-1'], true)
  t.decide('ap-1')
  await sleep(30)
  assert.deepEqual(t.inputs, ['approval ap-1'])
  assert.deepEqual(shown(t.events), ['approval.resolved', 'turn.started'])
})

test('a decision on an approval no turn waits on shows nothing and starts no turn', async () => {
  const t = setup('approval-stale', [], true)
  t.decide('ap-1')
  await sleep(30)
  assert.deepEqual(t.inputs, [])
  assert.deepEqual(shown(t.events), [])
})

test('one found stale only once its turn comes starts no turn either', async () => {
  const t = setup('approval-stale-late', [], false)
  t.decide('ap-1')
  await sleep(30)
  assert.deepEqual(t.inputs, [])
  assert.deepEqual(shown(t.events), ['approval.resolved'])
})

test('an answer while an approval waits is kept, the thread waiting, then goes in once decided', async () => {
  const t = setup('approval-keeps-answer', ['ap-1'], true)
  t.answer('ticket-1')
  await sleep(30)
  // Kept: no turn, and the thread still waits on a person.
  assert.deepEqual(t.inputs, [])
  const answered = t.events.find((e) => e.type === 'ticket.answered')
  assert.equal(answered?.type === 'ticket.answered' && answered.waiting, true)
  t.decide('ap-1')
  await sleep(30)
  assert.deepEqual(t.inputs, ['approval ap-1', 'ticket ticket-1'])
})

test('on reconnect, answers kept for a decision made before the restart are given', async () => {
  const t = setup('approval-kept-restart', [], true)
  t.kept.push({ kind: 'ticket', requestId: 'ticket-1' })
  t.reconnect()
  await sleep(30)
  assert.deepEqual(t.inputs, ['ticket ticket-1'])
})
