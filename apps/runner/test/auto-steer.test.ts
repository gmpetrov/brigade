// A person's message written while their teammate's turn runs goes into that turn at its next
// step, as in a chat: the turn's reply covers it, rather than a turn of its own after it. The
// harness is a stand-in whose turns end when told, and which keeps what was steered into it.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import type { AgentEvent, ThreadSpec } from '@brigade/contracts'

const home = await mkdtemp(join(tmpdir(), 'brigade-auto-steer-'))
process.env.BRIGADE_HOME = home
process.env.BRIGADE_AUTO_STEER_WAIT_MS = '2000'
await mkdir(join(home, 'state'), { recursive: true })
const { Threads } = await import('../src/threads.js')

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
} as unknown as ConstructorParameters<typeof Threads>[0])

/** Per thread: ends its running turn; what each turn was told; what was steered into it. */
const ends = new Map<string, () => void>()
const prompts = new Map<string, string[]>()
const steered = new Map<string, string[]>()
/** Per thread: whether its session can take a message now, and whether it refuses them. */
const live = new Map<string, boolean>()
const refuses = new Set<string>()
const seats: { parkTimer?: NodeJS.Timeout }[] = []
;(threads as unknown as { harness: (thread: unknown, spec: ThreadSpec) => unknown }).harness = (
  _,
  spec,
) => {
  const id = spec.sessionId
  const seat = {
    harness: {
      active: false,
      get forkable() {
        return live.get(id) ?? true
      },
      run: async (input: { text?: string }) => {
        prompts.set(id, [...(prompts.get(id) ?? []), input.text ?? ''])
        await new Promise<void>((resolve) => ends.set(id, resolve))
        events.push({
          sessionId: id,
          event: { at: new Date().toISOString(), type: 'turn.completed', finishReason: 'stop' },
        })
        return { status: 'idle' }
      },
      steer: async (text: string) => {
        if (refuses.has(id)) throw new Error('Harness session has no running turn to steer')
        steered.set(id, [...(steered.get(id) ?? []), text])
      },
      stopDrain: async () => undefined,
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
const of = (sessionId: string) =>
  events.filter((e) => e.sessionId === sessionId).map((e) => e.event)
const turns = (sessionId: string) => of(sessionId).filter((e) => e.type === 'turn.started').length
async function until(ok: () => boolean, what: string) {
  for (let i = 0; i < 300 && !ok(); i++) await sleep(20)
  assert.ok(ok(), what)
}
const shownSteered = (sessionId: string) =>
  of(sessionId)
    .filter((e) => e.type === 'message.user' && e.steered)
    .map((e) => (e.type === 'message.user' ? e.text : ''))
const finish = async (sessionId: string) => {
  const done = of(sessionId).filter((e) => e.type === 'turn.completed').length
  ends.get(sessionId)?.()
  await until(
    () => of(sessionId).filter((e) => e.type === 'turn.completed').length > done,
    'the turn ends',
  )
}

test("a person's messages during a turn go into it, in order, and get no turn of their own", async () => {
  send('a', 'Fix the export')
  await until(() => turns('a') === 1, 'the turn starts')
  send('a', 'test2')
  send('a', 'test3')
  await until(() => (steered.get('a') ?? []).length === 2, 'both go into the turn')
  assert.match(steered.get('a')![0]!, /test2/)
  assert.match(steered.get('a')![1]!, /test3/)
  assert.deepEqual(shownSteered('a'), ['test2', 'test3'])
  await finish('a')
  await sleep(150)
  assert.equal(turns('a'), 1, 'no turn after it for them')
})

test('a turn whose session is still starting takes the message once it can', async () => {
  live.set('b', false)
  send('b', 'Start')
  await until(() => turns('b') === 1, 'the turn starts')
  send('b', 'And this')
  await sleep(200)
  assert.equal((steered.get('b') ?? []).length, 0, 'not before its session can take it')
  live.set('b', true)
  await until(() => (steered.get('b') ?? []).length === 1, 'it goes in once it can')
  await finish('b')
})

test("refused, it waits quietly and the next turn reads it; Brigade's own are not steered", async () => {
  refuses.add('c')
  send('c', 'Start')
  await until(() => turns('c') === 1, 'the turn starts')
  send('c', 'A question')
  send('c', 'A wake-up', null)
  await sleep(300)
  // No note on the message: the person sees it wait as any queued one.
  assert.ok(
    of('c').every((e) => e.type !== 'message.queued' || !e.note),
    'nothing said of a refused steer',
  )
  refuses.delete('c')
  await finish('c')
  await until(() => turns('c') === 2, 'the next turn starts')
  const next = prompts.get('c')!.at(-1)!
  assert.match(next, /A question/)
  assert.match(next, /A wake-up/)
  await finish('c')
})

// Review of #678: a message must never reach the turn before one the thread got earlier and has
// not read, or a correction would be read before what it corrects.
test('a later message does not overtake one that could not go in: both wait, in order', async () => {
  live.set('d', false)
  send('d', 'Start the work')
  await until(() => turns('d') === 1, 'the turn starts')
  send('d', 'Rename the export to OLD_NAME')
  // The first gives up waiting for the session (2 s here); the next one comes after that.
  await sleep(2_300)
  live.set('d', true)
  send('d', 'Correction: use NEW_NAME instead')
  await sleep(400)
  assert.deepEqual(steered.get('d') ?? [], [], 'not ahead of the older request')
  await finish('d')
  await until(() => turns('d') === 2, 'the next turn reads both')
  const next = prompts.get('d')!.at(-1)!
  assert.ok(next.indexOf('OLD_NAME') >= 0 && next.indexOf('OLD_NAME') < next.indexOf('NEW_NAME'))
  await finish('d')
  await sleep(100)
  assert.equal(turns('d'), 2)
})

test('a message to the turn waits behind an earlier one for two teammates', async () => {
  send('e', 'Start the work')
  await until(() => turns('e') === 1, 'the turn starts')
  const mark = spec('e')
  const nina = { ...mark, teammate: { ...mark.teammate, id: 'nina', name: 'Nina' } }
  threads.handle({
    type: 'thread.prompt',
    commandId: 'e-both',
    messageId: 'e-both',
    thread: mark,
    then: [nina],
    memberId: 'm1',
    attachments: [],
    text: 'For both: rename the export to OLD_NAME',
  } as never)
  send('e', 'Correction: use NEW_NAME instead')
  await sleep(300)
  assert.deepEqual(steered.get('e') ?? [], [], 'not ahead of the message for both')
  for (let turn = 2; turn <= 4; turn++) {
    await finish('e')
    await until(() => turns('e') === turn, `turn ${turn} starts`)
  }
  const told = prompts.get('e')!
  assert.match(told[1]!, /OLD_NAME/)
  assert.doesNotMatch(told[1]!, /NEW_NAME/)
  assert.match(told[3]!, /NEW_NAME/)
  await finish('e')
})
