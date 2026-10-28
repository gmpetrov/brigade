// A person hands a thread back: its teammate is told their note and the files they changed,
// with a turn of its own unless it waits on a ticket answered with the hand back. The
// harness is a stand-in, so the thread's queue, notes and prompts are the runner's own.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import type { AgentEvent, ThreadSpec } from '@brigade/contracts'

const home = await mkdtemp(join(tmpdir(), 'brigade-handback-'))
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

/** A thread taken over, whose teammate waits on a ticket until it is answered. */
function takenOver(sessionId: string) {
  const t = setup(sessionId, [])
  const seat = (
    t.threads as unknown as { harness: () => { harness: Record<string, unknown> } }
  ).harness()
  const inputs: string[] = []
  let waiting = true
  seat.harness.awaitingPerson = async () => waiting
  seat.harness.run = async (input: { kind: string; text?: string }) => {
    inputs.push(input.kind)
    t.prompts.push(input.text ?? '')
    if (input.kind === 'ticket') waiting = false
    return { status: 'idle' }
  }
  t.threads.takeover(t.spec, 'm1', false)
  const answer = () =>
    t.threads.handle({
      type: 'thread.ticket',
      commandId: 'answer',
      thread: t.spec,
      requestId: 'req',
      memberId: 'm1',
      answer: { action: 'answered', replies: { a1: { type: 'action', done: true } } },
    })
  return { ...t, inputs, answer, stopWaiting: () => (waiting = false) }
}

const said = (events: AgentEvent[]) =>
  events.flatMap((e) => (e.type === 'message.user' ? [e.text] : []))

test('a hand back answering a ticket starts only the ticket turn, whenever its files come', async () => {
  for (const late of [true, false]) {
    const t = takenOver(`handback-ticket-${late}`)
    let scanned!: (files: string[]) => void
    const scan = new Promise<string[]>((resolve) => (scanned = resolve))
    void t.threads.handback(t.spec, 'm1', '', () => scan)
    if (!late) scanned(['.playwright-mcp/console.log'])
    t.answer()
    await sleep(30)
    if (late) scanned(['.playwright-mcp/console.log'])
    await sleep(30)
    assert.deepEqual(t.inputs, ['ticket'])
    assert.match(said(t.events).join(), /console\.log/)
    // Not left waiting: the ticket's turn reads it.
    assert.ok(t.events.every((e) => e.type !== 'message.user' || !e.waiting))
  }
})

test('a hand back while its teammate waits on a ticket says so, and starts no turn', async () => {
  const t = takenOver('handback-waiting')
  await t.threads.handback(t.spec, 'm1', 'I do not understand', async () => [])
  await sleep(30)
  assert.deepEqual(t.inputs, [])
  const message = t.events.find((e) => e.type === 'message.user')
  assert.equal(message?.type === 'message.user' && message.waiting, true)
  assert.match(t.notes().join(), /once the pending request is answered/)
  // Answered, the ticket's turn reads it.
  t.answer()
  await sleep(30)
  assert.deepEqual(t.inputs, ['ticket'])
})

test('a hand back with files and no ticket gives its teammate a turn', async () => {
  const t = takenOver('handback-alone')
  t.stopWaiting()
  await t.threads.handback(t.spec, 'm1', 'Logged in', async () => ['a.txt'])
  await sleep(30)
  assert.deepEqual(t.inputs, ['prompt'])
  assert.match(t.prompts.join(), /Logged in/)
})

test('a hand back with no note and no files says nothing', async () => {
  const t = takenOver('handback-quiet')
  t.stopWaiting()
  await t.threads.handback(t.spec, 'm1', '', async () => [])
  await sleep(30)
  assert.deepEqual(t.inputs, [])
  assert.deepEqual(said(t.events), [])
})

/** A thread whose teammate's first turn runs until `finish`, with a message queued behind it. */
async function queuedBehind(sessionId: string) {
  const t = setup(sessionId, [])
  const seat = (
    t.threads as unknown as { harness: () => { harness: Record<string, unknown> } }
  ).harness()
  let finish!: () => void
  const first = new Promise<void>((resolve) => (finish = resolve))
  let turns = 0
  seat.harness.run = async (input: { text?: string }) => {
    t.prompts.push(input.text ?? '')
    if (turns++ === 0) await first
    return { status: 'idle' }
  }
  t.message('Start')
  await sleep(20)
  t.message('Then this')
  await sleep(20)
  return { ...t, finish }
}

const cancelled = (events: AgentEvent[]) => events.filter((e) => e.type === 'message.cancelled')

test('a message queued when a person takes over runs once they hand back', async () => {
  // Handed back while the turn before it still runs, or once it ended.
  for (const early of [true, false]) {
    const t = await queuedBehind(`handback-queued-${early}`)
    t.threads.takeover(t.spec, 'm1', false)
    if (!early) {
      t.finish()
      await sleep(30)
    }
    const queued = t.events.findLast((e) => e.type === 'message.queued')
    assert.equal(queued?.type === 'message.queued' && queued.waitingFor, 'person')
    assert.equal(t.prompts.length, 1)
    await t.threads.handback(t.spec, 'm1', '', async () => [])
    t.finish()
    await sleep(50)
    assert.deepEqual(cancelled(t.events), [])
    assert.deepEqual(said(t.events), ['Start', 'Then this'])
    assert.equal(t.prompts.length, 2)
    assert.match(t.prompts[1]!, /Then this/)
  }
})

test("a hand back's note reaches the teammate before the messages held during it", async () => {
  const t = await queuedBehind('handback-note-first')
  t.threads.takeover(t.spec, 'm1', false)
  await t.threads.handback(t.spec, 'm1', 'Do not send the email, I sent it', async () => [
    'sent.txt',
  ])
  t.finish()
  await sleep(50)
  assert.equal(t.prompts.length, 3)
  assert.match(t.prompts[1]!, /Do not send the email/)
  assert.match(t.prompts[2]!, /Then this/)
})

test('a hand back during a turn releases the held messages once that turn ends', async () => {
  const t = await queuedBehind('handback-mid-turn')
  const seat = (
    t.threads as unknown as { harness: () => { harness: Record<string, unknown> } }
  ).harness()
  // A live session is not idle until its turn ends.
  let running = true
  seat.harness.awaitingPerson = async () => running
  t.threads.takeover(t.spec, 'm1', false)
  await t.threads.handback(t.spec, 'm1', '', async () => [])
  running = false
  t.finish()
  await sleep(50)
  assert.equal(t.prompts.length, 2)
  assert.match(t.prompts[1]!, /Then this/)
})

test('a hand back during a ticket turn runs its note, then the held message, once', async () => {
  const t = setup('handback-ticket-turn', [])
  const seat = (
    t.threads as unknown as { harness: () => { harness: Record<string, unknown> } }
  ).harness()
  let finish!: () => void
  const first = new Promise<void>((resolve) => (finish = resolve))
  let turns = 0
  seat.harness.run = async (input: { text?: string }) => {
    t.prompts.push(input.text ?? 'ticket')
    if (turns++ === 0) await first
    return { status: 'idle' }
  }
  t.threads.handle({
    type: 'thread.ticket',
    commandId: 'answer',
    thread: t.spec,
    requestId: 'req',
    memberId: 'm1',
    answer: { action: 'answered', replies: { a1: { type: 'action', done: true } } },
  })
  await sleep(20)
  t.message('Then this')
  await sleep(20)
  t.threads.takeover(t.spec, 'm1', false)
  await t.threads.handback(t.spec, 'm1', 'Do not send the email, I sent it', async () => [])
  finish()
  await sleep(50)
  assert.equal(t.prompts.length, 3)
  assert.match(t.prompts[1]!, /Do not send the email/)
  assert.match(t.prompts[2]!, /Then this/)
})
