import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'

// The Board (src/board.ts, docs/board.md): its cards, routines and stopped threads, computed
// from a workspace's lists, threads and schedules. The rules first, then against the API's
// development database (apps/api/.env), in an organization of its own removed at the end;
// skipped when no database answers.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL || undefined
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

const { prisma, scoped } = await import('../src/db.js')
const { board, dayIn, healthOf, outcomeOf } = await import('../src/board.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1 from "Session" limit 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

const DAY = 24 * 60 * 60_000

test("a run's outcome: its report when it reports to a thread, else its status", () => {
  assert.equal(outcomeOf({ status: 'running', report: null }), 'running')
  assert.equal(
    outcomeOf({
      status: 'idle',
      report: { status: 'nothing', summary: 'Nothing new', at: new Date().toISOString() },
    }),
    'nothing',
  )
  assert.equal(outcomeOf({ status: 'failed', report: null }), 'failed')
  assert.equal(outcomeOf({ status: 'idle', report: null }), 'ended')
})

test("a routine's health: paused, failed when its last run failed or it couldn't start, degraded after a failure this week", () => {
  const live = { pausedAt: null, lastError: null }
  assert.equal(healthOf({ pausedAt: new Date(), lastError: null }, ['failed'], true), 'paused')
  assert.equal(healthOf({ pausedAt: null, lastError: 'Its computer is off' }, [], true), 'failed')
  assert.equal(
    healthOf(live, ['running', 'failed', 'report'], true),
    'failed',
    'the last finished run',
  )
  assert.equal(healthOf(live, ['report', 'failed', 'nothing'], true), 'degraded')
  assert.equal(healthOf(live, ['nothing', 'report'], true), 'ok')
  assert.equal(healthOf(live, [], false), 'new')
  assert.equal(healthOf(live, [], true), 'ok', 'no run this week, but it ran before')
})

test("today is the routine's own day, in its time zone", () => {
  const at = new Date('2026-11-01T23:30:00Z')
  assert.equal(dayIn('Europe/Paris', at), '2026-11-02')
  assert.equal(dayIn('America/New_York', at), '2026-11-01')
  assert.equal(dayIn('Not/AZone', at), '2026-11-01')
})

describe('the Board', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<
    'org' | 'user' | 'member' | 'workspace' | 'computer' | 'riley' | 'file',
    string
  >
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string; memberId: string; role: 'owner' }
  const now = new Date()

  /** A top-level thread of Riley's, as Ada started it, last changed `ago` ms before now. */
  async function thread(title: string, data: Record<string, unknown> = {}, ago = 60_000) {
    const row = await db.session.create({
      data: {
        teammateId: ids.riley,
        startedByMemberId: ids.member,
        computerId: ids.computer,
        title,
        status: 'idle',
        ...data,
      },
    } as never)
    await prisma.$executeRaw`update "Session" set "updatedAt" = ${new Date(now.getTime() - ago)} where id = ${row.id}`
    return row.id as string
  }

  before(async () => {
    const library = await import('../src/library.js')
    ids.org = `org-board-${suffix}`
    ids.user = `user-board-${suffix}`
    ids.member = `m-board-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Board', slug: `board-${suffix}` },
    })
    await prisma.user.create({
      data: { id: ids.user, name: 'Ada', email: `${ids.user}@test.local` },
    })
    await prisma.member.create({
      data: { id: ids.member, organizationId: ids.org, userId: ids.user, role: 'owner' },
    })
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Board' } })
    ).id
    const base = { organizationId: ids.org, workspaceId: ids.workspace }
    scope = { ...base, memberId: ids.member, role: 'owner' }
    db = scoped(base)
    ids.computer = (
      await db.computer.create({
        data: { kind: 'member_machine', memberId: ids.member, name: 'Laptop', status: 'running' },
      } as never)
    ).id
    ids.riley = (await db.teammate.create({ data: { name: `Riley ${suffix}` } } as never)).id
    ids.file = (
      await library.saveLibraryFile(
        db,
        base,
        { type: 'member', id: ids.member },
        {
          path: 'Projects/Acme/launch.md',
          bytes: new TextEncoder().encode(
            [
              '# Launch',
              '',
              '## Tech',
              '',
              '* [ ] Ship the **board** <!-- item:aaaaaaaaaaaaaaaa -->',
              '* [x] Write the docs <!-- item:bbbbbbbbbbbbbbbb -->',
              '* [ ] Light load test',
              '',
            ].join('\n'),
          ),
        },
      )
    ).id
  })

  after(async () => {
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.libraryObject.deleteMany({ where: { organizationId: ids.org } })
    await prisma.libraryObjectFolder.deleteMany({ where: { organizationId: ids.org } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({ where: { id: ids.user } })
  })

  test('each thread on no list lands where it stands', async () => {
    const asking = await thread('Connect Slack')
    await db.ticket.create({
      data: { sessionId: asking, type: 'question', title: 'Which workspace?' },
    } as never)
    const working = await thread('Neon metrics', { status: 'running' })
    const waking = await thread('Check the deploy')
    await db.wakeup.create({
      data: {
        sessionId: waking,
        teammateId: ids.riley,
        note: 'Check it',
        wakeAt: new Date(now.getTime() + DAY),
      },
    } as never)
    const done = await thread('Wake up button', {
      doneAt: new Date(now.getTime() - DAY),
      doneSummary: 'The panel shows Wake up instead of the error.',
      doneByType: 'teammate',
      doneById: ids.riley,
    })
    const doneLongAgo = await thread(
      'Old work',
      { doneAt: new Date(now.getTime() - 9 * DAY) },
      9 * DAY,
    )
    const stopped = await thread('UI inspiration', {}, 2 * DAY)
    const closed = await thread('Teammate context', {}, 10 * DAY)
    const archived = await thread('Archived', { archivedAt: new Date() })

    const b = await board(db, scope, now)
    const card = (id: string) => b.cards.find((c) => c.key === `thread:${id}`)
    assert.equal(card(asking)?.column, 'needs_you')
    assert.equal(card(asking)?.reason, 'ticket')
    assert.equal(card(working)?.column, 'in_progress')
    assert.equal(card(working)?.reason, 'working')
    assert.equal(card(waking)?.column, 'in_progress')
    assert.equal(card(waking)?.reason, 'wakeup')
    assert.equal(card(done)?.column, 'done')
    assert.equal(card(done)?.note, 'The panel shows Wake up instead of the error.')
    assert.equal(card(done)?.done?.by, `Riley ${suffix}`)
    assert.equal(card(doneLongAgo), undefined, 'done before this week: off the Board')
    assert.equal(card(stopped), undefined)
    assert.deepEqual(
      b.stopped.filter((s) => s.key === `thread:${stopped}`).map((s) => [s.canClose, s.list]),
      [[true, null]],
    )
    assert.ok(
      b.closed.some((c) => c.id === closed),
      'quiet for 7 days: closed with no activity',
    )
    assert.ok(!b.stopped.some((s) => s.threadId === closed))
    assert.equal(card(archived), undefined)
    assert.ok(!b.stopped.some((s) => s.threadId === archived))
  })

  test("a list's line is the card, never its thread; a routine's runs are never cards", async () => {
    const onLine = await thread('Ship the board', { status: 'running' })
    await db.listItem.create({
      data: { id: 'aaaaaaaaaaaaaaaa', documentId: ids.file, text: 'Ship the **board**' },
    } as never)
    await db.listItemThread.create({
      data: { itemId: 'aaaaaaaaaaaaaaaa', sessionId: onLine },
    } as never)
    const ticked = await thread('Docs', { status: 'idle' })
    await db.listItem.create({
      data: {
        id: 'bbbbbbbbbbbbbbbb',
        documentId: ids.file,
        text: 'Write the docs',
        doneAt: new Date(now.getTime() - DAY),
        doneByType: 'teammate',
        doneById: ids.riley,
      },
    } as never)
    await db.listItemThread.create({
      data: { itemId: 'bbbbbbbbbbbbbbbb', sessionId: ticked },
    } as never)
    const schedule = await db.schedule.create({
      data: {
        teammateId: ids.riley,
        ownerMemberId: ids.member,
        title: 'Builder',
        instructions: 'Take the first line',
        cron: '0 */3 * * *',
        timezone: 'Europe/Paris',
      },
    } as never)
    const run = await thread('Scheduled run of Builder', {
      scheduleId: schedule.id,
      origin: 'schedule',
      status: 'running',
    })

    const b = await board(db, scope, now)
    const line = b.cards.find((c) => c.key === 'item:aaaaaaaaaaaaaaaa')
    assert.equal(line?.column, 'in_progress')
    assert.equal(line?.title, 'Ship the board', 'plain text')
    assert.deepEqual(line?.list, { documentId: ids.file, title: 'Launch', section: 'Tech' })
    assert.equal(line?.href, `/app/threads/${onLine}`)
    assert.equal(
      b.cards.find((c) => c.key === `thread:${onLine}`),
      undefined,
    )
    const docs = b.cards.find((c) => c.key === 'item:bbbbbbbbbbbbbbbb')
    assert.equal(docs?.column, 'done')
    assert.equal(docs?.done?.by, `Riley ${suffix}`)
    assert.equal(
      b.cards.find((c) => c.key === `thread:${run}`),
      undefined,
      'a run is no card',
    )
    assert.ok(b.lists.some((l) => l.documentId === ids.file))
    const routine = b.routines.find((r) => r.id === schedule.id)
    assert.equal(routine?.running?.id, run)
  })

  test("a routine's row: today's runs, those that found nothing counted, and its health", async () => {
    const schedule = await db.schedule.create({
      data: {
        teammateId: ids.riley,
        ownerMemberId: ids.member,
        title: 'Triage',
        instructions: 'Read the sources',
        cron: '0 7 * * *',
        timezone: 'UTC',
      },
    } as never)
    const report = (status: string) => ({
      status,
      summary: `${status} summary`,
      at: now.toISOString(),
    })
    for (const status of ['nothing', 'nothing', 'report'])
      await thread(`Run ${status}`, {
        scheduleId: schedule.id,
        origin: 'schedule',
        report: report(status),
      })
    let r = (await board(db, scope, now)).routines.find((x) => x.id === schedule.id)!
    assert.equal(r.health, 'ok')
    assert.deepEqual([r.week.runs, r.week.failed, r.today.runs, r.today.nothing], [3, 0, 3, 2])

    await thread('Run that failed', {
      scheduleId: schedule.id,
      origin: 'schedule',
      status: 'failed',
    })
    const b = await board(db, scope, new Date(now.getTime() + 1000))
    r = b.routines.find((x) => x.id === schedule.id)!
    assert.equal(r.health, 'failed')
    assert.equal(r.last?.outcome, 'failed')
    const card = b.cards.find((c) => c.key === `routine:${schedule.id}`)
    assert.equal(card?.column, 'needs_you', 'a failing routine waits on a person, as one card')
    assert.equal(card?.reason, 'routine_failed')
  })

  test('routine runs, however many, never push out a thread that waits on a person', async () => {
    const waiting = await thread('Waiting on a person', { status: 'waiting' }, 3 * DAY)
    const schedule = await db.schedule.create({
      data: {
        teammateId: ids.riley,
        ownerMemberId: ids.member,
        title: 'Hourly',
        instructions: 'Read',
        cron: '0 * * * *',
        timezone: 'UTC',
      },
    } as never)
    await db.session.createMany({
      data: Array.from({ length: 520 }, (_, i) => ({
        teammateId: ids.riley,
        startedByMemberId: ids.member,
        computerId: ids.computer,
        title: `Run ${i}`,
        origin: 'schedule',
        scheduleId: schedule.id,
        status: 'idle',
      })),
    } as never)
    const b = await board(db, scope, now)
    assert.equal(b.cards.find((c) => c.key === `thread:${waiting}`)?.column, 'needs_you')
  })

  test('a thread whose line left its list, or whose list was deleted, is a card of its own', async () => {
    const gone = await thread('Line removed', { status: 'running' })
    // A row for a line no longer in the file: its marker was removed.
    await db.listItem.create({
      data: { id: 'cccccccccccccccc', documentId: ids.file, text: 'Removed line' },
    } as never)
    await db.listItemThread.create({
      data: { itemId: 'cccccccccccccccc', sessionId: gone },
    } as never)
    const deleted = await thread('List deleted', { status: 'running' })
    const other = await db.document.create({
      data: {
        path: 'Projects/Acme/old.md',
        contentType: 'text/markdown',
        size: 1,
        text: '# Old\n\n* [ ] Ship <!-- item:dddddddddddddddd -->\n',
        deletedAt: new Date(),
      },
    } as never)
    await db.listItem.create({
      data: { id: 'dddddddddddddddd', documentId: other.id, text: 'Ship' },
    } as never)
    await db.listItemThread.create({
      data: { itemId: 'dddddddddddddddd', sessionId: deleted },
    } as never)
    const b = await board(db, scope, now)
    assert.equal(b.cards.find((c) => c.key === `thread:${gone}`)?.column, 'in_progress')
    assert.equal(b.cards.find((c) => c.key === `thread:${deleted}`)?.column, 'in_progress')
  })

  test('a line whose thread stopped shows as stopped, until that thread is marked done', async () => {
    const library = await import('../src/library.js')
    const file = await library.saveLibraryFile(
      db,
      { organizationId: ids.org, workspaceId: ids.workspace },
      { type: 'member', id: ids.member },
      {
        path: 'Projects/Acme/stopped.md',
        bytes: new TextEncoder().encode(
          '# Stopped\n\n* [ ] Load test <!-- item:eeeeeeeeeeeeeeee -->\n',
        ),
      },
    )
    const idle = await thread('Load test', {}, DAY)
    await db.listItem.create({
      data: { id: 'eeeeeeeeeeeeeeee', documentId: file.id, text: 'Load test' },
    } as never)
    await db.listItemThread.create({
      data: { itemId: 'eeeeeeeeeeeeeeee', sessionId: idle },
    } as never)
    let b = await board(db, scope, now)
    assert.equal(b.stopped.find((s) => s.key === 'item:eeeeeeeeeeeeeeee')?.threadId, idle)
    assert.equal(
      b.cards.find((c) => c.key === `thread:${idle}`),
      undefined,
      'its line shows it',
    )
    await db.session.updateMany({
      where: { id: idle },
      data: { doneAt: new Date(), doneByType: 'member', doneById: ids.member },
    })
    b = await board(db, scope, now)
    assert.equal(
      b.stopped.find((s) => s.key === 'item:eeeeeeeeeeeeeeee'),
      undefined,
    )
  })
})
