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

/** A message sent again by the API, as it does for a settled one its sender wants run after all. */
const resend = (
  sessionId: string,
  messageId: string,
  text: string,
  more: { steer?: boolean } = {},
) =>
  threads.handle({
    type: 'thread.prompt',
    commandId: `r${++n}`,
    thread: spec(sessionId),
    text,
    memberId: 'm1',
    messageId,
    then: [],
    attachments: [],
    settled: true,
    ...more,
  })

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

/** Waits until `ready` holds, so a busy computer's timing changes nothing (3 s at most). */
async function until(ready: () => boolean, what: string) {
  const by = Date.now() + 3000
  while (!ready()) {
    if (Date.now() > by) assert.fail(`timed out waiting: ${what}`)
    await sleep(5)
  }
}
/** Waits until the thread has started `count` turns, its latest one running. */
const started = (sessionId: string, count: number) =>
  until(() => turns(sessionId) === count && ends.has(sessionId), `turn ${count} in ${sessionId}`)
/** Ends the running turn, and waits for it to be over. */
async function finish(sessionId: string) {
  const completed = () => of(sessionId).filter((e) => e.type === 'turn.completed').length
  const before = completed()
  const ending = ends.get(sessionId)
  ends.delete(sessionId)
  ending?.()
  await until(() => completed() > before, `the turn in ${sessionId} to end`)
  await sleep(20)
}
const lastSide = (sessionId: string, messageId: string) => sides(sessionId, messageId).at(-1)

test('a question during the turn is answered on the side, read, and runs no turn of its own', async () => {
  send('ask', 'Fix the CSV export')
  await started('ask', 1)
  sideSays = 'It is in exportRows.\n\nROUTE: answer'
  const question = send('ask', 'Where was the bug?')
  await until(() => users('ask', question).length === 1, 'the question read')
  assert.deepEqual(
    sides('ask', question).map((e) => [e.status, e.route ?? null, e.text ?? null]),
    [
      ['answering', null, null],
      ['answered', 'answer', 'It is in exportRows.'],
    ],
  )
  assert.match(sideAsked.at(-1)!, /Where was the bug\?/)
  assert.deepEqual(users('ask', question)[0]!.side, {
    text: 'It is in exportRows.',
    route: 'answer',
  })
  // The turn ends: no turn comes for the settled question.
  await finish('ask')
  await sleep(50)
  assert.equal(turns('ask'), 1)
  // The next one is told of the exchange.
  send('ask', 'Thanks, carry on')
  await started('ask', 2)
  const told = prompts.get('ask')!.at(-1)!
  assert.match(told, /Where was the bug\?/)
  assert.match(told, /It is in exportRows\./)
  await finish('ask')
})

test('an instruction is passed to the running turn after a moment, unless its sender keeps it', async () => {
  send('steer', 'Fix the CSV export')
  await started('steer', 1)
  sideSays = 'Noted, I pass it on.\nROUTE: steer'
  const instruction = send('steer', 'Use a semicolon instead')
  await until(() => lastSide('steer', instruction)?.status === 'answered', 'its side reply')
  assert.equal(lastSide('steer', instruction)!.route, 'steer')
  assert.ok(lastSide('steer', instruction)!.steerAt)
  assert.equal(users('steer', instruction).length, 0, 'not yet')
  await until(() => users('steer', instruction).length === 1, 'it steered')
  assert.deepEqual(steered.get('steer'), ['Use a semicolon instead'])
  assert.equal(users('steer', instruction)[0]!.steered, true)

  // Kept: it waits for the turn to end instead, and runs in a turn of its own.
  const other = send('steer', 'Also rename the file')
  await until(() => lastSide('steer', other)?.route === 'steer', 'its side reply')
  act('steer', other, 'keep')
  await until(() => lastSide('steer', other)?.route === 'queue', 'kept')
  await sleep(300)
  assert.deepEqual(steered.get('steer'), ['Use a semicolon instead'])
  await finish('steer')
  await started('steer', 2)
  assert.equal(users('steer', other).length, 1)
  await finish('steer')
})

test('new work waits for the turn, as any message would', async () => {
  send('queue', 'Fix the CSV export')
  await started('queue', 1)
  sideSays = 'That is new work: after this one.\nROUTE: queue'
  const work = send('queue', 'Then add an Excel export')
  await until(() => lastSide('queue', work)?.status === 'answered', 'its side reply')
  assert.equal(lastSide('queue', work)!.route, 'queue')
  assert.equal(users('queue', work).length, 0)
  await finish('queue')
  await started('queue', 2)
  assert.equal(users('queue', work).length, 1)
  await finish('queue')
})

test('a settled message sent again by its sender gets no side reply, and runs or is steered', async () => {
  send('again', 'Fix the CSV export')
  await started('again', 1)
  sideSays = 'Yes.\nROUTE: answer'
  const message = send('again', 'Is it the date format?')
  await until(() => users('again', message).length === 1, 'settled')
  const asked = sideAsked.length
  // Sent again, as the API does for "Queue for after this turn": queued, no second aside.
  resend('again', message, 'Is it the date format?')
  // A second click while it waits changes nothing.
  resend('again', message, 'Is it the date format?')
  await sleep(60)
  assert.equal(sideAsked.length, asked)
  assert.equal(
    of('again').filter((e) => e.type === 'message.queued' && e.messageId === message).length,
    2,
    'its first queue, then once again',
  )
  await finish('again')
  await started('again', 2)
  assert.equal(users('again', message).filter((e) => !e.side).length, 1)
  await finish('again')
  await sleep(50)
  assert.equal(turns('again'), 2)

  // Sent again with steer, during a turn: it goes into it.
  send('again', 'Now the PDF export')
  await started('again', 3)
  const other = send('again', 'Which library?')
  await until(() => users('again', other).length === 1, 'settled')
  resend('again', other, 'Which library?', { steer: true })
  await until(() => users('again', other).some((e) => e.steered), 'steered')
  await finish('again')
})

test('one side reply at a time, even when one waiting for its turn is cancelled', async () => {
  send('one', 'Fix the CSV export')
  await started('one', 1)
  let release!: () => void
  hold = new Promise((resolve) => (release = resolve))
  const asked = sideAsked.length
  const first = send('one', 'First question')
  await until(() => lastSide('one', first)?.status === 'answering', 'the first under way')
  const second = send('one', 'Second question')
  act('one', second, 'cancel')
  await sleep(20)
  send('one', 'Third question')
  await sleep(100)
  assert.equal(sideAsked.length - asked, 1, 'only the first reached the harness')
  release()
  hold = undefined
  await until(() => sideAsked.length - asked === 2, 'the third after the first')
  await finish('one')
  for (let i = 0; i < 2; i++) {
    await sleep(30)
    if (ends.has('one')) await finish('one')
  }
})

test('a later aside, and a message passed to the turn, are told what was said on the side before', async () => {
  send('context', 'Fix the CSV export')
  await started('context', 1)
  sideSays = 'A comma, or a semicolon.\nROUTE: answer'
  const options = send('context', 'Which separators could we use?')
  await until(() => users('context', options).length === 1, 'settled')
  sideSays = 'Noted: the semicolon. I pass it on.\nROUTE: steer'
  const pick = send('context', 'Use the second one')
  await until(() => users('context', pick).some((e) => e.steered), 'steered')
  // The aside knew the first exchange…
  const prompt = sideAsked.at(-1)!
  assert.match(prompt, /Which separators could we use\?/)
  assert.match(prompt, /A comma, or a semicolon\./)
  // …and so does the turn it was passed to, which never heard it.
  const given = steered.get('context')!.at(-1)!
  assert.match(given, /A comma, or a semicolon\./)
  assert.match(given, /Use the second one$/)
  // The steered message says which side reply it came from.
  assert.deepEqual(users('context', pick).at(-1)!.side, {
    text: 'Noted: the semicolon. I pass it on.',
    route: 'steer',
  })
  await finish('context')
  // Its next turn hears it as notes: the one after starts afresh.
  send('context', 'Next')
  await started('context', 2)
  sideSays = 'ok\nROUTE: answer'
  const late = send('context', 'Anything else?')
  await until(() => users('context', late).length === 1, 'settled')
  assert.doesNotMatch(sideAsked.at(-1)!, /Which separators/)
  await finish('context')
})

test('when its turn comes first, the side reply stops and the teammate answers it itself', async () => {
  send('race', 'Fix the CSV export')
  await started('race', 1)
  let release!: () => void
  hold = new Promise((resolve) => (release = resolve))
  sideSays = 'Late.\nROUTE: answer'
  const message = send('race', 'How long will it take?')
  await until(() => lastSide('race', message)?.status === 'answering', 'its side reply')
  await finish('race')
  await started('race', 2)
  assert.equal(lastSide('race', message)!.status, 'failed')
  assert.equal(users('race', message).length, 1)
  assert.equal(users('race', message)[0]!.side, undefined)
  release()
  hold = undefined
  await finish('race')
})

test('no side reply for Brigade’s own messages, when memory is short, or when it fails', async () => {
  send('none', 'Fix the CSV export')
  await started('none', 1)
  const note = send('none', 'A wake-up', null)
  room = false
  const short = send('none', 'Short of memory')
  await sleep(60)
  room = true
  sideSays = new Error('bridge died')
  const failed = send('none', 'And this?')
  await until(() => lastSide('none', failed)?.status === 'failed', 'its side reply to fail')
  assert.equal(sides('none', note).length, 0)
  assert.equal(sides('none', short).length, 0)
  assert.deepEqual(
    sides('none', failed).map((e) => e.status),
    ['answering', 'failed'],
  )
  // All three wait for the turn, as before: each in a turn of its own, in order.
  for (let count = 2; count <= 4; count++) {
    await finish('none')
    await started('none', count)
  }
  await finish('none')
  for (const id of [note, short, failed]) assert.equal(users('none', id).length, 1)
  sideSays = 'ok\nROUTE: answer'
})

test('cancelled while it is answered, the message is neither read nor run', async () => {
  send('cancel', 'Fix the CSV export')
  await started('cancel', 1)
  let release!: () => void
  hold = new Promise((resolve) => (release = resolve))
  const message = send('cancel', 'Never mind this')
  await until(() => lastSide('cancel', message)?.status === 'answering', 'its side reply')
  act('cancel', message, 'cancel')
  await until(() => lastSide('cancel', message)?.status === 'failed', 'it stopped')
  release()
  hold = undefined
  await finish('cancel')
  await sleep(50)
  assert.equal(users('cancel', message).length, 0)
  assert.equal(turns('cancel'), 1)
})
