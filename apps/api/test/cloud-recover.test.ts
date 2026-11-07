import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { after, before, beforeEach, test } from 'node:test'
import pg from 'pg'

// A cloud computer marked running whose runner stays away, on a machine boat no longer saves, is
// recovered (src/cloud.ts's recoverAway, src/runner-away.ts's recoveryStep). On Nov 6–7, the
// workspace computer's disk restore failed two minutes after a resume: boat saved nothing more,
// refused every stop without force, and kept it running, unreachable, for six hours. boat's API is
// faked, answering as a throwaway sandbox did on Nov 7; the database is the local one of
// apps/api/.env, in an organization of its own removed at the end. Without a database to reach,
// the tests that need one are skipped.
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

// boat, faked: a machine whose agent refuses every command, as on Nov 7, and that boat saved last
// at `saved` (by sandbox; long ago unless said).
const { BoatApi } = createRequire(
  new URL('../../../packages/providers/package.json', import.meta.url),
)('@boatdev/sdk') as typeof import('@boatdev/sdk')
const MIN = 60_000
const boat = {
  stops: [] as { sandbox: string; force: boolean }[],
  resumes: [] as string[],
  commands: [] as string[],
  recovers: [] as string[],
  /** By sandbox: its state; ready unless said. */
  states: new Map<string, string>(),
  /** By sandbox: its last check (verified) and its last completed snapshot. */
  saved: new Map<string, { verified: Date | null; snapshot: Date | null }>(),
  /** What a recover answers: accepted, or a 409's code (as boat's baremetal machines do). */
  recoverAnswer: 'recover_unsupported' as string,
  /** Holds each recover's answer until it resolves. */
  answering: null as Promise<void> | null,
}
const longAgo = () => new Date(Date.now() - 2 * 60 * MIN)
const conflict = (code: string) =>
  Object.assign(new Error('Response returned an error code'), {
    response: new Response(JSON.stringify({ ok: false, status: 409, code, error: { code } }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    }),
  })
Object.assign(BoatApi.prototype, {
  get: async ({ sandboxId }: { sandboxId: string }) => {
    const saved = boat.saved.get(sandboxId) ?? { verified: longAgo(), snapshot: longAgo() }
    return {
      sandbox: {
        id: sandboxId,
        state: boat.states.get(sandboxId) ?? 'ready',
        health: 'ok',
        snapshotCompletedAt: saved.snapshot,
        snapshotVerifiedAt: saved.verified,
      },
    }
  },
  update: async () => ({}),
  stop: async ({
    sandboxId,
    stopRequest,
  }: {
    sandboxId: string
    stopRequest?: { force?: boolean }
  }) => {
    boat.stops.push({ sandbox: sandboxId, force: stopRequest?.force === true })
    boat.states.set(sandboxId, 'archived')
    return {}
  },
  resume: async ({ sandboxId }: { sandboxId: string }) => {
    boat.resumes.push(sandboxId)
    boat.states.delete(sandboxId)
    return {}
  },
  recover: async ({ sandboxId }: { sandboxId: string }) => {
    boat.recovers.push(sandboxId)
    await boat.answering
    if (boat.recoverAnswer !== 'accept') throw conflict(boat.recoverAnswer)
    return { ok: true, status: 'recovering' }
  },
  command: async ({ sandboxId }: { sandboxId: string }) => {
    boat.commands.push(sandboxId)
    throw new Error('the sandbox agent is not reachable')
  },
})

const { prisma } = await import('../src/db.js')
const cloud = await import('../src/cloud.js')
const {
  RECOVER_AFTER_MS,
  RECOVER_AGAIN_MS,
  RECOVER_LIMIT,
  RECOVER_WAIT_MS,
  UNSAVED_MS,
  awayFor,
  recoveryStep,
} = await import('../src/runner-away.js')
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

// What boat answers is set by each test that needs another: never carried from one to the next.
beforeEach(() => {
  boat.recoverAnswer = 'recover_unsupported'
  boat.answering = null
})

after(async () => {
  if (skip) return
  await prisma.organization.deleteMany({ where: { id: organizationId } })
  await prisma.$disconnect()
})

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

/** boat saved the computer's disk last `minutesAgo` (a check and a snapshot then), or never. */
function savedAgo(computer: { providerRef: unknown }, minutesAgo: number | null) {
  const at = minutesAgo === null ? null : new Date(Date.now() - minutesAgo * MIN)
  boat.saved.set(sandboxOf(computer), { verified: at, snapshot: at })
}

const stopsOf = (computer: { providerRef: unknown }) =>
  boat.stops.filter((s) => s.sandbox === sandboxOf(computer))

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

test('what Brigade does for a runner away, from what boat last saved', () => {
  const now = Date.now()
  const away = { since: now - 60 * MIN, restarts: 0 }
  const lost = {
    awayMs: RECOVER_AFTER_MS,
    savedAt: now - UNSAVED_MS,
    snapshotAt: now - UNSAVED_MS,
    diskFull: false,
    now,
  }
  // Nov 6, 23:23: its runner away 20 minutes, nothing saved since 23:01: boat is asked first.
  assert.equal(recoveryStep(away, lost), 'recover')
  // Away for less, or boat still saving it (its machine answers): nothing.
  assert.equal(recoveryStep(away, { ...lost, awayMs: RECOVER_AFTER_MS - 1 }), 'none')
  assert.equal(recoveryStep(away, { ...lost, savedAt: now - UNSAVED_MS + MIN }), 'none')
  // boat cannot power-cycle it (its baremetal machines), or could not: stopped with its last
  // snapshot and started again.
  const impossible = { ...away, recover: 'impossible' as const, recoverAskedAt: now }
  assert.equal(recoveryStep(impossible, lost), 'replace')
  // boat power-cycles it: its runner is waited for, then the same.
  const recovering = { ...away, recover: 'recovering' as const, recoverAskedAt: now }
  assert.equal(recoveryStep(recovering, lost), 'none')
  assert.equal(recoveryStep(recovering, { ...lost, now: now + RECOVER_WAIT_MS }), 'replace')
  // boat reaches it though it does not save it (a full disk?): left as it is, asked again later.
  const reachable = { ...away, recover: 'reachable' as const, recoverAskedAt: now }
  assert.equal(recoveryStep(reachable, lost), 'none')
  assert.equal(recoveryStep(reachable, { ...lost, now: now + RECOVER_AGAIN_MS }), 'recover')
  // Never stopped so without a snapshot to keep, nor on a full disk.
  assert.equal(recoveryStep(impossible, { ...lost, snapshotAt: null }), 'none')
  assert.equal(recoveryStep(impossible, { ...lost, savedAt: null, snapshotAt: null }), 'none')
  assert.equal(recoveryStep(impossible, { ...lost, diskFull: true }), 'none')
  // At most RECOVER_LIMIT times in a row, then left to operators.
  assert.equal(recoveryStep({ ...impossible, restarts: RECOVER_LIMIT }, lost), 'give-up')
  assert.equal(recoveryStep({ ...impossible, restarts: 1, gaveUp: true }, lost), 'none')
})

test(
  'a machine boat no longer saves is stopped with its last snapshot and started again',
  { skip },
  async () => {
    const computer = await runningComputer(30)
    const sandbox = sandboxOf(computer)
    const hub = localHub(workspaceId)
    // Nov 6 at 23:24: its runner away for 21 minutes, boat's last save 23 minutes ago.
    hub.runnerAway(computer.id, Date.now() - RECOVER_AFTER_MS - MIN)
    savedAgo(computer, 23)

    await inHub(() => cloud.checkIdle(computer))
    // Its service was started for it first: boat refused, as on Nov 7. Its disk was not asked
    // about before the stop: nothing reaches it.
    assert.deepEqual(
      boat.commands.filter((c) => c === sandbox),
      [sandbox],
    )
    // boat was asked to recover it, could not, and it was stopped with its last snapshot.
    assert.deepEqual(
      boat.recovers.filter((r) => r === sandbox),
      [sandbox],
    )
    assert.deepEqual(stopsOf(computer), [{ sandbox, force: true }])
    // Then started again, and marked running once boat has it up.
    assert.equal(await until(computer.id, 'running'), 'running')
    assert.deepEqual(boat.resumes, [sandbox])
    assert.equal(hub.runnerAway(computer.id)?.restarts, 1)
    assert.equal(hub.runnerAway(computer.id)?.recover, undefined)
    // Its start's audit is written once it is marked running.
    const actions = async () =>
      (
        await prisma.auditEntry.findMany({
          where: { targetId: computer.id },
          orderBy: { at: 'asc' },
          select: { action: true },
        })
      ).map((a) => a.action)
    for (let i = 0; i < 100 && (await actions()).length < 2; i++)
      await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(await actions(), ['computer.stopped', 'computer.started'])

    // Just started again: nothing before RECOVER_AFTER_MS from then, though away for longer.
    let row = await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } })
    assert.equal(
      await inHub(() => cloud.recoverAway(row, Date.now() + RECOVER_AFTER_MS - MIN)),
      false,
    )
    assert.equal(stopsOf(computer).length, 1)

    // Still away and unsaved after each: RECOVER_LIMIT times in all, then left to operators.
    for (let i = 2; i <= RECOVER_LIMIT; i++) {
      row = await marked(computer.id, 21)
      assert.equal(await inHub(() => cloud.recoverAway(row)), true)
      assert.equal(await until(computer.id, 'running'), 'running')
    }
    assert.equal(stopsOf(computer).length, RECOVER_LIMIT)
    row = await marked(computer.id, 60)
    assert.equal(await inHub(() => cloud.recoverAway(row)), false)
    assert.equal(stopsOf(computer).length, RECOVER_LIMIT)
    assert.equal(hub.runnerAway(computer.id)?.gaveUp, true)
    // Its alert says so.
    const alert = computerProblem(
      { ...row, workspace: { name: 'recover' } },
      false,
      awayFor(hub.runnerAway(computer.id), row),
      Date.now(),
      hub.runnerAway(computer.id),
    )
    assert.equal(alert?.severity, 'warning')
    assert.match(alert?.detail ?? '', /started it again 3 times, and no longer does/)

    // Its runner connects: nothing is away any more, and nothing is done.
    const runner = await fakeRunner({ organizationId, workspaceId }, computer.id)
    assert.equal(hub.runnerAway(computer.id), null)
    assert.equal(await inHub(() => cloud.recoverAway(row)), false)
    runner.close()
  },
)

test('a machine boat still saves is left as it is, its runner away or not', { skip }, async () => {
  const computer = await runningComputer(60)
  const hub = localHub(workspaceId)
  hub.runnerAway(computer.id, Date.now() - 45 * MIN)
  // Nov 7 at 11:05: a resumed machine stalled, boat's checks went on, and it came back by itself.
  savedAgo(computer, 4)
  assert.equal(await inHub(() => cloud.recoverAway(computer)), false)
  assert.deepEqual(
    boat.recovers.filter((r) => r === sandboxOf(computer)),
    [],
  )
  assert.deepEqual(stopsOf(computer), [])
  // Away for less than RECOVER_AFTER_MS: boat is not even asked what it saved.
  const fresh = await runningComputer(60)
  savedAgo(fresh, 60)
  const now = Date.now()
  hub.runnerAway(fresh.id, now)
  assert.equal(await inHub(() => cloud.recoverAway(fresh, now + RECOVER_AFTER_MS - MIN)), false)
  assert.deepEqual(stopsOf(fresh), [])
})

test(
  'a power-cycle boat accepts is waited for; a machine it reaches is left as it is',
  { skip },
  async () => {
    const hub = localHub(workspaceId)
    const recovered = await runningComputer(30)
    hub.runnerAway(recovered.id, Date.now() - RECOVER_AFTER_MS - MIN)
    savedAgo(recovered, 25)
    boat.recoverAnswer = 'accept'
    const now = Date.now()
    assert.equal(await inHub(() => cloud.recoverAway(recovered, now)), true)
    assert.equal(hub.runnerAway(recovered.id)?.recover, 'recovering')
    assert.deepEqual(stopsOf(recovered), [])
    // Not back RECOVER_WAIT_MS later, and still unsaved: stopped with its last snapshot.
    assert.equal(
      await inHub(() => cloud.recoverAway(recovered, now + RECOVER_WAIT_MS - MIN)),
      false,
    )
    assert.equal(await inHub(() => cloud.recoverAway(recovered, now + RECOVER_WAIT_MS)), true)
    assert.deepEqual(stopsOf(recovered), [{ sandbox: sandboxOf(recovered), force: true }])
    assert.equal(boat.recovers.filter((r) => r === sandboxOf(recovered)).length, 1)
    assert.equal(await until(recovered.id, 'running'), 'running')

    // A power-cycle after which boat saves the machine again, its runner still away: nothing more
    // is done, and its alert no longer says boat is power-cycling it once the wait is over.
    const cycled = await runningComputer(30)
    hub.runnerAway(cycled.id, Date.now() - RECOVER_AFTER_MS - MIN)
    savedAgo(cycled, 25)
    assert.equal(await inHub(() => cloud.recoverAway(cycled, now)), true)
    const later = now + RECOVER_WAIT_MS + 30 * MIN
    const savedAgain = new Date(later - MIN)
    boat.saved.set(sandboxOf(cycled), { verified: savedAgain, snapshot: savedAgain })
    assert.equal(await inHub(() => cloud.recoverAway(cycled, later)), false)
    assert.deepEqual(stopsOf(cycled), [])
    const detail = (at: number) =>
      computerProblem(
        { ...cycled, workspace: { name: 'recover' } },
        false,
        awayFor(hub.runnerAway(cycled.id), cycled, at),
        at,
        hub.runnerAway(cycled.id),
      )?.detail ?? ''
    assert.match(detail(now + MIN), /boat is power-cycling its machine/)
    assert.doesNotMatch(detail(later), /power-cycling/)

    // boat reaches the machine though it does not save it: nothing stopped, asked again later.
    const reached = await runningComputer(30)
    hub.runnerAway(reached.id, Date.now() - RECOVER_AFTER_MS - MIN)
    savedAgo(reached, 25)
    boat.recoverAnswer = 'sandbox_is_reachable'
    assert.equal(await inHub(() => cloud.recoverAway(reached, now)), false)
    assert.equal(await inHub(() => cloud.recoverAway(reached, now + RECOVER_WAIT_MS)), false)
    assert.equal(boat.recovers.filter((r) => r === sandboxOf(reached)).length, 1)
    assert.equal(await inHub(() => cloud.recoverAway(reached, now + RECOVER_AGAIN_MS)), false)
    assert.equal(boat.recovers.filter((r) => r === sandboxOf(reached)).length, 2)
    assert.deepEqual(stopsOf(reached), [])
  },
)

test('never stopped so without a snapshot, nor on a full disk', { skip }, async () => {
  const hub = localHub(workspaceId)
  const never = await runningComputer(30)
  hub.runnerAway(never.id, Date.now() - RECOVER_AFTER_MS - MIN)
  savedAgo(never, null)
  assert.equal(await inHub(() => cloud.recoverAway(never)), false)
  assert.deepEqual(stopsOf(never), [])

  const full = await runningComputer(30)
  await prisma.computer.update({
    where: { id: full.id },
    data: { disk: { used: 0.91, since: new Date().toISOString(), at: new Date().toISOString() } },
  })
  const row = await marked(full.id, 30)
  hub.runnerAway(full.id, Date.now() - RECOVER_AFTER_MS - MIN)
  savedAgo(full, 25)
  assert.equal(await inHub(() => cloud.recoverAway(row)), false)
  assert.deepEqual(stopsOf(full), [])
  // Stopped on purpose (its idle stop, a member): not awaited any more.
  await inHub(() => cloud.stopComputer(row, { type: 'system', id: 'brigade' }, { force: true }))
  assert.equal(hub.runnerAway(full.id)?.recover, undefined)
  assert.equal(hub.runnerAway(full.id)?.restarts, 0)
})

test('a runner back while boat is asked is left running', { skip }, async () => {
  const computer = await runningComputer(30)
  const hub = localHub(workspaceId)
  hub.runnerAway(computer.id, Date.now() - RECOVER_AFTER_MS - MIN)
  savedAgo(computer, 25)
  // boat's answer waits; the runner says hello meanwhile.
  let answer!: () => void
  boat.answering = new Promise((resolve) => (answer = resolve))
  const recovering = inHub(() => cloud.recoverAway(computer))
  for (let i = 0; i < 100 && !boat.recovers.includes(sandboxOf(computer)); i++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  const runner = await fakeRunner({ organizationId, workspaceId }, computer.id)
  answer()
  boat.answering = null
  assert.equal(await recovering, false)
  assert.deepEqual(stopsOf(computer), [])
  assert.equal(
    (await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } })).status,
    'running',
  )
  assert.ok(hub.runners.has(computer.id))
  runner.close()
})

test('a hello gives a computer its restarts back', { skip }, async () => {
  const computer = await runningComputer(30)
  const hub = localHub(workspaceId)
  hub.runnerAway(computer.id, Date.now() - 60 * MIN)
  for (let i = 0; i < RECOVER_LIMIT; i++) hub.noteAwayRestart(computer.id)
  hub.noteAwayRecover(computer.id, 'reachable')
  assert.equal(hub.runnerAway(computer.id)?.restarts, RECOVER_LIMIT)
  // Its runner connects and goes again before anything reads it online.
  const runner = await fakeRunner({ organizationId, workspaceId }, computer.id)
  const conn = hub.runners.get(computer.id)!
  hub.runners.delete(computer.id)
  hub.takeOver(conn)
  runner.close()
  const away = hub.runnerAway(computer.id)
  assert.equal(away?.restarts, 0)
  assert.equal(away?.recover, undefined)
  assert.ok(Date.now() - away!.since < MIN)
})
