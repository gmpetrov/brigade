// A turn that waits for a free slot, the runner running as many turns as it may at once,
// says so in its thread: who waits and how many turns run, and a message queued
// meanwhile says why it waits. The harness is a stand-in whose turns end when told.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { TURN_WAITING_SOURCE, type AgentEvent, type ThreadSpec } from '@brigade/contracts'

const home = await mkdtemp(join(tmpdir(), 'brigade-slots-'))
process.env.BRIGADE_HOME = home
await mkdir(join(home, 'state'), { recursive: true })
const { Threads } = await import('../src/threads.js')

const events: { sessionId: string; event: AgentEvent }[] = []
const threads = new Threads({
  concurrency: 1,
  emit: (sessionId, event) => events.push({ sessionId, event }),
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

/** Ends the turn running now. */
let end = () => {}
const seats: { parkTimer?: NodeJS.Timeout }[] = []
;(threads as unknown as { harness: (thread: unknown, spec: ThreadSpec) => unknown }).harness = (
  _,
  spec,
) => {
  const seat = {
    harness: {
      active: false,
      run: async () => {
        await new Promise<void>((resolve) => (end = resolve))
        events.push({
          sessionId: spec.sessionId,
          event: { at: new Date().toISOString(), type: 'turn.completed', finishReason: 'stop' },
        })
        return { status: 'idle' }
      },
      park: async () => undefined,
      backup: async () => undefined,
      awaitingPerson: async () => false,
      holdsMessages: async () => false,
      decidesNothing: () => false,
      awaitsApproval: async () => true,
      holdsAnswer: () => false,
      keepsAnswer: async () => false,
      answersToGive: async () => [],
    },
    folder: { key: `${spec.sessionId}-mark`, workDir: join(home, spec.sessionId) },
    parkTimer: undefined,
    turn: [],
    waiting: false,
    told: new Set(),
  }
  seats.push(seat)
  return seat
}

test.after(async () => {
  for (const thread of (
    threads as unknown as { threads: Map<string, { quietTimer?: NodeJS.Timeout }> }
  ).threads.values())
    clearTimeout(thread.quietTimer)
  for (const seat of seats) clearTimeout(seat.parkTimer)
  await rm(home, { recursive: true, force: true })
})

const spec = (sessionId: string) =>
  ({
    sessionId,
    teammate: { id: 'mark', name: 'Mark', harness: 'claude-code' },
    teammates: [{ id: 'mark', name: 'Mark', harness: 'claude-code' }],
    account: { id: 'acct' },
    attachments: [],
  }) as unknown as ThreadSpec

const message = (sessionId: string, text: string) =>
  threads.handle({
    type: 'thread.prompt',
    commandId: 'c',
    thread: spec(sessionId),
    text,
    memberId: 'm1',
    then: [],
    attachments: [],
  })

const of = (sessionId: string) =>
  events.filter((e) => e.sessionId === sessionId).map((e) => e.event)

test('a turn waiting for a slot says so, and starts when one is free', async () => {
  message('busy', 'A long job')
  await sleep(50)
  assert.equal(of('busy').filter((e) => e.type === 'turn.started').length, 1)

  message('next', 'Six designs')
  await sleep(50)
  assert.equal(of('next').filter((e) => e.type === 'turn.started').length, 0, 'no slot yet')
  const waits = of('next').filter((e) => e.type === 'raw' && e.source === TURN_WAITING_SOURCE)
  assert.deepEqual(
    waits.map((e) => e.type === 'raw' && e.value),
    [{ teammateId: 'mark', running: 1 }],
  )

  // A message written meanwhile, steered: it says what its teammate waits for.
  message('next', 'So?')
  await sleep(50)
  const queued = of('next').findLast((e) => e.type === 'message.queued')
  assert.ok(queued?.type === 'message.queued')
  threads.handle({
    type: 'thread.queued',
    commandId: 'q',
    sessionId: 'next',
    messageId: queued.messageId,
    action: 'steer',
    memberId: 'm1',
  })
  await sleep(50)
  const note = of('next').findLast((e) => e.type === 'message.queued')
  assert.ok(note?.type === 'message.queued')
  assert.match(note.note ?? '', /Mark is waiting for the turn running on this computer to end/)

  // The long job ends: the waiting turn takes its slot.
  end()
  await sleep(50)
  assert.equal(of('next').filter((e) => e.type === 'turn.started').length, 1)
  end()
  await sleep(50)
  end()
})
