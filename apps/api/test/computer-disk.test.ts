import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
// A cloud computer's full disk (src/computer-disk.ts): kept on the computer for operators, never
// a ticket for members, against the API's development database (apps/api/.env), in an
// organization of its own removed at the end; skipped when no database answers:
// - full: the computer keeps how full, since when (kept while it stays full) and what takes room;
// - no longer full: cleared;
// - a ticket an older API opened for it closes, and none opens;
// - a member's machine is never noted;
// - the disk: alert's text says what takes room.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { prisma, scoped } = await import('../src/db.js')
const { noteDisk, diskDetail, fullDisks } = await import('../src/computer-disk.js')
const { diskProblems } = await import('../src/ops/checks.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

test("the alert says how full, since when and what takes room in teammates' homes", () => {
  const detail = diskDetail({
    used: 0.894,
    since: '2026-11-05T11:21:30.000Z',
    at: '2026-11-05T11:41:00.000Z',
    largest: [
      { path: '/home/bt-1/threads', bytes: 12e9 },
      { path: '/home/bt-1/work', bytes: 2.7e9 },
    ],
  })
  assert.match(detail, /89% full since 2026-11-05T11:21Z/)
  assert.match(
    detail,
    /Largest in teammates' homes: \/home\/bt-1\/threads 12\.0 GB, \/home\/bt-1\/work 2\.7 GB\./,
  )
  assert.match(detail, /Members are not asked/)
  // An older runner says nothing of what takes room.
  assert.doesNotMatch(
    diskDetail({ used: 0.81, since: '2026-11-05T11:21:30.000Z', at: '2026-11-05T11:21:30.000Z' }),
    /Largest/,
  )
})

describe('a full disk', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const org = `disk-${suffix}`
  let workspaceId = ''
  let cloud = ''
  let machine = ''
  let runner: { organizationId: string; workspaceId: string; computerId: string }
  const t0 = new Date('2026-11-05T11:00:00Z')
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000)
  const diskOf = async (id: string) =>
    (await prisma.computer.findUniqueOrThrow({ where: { id }, select: { disk: true } })).disk

  before(async () => {
    await prisma.organization.create({ data: { id: org, name: 'Disk', slug: org } })
    workspaceId = (await prisma.workspace.create({ data: { organizationId: org, name: 'Disk' } }))
      .id
    const db = scoped({ organizationId: org, workspaceId })
    cloud = (await db.computer.create({ data: { kind: 'cloud', name: 'Cloud' } } as never)).id
    machine = (await db.computer.create({ data: { kind: 'member_machine', name: 'Mac' } } as never))
      .id
    runner = { organizationId: org, workspaceId, computerId: cloud }
  })
  after(async () => {
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } })
    await prisma.organization.deleteMany({ where: { id: org } })
  })

  test('is kept on the computer while it stays full, and a ticket for members closes', async () => {
    const db = scoped({ organizationId: org, workspaceId })
    // What an older API opened, asking members to delete threads.
    const old = await db.ticket.create({
      data: {
        type: 'disk_full',
        title: "The cloud computer's disk is full",
        payload: { computerId: cloud, used: 0.89 },
      },
    } as never)
    const largest = [{ path: '/home/bt-1/work', bytes: 2.7e9 }]
    await noteDisk(runner, { full: true, used: 0.89, largest }, at(0))
    assert.deepEqual(await diskOf(cloud), {
      used: 0.89,
      since: at(0).toISOString(),
      at: at(0).toISOString(),
      largest,
    })
    const tickets = await db.ticket.findMany({ where: { type: 'disk_full' } })
    assert.deepEqual(
      tickets.map((t) => [t.id, t.status]),
      [[old.id, 'resolved']],
    )

    // Still full ten minutes later: since when stays, the rest is the latest.
    await noteDisk(runner, { full: true, used: 0.92 }, at(10))
    assert.deepEqual(await diskOf(cloud), {
      used: 0.92,
      since: at(0).toISOString(),
      at: at(10).toISOString(),
    })
    // What the operators' check finds: this computer, and not the member's machine.
    const full = (await fullDisks()).filter((c) => [cloud, machine].includes(c.id))
    assert.deepEqual(
      diskProblems(full).map((a) => [a.key, a.severity]),
      [[`disk:${cloud}`, 'warning']],
    )
    assert.equal(await db.ticket.count({ where: { type: 'disk_full', status: 'open' } }), 0)

    await noteDisk(runner, { full: false, used: 0.7 }, at(20))
    assert.equal(await diskOf(cloud), null)
    assert.equal((await fullDisks()).filter((c) => c.id === cloud).length, 0)
    // Full again: a new since.
    await noteDisk(runner, { full: true, used: 0.81 }, at(30))
    assert.equal(((await diskOf(cloud)) as { since: string }).since, at(30).toISOString())
    await noteDisk(runner, { full: false, used: 0.7 }, at(40))
  })

  test("a member's machine is never noted", async () => {
    await noteDisk({ ...runner, computerId: machine }, { full: true, used: 0.95 }, at(0))
    assert.equal(await diskOf(machine), null)
  })

  test('another workspace cannot note it', async () => {
    await noteDisk({ ...runner, workspaceId: 'elsewhere' }, { full: true, used: 0.95 }, at(0))
    assert.equal(await diskOf(cloud), null)
  })
})
