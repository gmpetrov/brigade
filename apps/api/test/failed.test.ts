import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// What failed and waits on a person (src/failed.ts), and what counts it (Tasks' columns, a list
// item's state, pushes), against a real database: the local one of apps/api/.env, in an
// organization of its own that it removes at the end. Without a database to reach, those that
// need one are skipped.
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
const { failedThreadsOf, failedWaitingAmong, failingRoutines, failuresWaitingOn } =
  await import('../src/failed.js')
const { columnOf } = await import('../src/tasks.js')
const { stateOf } = await import('../src/lists.js')
const { workspaceItems } = await import('../src/notifications.js')

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const id = randomUUID().slice(0, 8)
const ids = {
  organization: `org-failed-${id}`,
  users: [`user-failed-${id}`, `user-failed-b-${id}`],
  members: [`mem-failed-${id}`, `mem-failed-b-${id}`],
}
let scope: { organizationId: string; workspaceId: string }
let teammateId: string
let computerId: string
const db = () => scoped(scope)

before(async () => {
  if (skip) return
  await prisma.organization.create({
    data: { id: ids.organization, name: 'Failed test', slug: ids.organization },
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
    data: { organizationId: ids.organization, name: 'Failed test' },
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

let titles = 0
/** A thread of member 0's, failed unless said otherwise, with its last error when given. */
async function thread(
  options: {
    status?: string
    parentId?: string
    scheduleId?: string
    quiet?: boolean
    archived?: boolean
    member?: number
    updatedAt?: Date
    error?: { message: string; at: Date }
  } = {},
) {
  const t = await prisma.session.create({
    data: {
      ...scope,
      teammateId,
      startedByMemberId: ids.members[options.member ?? 0]!,
      computerId,
      title: `Thread ${++titles}`,
      status: (options.status ?? 'failed') as never,
      origin: options.parentId ? 'child' : options.scheduleId ? 'schedule' : 'member',
      ...(options.parentId ? { parentId: options.parentId, parentTeammateId: teammateId } : {}),
      ...(options.scheduleId ? { scheduleId: options.scheduleId } : {}),
      ...(options.quiet ? { quiet: true } : {}),
      ...(options.archived ? { archivedAt: new Date() } : {}),
    },
  })
  if (options.error)
    await prisma.sessionEvent.create({
      data: {
        ...scope,
        sessionId: t.id,
        seq: 1,
        at: options.error.at,
        type: 'error',
        data: { type: 'error', message: options.error.message },
      },
    } as never)
  if (options.updatedAt)
    await prisma.session.update({ where: { id: t.id }, data: { updatedAt: options.updatedAt } })
  return t
}
const later = (member: number, sessionId: string) =>
  prisma.threadLater.create({ data: { ...scope, memberId: ids.members[member]!, sessionId } })
const schedule = (title: string, extra: { lastError?: string; paused?: boolean } = {}) =>
  prisma.schedule.create({
    data: {
      ...scope,
      teammateId,
      title,
      instructions: 'Do it',
      cron: '0 9 * * *',
      timezone: 'Europe/Paris',
      ownerMemberId: ids.members[0]!,
      ...(extra.lastError ? { lastError: extra.lastError } : {}),
      ...(extra.paused ? { pausedAt: new Date() } : {}),
    },
  })

test(
  'a failed thread waits at once, unless its runner may still try it again',
  { skip },
  async () => {
    const start = new Date()
    const broken = await thread({ error: { message: 'Tool failed: bad input', at: start } })
    const passing = await thread({
      error: { message: 'API Error: 529 overloaded', at: new Date(start.getTime() - 5 * MINUTE) },
    })
    const neverRan = await thread()
    const idle = await thread({ status: 'idle' })
    const now = new Date()
    const waiting = await failedWaitingAmong(
      db(),
      [broken.id, passing.id, neverRan.id, idle.id],
      now,
    )
    assert.deepEqual([...waiting.keys()].sort(), [broken.id, neverRan.id].sort())
    assert.equal(waiting.get(broken.id)?.error, 'Tool failed: bad input')
    // Past the runner's last try (15 minutes after its error, and a minute to start): it waits.
    const pastRetries = new Date(now.getTime() + 12 * MINUTE)
    assert.ok((await failedWaitingAmong(db(), [passing.id], pastRetries)).has(passing.id))
  },
)

test(
  'not a child, an archived thread, a routine’s run nor a quiet run nobody joined',
  { skip },
  async () => {
    const parent = await thread({ status: 'idle' })
    const child = await thread({ parentId: parent.id })
    const archived = await thread({ archived: true })
    const s = await schedule('Digest')
    const run = await thread({ scheduleId: s.id })
    const quiet = await thread({ quiet: true })
    const shown = await thread({ quiet: true })
    await prisma.session.update({ where: { id: shown.id }, data: { surfacedAt: new Date() } })
    const waiting = await failedWaitingAmong(db(), [
      child.id,
      archived.id,
      run.id,
      quiet.id,
      shown.id,
    ])
    assert.deepEqual([...waiting.keys()], [shown.id])
  },
)

test(
  'for a member: those they started, not put away for later, of the last 14 days',
  { skip },
  async () => {
    const mine = await thread()
    const theirs = await thread({ member: 1 })
    const putAway = await thread()
    await later(0, putAway.id)
    // Put away by someone else: still theirs to see.
    await later(1, mine.id)
    const old = await thread({ updatedAt: new Date(Date.now() - 15 * DAY) })
    const pending = await thread({
      error: { message: 'fetch failed', at: new Date(Date.now() - MINUTE) },
    })
    const { threads, next } = await failedThreadsOf(db(), ids.members[0]!)
    const listed = threads.map((t) => t.id)
    assert.ok(listed.includes(mine.id))
    for (const t of [theirs, putAway, old, pending]) assert.equal(listed.includes(t.id), false)
    assert.equal(threads.find((t) => t.id === mine.id)?.teammate.name, 'Riley')
    // The one a retry may still mend waits from then on: the dashboard asks again then.
    assert.ok(next && next.getTime() > Date.now())
    assert.ok((await failuresWaitingOn(db(), ids.members[0]!)).recheckAt)
  },
)

test(
  'a routine waits on its owner: its latest run failed, or it could not start without a ticket',
  { skip },
  async () => {
    const failedRun = await schedule('Failed run')
    const before = await thread({ scheduleId: failedRun.id, status: 'idle' })
    await prisma.session.update({
      where: { id: before.id },
      data: { createdAt: new Date(Date.now() - DAY) },
    })
    const run = await thread({
      scheduleId: failedRun.id,
      error: { message: 'Bad', at: new Date() },
    })
    const mended = await schedule('Mended')
    await thread({ scheduleId: mended.id })
    const latest = await thread({ scheduleId: mended.id, status: 'idle' })
    await prisma.session.update({
      where: { id: latest.id },
      data: { createdAt: new Date(Date.now() + MINUTE) },
    })
    const archivedRun = await schedule('Archived run')
    await thread({ scheduleId: archivedRun.id, archived: true })
    const putAway = await schedule('Put away')
    await later(0, (await thread({ scheduleId: putAway.id })).id)
    const offline = await schedule('Offline', { lastError: 'the computer is offline' })
    const asked = await schedule('Asked', { lastError: 'the workspace has no computer' })
    await db().ticket.create({
      data: {
        type: 'question',
        title: 'Schedule "Asked" could not start a run',
        payload: { scheduleId: asked.id, memberId: ids.members[0] },
      },
    } as never)
    const paused = await schedule('Paused', { lastError: 'offline', paused: true })

    const routines = await failingRoutines(db(), { ownerMemberId: ids.members[0]! })
    const of = (s: { id: string }) => routines.find((r) => r.scheduleId === s.id)
    assert.deepEqual(
      { runId: of(failedRun)?.runId, couldNotStart: of(failedRun)?.couldNotStart },
      { runId: run.id, couldNotStart: false },
    )
    assert.equal(of(failedRun)?.error, 'Bad')
    assert.deepEqual(
      { couldNotStart: of(offline)?.couldNotStart, error: of(offline)?.error },
      { couldNotStart: true, error: 'the computer is offline' },
    )
    for (const s of [mended, archivedRun, putAway, asked, paused]) assert.equal(of(s), undefined)
    assert.equal((await failingRoutines(db(), { ownerMemberId: ids.members[1]! })).length, 0)
  },
)

const session = (status: string, pull = false) => ({
  status,
  _count: { tickets: 0 },
  pullRequests: pull ? [{ state: 'open', mergeStatus: 'none', reviewSession: null }] : [],
})

test('Tasks: a failed thread that waits is Needs you, its pull request with it', () => {
  const task = (s: ReturnType<typeof session>) => ({ completedAt: null, session: s })
  assert.equal(columnOf(task(session('failed')), true), 'needs_you')
  assert.equal(columnOf(task(session('failed', true)), true), 'needs_you')
  // A retry of its own may still come: Doing, its pull request too.
  assert.equal(columnOf(task(session('failed')), false), 'doing')
  assert.equal(columnOf(task(session('failed', true)), false), 'doing')
  assert.equal(columnOf(task(session('idle', true)), false), 'needs_you')
})

test('a list item whose thread failed and waits needs you', () => {
  const row = (status: string, archived = false) => ({
    threads: [
      {
        session: {
          id: 't1',
          archivedAt: archived ? new Date() : null,
          ...session(status, true),
        },
      },
    ],
    pulls: [],
  })
  const failing = new Set(['t1'])
  assert.equal(stateOf(false, row('failed') as never, failing), 'needs_you')
  assert.equal(stateOf(false, row('failed') as never, new Set()), 'open')
  assert.equal(stateOf(false, row('failed', true) as never, failing), 'open')
  assert.equal(stateOf(true, row('failed') as never, failing), 'done')
})

test(
  'pushes: a failed thread is its starter’s, once by its thread; a routine its owner’s',
  { skip },
  async () => {
    const t = await thread({ error: { message: 'Bad request', at: new Date() } })
    // Its pull request waits with it, not on its own.
    await prisma.pullRequest.create({
      data: {
        ...scope,
        sessionId: t.id,
        repository: 'acme/web',
        number: 1,
        title: 'Fix',
        headRef: 'fix',
        baseRef: 'main',
      },
    } as never)
    const pending = await thread({ error: { message: 'socket hang up', at: new Date() } })
    const theirs = await thread({ member: 1 })
    const s = await schedule('Morning digest')
    await thread({ scheduleId: s.id, error: { message: 'Bad', at: new Date() } })
    const members = ids.members.map((m) => ({ id: m, role: 'owner', notify: 'needed' as const }))
    const { items, counted } = await workspaceItems(scope, members, new Date())
    const mine = items.get(ids.members[0]!)!
    const pushed = mine.find((i) => i.key === `needs:${t.id}`)
    assert.equal(pushed?.title, "Riley's thread failed")
    assert.equal(pushed?.body, t.title)
    assert.equal(mine.filter((i) => i.tag === t.id).length, 1)
    assert.equal(
      mine.find((i) => i.key === `routine:${s.id}`)?.title,
      'Routine Morning digest failed',
    )
    assert.ok(counted.get(ids.members[0]!)!.has(`needs:${t.id}`))
    assert.ok(counted.get(ids.members[0]!)!.has(`routine:${s.id}`))
    assert.equal(counted.get(ids.members[0]!)!.has(`needs:${pending.id}`), false)
    // Someone else's failed thread waits on them, not on this member.
    assert.equal(counted.get(ids.members[0]!)!.has(`needs:${theirs.id}`), false)
    assert.ok(counted.get(ids.members[1]!)!.has(`needs:${theirs.id}`))
  },
)
