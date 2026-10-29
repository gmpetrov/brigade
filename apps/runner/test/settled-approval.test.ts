// A person decides a held call (a credential, an App's write) once its tool no longer waits: the
// API sends the decision (thread.settle), and the runner shows the approval decided, without a
// turn. The harness is a stand-in.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import type { AgentEvent, ThreadSpec } from '@brigade/contracts'

const home = await mkdtemp(join(tmpdir(), 'brigade-settled-'))
process.env.BRIGADE_HOME = home
await mkdir(join(home, 'state'), { recursive: true })
const { Threads } = await import('../src/threads.js')

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

function setup(sessionId: string) {
  const events: AgentEvent[] = []
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
  const seat = {
    harness: {
      active: false,
      run: async () => {
        events.push({ at: new Date().toISOString(), type: 'turn.completed', finishReason: 'stop' })
        return { status: 'idle' }
      },
      park: async () => undefined,
      backup: async () => undefined,
      awaitingPerson: async () => false,
      holdsMessages: async () => false,
      decidesNothing: () => true,
      awaitsApproval: async () => false,
      holdsAnswer: () => false,
      keepsAnswer: async () => false,
      answersToGive: async () => [],
    },
    folder: { key: `${sessionId}-riley`, workDir: join(home, sessionId) },
    parkTimer: undefined,
    turn: [],
    waiting: false,
    told: new Set(),
  }
  seats.push(seat)
  ;(threads as unknown as { harness: () => unknown }).harness = () => seat
  const spec = {
    sessionId,
    teammate: { id: 'riley', name: 'Riley', harness: 'claude-code' },
    teammates: [{ id: 'riley', name: 'Riley', harness: 'claude-code' }],
    account: { id: 'acct' },
    attachments: [],
  } as unknown as ThreadSpec
  return { threads, events, spec }
}

test('a held call decided later shows its approval decided, with no turn', async () => {
  const { threads, events } = setup('settled-1')
  threads.settleApproval({
    type: 'thread.settle',
    commandId: 'settle:ticket-1',
    sessionId: 'settled-1',
    teammateId: 'riley',
    approvalId: 'ticket-1',
    approved: true,
    memberId: 'm1',
  })
  await sleep(50)
  assert.deepEqual(
    events.map((e) => ({ ...e, at: undefined })),
    [
      {
        at: undefined,
        type: 'approval.resolved',
        teammateId: 'riley',
        approvalId: 'ticket-1',
        approved: true,
        memberId: 'm1',
      },
    ],
    'only the decision: no message, no turn',
  )
})

test('a denial shows denied', async () => {
  const { threads, events } = setup('settled-2')
  threads.settleApproval({
    type: 'thread.settle',
    commandId: 'settle:ticket-2',
    sessionId: 'settled-2',
    teammateId: 'riley',
    approvalId: 'ticket-2',
    approved: false,
    memberId: null,
  })
  const resolved = events.find((e) => e.type === 'approval.resolved')
  assert.equal(resolved?.type === 'approval.resolved' && resolved.approved, false)
})

test('a thread that moved here: the decision is numbered after its history', async () => {
  // As the runner takes thread.settle (src/index.ts): its arrival first, then the decision.
  const { Outbox } = await import('../src/outbox.js')
  const outbox = new Outbox(join(home, 'moved-outbox'))
  const { threads } = setup('moved-settle')
  const emitted: { seq: number }[] = []
  ;(threads as unknown as { options: { emit: unknown } }).options.emit = (
    id: string,
    e: AgentEvent,
  ) => emitted.push(outbox.push(id, e))
  const moved = { at: new Date().toISOString(), from: 'laptop', seq: 40 }
  outbox.arrive('moved-settle', moved.at, moved.seq)
  threads.settleApproval({
    type: 'thread.settle',
    commandId: 'settle:t',
    sessionId: 'moved-settle',
    teammateId: 'riley',
    approvalId: 't',
    approved: true,
    memberId: 'm1',
    moved,
  })
  assert.equal(emitted[0]?.seq, 41)
  assert.equal(outbox.unacknowledgedFor('moved-settle').length, 1, 'kept to be sent')
})
