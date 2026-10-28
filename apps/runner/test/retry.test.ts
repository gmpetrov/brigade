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

type Outcome = { status: 'idle' | 'failed'; error?: string }

/** A thread whose teammate's turns end as `outcomes` say, in order (then idle). */
function setup(sessionId: string, outcomes: Outcome[]) {
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
  } as unknown as ConstructorParameters<typeof Threads>[0])
  made.push(threads)
  const harness = {
    active: false,
    run: async (input: { kind: string; text?: string }, spec: ThreadSpec) => {
      prompts.push(input.text ?? '')
      const outcome = outcomes.shift() ?? { status: 'idle' }
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
