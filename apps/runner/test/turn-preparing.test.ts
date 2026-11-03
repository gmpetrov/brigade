// A turn whose thread's files are fetched before it starts (its folder, after a move or
// once put away; files attached to the thread) says so in its thread, once, before it
// starts: the thread shows its teammate getting them ready rather than nothing at all.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { TURN_PREPARING_SOURCE, type AgentEvent, type ThreadSpec } from '@brigade/contracts'

const home = await mkdtemp(join(tmpdir(), 'brigade-preparing-'))
process.env.BRIGADE_HOME = home
await mkdir(join(home, 'state'), { recursive: true })
const { Threads } = await import('../src/threads.js')

const events: { sessionId: string; event: AgentEvent }[] = []
const threads = new Threads({
  concurrency: 4,
  emit: (sessionId, event) => events.push({ sessionId, event }),
  // Folder "far" is fetched before its turn (a move, a folder put away); "near" is on disk.
  folders: {
    arrive: async () => undefined,
    ready: async (name: { sessionId: string }, fetching?: () => void) => {
      if (name.sessionId === 'far') fetching?.()
    },
    takeNote: async () => '',
    touch: () => undefined,
  },
  previews: { threadBusy: async () => undefined },
  // Its attached files are fetched too: the thread is told once all the same.
  attachments: {
    deliver: async (_refs: unknown, folder: { workDir: string }, fetching?: () => void) => {
      if (folder.workDir.endsWith('far')) fetching?.()
      return []
    },
  },
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

/** Until its turn has started (the first run compiles slowly). */
async function untilStarted(sessionId: string) {
  for (let i = 0; i < 100 && !of(sessionId).some((e) => e.type === 'turn.started'); i++)
    await sleep(20)
}

test('a turn that fetches its files says so once, before it starts', async () => {
  message('far', 'Carry on')
  await untilStarted('far')
  const events = of('far')
  const preparing = events.flatMap((e, i) =>
    e.type === 'raw' && e.source === TURN_PREPARING_SOURCE ? [i] : [],
  )
  assert.equal(preparing.length, 1, 'told once, for the folder and the files alike')
  const event = events[preparing[0]!]!
  assert.ok(event.type === 'raw')
  assert.deepEqual(event.value, { teammateId: 'mark' })
  const started = events.findIndex((e) => e.type === 'turn.started')
  assert.ok(started > preparing[0]!, 'before its turn starts')
  end()
  await sleep(50)
})

test('a turn with its files already here says nothing of them', async () => {
  message('near', 'Carry on')
  await untilStarted('near')
  assert.equal(of('near').filter((e) => e.type === 'turn.started').length, 1)
  assert.equal(
    of('near').some((e) => e.type === 'raw' && e.source === TURN_PREPARING_SOURCE),
    false,
  )
  end()
  await sleep(50)
})
