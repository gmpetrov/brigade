import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// Choices nobody picked wait on a person (src/choices-waiting.ts), and what counts them (the
// Board, Home, a list item's state, Tasks' columns, pushes), against a real database: the local
// one of apps/api/.env, in an organization of its own that it removes at the end. Without a
// database to reach, those that need one are skipped.
const fromEnvFile = () => {
  try {
    const line = readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('DATABASE_URL='))
    return line?.slice('DATABASE_URL='.length).replace(/^"|"$/g, '') || undefined
  } catch {
    return undefined
  }
}
process.env.DATABASE_URL ??= fromEnvFile() ?? 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select 1 from "ThreadLater" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { prisma, scoped } = await import('../src/db.js')
const { choicesWaitingAmong, choicesWaitingOn } = await import('../src/choices-waiting.js')
const { board } = await import('../src/board.js')
const { homeFor, homeWaiting } = await import('../src/home.js')
const { columnOf } = await import('../src/tasks.js')
const { stateOf } = await import('../src/lists.js')
const { workspaceItems } = await import('../src/notifications.js')

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const id = randomUUID().slice(0, 8)
const ids = {
  organization: `org-choices-${id}`,
  users: [`user-choices-${id}`, `user-choices-b-${id}`],
  members: [`mem-choices-${id}`, `mem-choices-b-${id}`],
}
let scope: { organizationId: string; workspaceId: string }
let teammateId: string
let computerId: string
const db = () => scoped(scope)

before(async () => {
  if (skip) return
  await prisma.organization.create({
    data: { id: ids.organization, name: 'Choices test', slug: ids.organization },
  })
  for (const [i, userId] of ids.users.entries()) {
    await prisma.user.create({
      data: { id: userId, name: `Member ${i}`, email: `${userId}@example.com` },
    })
    await prisma.member.create({
      data: { id: ids.members[i]!, organizationId: ids.organization, userId, role: 'owner' },
    })
  }
  const workspace = await prisma.workspace.create({
    data: { organizationId: ids.organization, name: 'Choices test' },
  })
  scope = { organizationId: ids.organization, workspaceId: workspace.id }
  teammateId = (await prisma.teammate.create({ data: { ...scope, name: 'Riley' } })).id
  computerId = (
    await prisma.computer.create({
      data: { ...scope, kind: 'member_machine', memberId: ids.members[0], name: 'Laptop' },
    })
  ).id
})

after(async () => {
  if (skip) return
  await prisma.organization.deleteMany({ where: { id: ids.organization } })
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } })
  await prisma.$disconnect()
})

const QUESTION = 'Which name for Home?'
const choices = {
  question: QUESTION,
  options: [
    { id: 'a', label: '1 · Today' },
    { id: 'b', label: '2 · Desk' },
  ],
}
const replies = { replies: ['Build it', 'Not yet'] }

/** What happens in a thread, in order: a person writes, a teammate ends a turn on a card. */
type Step = { person: string } | { offers: 'choices' | 'replies'; ago?: number } | { reply: string }

let titles = 0
/** A thread of member 0's, idle unless said otherwise, with what happened in it. */
async function thread(
  steps: Step[],
  options: {
    status?: string
    parentId?: string
    scheduleId?: string
    quiet?: boolean
    archived?: boolean
    done?: boolean
    member?: number
  } = {},
) {
  const t = await prisma.session.create({
    data: {
      ...scope,
      teammateId,
      startedByMemberId: ids.members[options.member ?? 0]!,
      computerId,
      title: `Thread ${++titles}`,
      status: (options.status ?? 'idle') as never,
      origin: options.parentId ? 'child' : options.scheduleId ? 'schedule' : 'member',
      ...(options.parentId ? { parentId: options.parentId, parentTeammateId: teammateId } : {}),
      ...(options.scheduleId ? { scheduleId: options.scheduleId } : {}),
      ...(options.quiet ? { quiet: true } : {}),
      ...(options.archived ? { archivedAt: new Date() } : {}),
      ...(options.done ? { doneAt: new Date(), doneByType: 'teammate', doneById: teammateId } : {}),
    },
  })
  let seq = 0
  const event = (type: string, data: Record<string, unknown>, at = new Date()) =>
    prisma.sessionEvent.create({
      data: { ...scope, sessionId: t.id, seq: ++seq, at, type, data: { type, ...data } },
    } as never)
  for (const step of steps) {
    if ('person' in step) {
      await event('message.user', { text: step.person, memberId: ids.members[0] })
      continue
    }
    if ('reply' in step) {
      await event('message.done', { id: `m${seq}`, text: step.reply })
      await event('turn.completed', {})
      continue
    }
    const at = new Date(Date.now() - (step.ago ?? 0))
    await event('message.done', { id: `m${seq}`, text: 'Here are my proposals.' }, at)
    await event(
      'tool.started',
      step.offers === 'choices'
        ? { toolCallId: `m${seq}:offer_choices`, toolName: 'offer_choices', input: choices }
        : { toolCallId: `m${seq}:suggest_replies`, toolName: 'suggest_replies', input: replies },
      at,
    )
    await event('turn.completed', {}, at)
  }
  return t
}

test('choices nobody picked wait on a person, until someone writes', { skip }, async () => {
  const offered = await thread([{ person: 'Rename Home' }, { offers: 'choices' }])
  const picked = await thread([
    { person: 'Rename Home' },
    { offers: 'choices' },
    { person: 'Go with 1 · Today' },
    { reply: 'Renamed.' },
  ])
  // Offered again after a pick: the latest one waits.
  const again = await thread([
    { person: 'Rename Home' },
    { offers: 'choices' },
    { person: 'Something shorter' },
    { offers: 'choices' },
  ])
  // A later turn of its own (a wake-up) leaves the card open, as the thread shows it.
  const woken = await thread([{ person: 'Rename Home' }, { offers: 'choices' }, { reply: 'Hm.' }])
  // Reply buttons offer a next step a person may leave: they never wait.
  const buttons = await thread([{ person: 'Fix it' }, { offers: 'replies' }])
  const none = await thread([{ person: 'Hello' }, { reply: 'Hi' }])
  const old = await thread([{ person: 'Rename Home' }, { offers: 'choices', ago: 8 * DAY }])

  const waiting = await choicesWaitingAmong(db(), [
    offered.id,
    picked.id,
    again.id,
    woken.id,
    buttons.id,
    none.id,
    old.id,
  ])
  assert.deepEqual([...waiting.keys()].sort(), [offered.id, again.id, woken.id].sort())
  assert.equal(waiting.get(offered.id)?.question, QUESTION)
  assert.equal(waiting.get(offered.id)?.choices.options.length, 2)
})

test(
  'not while it works, nor in a child, a routine’s run, a quiet playbook run, archived or done',
  { skip },
  async () => {
    const steps: Step[] = [{ person: 'Rename Home' }, { offers: 'choices' }]
    const parent = await thread([])
    const schedule = await prisma.schedule.create({
      data: {
        ...scope,
        teammateId,
        title: 'Digest',
        instructions: 'Do it',
        cron: '0 9 * * *',
        timezone: 'Europe/Paris',
        ownerMemberId: ids.members[0]!,
      },
    })
    const threads = await Promise.all([
      thread(steps, { status: 'running' }),
      thread(steps, { parentId: parent.id }),
      thread(steps, { scheduleId: schedule.id }),
      thread(steps, { quiet: true }),
      thread(steps, { archived: true }),
      thread(steps, { done: true }),
    ])
    const waiting = await choicesWaitingAmong(
      db(),
      threads.map((t) => t.id),
    )
    assert.equal(waiting.size, 0)
  },
)

test(
  'they wait on whoever started the thread, unless they put it away for later',
  { skip },
  async () => {
    const mine = await thread([{ person: 'Rename Home' }, { offers: 'choices' }])
    const later = await thread([{ person: 'Rename Home' }, { offers: 'choices' }])
    await prisma.threadLater.create({
      data: { ...scope, memberId: ids.members[0]!, sessionId: later.id },
    })
    const theirs = await thread([{ person: 'Rename Home' }, { offers: 'choices' }], { member: 1 })
    const of = (member: number) =>
      choicesWaitingOn(db(), ids.members[member]!).then((c) => c.map((t) => t.id))
    const me = await of(0)
    assert.ok(me.includes(mine.id))
    assert.ok(!me.includes(later.id), 'put away for later')
    assert.ok(!me.includes(theirs.id), 'someone else’s')
    assert.ok((await of(1)).includes(theirs.id))

    // Home's Needs you lists it with its card; what came back and loose ends leave it to that.
    const waiting = await homeWaiting(db(), ids.members[0]!)
    const listed = waiting.choices.find((c) => c.id === mine.id)
    assert.equal(listed?.choices.question, QUESTION)
    const feed = await homeFor(db(), ids.members[0]!)
    assert.ok(!feed.results.some((r) => r.thread.id === mine.id))
    assert.ok(!feed.looseEnds.some((l) => l.thread.id === mine.id))
  },
)

test('the Board: a thread stopped on choices is Needs you, "Pick one"', { skip }, async () => {
  const offered = await thread([{ person: 'Rename Home' }, { offers: 'choices' }])
  const answered = await thread([
    { person: 'Rename Home' },
    { offers: 'choices' },
    { person: 'Go with 1 · Today' },
    { reply: 'Renamed.' },
  ])
  const view = await board(db(), { ...scope, memberId: ids.members[0]!, role: 'owner' } as never)
  const card = view.cards.find((c) => c.key === `thread:${offered.id}`)
  assert.equal(card?.column, 'needs_you')
  assert.equal(card?.reason, 'choice')
  assert.equal(card?.note, QUESTION)
  assert.ok(!view.stopped.some((s) => s.key === `thread:${offered.id}`))
  // Answered, nothing else pending: it stopped, as before.
  assert.ok(view.stopped.some((s) => s.key === `thread:${answered.id}`))
  assert.ok(!view.cards.some((c) => c.key === `thread:${answered.id}`))
})

test(
  'pushes: choices are their starter’s, with what they ask, once by its thread',
  { skip },
  async () => {
    const offered = await thread([{ person: 'Rename Home' }, { offers: 'choices' }])
    const members = ids.members.map((m) => ({ id: m, role: 'owner', notify: 'needed' as const }))
    const { items, counted } = await workspaceItems(scope, members, new Date())
    const mine = items.get(ids.members[0]!)!
    const pushed = mine.filter((i) => i.tag === offered.id)
    assert.equal(pushed.length, 1)
    assert.equal(pushed[0]?.key, `needs:${offered.id}`)
    assert.equal(pushed[0]?.title, 'Riley needs you to pick one')
    assert.equal(pushed[0]?.body, QUESTION)
    assert.ok(counted.get(ids.members[0]!)!.has(`needs:${offered.id}`))
    assert.equal(counted.get(ids.members[1]!)!.has(`needs:${offered.id}`), false)
  },
)

test('a list item and a task whose thread stopped on choices need you', () => {
  const session = {
    id: 't1',
    status: 'idle',
    archivedAt: null,
    _count: { tickets: 0 },
    pullRequests: [],
  }
  const row = { threads: [{ session }], pulls: [] }
  assert.equal(stateOf(false, row as never, new Set(), new Set(['t1'])), 'needs_you')
  assert.equal(stateOf(false, row as never, new Set(), new Set()), 'open')
  assert.equal(stateOf(true, row as never, new Set(), new Set(['t1'])), 'done')
  const task = { completedAt: null, session }
  assert.equal(columnOf(task, false, true), 'needs_you')
  assert.equal(columnOf(task, false), 'doing')
})
