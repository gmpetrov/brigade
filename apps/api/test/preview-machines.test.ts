import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import { Hono } from 'hono'
import type { ComputerRef, ComputerStatus, MachineProvider } from '@brigade/providers'
import { sessionStub } from './session-stub.js'

// Previews on a machine of their own (src/preview-machines.ts, docs/previews.md), against the
// API's development database (apps/api/.env), in an organization of its own removed at the end,
// with the provider faked; skipped when no database answers:
// - a thread gets a machine only when its starter has the preview_machines feature and turned
//   it on, and only on a cloud computer; nobody else gets one, and their previews run as before;
// - the same machine each time: started again once stopped, made again once the provider lost
//   it; two starts at once make one;
// - past the most a workspace runs at once, a preview runs on the computer, and says why;
// - starts in several threads at once never run more than the most at once;
// - sleep stops it; touch keeps it alive with the provider at most every ten minutes; a stop the
//   provider failed leaves it running, and the next sweep stops it; a machine being stopped keeps
//   its slot until the provider stopped it, and a stop its process lost is taken up by the sweep;
// - the sweep destroys the machine of a deleted thread and one stopped twelve days, stops one
//   its runner forgot, and undoes a making cut short; an `up` meanwhile never gets a machine being
//   destroyed; it judges each row again as it acts, under the lock an up takes; rows with nothing
//   due never hold back those that have;
// - the preference is offered only to members with the feature (404 for the others), and /me
//   says it.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

const { prisma, scoped } = await import('../src/db.js')
const machinesModule = await import('../src/preview-machines.js')
const {
  machineUp,
  machineSleep,
  machineTouch,
  sweepMachine,
  sweepPreviewMachines,
  CLAIM_MS,
  MACHINES_RUNNING_MAX,
} = machinesModule
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

/** A provider in memory: what was made, started, stopped, destroyed and let in. */
class FakeMachines implements MachineProvider {
  readonly size = '8 vCPU, 16 GB'
  readonly states = new Map<string, ComputerStatus>()
  readonly byKey = new Map<string, string>()
  made: string[] = []
  started: string[] = []
  stopped: string[] = []
  destroyed: string[] = []
  keptAlive: string[] = []
  /** How long a making takes. */
  makingMs = 0
  /** Stops that fail before reaching the provider (a timeout, a 503), in turn. */
  failStops = 0
  /** Holds each destroy until it resolves: a destroy under way. */
  destroyGate?: Promise<void>
  /** Holds each stop until it settles (a rejection fails it): a stop under way. */
  stopGate?: Promise<void>
  /** Called as a stop starts, before it waits on stopGate. */
  onStop?: () => void
  /** Called as a destroy starts, before it waits on destroyGate. */
  onDestroy?: () => void

  async create({ key }: { name: string; key: string }): Promise<ComputerRef> {
    this.made.push(key)
    await new Promise((done) => setTimeout(done, this.makingMs))
    let id = this.byKey.get(key)
    if (!id) {
      id = `vm-${randomUUID().slice(0, 8)}`
      this.byKey.set(key, id)
      this.states.set(id, 'running')
    }
    return { provider: 'boat', id }
  }
  async start(ref: ComputerRef) {
    this.started.push(ref.id)
    this.states.set(ref.id, 'running')
  }
  async stop(ref: ComputerRef) {
    this.onStop?.()
    await this.stopGate
    if (this.failStops > 0) {
      this.failStops--
      throw new Error('the provider did not answer')
    }
    this.stopped.push(ref.id)
    this.states.set(ref.id, 'stopped')
  }
  async destroy(ref: ComputerRef) {
    this.onDestroy?.()
    await this.destroyGate
    this.destroyed.push(ref.id)
    this.states.set(ref.id, 'destroyed')
  }
  async status(ref: ComputerRef) {
    const state = this.states.get(ref.id)
    if (!state) throw Object.assign(new Error('not found'), { response: { status: 404 } })
    return state
  }
  async keepAlive(ref: ComputerRef) {
    this.keptAlive.push(ref.id)
  }
  async authorize(ref: ComputerRef) {
    return { host: `${ref.id}.test`, port: 22, user: 'user', hostKey: 'ssh-ed25519 AAAAhost' }
  }
}

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIrunner brigade-runner'

describe('preview machines', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const org = `org-machines-${suffix}`
  const ids = {} as Record<'workspace' | 'ada' | 'bob' | 'cloud' | 'mac' | 'riley', string>
  let db: ReturnType<typeof scoped>
  let flagBefore: Awaited<ReturnType<typeof prisma.featureFlag.findUnique>> = null
  let app: Hono
  let restore: () => void
  const runner = () => ({ computerId: ids.cloud })

  before(async () => {
    await prisma.organization.create({ data: { id: org, name: 'Machines', slug: org } })
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: org, name: 'Machines' } })
    ).id
    db = scoped({ organizationId: org, workspaceId: ids.workspace })
    for (const who of ['ada', 'bob'] as const) {
      await prisma.user.create({
        data: { id: `${who}-${suffix}`, name: who, email: `${who}-${suffix}@machines.test` },
      })
      ids[who] = `m-${who}-${suffix}`
      await prisma.member.create({
        data: { id: ids[who], organizationId: org, userId: `${who}-${suffix}`, role: 'owner' },
      })
    }
    ids.cloud = (
      await db.computer.create({
        data: { kind: 'cloud', name: 'Cloud', status: 'running' } as never,
      })
    ).id
    ids.mac = (
      await db.computer.create({
        data: {
          kind: 'member_machine',
          name: 'Mac',
          status: 'running',
          memberId: ids.ada,
        } as never,
      })
    ).id
    ids.riley = (await db.teammate.create({ data: { name: 'Riley' } as never })).id
    // The feature, open to Ada alone, whatever the row held before (put back at the end).
    flagBefore = await prisma.featureFlag.findUnique({ where: { key: 'preview_machines' } })
    await prisma.featureFlag.upsert({
      where: { key: 'preview_machines' },
      create: { key: 'preview_machines', emails: [`ada-${suffix}@machines.test`] },
      update: { everyone: false, emails: [`ada-${suffix}@machines.test`], workspaceIds: [] },
    })
    await prisma.member.update({ where: { id: ids.ada }, data: { previewMachines: true } })

    const { auth } = await import('../src/auth.js')
    const { workspaces } = await import('../src/routes/workspaces.js')
    const getSession = auth.api.getSession
    ;(auth.api as { getSession: unknown }).getSession = sessionStub((headers) => ({
      user: { id: headers.get('x-test-user') },
      session: {
        id: `session-${headers.get('x-test-user')}`,
        activeOrganizationId: org,
        activeWorkspaceId: ids.workspace,
      },
    }))
    restore = () => ((auth.api as { getSession: unknown }).getSession = getSession)
    app = new Hono().route('/api', workspaces)
  })

  after(async () => {
    restore?.()
    if (flagBefore) {
      const { key: _key, updatedAt: _at, ...rest } = flagBefore
      await prisma.featureFlag.update({ where: { key: 'preview_machines' }, data: rest })
    } else await prisma.featureFlag.deleteMany({ where: { key: 'preview_machines' } })
    await prisma.previewMachine.deleteMany({ where: { workspaceId: ids.workspace } })
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.member.deleteMany({ where: { organizationId: org } })
    await prisma.organization.deleteMany({ where: { id: org } })
    await prisma.user.deleteMany({ where: { id: { in: [`ada-${suffix}`, `bob-${suffix}`] } } })
  })

  /** A thread started by `who`, on the cloud computer unless said. */
  const thread = async (who: 'ada' | 'bob', computer: 'cloud' | 'mac' = 'cloud') =>
    (
      await db.session.create({
        data: {
          teammateId: ids.riley,
          startedByMemberId: ids[who],
          computerId: ids[computer],
          title: `A thread of ${who}`,
          status: 'idle',
          lastSeq: 0,
        } as never,
      })
    ).id

  const row = (sessionId: string) =>
    prisma.previewMachine.findUniqueOrThrow({ where: { sessionId } })

  test('a thread gets a machine only when its starter has the feature and turned it on', async () => {
    const machines = new FakeMachines()
    const ada = await machineUp(machines, runner(), await thread('ada'), KEY)
    assert.equal(ada.machine?.host.endsWith('.test'), true)
    assert.equal(ada.machine?.size, '8 vCPU, 16 GB')
    assert.equal(ada.machine?.hostKey, 'ssh-ed25519 AAAAhost')

    // Bob turned it on, but does not have the feature.
    await prisma.member.update({ where: { id: ids.bob }, data: { previewMachines: true } })
    assert.deepEqual(await machineUp(machines, runner(), await thread('bob'), KEY), {
      machine: null,
    })
    await prisma.member.update({ where: { id: ids.bob }, data: { previewMachines: false } })

    // Ada turned it off.
    await prisma.member.update({ where: { id: ids.ada }, data: { previewMachines: false } })
    assert.deepEqual(await machineUp(machines, runner(), await thread('ada'), KEY), {
      machine: null,
    })
    await prisma.member.update({ where: { id: ids.ada }, data: { previewMachines: true } })

    // On her own machine, never: it is not a cloud computer.
    const onMac = await thread('ada', 'mac')
    assert.deepEqual(await machineUp(machines, { computerId: ids.mac }, onMac, KEY), {
      machine: null,
    })
    // Without a provider configured, never.
    assert.deepEqual(await machineUp(null, runner(), await thread('ada'), KEY), { machine: null })
    // A thread of another computer is refused.
    await assert.rejects(machineUp(machines, runner(), onMac, KEY), /Unknown thread/)
    assert.equal(machines.made.length, 1, 'one machine, Ada’s first thread’s')
  })

  test('the same machine each time: started again when stopped, made again when gone', async () => {
    const machines = new FakeMachines()
    const sessionId = await thread('ada')
    const first = await machineUp(machines, runner(), sessionId, KEY)
    const vm = machines.byKey.get(machines.made[0]!)!
    assert.equal(
      (await machineUp(machines, runner(), sessionId, KEY)).machine?.host,
      first.machine?.host,
    )
    assert.equal(machines.made.length, 1)

    await machineSleep(machines, runner(), sessionId)
    assert.deepEqual(machines.stopped, [vm])
    assert.equal((await row(sessionId)).status, 'stopped')
    await machineUp(machines, runner(), sessionId, KEY)
    assert.deepEqual(machines.started, [vm], 'started again, not made again')
    assert.equal((await row(sessionId)).status, 'running')

    // The provider lost it (its disk expired): a new one, under a new key.
    machines.states.delete(vm)
    const again = await machineUp(machines, runner(), sessionId, KEY)
    assert.equal(machines.made.length, 2)
    assert.notEqual(machines.made[1], machines.made[0])
    assert.notEqual(again.machine?.host, first.machine?.host)
    assert.equal((await row(sessionId)).generation, 1)
  })

  test('two starts at once make one machine', async () => {
    const machines = new FakeMachines()
    machines.makingMs = 300
    const sessionId = await thread('ada')
    const [a, b] = await Promise.all([
      machineUp(machines, runner(), sessionId, KEY),
      machineUp(machines, runner(), sessionId, KEY),
    ])
    assert.equal(machines.made.length, 1)
    assert.equal(a.machine?.host, b.machine?.host)
  })

  test('past the most at once, a preview runs on the computer and says why', async () => {
    const machines = new FakeMachines()
    await prisma.previewMachine.updateMany({
      where: { workspaceId: ids.workspace },
      data: { status: 'stopped' },
    })
    for (let i = 0; i < MACHINES_RUNNING_MAX; i++)
      assert.ok((await machineUp(machines, runner(), await thread('ada'), KEY)).machine)
    const over = await machineUp(machines, runner(), await thread('ada'), KEY)
    assert.equal(over.machine, null)
    assert.match(over.reason ?? '', /runs on the cloud computer/)
    await prisma.previewMachine.updateMany({
      where: { workspaceId: ids.workspace },
      data: { status: 'stopped' },
    })
  })

  test('touch keeps it alive with the provider at most every ten minutes', async () => {
    const machines = new FakeMachines()
    const sessionId = await thread('ada')
    await machineUp(machines, runner(), sessionId, KEY)
    const now = Date.now()
    await machineTouch(machines, runner(), sessionId, new Date(now))
    assert.equal(machines.keptAlive.length, 0, 'made just now: kept alive then')
    await machineTouch(machines, runner(), sessionId, new Date(now + 11 * 60_000))
    await machineTouch(machines, runner(), sessionId, new Date(now + 12 * 60_000))
    assert.equal(machines.keptAlive.length, 1)
    assert.equal((await row(sessionId)).usedAt.getTime(), now + 12 * 60_000)
    await machineSleep(machines, runner(), sessionId)
    await machineTouch(machines, runner(), sessionId, new Date(now + 30 * 60_000))
    assert.equal(machines.keptAlive.length, 1, 'a stopped one is not kept alive')
    await prisma.previewMachine.deleteMany({ where: { sessionId } })
  })

  test('the sweep destroys, stops and undoes what it should, and leaves the rest', async () => {
    await prisma.previewMachine.deleteMany({ where: { workspaceId: ids.workspace } })
    const machines = new FakeMachines()
    const now = new Date()
    const ago = (ms: number) => new Date(now.getTime() - ms)

    const deleted = await thread('ada')
    await machineUp(machines, runner(), deleted, KEY)
    const deletedVm = (await row(deleted)).providerRef as { id: string }
    await prisma.session.delete({ where: { id: deleted } })

    const forgotten = await thread('ada')
    await machineUp(machines, runner(), forgotten, KEY)
    await prisma.previewMachine.update({
      where: { sessionId: forgotten },
      data: { usedAt: ago(50 * 60_000) },
    })

    const longStopped = await thread('ada')
    await machineUp(machines, runner(), longStopped, KEY)
    await prisma.previewMachine.update({
      where: { sessionId: longStopped },
      data: { status: 'stopped', stoppedAt: ago(13 * 24 * 3600_000) },
    })

    const inUse = await thread('ada')
    await machineUp(machines, runner(), inUse, KEY)

    // A making cut short: claimed, its claim over, no machine recorded, untouched for an hour.
    const cut = await thread('ada')
    const cutRow = await prisma.previewMachine.create({
      data: {
        organizationId: org,
        workspaceId: ids.workspace,
        sessionId: cut,
        claimedUntil: ago(40 * 60_000),
      },
    })
    await prisma.$executeRaw`UPDATE "PreviewMachine" SET "updatedAt" = ${ago(3600_000)} WHERE "id" = ${cutRow.id}`
    // It did reach the provider before it was cut short.
    const cutVm = (await machines.create({ name: 'x', key: `brigade-preview-${cutRow.id}-0` })).id
    machines.made = []

    await sweepPreviewMachines(now, machines)

    assert.ok(machines.destroyed.includes(deletedVm.id), 'the deleted thread’s machine')
    assert.equal(await prisma.previewMachine.count({ where: { sessionId: deleted } }), 0)
    assert.equal((await row(forgotten)).status, 'stopped', 'the forgotten one is stopped')
    assert.equal(await prisma.previewMachine.count({ where: { sessionId: longStopped } }), 0)
    assert.equal((await row(inUse)).status, 'running', 'the one in use is left alone')
    assert.ok(machines.destroyed.includes(cutVm), 'the machine of the making cut short')
    assert.equal(await prisma.previewMachine.count({ where: { sessionId: cut } }), 0)
    assert.equal(machines.destroyed.length, 3)
  })

  test('starts in several threads at once never run more than the most at once', async () => {
    await prisma.previewMachine.deleteMany({ where: { workspaceId: ids.workspace } })
    const machines = new FakeMachines()
    machines.makingMs = 200
    for (let i = 0; i < MACHINES_RUNNING_MAX - 1; i++)
      assert.ok((await machineUp(machines, runner(), await thread('ada'), KEY)).machine)
    // Each new row's insert waits half a second (this workspace's only): without the lock, both
    // starts count four before either row is there.
    const fn = `preview_machines_slow_${suffix.replace(/-/g, '')}`
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN IF NEW."workspaceId" = '${ids.workspace}' THEN PERFORM pg_sleep(0.5); END IF; RETURN NEW; END $$ LANGUAGE plpgsql`,
    )
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${fn} BEFORE INSERT ON "PreviewMachine" FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    )
    const [one, two] = [await thread('ada'), await thread('ada')]
    let a, b
    try {
      ;[a, b] = await Promise.all([
        machineUp(machines, runner(), one, KEY),
        machineUp(machines, runner(), two, KEY),
      ])
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER ${fn} ON "PreviewMachine"`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION ${fn}()`)
    }
    assert.equal([a, b].filter((r) => r.machine).length, 1, 'one gets the last slot')
    assert.match([a, b].find((r) => !r.machine)?.reason ?? '', /cloud computer/)
    assert.equal(
      await prisma.previewMachine.count({
        where: { workspaceId: ids.workspace, status: { in: ['creating', 'running'] } },
      }),
      MACHINES_RUNNING_MAX,
    )
    await prisma.previewMachine.deleteMany({ where: { workspaceId: ids.workspace } })
  })

  test('a stop the provider failed leaves it running, and the next sweep stops it', async () => {
    const machines = new FakeMachines()
    const sessionId = await thread('ada')
    await machineUp(machines, runner(), sessionId, KEY)
    machines.failStops = 1
    await assert.rejects(machineSleep(machines, runner(), sessionId), /did not answer/)
    assert.equal((await row(sessionId)).status, 'running', 'still up: not said stopped')
    assert.equal((await row(sessionId)).claimedUntil, null)
    await sweepPreviewMachines(new Date(), machines)
    assert.equal(machines.stopped.length, 1, 'the sweep stopped it')
    assert.equal((await row(sessionId)).status, 'stopped')
    await prisma.previewMachine.deleteMany({ where: { sessionId } })
  })

  test('an up while its machine is destroyed waits, then gets a new machine', async () => {
    await prisma.previewMachine.deleteMany({ where: { workspaceId: ids.workspace } })
    const machines = new FakeMachines()
    const sessionId = await thread('ada')
    const first = await machineUp(machines, runner(), sessionId, KEY)
    const old = ((await row(sessionId)).providerRef as { id: string }).id
    await prisma.previewMachine.update({
      where: { sessionId },
      data: { status: 'stopped', stoppedAt: new Date(Date.now() - 13 * 24 * 3600_000) },
    })
    // The sweep is destroying it when the thread's preview starts again.
    let release!: () => void
    machines.destroyGate = new Promise((done) => (release = done))
    const destroying = new Promise<void>((done) => (machines.onDestroy = done))
    const sweep = sweepPreviewMachines(new Date(), machines)
    await destroying
    const up = machineUp(machines, runner(), sessionId, KEY)
    await new Promise((done) => setTimeout(done, 300))
    release()
    await sweep
    const after = await up
    assert.deepEqual(machines.destroyed, [old])
    assert.ok(after.machine)
    assert.notEqual(after.machine.host, first.machine?.host, 'a new machine, not the destroyed one')
    assert.equal((await row(sessionId)).status, 'running')
    machines.destroyGate = undefined
    await prisma.previewMachine.deleteMany({ where: { sessionId } })
  })

  test('the sweep judges a row again as it acts: an up since it listed it wins', async () => {
    const machines = new FakeMachines()
    const sessionId = await thread('ada')
    await machineUp(machines, runner(), sessionId, KEY)
    const { id } = await row(sessionId)
    // Listed as stopped long enough to destroy; the thread's preview starts again meanwhile.
    await prisma.previewMachine.update({
      where: { id },
      data: { status: 'stopped', stoppedAt: new Date(Date.now() - 13 * 24 * 3600_000) },
    })
    await machineUp(machines, runner(), sessionId, KEY)
    assert.equal(await sweepMachine(machines, id, ids.workspace, new Date()), null)
    // Listed as running unused for an hour; used meanwhile.
    await prisma.previewMachine.update({
      where: { id },
      data: { usedAt: new Date(Date.now() - 3600_000) },
    })
    await machineTouch(machines, runner(), sessionId)
    assert.equal(await sweepMachine(machines, id, ids.workspace, new Date()), null)
    assert.deepEqual(machines.destroyed, [])
    assert.deepEqual(machines.stopped, [])
    assert.equal((await row(sessionId)).status, 'running')
    await prisma.previewMachine.deleteMany({ where: { sessionId } })
  })

  test('a stop or a destroy is decided under the lock an up takes', async () => {
    const machines = new FakeMachines()
    const sessionId = await thread('ada')
    await machineUp(machines, runner(), sessionId, KEY)
    const { id } = await row(sessionId)
    await prisma.previewMachine.update({
      where: { id },
      data: { status: 'stopped', stoppedAt: new Date(Date.now() - 13 * 24 * 3600_000) },
    })
    // The workspace's lock, held as an up's reserve holds it.
    let release!: () => void
    let locked!: () => void
    const holding = new Promise<void>((done) => (locked = done))
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`preview-machines:${ids.workspace}`}))`
        locked()
        await new Promise<void>((done) => (release = done))
      },
      { timeout: 20_000 },
    )
    await holding
    let finished = false
    const sweep = sweepMachine(machines, id, ids.workspace, new Date()).then((due) => {
      finished = true
      return due
    })
    await new Promise((done) => setTimeout(done, 500))
    assert.equal(finished, false, 'it waits for the lock')
    assert.deepEqual(machines.destroyed, [])
    release()
    await holder
    assert.equal(await sweep, 'destroy')
    await prisma.previewMachine.deleteMany({ where: { sessionId } })
  })

  test("a touch is decided under the same lock: never lost between a sweep's read and claim", async () => {
    const machines = new FakeMachines()
    const sessionId = await thread('ada')
    await machineUp(machines, runner(), sessionId, KEY)
    let release!: () => void
    let locked!: () => void
    const holding = new Promise<void>((done) => (locked = done))
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`preview-machines:${ids.workspace}`}))`
        locked()
        await new Promise<void>((done) => (release = done))
      },
      { timeout: 20_000 },
    )
    await holding
    const at = new Date(Date.now() + 60_000)
    let finished = false
    const touch = machineTouch(machines, runner(), sessionId, at).then(() => (finished = true))
    await new Promise((done) => setTimeout(done, 500))
    assert.equal(finished, false, 'it waits for the lock')
    release()
    await holder
    await touch
    assert.equal((await row(sessionId)).usedAt.getTime(), at.getTime())
    await prisma.previewMachine.deleteMany({ where: { sessionId } })
  })

  test('a claim runs from when it is taken, however long ago its sweep began', async () => {
    const machines = new FakeMachines()
    const sessionId = await thread('ada')
    await machineUp(machines, runner(), sessionId, KEY)
    const { id } = await prisma.previewMachine.update({
      where: { sessionId },
      data: { usedAt: new Date(Date.now() - 3 * 3600_000) },
    })
    const vm = ((await row(sessionId)).providerRef as { id: string }).id
    // A sweep that began longer ago than a claim lasts reaches this row now (a lease counted from
    // its start would be over already); its provider's stop is slow.
    let stopped!: () => void
    machines.stopGate = new Promise<void>((done) => (stopped = done))
    const stopping = new Promise<void>((done) => (machines.onStop = done))
    const began = new Date(Date.now() - 2 * CLAIM_MS)
    const taking = Date.now()
    const sweep = sweepMachine(machines, id, ids.workspace, began)
    await stopping
    const held = await row(sessionId)
    assert.equal(held.status, 'stopping')
    assert.ok(held.claimedUntil!.getTime() >= taking + CLAIM_MS, 'a claim from when it was taken')
    // The thread's preview starts again meanwhile: it waits for the stop, then starts it again.
    let upDone = false
    const up = machineUp(machines, runner(), sessionId, KEY).then((r) => ((upDone = true), r))
    await new Promise((done) => setTimeout(done, 500))
    assert.equal(upDone, false, 'the up waits for the stop under way')
    stopped()
    assert.equal(await sweep, 'stop')
    assert.ok((await up).machine)
    assert.equal(machines.states.get(vm), 'running', 'started again after the stop')
    assert.equal((await row(sessionId)).status, 'running')
    machines.stopGate = undefined
    machines.onStop = undefined
    await prisma.previewMachine.deleteMany({ where: { sessionId } })
  })

  test('a machine being stopped keeps its slot until the provider stopped it', async () => {
    await prisma.previewMachine.deleteMany({ where: { workspaceId: ids.workspace } })
    const machines = new FakeMachines()
    const threads: string[] = []
    for (let i = 0; i < MACHINES_RUNNING_MAX; i++) {
      threads.push(await thread('ada'))
      assert.ok((await machineUp(machines, runner(), threads[i]!, KEY)).machine)
    }
    // One goes to sleep; its provider's stop is slow, then fails.
    let settle!: (failed: boolean) => void
    machines.stopGate = new Promise<void>((done, fail) => {
      settle = (failed) => (failed ? fail(new Error('the provider did not answer')) : done())
    })
    machines.stopGate.catch(() => undefined)
    const stopping = new Promise<void>((done) => (machines.onStop = done))
    const sleeping = machineSleep(machines, runner(), threads[0]!).catch((e: Error) => e)
    await stopping
    const sixth = await machineUp(machines, runner(), await thread('ada'), KEY)
    assert.equal(sixth.machine, null, 'its slot is still taken')
    settle(true)
    assert.match(String(await sleeping), /did not answer/)
    assert.equal((await row(threads[0]!)).status, 'running')
    assert.equal(
      await prisma.previewMachine.count({
        where: { workspaceId: ids.workspace, status: { in: ['creating', 'running', 'stopping'] } },
      }),
      MACHINES_RUNNING_MAX,
    )
    machines.stopGate = undefined
    machines.onStop = undefined
    await prisma.previewMachine.deleteMany({ where: { workspaceId: ids.workspace } })
  })

  test('a stop its process lost is taken up by the sweep', async () => {
    const machines = new FakeMachines()
    const sessionId = await thread('ada')
    await machineUp(machines, runner(), sessionId, KEY)
    // Its stop was asked for, then the process went (its claim ran out, the provider never told).
    await prisma.previewMachine.update({
      where: { sessionId },
      data: { status: 'stopping', claimedUntil: new Date(Date.now() - 60_000) },
    })
    await sweepPreviewMachines(new Date(), machines)
    assert.equal(machines.stopped.length, 1)
    assert.equal((await row(sessionId)).status, 'stopped')
    await prisma.previewMachine.deleteMany({ where: { sessionId } })
  })

  test('rows with nothing due never hold back one that has', async () => {
    await prisma.previewMachine.deleteMany({ where: { workspaceId: ids.workspace } })
    const machines = new FakeMachines()
    // Many stopped machines of live threads, older than the one due below, none due yet.
    const recent = new Date(Date.now() - 24 * 3600_000)
    const quiet = await Promise.all(Array.from({ length: 130 }, () => thread('ada')))
    await prisma.previewMachine.createMany({
      data: quiet.map((sessionId, i) => ({
        organizationId: org,
        workspaceId: ids.workspace,
        sessionId,
        status: 'stopped' as const,
        providerRef: { provider: 'boat', id: `quiet-${i}` },
        stoppedAt: recent,
      })),
    })
    const gone = await thread('ada')
    await machineUp(machines, runner(), gone, KEY)
    const vm = ((await row(gone)).providerRef as { id: string }).id
    await prisma.session.delete({ where: { id: gone } })
    await sweepPreviewMachines(new Date(), machines)
    assert.deepEqual(machines.destroyed, [vm], 'the deleted thread’s machine, at the first sweep')
    assert.equal(await prisma.previewMachine.count({ where: { sessionId: gone } }), 0)
    await prisma.previewMachine.deleteMany({ where: { workspaceId: ids.workspace } })
  })

  test('the preference shows to members with the feature only, and /me says it', async () => {
    const put = (who: 'ada' | 'bob', on: boolean) =>
      app.request('/api/me/preview-machines', {
        method: 'PUT',
        headers: { 'x-test-user': `${who}-${suffix}`, 'content-type': 'application/json' },
        body: JSON.stringify({ previewMachines: on }),
      })
    const me = async (who: 'ada' | 'bob') =>
      (await app.request('/api/me', { headers: { 'x-test-user': `${who}-${suffix}` } })).json()

    assert.equal((await put('bob', true)).status, 404, 'as if it were not there')
    assert.equal(
      (await prisma.member.findUniqueOrThrow({ where: { id: ids.bob } })).previewMachines,
      false,
    )
    const bob = await me('bob')
    assert.ok(!bob.features.includes('preview_machines'))

    assert.equal((await put('ada', false)).status, 204)
    assert.equal((await me('ada')).previewMachines, false)
    assert.equal((await put('ada', true)).status, 204)
    const ada = await me('ada')
    assert.equal(ada.previewMachines, true)
    assert.ok(ada.features.includes('preview_machines'))
  })
})
