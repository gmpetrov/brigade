import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import pg from 'pg'

// The background jobs (src/jobs.ts, docs/workspace-hubs-plan.md Phase 3): each says which
// workspaces have work due, and runs for one workspace alone; what the cron puts on the queue
// each minute. Against the local database of apps/api/.env, in an organization of its own that it
// removes at the end; skipped without a database.
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
    await client.query('select 1 from "Wakeup" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { JOBS, dueMessages, runJob } = await import('../src/jobs.js')
const { failuresOf } = await import('../src/ops/failures.js')

test('a job no one knows is dropped; one that throws is counted, and throws for its retry', async () => {
  await runJob({ job: 'no-such-job', key: null })
  const before = failuresOf('job:inbound-event', 60_000).length
  const jobs = JOBS as Record<string, { run: (key: string | null, now: Date) => Promise<unknown> }>
  const real = jobs['inbound-event']!.run
  jobs['inbound-event']!.run = async () => {
    throw new Error('the database went away')
  }
  try {
    await assert.rejects(runJob({ job: 'inbound-event', key: 'e1' }), /database went away/)
  } finally {
    jobs['inbound-event']!.run = real
  }
  assert.equal(failuresOf('job:inbound-event', 60_000).length, before + 1)
})

describe('due work, by workspace', { skip }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<
    'org' | 'busy' | 'quiet' | 'teammate' | 'computer' | 'session' | 'member',
    string
  >
  let prisma: (typeof import('../src/db.js'))['prisma']

  before(async () => {
    ;({ prisma } = await import('../src/db.js'))
    ids.org = `org-jobs-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Jobs', slug: `jobs-${suffix}` },
    })
    await prisma.user.create({
      data: { id: `user-jobs-${suffix}`, name: 'Ada', email: `jobs-${suffix}@test.local` },
    })
    ids.member = (
      await prisma.member.create({
        data: {
          id: `member-jobs-${suffix}`,
          organizationId: ids.org,
          userId: `user-jobs-${suffix}`,
          role: 'owner',
        },
      })
    ).id
    for (const key of ['busy', 'quiet'] as const)
      ids[key] = (
        await prisma.workspace.create({ data: { organizationId: ids.org, name: key } })
      ).id
    const scope = { organizationId: ids.org, workspaceId: ids.busy }
    ids.teammate = (await prisma.teammate.create({ data: { ...scope, name: 'Sam' } as never })).id
    ids.computer = (
      await prisma.computer.create({
        data: { ...scope, kind: 'cloud', name: 'Cloud', status: 'stopped' } as never,
      })
    ).id
    ids.session = (
      await prisma.session.create({
        data: {
          ...scope,
          teammateId: ids.teammate,
          startedByMemberId: ids.member,
          computerId: ids.computer,
          title: 'Waiting',
          status: 'idle',
        } as never,
      })
    ).id
  })

  after(async () => {
    await prisma.workspace.deleteMany({ where: { organizationId: ids.org } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({ where: { id: `user-jobs-${suffix}` } })
  })

  test('every job reads what is due without failing', async () => {
    for (const [name, job] of Object.entries(JOBS) as [
      string,
      { due?: (now: Date) => Promise<string[]> },
    ][])
      if (job.due) assert.ok(Array.isArray(await job.due(new Date())), name)
  })

  test("a workspace's wake-up due puts its workspace's message on the queue, not others'", async () => {
    await prisma.wakeup.create({
      data: {
        organizationId: ids.org,
        workspaceId: ids.busy,
        sessionId: ids.session,
        teammateId: ids.teammate,
        note: 'Check the deploy',
        wakeAt: new Date(Date.now() - 1000),
      },
    })
    const now = new Date()
    const messages = await dueMessages(now)
    const wakeups = messages.filter((m) => m.body.job === 'wakeups').map((m) => m.body.key)
    assert.ok(wakeups.includes(ids.busy))
    assert.ok(!wakeups.includes(ids.quiet))
    // One each, whatever else is due there.
    assert.equal(wakeups.filter((k) => k === ids.busy).length, 1)
    // A job that is no workspace's goes once; one more often than each minute, twice.
    assert.equal(messages.filter((m) => m.body.job === 'inbound').length, 1)
    const notifications = messages.filter((m) => m.body.job === 'notifications')
    assert.deepEqual(
      notifications.map((m) => m.delaySeconds ?? 0),
      [0, 30],
    )
    // Hourly sweeps: on the hour only.
    const onTheHour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000)
    const atTen = new Date(onTheHour.getTime() + 10 * 60_000)
    assert.ok((await dueMessages(onTheHour)).some((m) => m.body.job === 'trash-sweep'))
    assert.ok(!(await dueMessages(atTen)).some((m) => m.body.job === 'trash-sweep'))
    assert.ok((await dueMessages(atTen)).some((m) => m.body.job === 'github-redeliver'))
  })

  test("a workspace's run does its own work only", async () => {
    const other = await prisma.session.create({
      data: {
        organizationId: ids.org,
        workspaceId: ids.quiet,
        teammateId: ids.teammate,
        startedByMemberId: ids.member,
        computerId: ids.computer,
        title: 'Elsewhere',
        status: 'idle',
      } as never,
    })
    const elsewhere = await prisma.wakeup.create({
      data: {
        organizationId: ids.org,
        workspaceId: ids.quiet,
        sessionId: other.id,
        teammateId: ids.teammate,
        note: 'Not yours',
        wakeAt: new Date(Date.now() - 1000),
      },
    })
    await runJob({ job: 'wakeups', key: ids.busy })
    const mine = await prisma.wakeup.findMany({ where: { workspaceId: ids.busy } })
    assert.ok(
      mine.every((w) => w.status !== 'pending'),
      "the workspace's wake-ups went",
    )
    const theirs = await prisma.wakeup.findUniqueOrThrow({ where: { id: elsewhere.id } })
    assert.equal(theirs.status, 'pending', "another workspace's waits for its own run")
  })
})
