// A turn that failed tried again: on its own after a passing error (a full disk, the
// network), or when a person asks (thread.retry). The harness is a stand-in that fails
// as told, so the thread's queue, notes and prompts are the runner's own.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import type { AgentEvent, ThreadSpec } from '@brigade/contracts'

const home = await mkdtemp(join(tmpdir(), 'brigade-retry-'))
process.env.BRIGADE_HOME = home
process.env.BRIGADE_RETRY_MS = '100'
process.env.BRIGADE_MEMORY_NOTICE_MS = '300'
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

type Outcome = { status: 'idle' | 'failed'; error?: string; memoryStop?: string }

/**
 * A thread whose teammate's turns end as `outcomes` say, in order (then idle). `memoryRoom`:
 * the computer's memory, as the runner reads it on a cloud computer.
 */
function setup(sessionId: string, outcomes: Outcome[], memoryRoom?: () => Promise<boolean>) {
  const events: AgentEvent[] = []
  const prompts: string[] = []
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
    ...(memoryRoom ? { memoryRoom } : {}),
  } as unknown as ConstructorParameters<typeof Threads>[0])
  made.push(threads)
  const harness = {
    active: false,
    run: async (input: { kind: string; text?: string }, spec: ThreadSpec) => {
      prompts.push(input.text ?? '')
      const outcome = outcomes.shift() ?? { status: 'idle' }
      // The memory guard stops the turn while it runs: its harness's process goes with it.
      if (outcome.memoryStop) threads.stoppedForMemory(spec.sessionId, outcome.memoryStop)
      if (outcome.error)
        events.push({ at: new Date().toISOString(), type: 'error', message: outcome.error })
      else
        events.push({ at: new Date().toISOString(), type: 'turn.completed', finishReason: 'stop' })
      void spec
      return outcome
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
  const message = (text: string) =>
    threads.handle({
      type: 'thread.prompt',
      commandId: 'c',
      thread: spec,
      text,
      memberId: 'm1',
      then: [],
      attachments: [],
    })
  const notes = () =>
    events.flatMap((e) => (e.type === 'raw' && typeof e.value === 'string' ? [e.value] : []))
  return { threads, events, prompts, spec, message, notes }
}

const turns = (events: AgentEvent[]) => events.filter((e) => e.type === 'turn.started').length

test('a turn that failed on a full disk is tried again on its own, told the error', async () => {
  const t = setup('disk', [{ status: 'failed', error: 'ENOSPC: no space left on device, write' }])
  t.message('Go with 1')
  await sleep(400)
  assert.equal(turns(t.events), 2)
  assert.match(t.notes().join('\n'), /Mark tries again in/)
  assert.match(t.prompts[1]!, /^Your last turn in this thread stopped on an error: ENOSPC/)
  assert.match(t.prompts[1]!, /check what is already done/)
})

test('an error that does not pass waits for a person, who tries it again', async () => {
  const t = setup('bug', [{ status: 'failed', error: 'Claude Code process exited with code 1' }])
  t.message('Do it')
  await sleep(400)
  assert.equal(turns(t.events), 1, 'not tried again on its own')
  assert.deepEqual(t.notes(), [])
  t.threads.handle({
    type: 'thread.retry',
    commandId: 'r',
    thread: t.spec,
    error: 'Claude Code process exited with code 1',
    memberId: 'm1',
  })
  await sleep(100)
  assert.equal(turns(t.events), 2)
  assert.match(t.prompts[1]!, /stopped on an error: Claude Code process exited with code 1/)
})

test('after three tries on its own, it stops and says so', async () => {
  const t = setup(
    'down',
    Array.from({ length: 5 }, () => ({ status: 'failed' as const, error: 'socket hang up' })),
  )
  t.message('Go')
  await sleep(900)
  assert.equal(turns(t.events), 4, 'the turn and three tries')
  assert.match(t.notes().at(-1)!, /Mark tried again 3 times and the error came back/)
})

test('a message sent before the try goes on instead of it', async () => {
  const t = setup('msg', [{ status: 'failed', error: 'ECONNRESET' }])
  t.message('First')
  await sleep(30)
  t.message('Never mind, do this')
  await sleep(400)
  assert.equal(turns(t.events), 2, 'the failed turn and the message, no try')
  assert.equal(t.prompts[1], 'Never mind, do this')
})

const BRIDGE_CLOSED = 'claude-code bridge closed before the turn finished.'

test('a turn whose harness process went away is tried again on its own', async () => {
  const t = setup('bridge', [{ status: 'failed', error: BRIDGE_CLOSED }])
  t.message('Go')
  await sleep(400)
  assert.equal(turns(t.events), 2)
  assert.match(t.notes().join('\n'), /Mark tries again in/)
})

test('a turn the memory guard stopped goes on once the computer has memory again', async () => {
  // Room for the first turn, none at the first try, then room again.
  const room = [true, false, true, true]
  const t = setup(
    'memory',
    [
      {
        status: 'failed',
        error: BRIDGE_CLOSED,
        memoryStop: 'the computer is nearly out of memory, and it held the most (2.1 GB)',
      },
    ],
    async () => room.shift() ?? true,
  )
  t.message('Go')
  await sleep(600)
  assert.equal(turns(t.events), 2, 'the turn, then once there is memory, the try')
  const notes = t.notes()
  assert.equal(notes.length, 2)
  assert.match(
    notes[0]!,
    /^Mark goes on once the computer has memory again, in .+ at the earliest\.$/,
  )
  assert.equal(
    notes[1],
    'The computer is still short of memory. Mark goes on once it has some again.',
  )
  assert.match(
    t.prompts[1]!,
    /^Your last turn in this thread stopped on an error: Stopped to give the computer memory back: the computer is nearly out of memory, and it held the most \(2\.1 GB\)\./,
  )
  assert.match(t.prompts[1]!, /one at a time/)
})

test('a turn waits for the computer to have memory before it starts', async () => {
  let room = false
  const t = setup('wait', [], async () => room)
  t.message('Go')
  await sleep(100)
  assert.equal(turns(t.events), 0)
  // A short wait says nothing; a longer one says why, once.
  assert.deepEqual(t.notes(), [])
  await sleep(5_200)
  assert.deepEqual(t.notes(), [
    'The computer is short of memory: Mark starts once it has some again.',
  ])
  room = true
  await sleep(5_200)
  assert.equal(turns(t.events), 1)
})

test('waiting for memory does not use up the tries of a turn the guard stopped', async () => {
  let room = true
  const t = setup(
    'budget',
    [{ status: 'failed', error: BRIDGE_CLOSED, memoryStop: 'pressure' }],
    async () => room,
  )
  t.message('Go')
  await sleep(50)
  // Short of memory longer than all three tries would take.
  room = false
  await sleep(500)
  assert.equal(turns(t.events), 1)
  room = true
  await sleep(250)
  assert.equal(turns(t.events), 2, JSON.stringify(t.notes()))
  assert.ok(!t.notes().some((n) => /tried again 3 times/.test(n)))
  assert.equal(t.notes().filter((n) => /still short of memory/.test(n)).length, 1, 'said once')
})

test('a person taking control while a try waits for memory: it does not run', async () => {
  let room = true
  const t = setup('takeover-wait', [{ status: 'failed', error: BRIDGE_CLOSED }], async () => room)
  t.message('Go')
  await sleep(50)
  // The try is queued, then waits for memory before it starts.
  room = false
  await sleep(200)
  t.threads.takeover(t.spec, 'm1', true)
  room = true
  // Past the wait's next check of memory.
  await sleep(5_300)
  assert.equal(turns(t.events), 1, 'the try ran despite the takeover')
})
