// Messages written while their teammate works wait for its turn to end, then go into one
// turn together, rather than a turn each, one after the other. The harness is a stand-in
// whose turns end when told, and which keeps what each turn was told.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import type { AgentEvent, ThreadSpec } from '@brigade/contracts'

const home = await mkdtemp(join(tmpdir(), 'brigade-together-'))
process.env.BRIGADE_HOME = home
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

/** Ends the turn running now. */
let end = () => {}
/** What each turn was told, with the spec it ran on. */
const told: { teammate: string; text: string; spec: ThreadSpec }[] = []
const seats: { parkTimer?: NodeJS.Timeout }[] = []
;(threads as unknown as { harness: (thread: unknown, spec: ThreadSpec) => unknown }).harness = (
  _,
  spec,
) => {
  const seat = {
    harness: {
      active: false,
      run: async (turn: { kind: string; text?: string }, ran: ThreadSpec) => {
        told.push({ teammate: ran.teammate.id, text: turn.text ?? '', spec: ran })
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
      forkable: false,
      stopDrain: async () => undefined,
    },
    folder: { key: `${spec.sessionId}-${spec.teammate.id}`, workDir: join(home, spec.sessionId) },
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

const team = [
  { id: 'mark', name: 'Mark', harness: 'claude-code' },
  { id: 'nina', name: 'Nina', harness: 'claude-code' },
]
const spec = (sessionId: string, teammate = 'mark', note = '') =>
  ({
    sessionId,
    teammate: team.find((t) => t.id === teammate),
    teammates: team,
    account: { id: 'acct' },
    attachments: [],
    note,
  }) as unknown as ThreadSpec

const message = (sessionId: string, text: string, teammate = 'mark', then: string[] = []) =>
  threads.handle({
    type: 'thread.prompt',
    commandId: `c-${text.slice(0, 40)}`,
    thread: spec(sessionId, teammate, text.slice(0, 40)),
    text,
    memberId: 'm1',
    then: then.map((id) => spec(sessionId, id, text.slice(0, 40))),
    attachments: [],
  })

const of = (sessionId: string) =>
  events.filter((e) => e.sessionId === sessionId).map((e) => e.event)

/** Waits until `ok` holds, rather than for a fixed time a busy computer may overrun. */
async function until(ok: () => boolean, what: string) {
  for (let i = 0; i < 500 && !ok(); i++) await sleep(20)
  assert.ok(ok(), what)
}
const turns = (sessionId: string) => of(sessionId).filter((e) => e.type === 'turn.started').length

test('messages queued during a turn go into the next turn together', async () => {
  message('t1', 'Build the page')
  await until(() => turns('t1') === 1, 'the first turn starts')
  message('t1', 'Also the footer')
  message('t1', 'And dark mode')
  await until(
    () => of('t1').filter((e) => e.type === 'message.queued').length === 2,
    'both wait for the turn',
  )

  end()
  await until(() => turns('t1') === 2, 'the next turn starts')
  const next = told.at(-1)!
  assert.match(next.text, /Also the footer/)
  assert.match(next.text, /And dark mode/)
  // It runs on the spec the last of them came with: the thread as it is now.
  assert.equal((next.spec as unknown as { note: string }).note, 'And dark mode')
  // Both show in the thread, in the order they were written, before the turn starts.
  const shown = of('t1')
    .filter((e) => e.type === 'message.user')
    .map((e) => (e.type === 'message.user' ? e.text : ''))
  assert.deepEqual(shown, ['Build the page', 'Also the footer', 'And dark mode'])

  end()
  await sleep(100)
  assert.equal(turns('t1'), 2, 'no turn of their own after it')
})

test('a message for another teammate keeps its place: the ones after it wait for its turn', async () => {
  message('t2', 'Start')
  await until(() => turns('t2') === 1, 'the first turn starts')
  message('t2', 'One')
  message('t2', 'For Nina', 'nina')
  message('t2', 'Two')
  await until(
    () => of('t2').filter((e) => e.type === 'message.queued').length === 3,
    'all three wait',
  )

  end()
  await until(() => turns('t2') === 2, "Mark's next turn starts")
  assert.match(told.at(-1)!.text, /One/)
  assert.doesNotMatch(told.at(-1)!.text, /Two/)

  end()
  await until(() => turns('t2') === 3, "Nina's turn starts")
  assert.equal(told.at(-1)!.teammate, 'nina')
  assert.match(told.at(-1)!.text, /For Nina/)

  end()
  await until(() => turns('t2') === 4, "Mark's turn for the last one starts")
  assert.equal(told.at(-1)!.teammate, 'mark')
  assert.match(told.at(-1)!.text, /Two/)
  end()
  await sleep(50)
})

test('queued messages too long to be told together each get a turn, none dropped', async () => {
  message('t3', 'Start')
  await until(() => turns('t3') === 1, 'the first turn starts')
  // Each about 60k characters: together past what a turn is told, the first would be cut.
  message('t3', `FIRST ${'a'.repeat(60_000)}`)
  message('t3', `SECOND ${'b'.repeat(60_000)}`)
  await until(
    () => of('t3').filter((e) => e.type === 'message.queued').length === 2,
    'both wait for the turn',
  )
  end()
  await until(() => turns('t3') === 2, 'the next turn starts')
  assert.match(told.at(-1)!.text, /FIRST/)
  assert.doesNotMatch(told.at(-1)!.text, /SECOND/)
  end()
  await until(() => turns('t3') === 3, 'the second gets a turn of its own')
  assert.match(told.at(-1)!.text, /SECOND/)
  end()
  await sleep(50)
})

test('a message to two teammates: the second answers it before the next message is read', async () => {
  message('t4', 'Start')
  await until(() => turns('t4') === 1, 'the first turn starts')
  message('t4', 'For Mark then Nina', 'mark', ['nina'])
  message('t4', 'Then this')
  await until(
    () => of('t4').filter((e) => e.type === 'message.queued').length === 2,
    'both wait for the turn',
  )
  end()
  await until(() => turns('t4') === 2, "Mark's turn starts")
  assert.match(told.at(-1)!.text, /For Mark then Nina/)
  assert.doesNotMatch(told.at(-1)!.text, /Then this/)
  end()
  await until(() => turns('t4') === 3, "Nina's turn starts")
  assert.equal(told.at(-1)!.teammate, 'nina')
  end()
  await until(() => turns('t4') === 4, "Mark's turn for the next message starts")
  assert.equal(told.at(-1)!.teammate, 'mark')
  assert.match(told.at(-1)!.text, /Then this/)
  end()
  await sleep(50)
})

test('read together up to a message to two teammates, not past it', async () => {
  message('t5', 'Start')
  await until(() => turns('t5') === 1, 'the first turn starts')
  message('t5', 'Before it')
  message('t5', 'For Mark then Nina', 'mark', ['nina'])
  message('t5', 'After it')
  await until(
    () => of('t5').filter((e) => e.type === 'message.queued').length === 3,
    'all three wait for the turn',
  )
  end()
  await until(() => turns('t5') === 2, "Mark's turn starts")
  assert.match(told.at(-1)!.text, /Before it/)
  assert.match(told.at(-1)!.text, /For Mark then Nina/)
  assert.doesNotMatch(told.at(-1)!.text, /After it/)
  end()
  await until(() => turns('t5') === 3, "Nina's turn starts")
  assert.equal(told.at(-1)!.teammate, 'nina')
  end()
  await until(() => turns('t5') === 4, "Mark's turn for the last one starts")
  assert.match(told.at(-1)!.text, /After it/)
  end()
  await sleep(50)
})
