import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, beforeEach, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import type {
  ComputerRef,
  ComputerStatus,
  MachineProvider,
  ProviderLedger,
  VmState,
} from '@brigade/providers'

// What each workspace's VMs cost (src/vm-costs.ts, docs/vm-costs.md), against the API's
// development database (apps/api/.env), in an organization of its own removed at the end, the
// provider and its figures faked; skipped when no database answers:
// - a thread's machine: its making, its stop, its start again, each a run; a start asked again
//   while one is under way is the same run;
// - boat's own stops: its webhook (signed; sent twice or late, it changes nothing more), and the
//   minute's check of boat's list, from boat's own figure of how long it ran;
// - a crash between a start and its record: a start retried after it is the same run, counted
//   once; one nobody finished is settled from boat's list and figures (running: open; never ran:
//   void; ran then stopped: closed when it stopped); a create that never said its VM is void; a
//   stop not recorded is closed from boat's figures; a VM running without a run is found, as no
//   start, but not one whose stop was recorded after the list was read;
// - a month's sums: hours split at the month's ends, starts, found runs no start, void runs
//   nothing, each thread's (a deleted one untitled), the computer at its size, boat's figure.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

const { prisma, scoped } = await import('../src/db.js')
const costs = await import('../src/vm-costs.js')
const { machineUp, machineSleep } = await import('../src/preview-machines.js')
const {
  beginRun,
  runMade,
  runStarted,
  runStopped,
  reconcileVmRuns,
  boatWebhook,
  workspaceVmCosts,
  allVmCosts,
  sumRuns,
  PENDING_MS,
} = costs
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

/** boat's figures in memory: each VM's state, and how long it ran (seconds) over any window. */
class FakeLedger implements ProviderLedger {
  readonly vms = new Map<string, VmState>()
  readonly ran = new Map<string, number>()
  /** Called while the list is read: what happens just after boat answered it. */
  onList?: () => Promise<void>
  usageAsked: string[] = []
  async states() {
    const states = new Map(this.vms)
    await this.onList?.()
    return states
  }
  async usage(id: string) {
    this.usageAsked.push(id)
    if (!this.vms.has(id))
      throw Object.assign(new Error('not found'), { response: { status: 404 } })
    const runSeconds = this.ran.get(id) ?? 0
    return {
      runSeconds,
      dollars: (runSeconds / 3600) * 0.072,
      running: this.vms.get(id) === 'running',
    }
  }
  async limits() {
    return {}
  }
}

/** A provider of machines in memory, saying when it resumed each. */
class FakeMachines implements MachineProvider {
  readonly size = '8 vCPU, 16 GB'
  readonly states = new Map<string, ComputerStatus>()
  readonly byKey = new Map<string, string>()
  async create({ key, onCreated }: Parameters<MachineProvider['create']>[0]) {
    let id = this.byKey.get(key)
    if (!id) {
      id = `vm-${randomUUID().slice(0, 8)}`
      this.byKey.set(key, id)
    }
    await onCreated?.({ provider: 'boat', id })
    this.states.set(id, 'running')
    return { provider: 'boat', id }
  }
  async start(ref: ComputerRef) {
    const resumed = this.states.get(ref.id) !== 'running'
    this.states.set(ref.id, 'running')
    return { resumedAt: resumed ? new Date() : null }
  }
  async stop(ref: ComputerRef) {
    this.states.set(ref.id, 'stopped')
  }
  async destroy(ref: ComputerRef) {
    this.states.delete(ref.id)
  }
  async status(ref: ComputerRef) {
    const state = this.states.get(ref.id)
    if (!state) throw Object.assign(new Error('not found'), { response: { status: 404 } })
    return state
  }
  async keepAlive() {}
  async authorize(ref: ComputerRef) {
    return { host: `${ref.id}.test`, port: 22, user: 'user', hostKey: 'ssh-ed25519 AAAAhost' }
  }
}

const SECRET = 'whsec_test_secret'

/** A webhook boat signed, as docs.boat.dev/webhooks says. */
function signed(event: object, secret = SECRET, at = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(event)
  const delivery = `evt_${randomUUID().slice(0, 8)}`
  const signature = createHmac('sha256', secret).update(`${delivery}.${at}.${body}`).digest('hex')
  return new Request('https://api.test/api/boat/webhook', {
    method: 'POST',
    body,
    headers: {
      'x-ascii-event': (event as { type: string }).type,
      'x-ascii-delivery': delivery,
      'x-ascii-timestamp': String(at),
      'x-ascii-signature': `v1=${signature}`,
    },
  })
}

const archived = (sandboxId: string, at: Date) => ({
  id: `evt_${randomUUID().slice(0, 8)}`,
  type: 'sandbox.archived',
  createdAt: at.toISOString(),
  data: { sandbox: { id: sandboxId, name: 'x' }, previousState: 'running', state: 'archived' },
})

describe('vm costs', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const org = `org-vm-costs-${suffix}`
  const ids = {} as Record<'workspace' | 'ada' | 'cloud' | 'riley', string>
  let db: ReturnType<typeof scoped>
  let flagBefore: Awaited<ReturnType<typeof prisma.featureFlag.findUnique>> = null
  const runner = () => ({ computerId: ids.cloud })
  const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIrunner brigade-runner'

  before(async () => {
    await prisma.organization.create({ data: { id: org, name: 'VM costs', slug: org } })
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: org, name: 'VM costs' } })
    ).id
    db = scoped({ organizationId: org, workspaceId: ids.workspace })
    await prisma.user.create({
      data: { id: `ada-${suffix}`, name: 'ada', email: `ada-${suffix}@vm-costs.test` },
    })
    ids.ada = `m-ada-${suffix}`
    await prisma.member.create({
      data: { id: ids.ada, organizationId: org, userId: `ada-${suffix}`, role: 'owner' },
    })
    ids.cloud = (
      await db.computer.create({
        data: { kind: 'cloud', name: 'Cloud', status: 'running', size: '2x4' } as never,
      })
    ).id
    ids.riley = (await db.teammate.create({ data: { name: 'Riley' } as never })).id
    flagBefore = await prisma.featureFlag.findUnique({ where: { key: 'preview_machines' } })
    await prisma.featureFlag.upsert({
      where: { key: 'preview_machines' },
      create: { key: 'preview_machines', emails: [`ada-${suffix}@vm-costs.test`] },
      update: { everyone: false, emails: [`ada-${suffix}@vm-costs.test`], workspaceIds: [] },
    })
    await prisma.member.update({ where: { id: ids.ada }, data: { previewMachines: true } })
  })

  after(async () => {
    if (flagBefore) {
      const { key: _key, updatedAt: _at, ...rest } = flagBefore
      await prisma.featureFlag.update({ where: { key: 'preview_machines' }, data: rest })
    } else await prisma.featureFlag.deleteMany({ where: { key: 'preview_machines' } })
    await prisma.previewMachine.deleteMany({ where: { workspaceId: ids.workspace } })
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.member.deleteMany({ where: { organizationId: org } })
    await prisma.organization.deleteMany({ where: { id: org } })
    await prisma.user.deleteMany({ where: { id: `ada-${suffix}` } })
  })

  // Each test starts from no runs, the cloud computer's included.
  beforeEach(async () => {
    await prisma.vmRun.deleteMany({ where: { workspaceId: ids.workspace } })
    await prisma.previewMachine.deleteMany({ where: { workspaceId: ids.workspace } })
    await prisma.computer.update({ where: { id: ids.cloud }, data: { providerRef: null as never } })
  })

  const thread = async (title = 'A thread') =>
    (
      await db.session.create({
        data: {
          teammateId: ids.riley,
          startedByMemberId: ids.ada,
          computerId: ids.cloud,
          title,
          status: 'idle',
          lastSeq: 0,
        } as never,
      })
    ).id

  const runs = () =>
    prisma.vmRun.findMany({ where: { workspaceId: ids.workspace }, orderBy: { createdAt: 'asc' } })

  const computer = () => ({
    kind: 'computer' as const,
    computerId: ids.cloud,
    organizationId: org,
    workspaceId: ids.workspace,
    size: '2x4' as const,
  })

  /** Ages a run as if it were written `ms` ago. */
  const age = (id: string, ms: number) =>
    prisma.vmRun.update({
      where: { id },
      data: { createdAt: new Date(Date.now() - ms), startedAt: new Date(Date.now() - ms) },
    })

  test('a thread’s machine: made, stopped, started again, each start a run', async () => {
    const machines = new FakeMachines()
    const sessionId = await thread()
    await machineUp(machines, runner(), sessionId, KEY)
    let [made] = await runs()
    assert.equal(made?.status, 'open')
    assert.equal(made?.start, 'create')
    assert.equal(made?.kind, 'machine')
    assert.equal(made?.sessionId, sessionId)
    assert.equal(made?.size, '8x16')
    const vm = machines.byKey.values().next().value!
    assert.equal(made?.sandboxId, vm)

    // Up again while it runs: no start, no new run.
    await machineUp(machines, runner(), sessionId, KEY)
    assert.equal((await runs()).length, 1)

    await machineSleep(machines, runner(), sessionId)
    ;[made] = await runs()
    assert.equal(made?.status, 'closed')
    assert.equal(made?.stoppedBy, 'brigade')
    assert.ok(made?.stoppedAt)

    await machineUp(machines, runner(), sessionId, KEY)
    const all = await runs()
    assert.equal(all.length, 2)
    assert.equal(all[1]?.start, 'resume')
    assert.equal(all[1]?.status, 'open')
    assert.equal(all[1]?.sandboxId, vm)
    const month = await workspaceVmCosts(ids.workspace, new Date().toISOString().slice(0, 7))
    assert.equal(month.machines.count, 1)
    assert.equal(month.machines.starts, 2)
    assert.equal(month.machines.threads[0]?.title, 'A thread')
  })

  test('boat’s webhook ends a run once, never one started after its stop, and only signed', async () => {
    const run = await beginRun(computer(), 'resume', 'vm-hook')
    await runStarted(run, 'vm-hook', { resumedAt: new Date(Date.now() - 60_000) })
    const stoppedAt = new Date(Date.now() - 10_000)

    // Unsigned, signed with another secret, too old, or with no secret configured: refused.
    const forged = signed(archived('vm-hook', stoppedAt), 'whsec_other')
    assert.equal((await boatWebhook(forged, SECRET)).status, 401)
    const stale = signed(
      archived('vm-hook', stoppedAt),
      SECRET,
      Math.floor(Date.now() / 1000) - 900,
    )
    assert.equal((await boatWebhook(stale, SECRET)).status, 401)
    assert.equal((await boatWebhook(signed(archived('vm-hook', stoppedAt)), undefined)).status, 404)
    assert.equal((await runs())[0]?.status, 'open')

    const event = archived('vm-hook', stoppedAt)
    assert.equal((await boatWebhook(signed(event), SECRET)).status, 200)
    let [closed] = await runs()
    assert.equal(closed?.status, 'closed')
    assert.equal(closed?.stoppedBy, 'provider')
    assert.equal(closed?.stoppedAt?.getTime(), stoppedAt.getTime())
    // Sent again: the same.
    assert.equal((await boatWebhook(signed(event), SECRET)).status, 200)
    ;[closed] = await runs()
    assert.equal(closed?.stoppedAt?.getTime(), stoppedAt.getTime())

    // Started again; that first stop's news arriving late does not end the new run.
    const again = await beginRun(computer(), 'resume', 'vm-hook')
    await runStarted(again, 'vm-hook', { resumedAt: new Date() })
    assert.equal((await boatWebhook(signed(archived('vm-hook', stoppedAt)), SECRET)).status, 200)
    const all = await runs()
    assert.equal(all.length, 2)
    assert.equal(all[1]?.status, 'open')
  })

  test('a stop nobody recorded is closed from boat’s list, when boat says it stopped', async () => {
    const ledger = new FakeLedger()
    const run = await beginRun(computer(), 'resume', 'vm-list')
    await runStarted(run, 'vm-list', undefined)
    await age(run!.id, 3 * 3600_000)
    ledger.vms.set('vm-list', 'running')
    await reconcileVmRuns(new Date(), ledger)
    let [open] = await runs()
    assert.equal(open?.status, 'open')
    assert.ok(open?.seenAt, 'seen running')

    // boat stopped it on its own (its TTL), or Brigade's stop was cut off before its record.
    ledger.vms.set('vm-list', 'stopped')
    ledger.ran.set('vm-list', 2 * 3600)
    await reconcileVmRuns(new Date(), ledger)
    ;[open] = await runs()
    assert.equal(open?.status, 'closed')
    assert.equal(open?.stoppedBy, 'provider')
    // It ran two hours from its start, by boat's own count; bounded by when it was last seen.
    const ran = open!.stoppedAt!.getTime() - open!.startedAt.getTime()
    assert.ok(
      ran >= Math.min(2 * 3600_000, open!.seenAt!.getTime() - open!.startedAt.getTime()),
      `ran ${ran} ms`,
    )
    assert.ok(Math.abs(ran - 2 * 3600_000) < 60_000 || open!.stoppedAt! >= open!.seenAt!)
  })

  test('a start retried after a crash is the same run, counted once', async () => {
    // The first attempt wrote its run, asked boat to resume, and its process died.
    const first = await beginRun(computer(), 'resume', 'vm-crash')
    assert.equal(first?.reused, null)
    // The retry: the same run, and boat says the VM is up already (that first resume did it).
    const retry = await beginRun(computer(), 'resume', 'vm-crash')
    assert.equal(retry?.id, first?.id)
    assert.equal(retry?.reused, 'pending')
    await runStarted(retry, 'vm-crash', { resumedAt: null })
    const all = await runs()
    assert.equal(all.length, 1)
    assert.equal(all[0]?.status, 'open')
    assert.equal(all[0]?.start, 'resume', 'counted as the start it was')

    // A fresh start on a VM found up already, with no start cut short: no start counted.
    const found = await beginRun(computer(), 'resume', 'vm-up')
    await runStarted(found, 'vm-up', { resumedAt: null })
    const up = (await runs()).find((r) => r.sandboxId === 'vm-up')
    assert.equal(up?.start, 'found')
  })

  test('a start nobody finished is settled from boat: open, void or closed', async () => {
    const ledger = new FakeLedger()
    const running = await beginRun(computer(), 'resume', 'vm-a')
    const never = await beginRun(computer(), 'resume', 'vm-b')
    const ranThenStopped = await beginRun(computer(), 'resume', 'vm-c')
    const recent = await beginRun(computer(), 'resume', 'vm-d')
    for (const run of [running, never, ranThenStopped]) await age(run!.id, PENDING_MS + 60_000)
    ledger.vms.set('vm-a', 'running')
    ledger.vms.set('vm-b', 'stopped')
    ledger.vms.set('vm-c', 'stopped')
    ledger.ran.set('vm-c', 300)
    // Still being started (its start waits for a stop under way): left for later.
    ledger.vms.set('vm-d', 'stopped')
    await reconcileVmRuns(new Date(), ledger)
    const by = new Map((await runs()).map((r) => [r.sandboxId, r]))
    assert.equal(by.get('vm-a')?.status, 'open')
    assert.equal(by.get('vm-b')?.status, 'void')
    assert.equal(by.get('vm-c')?.status, 'closed')
    const c = by.get('vm-c')!
    assert.equal(c.stoppedAt!.getTime() - c.startedAt.getTime(), 300_000)
    assert.equal(by.get('vm-d')?.status, 'pending')
    assert.equal(recent?.reused, null)

    // The process that asked comes back late: nothing changes for a run settled already.
    await runStarted(never, 'vm-b', { resumedAt: new Date() })
    assert.equal((await prisma.vmRun.findUnique({ where: { id: never!.id } }))?.status, 'void')
  })

  test('a create that never said its VM is void; one made again under its key counts once', async () => {
    const ledger = new FakeLedger()
    const lost = await beginRun(computer(), 'create', null)
    await age(lost!.id, PENDING_MS + 60_000)
    await reconcileVmRuns(new Date(), ledger)
    assert.equal((await prisma.vmRun.findUnique({ where: { id: lost!.id } }))?.status, 'void')

    // A making cut short after boat made the VM, retried under the same key: the same VM.
    const of = { ...computer() }
    const first = await beginRun(of, 'create', null)
    await runMade(first, 'vm-key')
    const second = await beginRun(of, 'create', null)
    await runMade(second, 'vm-key')
    await runStarted(second, 'vm-key', { resumedAt: null })
    const made = (await runs()).filter((r) => r.id === first!.id || r.id === second!.id)
    assert.deepEqual(made.map((r) => r.status).sort(), ['open', 'void'])
    assert.equal(made.find((r) => r.status === 'open')?.id, first!.id)
  })

  test('a VM of Brigade’s running without a run is found, unless its stop came after the list', async () => {
    const ledger = new FakeLedger()
    await prisma.computer.update({
      where: { id: ids.cloud },
      data: { providerRef: { provider: 'boat', id: 'vm-found' } },
    })
    ledger.vms.set('vm-found', 'running')
    ledger.vms.set('vm-not-ours', 'running')
    await reconcileVmRuns(new Date(), ledger)
    let all = await runs()
    assert.equal(all.length, 1, 'only a VM Brigade knows')
    assert.equal(all[0]?.start, 'found')
    assert.equal(all[0]?.status, 'open')
    assert.equal(all[0]?.size, '2x4')
    // Found again next minute: the same run.
    await reconcileVmRuns(new Date(), ledger)
    assert.equal((await runs()).length, 1)

    // Brigade stops it just after boat's list was read (which still says running).
    ledger.onList = async () => {
      ledger.onList = undefined
      await runStopped('vm-found', new Date(), 'brigade')
    }
    await reconcileVmRuns(new Date(), ledger)
    all = await runs()
    assert.equal(all.length, 1, 'not found again from a list older than its stop')
    assert.equal(all[0]?.status, 'closed')
  })

  test('a run left open by an unseen stop ends when last seen, and the new start is a run', async () => {
    const run = await beginRun(computer(), 'resume', 'vm-stale')
    await runStarted(run, 'vm-stale', { resumedAt: new Date(Date.now() - 3600_000) })
    const seenAt = new Date(Date.now() - 1800_000)
    await prisma.vmRun.update({ where: { id: run!.id }, data: { seenAt } })
    const again = await beginRun(computer(), 'resume', 'vm-stale')
    assert.equal(again?.reused, 'open')
    await runStarted(again, 'vm-stale', { resumedAt: new Date() })
    const all = await runs()
    assert.equal(all.length, 2)
    assert.equal(all[0]?.status, 'closed')
    assert.equal(all[0]?.stoppedAt?.getTime(), seenAt.getTime())
    assert.equal(all[1]?.status, 'open')
    assert.equal(all[1]?.start, 'resume')
  })

  test('a resume is counted once when its reused run is settled while boat resumes it', async () => {
    const ledger = new FakeLedger()
    // 1. Its open run, reused; boat's stop webhook closes it while the resume is under way.
    const first = await beginRun(computer(), 'resume', 'vm-race1')
    await runStarted(first, 'vm-race1', { resumedAt: new Date(Date.now() - 3600_000) })
    const reused = await beginRun(computer(), 'resume', 'vm-race1')
    assert.equal(reused?.reused, 'open')
    const stoppedAt = new Date(Date.now() - 60_000)
    assert.equal((await boatWebhook(signed(archived('vm-race1', stoppedAt)), SECRET)).status, 200)
    const resumedAt = new Date(Date.now() - 30_000)
    await runStarted(reused, 'vm-race1', { resumedAt })
    let mine = (await runs()).filter((r) => r.sandboxId === 'vm-race1')
    assert.deepEqual(
      mine.map((r) => [r.status, r.start]),
      [
        ['closed', 'resume'],
        ['open', 'resume'],
      ],
    )
    assert.equal(mine[0]?.stoppedAt?.getTime(), stoppedAt.getTime())
    assert.equal(mine[1]?.startedAt.getTime(), resumedAt.getTime())

    // 2. The same, and the minute's check finds the VM up meanwhile and gives it a found run:
    // that run is this resume, counted as one.
    await prisma.computer.update({
      where: { id: ids.cloud },
      data: { providerRef: { provider: 'boat', id: 'vm-race2' } },
    })
    const old = await beginRun(computer(), 'resume', 'vm-race2')
    await runStarted(old, 'vm-race2', { resumedAt: new Date(Date.now() - 3600_000) })
    const again = await beginRun(computer(), 'resume', 'vm-race2')
    await runStopped('vm-race2', new Date(Date.now() - 60_000), 'provider')
    ledger.vms.set('vm-race2', 'running')
    await reconcileVmRuns(new Date(), ledger)
    assert.equal(
      (await runs()).find((r) => r.sandboxId === 'vm-race2' && r.status === 'open')?.start,
      'found',
    )
    const resumed2 = new Date(Date.now() - 30_000)
    await runStarted(again, 'vm-race2', { resumedAt: resumed2 })
    mine = (await runs()).filter((r) => r.sandboxId === 'vm-race2')
    assert.equal(mine.length, 2)
    assert.equal(mine[1]?.status, 'open')
    assert.equal(mine[1]?.start, 'resume')
    assert.equal(mine[1]?.startedAt.getTime(), resumed2.getTime())

    // 3. A start cut short, retried: the minute's check voids its pending run (the VM stopped,
    // boat says it never ran) while the retry has boat resume it. The resume is a run.
    const cut = await beginRun(computer(), 'resume', 'vm-race3')
    await age(cut!.id, PENDING_MS + 60_000)
    const retry = await beginRun(computer(), 'resume', 'vm-race3')
    assert.equal(retry?.reused, 'pending')
    ledger.vms.set('vm-race3', 'stopped')
    await reconcileVmRuns(new Date(), ledger)
    assert.equal((await prisma.vmRun.findUnique({ where: { id: cut!.id } }))?.status, 'void')
    await runStarted(retry, 'vm-race3', { resumedAt: new Date() })
    mine = (await runs()).filter((r) => r.sandboxId === 'vm-race3')
    assert.deepEqual(
      mine.map((r) => [r.status, r.start]),
      [
        ['void', 'resume'],
        ['open', 'resume'],
      ],
    )
  })

  test('a month’s sums: split at its ends, starts, found and void runs, threads, boat', async () => {
    const at = (iso: string) => new Date(iso)
    const base = {
      organizationId: org,
      workspaceId: ids.workspace,
    }
    const kept = await thread('Kept thread')
    await prisma.vmRun.createMany({
      data: [
        // The computer: 10 hours across October's end (2 in November), resumed in October.
        {
          ...base,
          kind: 'computer',
          computerId: ids.cloud,
          sandboxId: 'vm-c',
          size: '2x4',
          start: 'resume',
          status: 'closed',
          startedAt: at('2026-10-31T16:00:00Z'),
          stoppedAt: at('2026-11-01T02:00:00Z'),
        },
        // Found running: 3 hours, no start.
        {
          ...base,
          kind: 'computer',
          computerId: ids.cloud,
          sandboxId: 'vm-c',
          size: '2x4',
          start: 'found',
          status: 'closed',
          startedAt: at('2026-11-03T00:00:00Z'),
          stoppedAt: at('2026-11-03T03:00:00Z'),
        },
        // Never ran: nothing.
        {
          ...base,
          kind: 'computer',
          computerId: ids.cloud,
          sandboxId: 'vm-c',
          size: '2x4',
          start: 'resume',
          status: 'void',
          startedAt: at('2026-11-04T00:00:00Z'),
        },
        // A thread's machine: made, 1 hour; resumed, 4 hours across November's end (3 in it).
        {
          ...base,
          kind: 'machine',
          sessionId: kept,
          machineId: 'm1',
          sandboxId: 'vm-m1',
          size: '8x16',
          start: 'create',
          status: 'closed',
          startedAt: at('2026-11-10T10:00:00Z'),
          stoppedAt: at('2026-11-10T11:00:00Z'),
        },
        {
          ...base,
          kind: 'machine',
          sessionId: kept,
          machineId: 'm1',
          sandboxId: 'vm-m1',
          size: '8x16',
          start: 'resume',
          status: 'closed',
          startedAt: at('2026-11-30T21:00:00Z'),
          stoppedAt: at('2026-12-01T01:00:00Z'),
        },
        // A deleted thread's machine: 2 hours.
        {
          ...base,
          kind: 'machine',
          sessionId: 'deleted-thread',
          machineId: 'm2',
          sandboxId: 'vm-m2',
          size: '8x16',
          start: 'create',
          status: 'closed',
          startedAt: at('2026-11-12T00:00:00Z'),
          stoppedAt: at('2026-11-12T02:00:00Z'),
        },
      ],
    })
    const ledger = new FakeLedger()
    for (const vm of ['vm-c', 'vm-m1', 'vm-m2']) ledger.vms.set(vm, 'stopped')
    ledger.ran.set('vm-m1', 4 * 3600)
    const report = await workspaceVmCosts(ids.workspace, '2026-11', {
      reconcile: true,
      now: at('2026-12-15T00:00:00Z'),
      ledger,
    })
    assert.equal(report.computer.hours, 5)
    assert.equal(report.computer.starts, 0, 'resumed in October, and found')
    assert.equal(report.computer.cost, Math.round(5 * 0.018 * 1e4) / 1e4)
    assert.equal(report.machines.count, 2)
    assert.equal(report.machines.starts, 3)
    assert.equal(report.machines.hours, 6)
    assert.equal(report.machines.cost, Math.round(6 * 0.072 * 1e4) / 1e4)
    assert.deepEqual(
      report.machines.threads.map((t) => [t.title, t.hours, t.starts]),
      [
        ['Kept thread', 4, 2],
        [null, 2, 1],
      ],
    )
    assert.equal(report.total, Math.round((5 * 0.018 + 6 * 0.072) * 1e4) / 1e4)
    assert.deepEqual(report.snapshots, { saved: 0, cost: 0 })
    // boat's figure beside each VM, for the same month.
    const m1 = report.machines.threads[0]!.vms[0]!
    assert.equal(m1.boatCost, 0.288)
    assert.equal(typeof report.boatTotal, 'number')

    const october = await workspaceVmCosts(ids.workspace, '2026-10', {
      now: at('2026-12-15T00:00:00Z'),
      ledger: null,
    })
    assert.equal(october.computer.hours, 8)
    assert.equal(october.computer.starts, 1)

    const everyone = await allVmCosts('2026-11', at('2026-12-15T00:00:00Z'))
    const mine = everyone.workspaces.find((w) => w.workspaceId === ids.workspace)
    assert.equal(mine?.total, report.total)
    assert.equal(mine?.name, 'VM costs')

    // A run still open counts until now.
    const open = sumRuns(
      ids.workspace,
      '2026-11',
      [
        {
          ...(await runs())[0]!,
          status: 'open',
          startedAt: at('2026-11-20T00:00:00Z'),
          stoppedAt: null,
        },
      ],
      at('2026-11-20T06:00:00Z'),
    )
    assert.equal(open.computer.hours, 6)
  })
})
