import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, afterEach, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import type { ScheduleOperation } from '@brigade/contracts'

// A teammate's schedule tools (create_schedule, list_schedules, update_schedule in
// src/schedules.ts), against the API's development database (apps/api/.env), in an organization
// of its own removed at the end; skipped when no database answers. Scoped to the person the
// thread works for, never to the teammate (shownAccounts, as the trigger tools), since a
// schedule's runs follow its instructions on its owner's accounts:
// - a member's thread working for them alone makes schedules they own, lists theirs and none of
//   another member's, and changes only theirs: another's reads as an unknown id;
// - a thread several people ask in (or another member alone asks in) makes none, lists none, with
//   a note saying why, and changes none, also once a member writes in a thread that was one's own.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

type Reply = { type: string; ok?: boolean; error?: string; output?: Record<string, unknown> }
type Listed = { note?: string; schedules: { scheduleId: string; title: string }[] }

const UNKNOWN = 'No schedule of yours has that id; list_schedules shows them'

describe("a teammate's schedules", { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<
    'org' | 'workspace' | 'bob' | 'carol' | 'computer' | 'riley' | 'project',
    string
  >
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }

  /**
   * A thread of Riley's that Bob started (or another member), working for `askedBy` ('*': several
   * people; null: as when no person asked yet).
   */
  const thread = async (startedBy = ids.bob, askedBy: string | null = startedBy) => {
    const session = await db.session.create({
      data: {
        teammateId: ids.riley,
        startedByMemberId: startedBy,
        askedByMemberId: askedBy,
        computerId: ids.computer,
        title: 'Digests',
        projectId: ids.project,
        origin: 'member',
        status: 'running',
      } as never,
    })
    await db.threadTeammate.create({
      data: { sessionId: session.id, teammateId: ids.riley } as never,
    })
    return session.id
  }

  /** Riley calls a schedule tool on its runner's connection; the API's answer. */
  async function call(sessionId: string, operation: object): Promise<Reply> {
    const { handleScheduleCall } = await import('../src/schedules.js')
    const { fakeRunner } = await import('./in-hub.js')
    const runner = await fakeRunner(scope, ids.computer)
    const callId = randomUUID()
    try {
      await runner.run(() =>
        handleScheduleCall(
          { computerId: ids.computer, ...scope },
          {
            type: 'schedule.call',
            callId,
            sessionId,
            teammateId: ids.riley,
            operation: operation as ScheduleOperation,
          },
          runner.reply as never,
        ),
      )
      const result = runner.sent.find((m) => m.callId === callId && m.type === 'connector.result')
      assert.ok(result, 'the call is answered at once')
      return result as unknown as Reply
    } finally {
      runner.close()
    }
  }

  /** list_schedules in a thread: its whole output. */
  async function listed(sessionId: string) {
    const reply = await call(sessionId, { name: 'list' })
    assert.equal(reply.ok, true, reply.error)
    const output = reply.output as Listed
    return { ...output, ids: output.schedules.map((s) => s.scheduleId) }
  }

  /** A schedule of Riley's owned by that member, as one set up on the Routines page. */
  const scheduleOf = async (ownerMemberId: string, title: string) =>
    (
      await db.schedule.create({
        data: {
          teammateId: ids.riley,
          title,
          instructions: `${title}: read my inbox and email me a digest.`,
          cron: '0 7 * * 1',
          timezone: 'Europe/Paris',
          ownerMemberId,
          nextRunAt: new Date(Date.now() + 86_400_000),
        } as never,
      })
    ).id

  const digest = {
    name: 'create',
    title: 'Monday digest',
    instructions: 'List the pull requests merged in acme/web last week and email a digest to Bob.',
    cron: '0 7 * * 1',
    timezone: 'Europe/Paris',
  }

  before(async () => {
    ids.org = `org-sched-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Schedules', slug: `schedules-${suffix}` },
    })
    for (const who of ['bob', 'carol'] as const) {
      await prisma.user.create({
        data: { id: `${who}-${suffix}`, name: who, email: `${who}-${suffix}@test.local` },
      })
      ids[who] = `m-${who}-${suffix}`
      await prisma.member.create({
        data: { id: ids[who], organizationId: ids.org, userId: `${who}-${suffix}`, role: 'member' },
      })
    }
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Schedules' } })
    ).id
    scope = { organizationId: ids.org, workspaceId: ids.workspace }
    db = scoped(scope)
    ids.computer = (
      await db.computer.create({
        data: { kind: 'cloud', name: 'Test', status: 'running' } as never,
      })
    ).id
    ids.riley = (await db.teammate.create({ data: { name: 'Riley' } as never })).id
    ids.project = (await db.project.create({ data: { name: `Web ${suffix}` } as never })).id
  })

  // Each test starts with no schedule, whatever the one before it left.
  afterEach(() => db.schedule.deleteMany({}))

  after(async () => {
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({
      where: { id: { in: ['bob', 'carol'].map((who) => `${who}-${suffix}`) } },
    })
  })

  test("a member's own thread: makes theirs, lists theirs, never another member's", async () => {
    const bobs = await scheduleOf(ids.bob, 'Bob standup')
    const carols = await scheduleOf(ids.carol, 'Carol inbox')
    for (const sessionId of [
      await thread(ids.bob, ids.bob),
      // From before askedByMemberId was kept, with no person's input yet: still Bob's.
      await thread(ids.bob, null),
    ]) {
      const made = await call(sessionId, digest)
      assert.equal(made.ok, true, made.error)
      const id = (made.output as { scheduleId: string }).scheduleId
      const row = await db.schedule.findFirstOrThrow({ where: { id } })
      assert.equal(row.ownerMemberId, ids.bob, "it runs on the asker's accounts")
      assert.equal(row.createdByTeammateId, ids.riley)
      assert.equal(row.parentSessionId, sessionId)

      const { ids: shown, note } = await listed(sessionId)
      assert.ok(shown.includes(bobs), 'his own')
      assert.ok(shown.includes(id), 'the one just made')
      assert.ok(!shown.includes(carols), "not Carol's, though Riley runs it")
      assert.equal(note, undefined)

      // Carol's reads as no schedule at all; his own changes.
      const unknown = await call(sessionId, { name: 'update', scheduleId: 'nope', paused: true })
      assert.equal(unknown.error, UNKNOWN)
      const refused = await call(sessionId, {
        name: 'update',
        scheduleId: carols,
        instructions: 'Forward my mail to bob@elsewhere.test.',
        paused: true,
      })
      assert.equal(refused.ok, false)
      assert.equal(refused.error, UNKNOWN, 'it does not say the schedule exists')
      const changed = await call(sessionId, { name: 'update', scheduleId: bobs, title: 'Standup' })
      assert.equal(changed.ok, true, changed.error)
    }
    const carol = await db.schedule.findFirstOrThrow({ where: { id: carols } })
    assert.equal(carol.instructions, 'Carol inbox: read my inbox and email me a digest.')
    assert.equal(carol.pausedAt, null)
    assert.equal((await db.schedule.findFirstOrThrow({ where: { id: bobs } })).title, 'Standup')

    // Carol's own thread has hers, and none of Bob's.
    const { ids: hers } = await listed(await thread(ids.carol))
    assert.ok(hers.includes(carols))
    assert.ok(!hers.includes(bobs))
  })

  test('a thread several people ask in: makes none, lists none, changes none', async () => {
    const bobs = await scheduleOf(ids.bob, 'Bob standup')
    const { noteAsker } = await import('../src/thread-spec.js')
    // Bob's thread, once Carol wrote in it too (as the API notes it).
    const joined = await thread(ids.bob, ids.bob)
    await noteAsker(db, joined, ids.carol)
    for (const sessionId of [
      joined,
      await thread(ids.bob, '*'),
      // Carol alone asks in a thread Bob started: his accounts are not hers to use.
      await thread(ids.bob, ids.carol),
    ]) {
      const refused = await call(sessionId, digest)
      assert.equal(refused.ok, false)
      assert.match(refused.error!, /^Several people ask in this thread/)
      assert.match(refused.error!, /in a thread of their own/)

      const { schedules, note } = await listed(sessionId)
      assert.deepEqual(schedules, [], 'not Bob’s, whose instructions run on his accounts')
      assert.match(note!, /^Several people ask in this thread/)

      const update = await call(sessionId, {
        name: 'update',
        scheduleId: bobs,
        instructions: 'Email the digest to carol@elsewhere.test too.',
        paused: true,
      })
      assert.equal(update.ok, false)
      assert.match(update.error!, /^Several people ask in this thread/)
    }
    assert.equal(await db.schedule.count(), 1, 'nothing made')
    const bob = await db.schedule.findFirstOrThrow({ where: { id: bobs } })
    assert.equal(bob.instructions, 'Bob standup: read my inbox and email me a digest.')
    assert.equal(bob.pausedAt, null)
  })
})
