// A message Brigade wrote to a teammate (a sub-thread's report) is told to the other teammates
// of the thread as a note from Brigade, never as a person's message; the teammate whose
// sub-thread it reports hears that it is its own. The harness is a stand-in whose turns end
// when told, and which keeps what each turn was told.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { singleNote, type AgentEvent, type ThreadSpec } from '@brigade/contracts'

const home = await mkdtemp(join(tmpdir(), 'brigade-notes-'))
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
  // The last turn may still be saving its log.
  await rm(home, { recursive: true, force: true, maxRetries: 5 })
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

const message = (
  sessionId: string,
  text: string,
  teammate = 'mark',
  then: string[] = [],
  memberId: string | null = 'm1',
) =>
  threads.handle({
    type: 'thread.prompt',
    commandId: `c-${text.slice(0, 40)}`,
    thread: spec(sessionId, teammate, text.slice(0, 40)),
    text,
    memberId,
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

test("a sub-thread's report reaches its teammate as is, and the others as Brigade's note", async () => {
  message('n1', 'Fix the session cookie')
  await until(() => turns('n1') === 1, 'the first turn starts')
  end()

  // Nina reviewed Mark's pull request in a sub-thread: Brigade brings Mark her report.
  const report = singleNote({
    id: 'kid1',
    title: 'Review #710: Sessions',
    teammate: 'Nina',
    schedule: null,
    report: {
      status: 'report',
      summary: 'Two blockers in the tests.',
      at: new Date().toISOString(),
    },
  })
  message('n1', report, 'mark', [], null)
  await until(() => turns('n1') === 2, 'Mark reads the report')
  // To the teammate it was written to, as it is: a thread with one teammate reads as before.
  assert.equal(told.at(-1)!.text, report)
  end()

  // A person asks Nina about it, in the parent thread.
  message('n1', '@Nina why is the second one blocking?', 'nina')
  await until(() => turns('n1') === 3, 'Nina answers')
  const nina = told.at(-1)!
  assert.equal(nina.teammate, 'nina')
  // Brigade's words, not a person's: a report never stands for what someone asked.
  assert.match(
    nina.text,
    /<message from="Brigade, to Mark" kind="note">\nYour child thread “Review #710: Sessions”/,
  )
  assert.doesNotMatch(nina.text, /kind="person">\nYour child thread/)
  // The person's own message still reads as theirs.
  assert.match(nina.text, /kind="person">\n@Nina why is the second one blocking\?/)
  // And she hears the report is her own, with where to read it whole.
  assert.match(nina.text, /report of your own sub-thread “Review #710: Sessions” \(kid1\)/)
  assert.match(nina.text, /`read_child`/)
  end()
})

test("a teammate hears nothing of its own when the report is another's", async () => {
  message('n2', 'Ship it')
  await until(() => turns('n2') === 1, 'the first turn starts')
  end()
  const report = singleNote({
    id: 'kid2',
    title: 'Check the deploy',
    teammate: 'Mark',
    schedule: null,
    report: { status: 'report', summary: 'Deployed.', at: new Date().toISOString() },
  })
  message('n2', report, 'mark', [], null)
  await until(() => turns('n2') === 2, 'Mark reads the report')
  end()
  message('n2', '@Nina anything else?', 'nina')
  await until(() => turns('n2') === 3, 'Nina answers')
  const nina = told.at(-1)!.text
  assert.match(nina, /from="Brigade, to Mark" kind="note"/)
  assert.doesNotMatch(nina, /your own sub-thread/)
  end()
})
