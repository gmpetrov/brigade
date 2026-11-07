import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// A cloud computer marked running whose runner stays away is restarted (src/cloud.ts's
// recoverAway). On Nov 6–7, boat resumed the workspace computer into a VM whose agent never
// answered: every command refused, no runner, five hours marked running. boat's API is faked; the
// database is the local one of apps/api/.env, in an organization of its own removed at the end.
// Without a database to reach, it is skipped.
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
process.env.BOAT_API_KEY = 'test'

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select "id" from "Computer" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

// boat, faked: a VM up whose agent refuses every command, as on Nov 7.
const { BoatApi } = createRequire(
  new URL('../../../packages/providers/package.json', import.meta.url),
)('@boatdev/sdk') as typeof import('@boatdev/sdk')
const boat = {
  stops: [] as string[],
  resumes: [] as string[],
  commands: [] as string[],
  /** By sandbox: its state; ready unless said. */
  states: new Map<string, string>(),
}
Object.assign(BoatApi.prototype, {
  get: async ({ sandboxId }: { sandboxId: string }) => ({
    sandbox: { id: sandboxId, state: boat.states.get(sandboxId) ?? 'ready' },
  }),
  update: async () => ({}),
  stop: async ({ sandboxId }: { sandboxId: string }) => {
    boat.stops.push(sandboxId)
    boat.states.set(sandboxId, 'archived')
    return {}
  },
  resume: async ({ sandboxId }: { sandboxId: string }) => {
    boat.resumes.push(sandboxId)
    boat.states.delete(sandboxId)
    return {}
  },
  command: async ({ sandboxId }: { sandboxId: string }) => {
    boat.commands.push(sandboxId)
    throw new Error('the sandbox agent is not reachable')
  },
})

const { prisma } = await import('../src/db.js')
const cloud = await import('../src/cloud.js')
const { RECOVER_AFTER_MS, RECOVER_LIMIT, awayFor } = await import('../src/runner-away.js')
const { computerProblem } = await import('../src/ops/checks.js')
const { localHub } = await import('../src/hub/memory-host.js')
const { inWorkspaceHub, fakeRunner } = await import('./in-hub.js')

const id = randomUUID().slice(0, 8)
const organizationId = `org-cloud-recover-${id}`
let workspaceId = ''

before(async () => {
  if (skip) return
  await prisma.organization.create({
    data: { id: organizationId, name: organizationId, slug: organizationId },
  })
  workspaceId = (await prisma.workspace.create({ data: { organizationId, name: 'recover' } })).id
})

after(async () => {
  if (skip) return
  await prisma.organization.deleteMany({ where: { id: organizationId } })
  await prisma.$disconnect()
})

const MIN = 60_000

/** The workspace's cloud computer, marked running `minutesAgo`, with no runner connected. */
async function runningComputer(minutesAgo: number) {
  const computer = await prisma.computer.create({
    data: {
      organizationId,
      workspaceId,
      kind: 'cloud',
      name: 'Cloud computer',
      status: 'running',
      providerRef: { provider: 'boat', id: `sb-${randomUUID().slice(0, 8)}` },
    },
  })
  await prisma.runner.create({
    data: { organizationId, workspaceId, computerId: computer.id, tokenHash: randomUUID() },
  })
  return marked(computer.id, minutesAgo)
}

/** Its row as it is, its status last changed `minutesAgo`. */
async function marked(computerId: string, minutesAgo: number) {
  const at = new Date(Date.now() - minutesAgo * MIN)
  await prisma.$executeRaw`UPDATE "Computer" SET "updatedAt" = ${at} WHERE "id" = ${computerId}`
  return prisma.computer.findUniqueOrThrow({ where: { id: computerId } })
}

const sandboxOf = (computer: { providerRef: unknown }) =>
  (computer.providerRef as { id: string }).id

/** Wait for a computer to reach a status: its start runs in the background. */
async function until(computerId: string, status: string) {
  const statusOf = async () =>
    (await prisma.computer.findUniqueOrThrow({ where: { id: computerId } })).status
  for (let i = 0; i < 200 && (await statusOf()) !== status; i++)
    await new Promise((resolve) => setTimeout(resolve, 20))
  return statusOf()
}

const inHub = <T>(fn: () => T) => inWorkspaceHub(workspaceId, fn)

test('how long a runner is away counts from its status change too', () => {
  const now = Date.now()
  assert.equal(awayFor(null, { updatedAt: new Date(now - 60 * MIN) }, now), 0)
  // Away for an hour, but its computer was restarted 5 minutes ago: 5 minutes.
  assert.equal(
    awayFor({ since: now - 60 * MIN }, { updatedAt: new Date(now - 5 * MIN) }, now),
    5 * MIN,
  )
  assert.equal(
    awayFor({ since: now - 20 * MIN }, { updatedAt: new Date(now - 60 * MIN) }, now),
    20 * MIN,
  )
})

test(
  'the idle check restarts a running computer whose runner stays away, up to its limit',
  { skip },
  async () => {
    const computer = await runningComputer(30)
    const sandbox = sandboxOf(computer)
    const hub = localHub(workspaceId)
    // Away since 16 minutes, as its hub noted it: past RECOVER_AFTER_MS.
    hub.runnerAway(computer.id, Date.now() - RECOVER_AFTER_MS - MIN)

    await inHub(() => cloud.checkIdle(computer))
    // Its service was started for it first: boat refused, as on Nov 7.
    assert.ok(boat.commands.includes(sandbox))
    // Then stopped and started again, and marked running once boat has it up.
    assert.deepEqual(boat.stops, [sandbox])
    assert.equal(await until(computer.id, 'running'), 'running')
    assert.deepEqual(boat.resumes, [sandbox])
    assert.equal(hub.runnerAway(computer.id)?.restarts, 1)
    const actions = await prisma.auditEntry.findMany({
      where: { targetId: computer.id },
      orderBy: { at: 'asc' },
      select: { action: true },
    })
    assert.deepEqual(
      actions.map((a) => a.action),
      ['computer.stopped', 'computer.started'],
    )

    // Just restarted: not again before RECOVER_AFTER_MS from then, though away for longer.
    const now = Date.now()
    let row = await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } })
    assert.equal(await inHub(() => cloud.recoverAway(row, now + RECOVER_AFTER_MS - MIN)), false)
    assert.equal(boat.stops.length, 1)

    // Still away after each: restarted RECOVER_LIMIT times in all, then left to operators.
    for (let i = 2; i <= RECOVER_LIMIT; i++) {
      row = await marked(computer.id, 16)
      assert.equal(await inHub(() => cloud.recoverAway(row)), true)
      assert.equal(await until(computer.id, 'running'), 'running')
    }
    assert.equal(boat.stops.length, RECOVER_LIMIT)
    row = await marked(computer.id, 60)
    assert.equal(await inHub(() => cloud.recoverAway(row)), false)
    assert.equal(boat.stops.length, RECOVER_LIMIT)
    // Its alert says so.
    const alert = computerProblem(
      { ...row, workspace: { name: 'recover' } },
      false,
      awayFor(hub.runnerAway(computer.id), row),
      Date.now(),
      hub.runnerAway(computer.id)!.restarts,
    )
    assert.equal(alert?.severity, 'warning')
    assert.match(alert?.detail ?? '', /restarted it 3 times for it, and no longer does/)

    // Its runner connects: nothing is away any more, and nothing is restarted.
    const runner = await fakeRunner({ organizationId, workspaceId }, computer.id)
    assert.equal(hub.runnerAway(computer.id), null)
    assert.equal(await inHub(() => cloud.recoverAway(row)), false)
    runner.close()
  },
)

test('a runner away for less than RECOVER_AFTER_MS is left alone', { skip }, async () => {
  const computer = await runningComputer(60)
  const before = boat.stops.length
  const hub = localHub(workspaceId)
  // First seen away now: its runner's service is started, and it waits.
  const now = Date.now()
  assert.equal(await inHub(() => cloud.recoverAway(computer, now)), false)
  assert.equal(await inHub(() => cloud.recoverAway(computer, now + RECOVER_AFTER_MS - MIN)), false)
  assert.equal(boat.stops.length, before)
  // Past it: restarted.
  assert.equal(await inHub(() => cloud.recoverAway(computer, now + RECOVER_AFTER_MS)), true)
  assert.equal(boat.stops.length, before + 1)
  assert.equal(await until(computer.id, 'running'), 'running')
  // Stopped on purpose (its idle stop, a member): not awaited any more.
  const row = await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } })
  await inHub(() => cloud.stopComputer(row, { type: 'system', id: 'brigade' }))
  assert.equal(hub.runnerAway(computer.id)?.restarts, 0)
})
