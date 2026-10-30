// Where the runner reads the computer's memory, memory decides how many turns run at once:
// past the first few, turns start one at a time, a moment apart, so each sees the memory the
// one before took; and after the memory guard stopped a turn, the computer runs one fewer at
// once for a while, then more again. The harness is a stand-in whose turns end when told.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { TURN_WAITING_SOURCE, type AgentEvent, type ThreadSpec } from '@brigade/contracts'

const home = await mkdtemp(join(tmpdir(), 'brigade-turn-limit-'))
process.env.BRIGADE_HOME = home
process.env.BRIGADE_TURN_SETTLE_MS = '150'
process.env.BRIGADE_TURN_RAISE_MS = '300'
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

/** A runner whose turns run until `end(sessionId)`, on a computer with memory as `room` says. */
function setup(concurrency: number, room: () => boolean) {
  const events: { sessionId: string; event: AgentEvent; at: number }[] = []
  const ends = new Map<string, () => void>()
  const threads = new Threads({
    concurrency,
    emit: (sessionId, event) => events.push({ sessionId, event, at: Date.now() }),
    folders: {
      arrive: async () => undefined,
      ready: async () => undefined,
      takeNote: async () => '',
      touch: () => undefined,
    },
    previews: { threadBusy: async () => undefined },
    attachments: { deliver: async () => [] },
    context: { memoryFor: () => ({ workspace: '', teammate: '' }) },
    memoryRoom: async () => room(),
  } as unknown as ConstructorParameters<typeof Threads>[0])
  made.push(threads)
  ;(threads as unknown as { harness: (thread: unknown, spec: ThreadSpec) => unknown }).harness = (
    _,
    spec,
  ) => {
    const seat = {
      harness: {
        active: false,
        run: async () => {
          await new Promise<void>((resolve) => ends.set(spec.sessionId, resolve))
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
  const message = (sessionId: string) =>
    threads.handle({
      type: 'thread.prompt',
      commandId: 'c',
      thread: {
        sessionId,
        teammate: { id: 'mark', name: 'Mark', harness: 'claude-code' },
        teammates: [{ id: 'mark', name: 'Mark', harness: 'claude-code' }],
        account: { id: 'acct' },
        attachments: [],
      } as unknown as ThreadSpec,
      text: 'Go',
      memberId: 'm1',
      then: [],
      attachments: [],
    })
  const startedAt = (sessionId: string) =>
    events.find((e) => e.sessionId === sessionId && e.event.type === 'turn.started')?.at
  const end = (sessionId: string) => ends.get(sessionId)?.()
  return { threads, events, message, startedAt, end }
}

test('past the first few, turns start one at a time, a moment apart', async () => {
  const { message, startedAt, end } = setup(32, () => true)
  const ids = ['a', 'b', 'c', 'd', 'e', 'f']
  const sent = Date.now()
  for (const id of ids) message(id)
  await sleep(60)
  // The first four at once.
  for (const id of ids.slice(0, 4)) assert.ok(startedAt(id), `${id} started`)
  assert.equal(startedAt('e'), undefined, 'the fifth waits for the fourth to settle')
  await sleep(500)
  const e = startedAt('e')!
  const f = startedAt('f')!
  assert.ok(e && f, 'the fifth and sixth started')
  assert.ok(f - e >= 140, `the sixth started ${f - e} ms after the fifth`)
  assert.ok(e - sent >= 140, `the fifth started ${e - sent} ms after the burst`)
  for (const id of ids) end(id)
})

test('short of memory past the first few, a turn waits until there is room', async () => {
  let room = true
  const { message, startedAt, end } = setup(32, () => room)
  for (const id of ['a', 'b', 'c', 'd']) message(id)
  await sleep(60)
  room = false
  message('e')
  await sleep(300)
  assert.equal(startedAt('e'), undefined)
  room = true
  // Memory is checked again every 5 s.
  await sleep(5_200)
  assert.ok(startedAt('e'), 'it starts once there is room')
  for (const id of ['a', 'b', 'c', 'd', 'e']) end(id)
})

test('after the memory guard stopped a turn, one fewer at once, then more again', async () => {
  const { threads, events, message, startedAt, end } = setup(8, () => true)
  const ids = ['a', 'b', 'c', 'd', 'e', 'f']
  for (const id of ids) message(id)
  await sleep(600)
  for (const id of ids) assert.ok(startedAt(id), `${id} started`)

  // The guard stops f's turn: six were too many, five at once for a while.
  threads.stoppedForMemory('f', 'the computer was stuck waiting for memory for 10 s')
  end('f')
  await sleep(30)
  message('g')
  await sleep(60)
  assert.equal(startedAt('g'), undefined, 'no slot while five run')
  assert.ok(
    events.some(
      (e) =>
        e.sessionId === 'g' && e.event.type === 'raw' && e.event.source === TURN_WAITING_SOURCE,
    ),
    'g says it waits for a slot',
  )
  // A while without another stop: one more at once.
  await sleep(500)
  assert.ok(startedAt('g'), 'g started once the limit went back up')
  for (const id of [...ids, 'g']) end(id)
})

test('turns waiting to start keep to a cap lowered meanwhile', async () => {
  const { threads, message, startedAt, end } = setup(32, () => true)
  const ids = Array.from({ length: 10 }, (_, i) => `q${i}`)
  for (const id of ids) message(id)
  await sleep(220)
  assert.equal(ids.filter((id) => startedAt(id)).length, 5)
  // The guard stops the fifth: four at once now, and the five still queued wait for a place.
  threads.stoppedForMemory('q4', 'the computer was stuck waiting for memory for 10 s')
  end('q4')
  await sleep(250)
  assert.equal(ids.filter((id) => startedAt(id)).length - 1, 4)
  // A while without another stop, the cap goes back up and they start, one at a time.
  await sleep(3_500)
  assert.equal(ids.filter((id) => startedAt(id)).length - 1, 9)
  for (const id of ids) end(id)
})
