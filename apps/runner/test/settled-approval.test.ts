// A person decides a held call (a credential, an App's write) once its tool no longer waits: the
// API tells the thread with a message that carries the decision, and the runner shows the
// approval decided before the message. The harness is a stand-in.
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

test('a message telling of a held call decided later shows its approval decided, then itself', async () => {
  const { threads, events, spec } = setup('settled-1')
  threads.handle({
    type: 'thread.prompt',
    commandId: 'wakeup:w1',
    thread: spec,
    text: 'A person approved what you asked for earlier…',
    memberId: null,
    then: [],
    attachments: [],
    settles: { approvalId: 'ticket-1', approved: true, memberId: 'm1' },
  })
  await sleep(50)
  const resolved = events.findIndex((e) => e.type === 'approval.resolved')
  const message = events.findIndex((e) => e.type === 'message.user')
  assert.ok(resolved >= 0, 'the approval is decided')
  assert.ok(message > resolved, 'before the message')
  assert.deepEqual(
    { ...events[resolved], at: undefined },
    {
      at: undefined,
      type: 'approval.resolved',
      teammateId: 'riley',
      approvalId: 'ticket-1',
      approved: true,
      memberId: 'm1',
    },
  )
})

test('a message without a decision decides no approval', async () => {
  const { threads, events, spec } = setup('settled-2')
  threads.handle({
    type: 'thread.prompt',
    commandId: 'c',
    thread: spec,
    text: 'Hello',
    memberId: 'm1',
    then: [],
    attachments: [],
  })
  await sleep(50)
  assert.equal(events.filter((e) => e.type === 'approval.resolved').length, 0)
  assert.equal(events.filter((e) => e.type === 'message.user').length, 1)
})
