// A person writes while their teammate's turn runs: a copy of its conversation answers on the
// side (side-replies.ts), and the message is settled, passed to the turn, or left for after it.
// The harness is a stand-in whose turns end when told and whose side replies say what they're told.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import type { AgentEvent, ThreadSpec } from '@brigade/contracts'

const home = await mkdtemp(join(tmpdir(), 'brigade-side-'))
process.env.BRIGADE_HOME = home
process.env.BRIGADE_SIDE_STEER_MS = '150'
await mkdir(join(home, 'state'), { recursive: true })
const { Threads } = await import('../src/threads.js')

const events: { sessionId: string; event: AgentEvent }[] = []
let room = true
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
  memoryRoom: async () => room,
} as unknown as ConstructorParameters<typeof Threads>[0])

/** Per thread: ends its running turn; what each turn and side reply was given; what steers got. */
const ends = new Map<string, () => void>()
const prompts = new Map<string, string[]>()
const steered = new Map<string, string[]>()
/** What the next side reply says, or how it fails; `hold` keeps it going until released. */
let sideSays: string | Error = 'ok\nROUTE: answer'
let hold: Promise<void> | undefined
const sideAsked: string[] = []
const seats: { parkTimer?: NodeJS.Timeout }[] = []
;(threads as unknown as { harness: (thread: unknown, spec: ThreadSpec) => unknown }).harness = (
  _,
  spec,
) => {
  const id = spec.sessionId
  const seat = {
    harness: {
      active: false,
      forkable: true,
      run: async (input: { text?: string }) => {
        prompts.set(id, [...(prompts.get(id) ?? []), input.text ?? ''])
        await new Promise<void>((resolve) => ends.set(id, resolve))
        events.push({
          sessionId: id,
          event: { at: new Date().toISOString(), type: 'turn.completed', finishReason: 'stop' },
        })
        return { status: 'idle' }
      },
      sideReply: async (prompt: string, signal: AbortSignal) => {
        sideAsked.push(prompt)
        if (hold)
          await Promise.race([
            hold,
            new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })),
          ])
        if (signal.aborted) throw new Error('stopped')
        if (sideSays instanceof Error) throw sideSays
        return sideSays
      },
      steer: async (text: string) => {
        steered.set(id, [...(steered.get(id) ?? []), text])
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
    folder: { key: `${id}-mark`, workDir: join(home, id) },
    parkTimer: undefined,
    turn: [],
    waiting: false,
    told: new Set(),
    background: [],
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

let n = 0
/** A person's message; its id. */
const send = (sessionId: string, text: string, memberId: string | null = 'm1') => {
  const messageId = `msg${++n}`
  threads.handle({
    type: 'thread.prompt',
    commandId: `c${n}`,
    thread: spec(sessionId),
    text,
    memberId,
    messageId,
    then: [],
    attachments: [],
  })
  return messageId
}

const act = (sessionId: string, messageId: string, action: 'keep' | 'queue' | 'steer' | 'cancel') =>
  threads.handle({
    type: 'thread.queued',
    commandId: `a${++n}`,
    sessionId,
    messageId,
    action,
    memberId: 'm1',
  })

const of = (sessionId: string) =>
  events.filter((e) => e.sessionId === sessionId).map((e) => e.event)
const sides = (sessionId: string, messageId: string) =>
  of(sessionId).filter(
    (e): e is Extract<AgentEvent, { type: 'message.side' }> =>
      e.type === 'message.side' && e.messageId === messageId,
  )
const users = (sessionId: string, messageId: string) =>
  of(sessionId).filter(
    (e): e is Extract<AgentEvent, { type: 'message.user' }> =>
      e.type === 'message.user' && e.messageId === messageId,
  )
const turns = (sessionId: string) => of(sessionId).filter((e) => e.type === 'turn.started').length
const end = (sessionId: string) => ends.get(sessionId)?.()

test('a question during the turn is answered on the side, read, and runs no turn of its own', async () => {
  send('ask', 'Fix the CSV export')
  await sleep(30)
  sideSays = 'It is in exportRows.\n\nROUTE: answer'
  const question = send('ask', 'Where was the bug?')
  await sleep(50)
  assert.deepEqual(
    sides('ask', question).map((e) => [e.status, e.route ?? null, e.text ?? null]),
    [
      ['answering', null, null],
      ['answered', 'answer', 'It is in exportRows.'],
    ],
  )
  assert.match(sideAsked.at(-1)!, /Where was the bug\?/)
  const read = users('ask', question)
  assert.equal(read.length, 1)
  assert.equal(read[0]!.side, true)
  // The turn ends: no turn comes for the settled question.
  end('ask')
  await sleep(50)
  assert.equal(turns('ask'), 1)
  // The next one is told of the exchange.
  send('ask', 'Thanks, carry on')
  await sleep(50)
  assert.equal(turns('ask'), 2)
  const told = prompts.get('ask')!.at(-1)!
  assert.match(told, /Where was the bug\?/)
  assert.match(told, /It is in exportRows\./)
  end('ask')
  await sleep(30)
})

test('an instruction is passed to the running turn after a moment, unless its sender keeps it', async () => {
  send('steer', 'Fix the CSV export')
  await sleep(30)
  sideSays = 'Noted, I pass it on.\nROUTE: steer'
  const instruction = send('steer', 'Use a semicolon instead')
  await sleep(40)
  const pending = sides('steer', instruction).at(-1)!
  assert.equal(pending.route, 'steer')
  assert.ok(pending.steerAt)
  assert.equal(users('steer', instruction).length, 0, 'not yet')
  await sleep(200)
  assert.deepEqual(steered.get('steer'), ['Use a semicolon instead'])
  assert.equal(users('steer', instruction)[0]?.steered, true)

  // Kept: it waits for the turn to end instead, and runs in a turn of its own.
  const other = send('steer', 'Also rename the file')
  await sleep(40)
  act('steer', other, 'keep')
  await sleep(250)
  assert.deepEqual(steered.get('steer'), ['Use a semicolon instead'])
  assert.equal(sides('steer', other).at(-1)?.route, 'queue')
  end('steer')
  await sleep(50)
  assert.equal(turns('steer'), 2)
  assert.equal(users('steer', other).length, 1)
  end('steer')
  await sleep(30)
})

test('new work waits for the turn, as any message would', async () => {
  send('queue', 'Fix the CSV export')
  await sleep(30)
  sideSays = 'That is new work: after this one.\nROUTE: queue'
  const work = send('queue', 'Then add an Excel export')
  await sleep(50)
  assert.equal(sides('queue', work).at(-1)?.route, 'queue')
  assert.equal(users('queue', work).length, 0)
  end('queue')
  await sleep(50)
  assert.equal(turns('queue'), 2)
  assert.equal(users('queue', work).length, 1)
  end('queue')
  await sleep(30)
})

test('a settled message its sender wants run after all gets its turn, even once the turn is over', async () => {
  send('requeue', 'Fix the CSV export')
  await sleep(30)
  sideSays = 'Yes.\nROUTE: answer'
  const message = send('requeue', 'Is it the date format?')
  await sleep(50)
  end('requeue')
  await sleep(50)
  assert.equal(turns('requeue'), 1)
  act('requeue', message, 'queue')
  await sleep(50)
  assert.equal(turns('requeue'), 2)
  assert.equal(sides('requeue', message).at(-1)?.route, 'queue')
  assert.equal(users('requeue', message).filter((e) => !e.side).length, 1)
  end('requeue')
  await sleep(30)
})

test('when its turn comes first, the side reply stops and the teammate answers it itself', async () => {
  send('race', 'Fix the CSV export')
  await sleep(30)
  let release!: () => void
  hold = new Promise((resolve) => (release = resolve))
  sideSays = 'Late.\nROUTE: answer'
  const message = send('race', 'How long will it take?')
  await sleep(30)
  end('race')
  await sleep(50)
  assert.equal(sides('race', message).at(-1)?.status, 'failed')
  assert.equal(turns('race'), 2)
  assert.equal(users('race', message).length, 1)
  assert.equal(users('race', message)[0]!.side, undefined)
  release()
  hold = undefined
  end('race')
  await sleep(30)
})

test('no side reply for Brigade’s own messages, when memory is short, or when it fails', async () => {
  send('none', 'Fix the CSV export')
  await sleep(30)
  const note = send('none', 'A wake-up', null)
  room = false
  const short = send('none', 'Short of memory')
  await sleep(40)
  room = true
  sideSays = new Error('bridge died')
  const failed = send('none', 'And this?')
  await sleep(50)
  assert.equal(sides('none', note).length, 0)
  assert.equal(sides('none', short).length, 0)
  assert.deepEqual(
    sides('none', failed).map((e) => e.status),
    ['answering', 'failed'],
  )
  // All three wait for the turn, as before: each in a turn of its own, in order.
  for (let i = 0; i < 4; i++) {
    end('none')
    await sleep(40)
  }
  for (const id of [note, short, failed]) assert.equal(users('none', id).length, 1)
  assert.equal(turns('none'), 4)
  sideSays = 'ok\nROUTE: answer'
})

test('cancelled while it is answered, the message is neither read nor run', async () => {
  send('cancel', 'Fix the CSV export')
  await sleep(30)
  let release!: () => void
  hold = new Promise((resolve) => (release = resolve))
  const message = send('cancel', 'Never mind this')
  await sleep(30)
  act('cancel', message, 'cancel')
  await sleep(50)
  assert.equal(sides('cancel', message).at(-1)?.status, 'failed')
  release()
  hold = undefined
  end('cancel')
  await sleep(50)
  assert.equal(users('cancel', message).length, 0)
  assert.equal(turns('cancel'), 1)
})
