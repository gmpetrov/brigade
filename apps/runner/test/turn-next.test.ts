// Teammates asked one after another (a handoff, a message to several) show as answering next,
// in order, until each starts; and the turn under way stops waiting on Claude Code's guess at
// the member's next message, which their answers replace, so the next starts at once.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { TURN_NEXT_SOURCE, type AgentEvent, type ThreadSpec } from '@brigade/contracts'

const home = await mkdtemp(join(tmpdir(), 'brigade-next-'))
process.env.BRIGADE_HOME = home
await mkdir(join(home, 'state'), { recursive: true })
const { Threads, guessMoot } = await import('../src/threads.js')

const events: { sessionId: string; event: AgentEvent }[] = []
const threads = new Threads({
  concurrency: 4,
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
  handoff: () => undefined,
} as unknown as ConstructorParameters<typeof Threads>[0])

/** Ends the turn running now. */
let end = () => {}
let drainsStopped = 0
const seats: { parkTimer?: NodeJS.Timeout }[] = []
;(
  threads as unknown as {
    harness: (thread: { harnesses: Map<string, unknown> }, spec: ThreadSpec) => unknown
  }
).harness = (thread, spec) => {
  const known = thread.harnesses.get(spec.teammate.id)
  if (known) return known
  const seat = {
    harness: {
      active: false,
      run: async () => {
        await new Promise<void>((resolve) => (end = resolve))
        events.push({
          sessionId: spec.sessionId,
          event: {
            at: new Date().toISOString(),
            type: 'turn.completed',
            finishReason: 'stop',
            teammateId: spec.teammate.id,
          },
        })
        return { status: 'idle' }
      },
      stopDrain: async () => void drainsStopped++,
      park: async () => undefined,
      backup: async () => undefined,
      awaitingPerson: async () => false,
      holdsMessages: async () => false,
      decidesNothing: () => false,
      awaitsApproval: async () => true,
      cutOff: async () => false,
      holdsAnswer: () => false,
      keepsAnswer: async () => false,
      answersToGive: async () => [],
    },
    folder: { key: `${spec.sessionId}-${spec.teammate.id}`, workDir: join(home, spec.teammate.id) },
    parkTimer: undefined,
    turn: [],
    waiting: false,
    told: new Set(),
  }
  seats.push(seat)
  thread.harnesses.set(spec.teammate.id, seat)
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

const team = [
  { id: 'chief', name: 'Chief', harness: 'claude-code' },
  { id: 'riley', name: 'Riley', harness: 'claude-code' },
  { id: 'cody', name: 'Cody', harness: 'codex' },
]
const spec = (sessionId: string, teammateId: string) =>
  ({
    sessionId,
    teammate: team.find((t) => t.id === teammateId),
    teammates: team,
    account: { id: 'acct' },
    attachments: [],
  }) as unknown as ThreadSpec

const of = (sessionId: string) =>
  events.filter((e) => e.sessionId === sessionId).map((e) => e.event)
const told = (sessionId: string) =>
  of(sessionId).flatMap((e) =>
    e.type === 'raw' && e.source === TURN_NEXT_SOURCE
      ? [(e.value as { teammateIds: string[] }).teammateIds]
      : [],
  )
const started = (sessionId: string) =>
  of(sessionId).flatMap((e) => (e.type === 'turn.started' ? [e.teammateId] : []))

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await sleep(20)
  assert.ok(check(), 'timed out')
}

test('a handoff to two says who answers next until each starts, and ends the guess under way', async () => {
  // Chief answers a member.
  threads.handle({
    type: 'thread.prompt',
    commandId: 'c1',
    thread: spec('t1', 'chief'),
    text: 'Test them',
    memberId: 'm1',
    then: [],
    attachments: [],
  })
  await until(() => started('t1').length === 1)
  assert.deepEqual(told('t1'), [], 'a turn of its own answers nobody after anyone')
  // Its reply hands on to Riley, then Cody, while its turn still waits on Claude Code's guess.
  threads.handle({
    type: 'thread.prompt',
    commandId: 'c2',
    thread: spec('t1', 'riley'),
    text: '',
    memberId: null,
    then: [spec('t1', 'cody')],
    handoff: true,
    attachments: [],
  })
  assert.deepEqual(told('t1'), [['riley'], ['riley', 'cody']])
  assert.equal(drainsStopped, 1, "the guess of Chief's answered turn no longer matters")
  end()
  await until(() => started('t1').length === 2)
  assert.deepEqual(started('t1'), ['chief', 'riley'])
  assert.deepEqual(told('t1').at(-1), ['cody'], 'Riley started: Cody answers next')
  end()
  await until(() => started('t1').length === 3)
  assert.deepEqual(told('t1').at(-1), [], 'Cody started: nobody is next')
  end()
})

test('a message to several says the ones after the first answer next', async () => {
  threads.handle({
    type: 'thread.prompt',
    commandId: 'c3',
    thread: spec('t2', 'riley'),
    text: 'What do you both think?',
    memberId: 'm1',
    then: [spec('t2', 'cody')],
    attachments: [],
  })
  await until(() => started('t2').length === 1)
  assert.deepEqual(told('t2'), [['cody']])
  end()
  await until(() => started('t2').length === 2)
  assert.deepEqual(told('t2'), [['cody'], []])
  end()
})

test("an answered turn's guess is moot once someone answers after it", () => {
  const s = spec('t3', 'riley')
  assert.equal(guessMoot(new Map(), 'Done.', s, 'riley'), false, 'the member is next')
  assert.equal(guessMoot(new Map([['cody', 0]]), 'Done.', s, 'riley'), false)
  assert.equal(guessMoot(new Map([['cody', 1]]), 'Done.', s, 'riley'), true, 'Cody waits behind it')
  assert.equal(guessMoot(new Map(), '@Cody over to you', s, 'riley'), true, 'it hands on')
  assert.equal(guessMoot(new Map(), '@Riley noted', s, 'riley'), false, 'only itself')
})
