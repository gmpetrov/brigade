// What each workspace's VMs cost at the provider (docs/vm-costs.md): its cloud computer and its
// threads' own machines (preview_machines). Each run of a VM is a row (VmRun): its start (a create
// or a resume, which the provider counts as one start each) and the time it ran until it stopped.
//
// Recording, so that a crash anywhere loses nothing and counts nothing twice:
// - before Brigade asks the provider to start a VM, its run is written `pending` (beginRun); one
//   live run at a time per VM (a unique index), so a start asked again (a retry, a restart after
//   a crash) is the same run;
// - the provider's answer opens it (runStarted), from when the provider says it resumed it; a
//   create says its VM as soon as the provider has it (runMade), as it bills from then;
// - Brigade's own stops and destroys close it (runStopped), and so do boat's own stops, from its
//   webhook (POST /api/boat/webhook);
// - each minute, the provider's list (reconcileVmRuns) settles the rest: a pending run whose
//   start was cut short is opened if its VM runs, closed or void from the provider's own figures
//   if not; an open run whose stop nobody saw is closed when its VM ran until, by the provider's
//   usage; a VM of Brigade's running without a run (from before runs were kept) gets one, `found`,
//   counted from then and as no start.
//
// Recording never holds a VM back: a write that fails is logged, and the minute's check settles it.
//
// Reading: per workspace and month, the hours each ran (a run across a month's end split at it),
// at the size's hourly price in @brigade/providers (VM_PRICES), its starts, and, when asked, the
// provider's own figure for each VM over the same month to check against.
import { randomUUID } from 'node:crypto'
import {
  ledgerFromEnv,
  MACHINE_COMPUTER_SIZE,
  VM_PRICES,
  vmCost,
  type ComputerSize,
  type ProviderLedger,
  type StartResult,
  type VmState,
} from '@brigade/providers'
import { defaults } from './config.js'
import { Prisma, prisma } from './db.js'
import type { VmRun } from './generated/prisma/client.js'
import { noteFailure } from './ops/failures.js'

/** The configured provider's own figures; null without one. */
const configured = ledgerFromEnv(process.env)

/** How long a start may be under way before the minute's check settles it from the provider. */
export const PENDING_MS = 15 * 60_000

export const MACHINE_SIZE: ComputerSize = MACHINE_COMPUTER_SIZE

/** What a run is of: the workspace's cloud computer, or a thread's machine. */
export type RunOf = {
  organizationId: string
  workspaceId: string
  size: ComputerSize
} & (
  | { kind: 'computer'; computerId: string }
  | { kind: 'machine'; machineId: string; sessionId: string }
)

/** A run asked for: `reused`, when the VM had one already (pending or open), the same run. */
export type RunHandle = { id: string; reused: 'pending' | 'open' | null } | null

/** A cloud computer's size, as kept on its row. */
export function computerSize(size: string | null | undefined): ComputerSize {
  return size && size in VM_PRICES.hourly ? (size as ComputerSize) : defaults.cloudComputerSize
}

const unique = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'

function failed(what: string, error: unknown) {
  console.error(`vm runs: ${what} failed`, error)
  noteFailure('vm-runs:record', error)
}

const liveOf = (sandboxId: string) =>
  prisma.vmRun.findFirst({ where: { sandboxId, status: { in: ['pending', 'open'] } } })

/**
 * Before asking the provider to start a VM (`sandboxId`), or to make one (null): its run, written
 * pending, or the run it has already. Null when the database failed: the start goes on.
 */
export async function beginRun(
  of: RunOf,
  start: 'create' | 'resume',
  sandboxId: string | null,
): Promise<RunHandle> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (sandboxId) {
        const live = await liveOf(sandboxId)
        if (live) return { id: live.id, reused: live.status as 'pending' | 'open' }
      }
      const row = await prisma.vmRun.create({
        data: {
          organizationId: of.organizationId,
          workspaceId: of.workspaceId,
          kind: of.kind,
          size: of.size,
          ...(of.kind === 'computer'
            ? { computerId: of.computerId }
            : { machineId: of.machineId, sessionId: of.sessionId }),
          sandboxId,
          start,
        },
      })
      return { id: row.id, reused: null }
    } catch (error) {
      // Another start of the same VM wrote its run meanwhile: that one is this one.
      if (unique(error) && attempt === 0) continue
      failed('a start', error)
      return null
    }
  }
  return null
}

/**
 * A create's VM, as soon as the provider has it. Made already under the same key (a retry): that
 * VM's run is the one, and this one is void.
 */
export async function runMade(handle: RunHandle, sandboxId: string) {
  if (!handle) return
  try {
    await prisma.vmRun.updateMany({
      where: { id: handle.id, sandboxId: null, status: 'pending' },
      data: { sandboxId },
    })
  } catch (error) {
    if (!unique(error)) return failed('a create', error)
    await prisma.vmRun
      .updateMany({ where: { id: handle.id, status: 'pending' }, data: { status: 'void' } })
      .catch((e: unknown) => failed('a create', e))
  }
}

/**
 * The provider answered a start. `result` says when it resumed the VM, or null when it was up
 * already; a provider that says nothing (undefined) started it now. A create opens its run as it
 * was written. A resume boat did is counted once, even when the run it reused was settled
 * meanwhile (a stop's webhook, the minute's check): it then gets a run of its own.
 */
export async function runStarted(
  handle: RunHandle,
  sandboxId: string,
  result: StartResult | void,
  now = new Date(),
) {
  if (!handle) return
  try {
    await runMade(handle, sandboxId)
    const resumedAt = result === undefined ? now : result.resumedAt
    // Each write is conditional on the row as read: when another changed it, read it again.
    for (let attempt = 0; attempt < 5; attempt++) {
      let row: VmRun | null = await prisma.vmRun.findUnique({ where: { id: handle.id } })
      if (row && row.sandboxId !== sandboxId) {
        // A create made again under its key gave the VM an earlier attempt made: that one's run.
        row = await liveOf(sandboxId)
        if (row) handle = { id: row.id, reused: row.status as 'pending' | 'open' }
      }
      if (!row) return
      const mine = { id: row.id, status: row.status, updatedAt: row.updatedAt }
      if (row.status === 'pending') {
        // Up already, and no earlier start of this run was cut short: it ran before Brigade saw it.
        const found = row.start === 'resume' && resumedAt === null && handle.reused === null
        const { count } = await prisma.vmRun.updateMany({
          where: mine,
          data: {
            status: 'open',
            seenAt: now,
            ...(found
              ? { start: 'found', startedAt: now }
              : resumedAt
                ? { startedAt: resumedAt }
                : {}),
          },
        })
        if (count) return
        continue
      }
      // Up already: the run it has is the one.
      if (!resumedAt) return
      if (row.status === 'open') {
        // Open when this start began, and the provider still resumed it: it had stopped, unseen.
        // That run ends when it was last seen running, and this start is a run of its own.
        if (handle.reused !== 'open') return
        const end = new Date(Math.max(row.startedAt.getTime(), (row.seenAt ?? resumedAt).getTime()))
        const closed = await prisma.$transaction(async (tx) => {
          const { count } = await tx.vmRun.updateMany({
            where: mine,
            data: { status: 'closed', stoppedAt: end, stoppedBy: 'provider' },
          })
          if (count) await tx.vmRun.create({ data: resumeOf(row, sandboxId, resumedAt, now) })
          return count > 0
        })
        if (closed) return
        continue
      }
      // Settled while this start ran (closed by a stop's news, void from the provider's figures):
      // boat resumed it all the same, so the resume is a run of its own.
      await resumedRun(row, sandboxId, resumedAt, now)
      return
    }
    failed('a start', new Error(`run ${handle.id} kept changing`))
  } catch (error) {
    failed('a start', error)
  }
}

/** A new open run for a resume, as `row`'s VM's. */
function resumeOf(row: VmRun, sandboxId: string, resumedAt: Date, now: Date) {
  return {
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    kind: row.kind,
    computerId: row.computerId,
    machineId: row.machineId,
    sessionId: row.sessionId,
    sandboxId,
    size: row.size,
    start: 'resume' as const,
    status: 'open' as const,
    startedAt: resumedAt,
    seenAt: now,
  }
}

/**
 * A resume whose run was settled meanwhile: a run of its own. When the VM has a live run already
 * (the minute's check found it running and gave it one, as no start), that one is this resume.
 */
async function resumedRun(row: VmRun, sandboxId: string, resumedAt: Date, now: Date) {
  try {
    await prisma.vmRun.create({ data: resumeOf(row, sandboxId, resumedAt, now) })
  } catch (error) {
    if (!unique(error)) throw error
    const live = await liveOf(sandboxId)
    if (live?.start === 'found')
      await prisma.vmRun.updateMany({
        where: { id: live.id, start: 'found' },
        data: {
          start: 'resume',
          startedAt: live.startedAt < resumedAt ? live.startedAt : resumedAt,
        },
      })
  }
}

/**
 * The provider stopped the VM (`by` brigade), or boat did on its own (provider), or it was
 * destroyed: its run ends at `at`. A run started after `at` (a stop's late news) stays open.
 */
export async function runStopped(
  sandboxId: string,
  at: Date,
  by: 'brigade' | 'provider' | 'destroyed',
) {
  try {
    await prisma.vmRun.updateMany({
      where: { sandboxId, status: 'open', startedAt: { lte: at } },
      data: { status: 'closed', stoppedAt: at, stoppedBy: by },
    })
  } catch (error) {
    failed('a stop', error)
  }
}

/** A VM of Brigade's, as its rows say: whose it is. */
type Known = { sandboxId: string; of: RunOf }

/** Every VM Brigade's rows name: cloud computers (and VMs they replaced), threads' machines. */
async function knownVms(): Promise<Known[]> {
  const computers = await prisma.$queryRaw<
    {
      id: string
      organizationId: string
      workspaceId: string
      size: string | null
      sandbox: string
    }[]
  >`SELECT c."id", c."organizationId", c."workspaceId", c."size", c."providerRef"->>'id' AS "sandbox"
    FROM "Computer" c WHERE c."kind" = 'cloud' AND c."providerRef"->>'id' IS NOT NULL
    UNION
    SELECT c."id", c."organizationId", c."workspaceId", c."size", r."oldProviderRef"->>'id'
    FROM "ComputerReplacement" r JOIN "Computer" c ON c."id" = r."computerId"
    WHERE r."oldProviderRef"->>'id' IS NOT NULL`
  const machines = await prisma.$queryRaw<
    {
      id: string
      organizationId: string
      workspaceId: string
      sessionId: string
      sandbox: string
    }[]
  >`SELECT m."id", m."organizationId", m."workspaceId", m."sessionId", m."providerRef"->>'id' AS "sandbox"
    FROM "PreviewMachine" m WHERE m."providerRef"->>'id' IS NOT NULL`
  return [
    ...computers.map((c) => ({
      sandboxId: c.sandbox,
      of: {
        kind: 'computer' as const,
        computerId: c.id,
        organizationId: c.organizationId,
        workspaceId: c.workspaceId,
        size: computerSize(c.size),
      },
    })),
    ...machines.map((m) => ({
      sandboxId: m.sandbox,
      of: {
        kind: 'machine' as const,
        machineId: m.id,
        sessionId: m.sessionId,
        organizationId: m.organizationId,
        workspaceId: m.workspaceId,
        size: MACHINE_SIZE,
      },
    })),
  ]
}

const billing = (state: VmState | undefined) => state === 'running' || state === 'starting'

/**
 * When a run whose stop nobody saw ended: from the provider's usage since it started (the time it
 * ran), no earlier than it was last seen running and no later than the list that found it stopped.
 * Without the provider's figure, when it was last seen running.
 */
async function endOf(ledger: ProviderLedger, run: VmRun, listedAt: Date) {
  const floor = (run.seenAt ?? run.startedAt).getTime()
  const usage = await ledger.usage(run.sandboxId!, run.startedAt, listedAt).catch(() => null)
  if (!usage) return { at: new Date(floor), ran: null }
  const at = run.startedAt.getTime() + usage.runSeconds * 1000
  return {
    at: new Date(Math.min(listedAt.getTime(), Math.max(floor, at))),
    ran: usage.runSeconds,
  }
}

/**
 * Each minute (src/jobs.ts): the runs settled against the provider's list of VMs, read once
 * (docs/vm-costs.md). Every write is conditional on the row as it was read, so a start or a stop
 * recorded meanwhile is never overwritten; and nothing that happened after the list was read is
 * judged from it.
 */
export async function reconcileVmRuns(
  now = new Date(),
  ledger: ProviderLedger | null = configured,
) {
  if (!ledger) return
  const listedAt = new Date()
  const states = await ledger.states()
  const live = await prisma.vmRun.findMany({ where: { status: { in: ['pending', 'open'] } } })
  const old = (run: VmRun) => now.getTime() - run.createdAt.getTime() >= PENDING_MS
  const seen: string[] = []
  for (const run of live) {
    const mine = { id: run.id, status: run.status, updatedAt: run.updatedAt }
    try {
      if (!run.sandboxId) {
        // A create cut short before the provider said its VM: none is known to have been made.
        if (old(run)) {
          console.warn(`vm runs: ${run.id}'s create never said its VM: not counted`)
          await prisma.vmRun.updateMany({ where: mine, data: { status: 'void' } })
        }
        continue
      }
      const state = states.get(run.sandboxId)
      if (billing(state)) {
        if (run.status === 'open') seen.push(run.id)
        // A start cut short after the provider started it: it runs.
        else if (old(run))
          await prisma.vmRun.updateMany({
            where: mine,
            data: { status: 'open', seenAt: listedAt },
          })
        continue
      }
      // Stopped, in error or gone, as of the list: not for a run begun since, nor for a start
      // that may still be under way (it waits for a stop to end first).
      if (run.startedAt >= listedAt || (run.status === 'pending' && !old(run))) continue
      const end = await endOf(ledger, run, listedAt)
      const stoppedBy = state === undefined ? 'destroyed' : 'provider'
      if (run.status === 'pending' && !(end.ran && end.ran >= 1)) {
        // Its start never ran it (or nothing says it did): not counted.
        await prisma.vmRun.updateMany({ where: mine, data: { status: 'void' } })
        continue
      }
      await prisma.vmRun.updateMany({
        where: mine,
        data: { status: 'closed', stoppedAt: end.at, stoppedBy },
      })
    } catch (error) {
      console.warn(`vm runs: settling ${run.id} failed`, error)
    }
  }
  if (seen.length)
    await prisma.vmRun.updateMany({
      where: { id: { in: seen }, status: 'open' },
      data: { seenAt: listedAt },
    })
  await adoptRunning(states, new Set(live.map((r) => r.sandboxId)), listedAt)
}

/**
 * VMs of Brigade's running without a run: one from before runs were kept, or started outside
 * Brigade. Each gets a run from the list's time, counted as no start; not one whose run changed
 * since the list was read (a stop recorded meanwhile), nor one a start is writing now.
 */
async function adoptRunning(
  states: Map<string, VmState>,
  live: Set<string | null>,
  listedAt: Date,
) {
  const known = await knownVms()
  for (const { sandboxId, of } of known) {
    if (live.has(sandboxId) || states.get(sandboxId) !== 'running') continue
    const computerId = of.kind === 'computer' ? of.computerId : null
    const machineId = of.kind === 'machine' ? of.machineId : null
    const sessionId = of.kind === 'machine' ? of.sessionId : null
    const added = await prisma.$executeRaw`
      INSERT INTO "VmRun" ("id", "organizationId", "workspaceId", "kind", "computerId", "machineId",
        "sessionId", "sandboxId", "size", "start", "status", "startedAt", "seenAt", "updatedAt")
      SELECT ${randomUUID()}, ${of.organizationId}, ${of.workspaceId}, ${of.kind}::"VmKind",
        ${computerId}, ${machineId}, ${sessionId}, ${sandboxId}, ${of.size}, 'found'::"VmStart",
        'open'::"VmRunStatus", ${listedAt}, ${listedAt}, now()
      WHERE NOT EXISTS (
        SELECT 1 FROM "VmRun" r WHERE r."sandboxId" = ${sandboxId}
          AND (r."status" IN ('pending', 'open') OR r."updatedAt" >= ${listedAt})
      )
      ON CONFLICT DO NOTHING`.catch((error: unknown) => {
      console.warn(`vm runs: adopting ${sandboxId} failed`, error)
      return 0
    })
    if (added) console.log(`vm runs: ${sandboxId} runs without a run of Brigade's: found`)
  }
}

// --- Boat's webhook --------------------------------------------------------------------------

/** How old a webhook's signature may be. */
const WEBHOOK_TOLERANCE_S = 300

async function hmacHex(secret: string, text: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text))
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function sameText(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * boat's webhook (docs.boat.dev/webhooks): verified over its raw body (HMAC-SHA256 of
 * `delivery.timestamp.body`), then a stop (`sandbox.archived`) ends its VM's run at the event's
 * time. Sent again or out of order, the same event changes nothing more: a run ends once, and
 * never before it started. 404 without a secret configured, 401 when the signature is wrong.
 */
export async function boatWebhook(
  request: Request,
  secret: string | undefined,
  nowMs = Date.now(),
) {
  if (!secret) return Response.json({ error: 'Not found' }, { status: 404 })
  const body = await request.text()
  const delivery = request.headers.get('x-ascii-delivery') ?? ''
  const timestamp = request.headers.get('x-ascii-timestamp') ?? ''
  const signature = (request.headers.get('x-ascii-signature') ?? '').replace(/^v1=/, '')
  const age = Math.abs(nowMs / 1000 - Number(timestamp))
  if (!delivery || !(age <= WEBHOOK_TOLERANCE_S))
    return Response.json({ error: 'Bad signature' }, { status: 401 })
  const expected = await hmacHex(secret, `${delivery}.${timestamp}.${body}`)
  if (!sameText(expected, signature.toLowerCase()))
    return Response.json({ error: 'Bad signature' }, { status: 401 })
  let event: { type?: string; createdAt?: string; data?: { sandbox?: { id?: string } } }
  try {
    event = JSON.parse(body)
  } catch {
    return Response.json({ error: 'Bad body' }, { status: 400 })
  }
  const sandboxId = event.data?.sandbox?.id
  const at = event.createdAt ? new Date(event.createdAt) : null
  if (event.type === 'sandbox.archived' && sandboxId && at && !Number.isNaN(at.getTime()))
    await runStopped(sandboxId, at, 'provider')
  return Response.json({ ok: true })
}

// --- Reading ---------------------------------------------------------------------------------

/** A calendar month, UTC, as "2026-11". */
export type Month = string

export function monthOf(value: string | undefined, now = new Date()): Month | null {
  if (!value) return now.toISOString().slice(0, 7)
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : null
}

export function monthBounds(month: Month) {
  const [year, m] = month.split('-').map(Number) as [number, number]
  return { from: new Date(Date.UTC(year, m - 1, 1)), to: new Date(Date.UTC(year, m, 1)) }
}

/** Used: starts, hours running, and what they cost at list price. */
export type Used = { starts: number; hours: number; cost: number }

export type VmCost = Used & { sandboxId: string; size: ComputerSize; boatCost?: number | null }

export type WorkspaceVmCosts = {
  workspaceId: string
  month: Month
  /** The cloud computer: each VM it had over the month (a replacement makes a new one). */
  computer: Used & { vms: VmCost[] }
  /** The threads' machines: how many ran, and each thread's. */
  machines: Used & {
    count: number
    threads: (Used & { sessionId: string | null; title: string | null; vms: VmCost[] })[]
  }
  /** Saved snapshots billed: Brigade saves none (automatic snapshots are free). */
  snapshots: { saved: number; cost: number }
  total: number
  /** The provider's own figure for the month, when asked for (null: it could not say). */
  boatTotal?: number | null
}

const zero = (): Used => ({ starts: 0, hours: 0, cost: 0 })
const add = (to: Used, from: Used) => {
  to.starts += from.starts
  to.hours += from.hours
  to.cost += from.cost
}
const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits
function rounded<T extends Used>(used: T): T {
  return { ...used, hours: round(used.hours, 3), cost: round(used.cost, 4) }
}

/** What one run used of [from, to): its start if it began then, and the hours it ran then. */
export function usedBy(
  run: Pick<VmRun, 'start' | 'status' | 'startedAt' | 'stoppedAt' | 'size'>,
  from: Date,
  to: Date,
  now: Date,
): Used {
  if (run.status === 'void') return zero()
  const end = run.stoppedAt ?? now
  const ms = Math.max(
    0,
    Math.min(end.getTime(), to.getTime()) - Math.max(run.startedAt.getTime(), from.getTime()),
  )
  const hours = ms / 3_600_000
  const starts = run.start !== 'found' && run.startedAt >= from && run.startedAt < to ? 1 : 0
  return { starts, hours, cost: vmCost(computerSize(run.size), hours) }
}

/** The runs of a month, of one workspace or all. */
function runsOf(month: Month, workspaceId: string | undefined, now: Date) {
  const { from, to } = monthBounds(month)
  return prisma.vmRun.findMany({
    where: {
      ...(workspaceId ? { workspaceId } : {}),
      status: { not: 'void' },
      startedAt: { lt: to < now ? to : now },
      OR: [{ stoppedAt: null }, { stoppedAt: { gt: from } }],
    },
    orderBy: { startedAt: 'asc' },
  })
}

/** Sums one workspace's runs of a month. */
export function sumRuns(
  workspaceId: string,
  month: Month,
  runs: VmRun[],
  now: Date,
  titles: Map<string, string> = new Map(),
): WorkspaceVmCosts {
  const { from, to } = monthBounds(month)
  const computer = { ...zero(), vms: new Map<string, VmCost>() }
  const threads = new Map<string | null, Used & { vms: Map<string, VmCost> }>()
  for (const run of runs) {
    const used = usedBy(run, from, to, now)
    const sandboxId = run.sandboxId ?? '?'
    const into =
      run.kind === 'computer'
        ? computer
        : (threads.get(run.sessionId) ??
          threads.set(run.sessionId, { ...zero(), vms: new Map() }).get(run.sessionId)!)
    add(into, used)
    const vm =
      into.vms.get(sandboxId) ??
      into.vms
        .set(sandboxId, { sandboxId, size: computerSize(run.size), ...zero() })
        .get(sandboxId)!
    add(vm, used)
  }
  const machines = { ...zero(), count: 0 }
  const threadList = [...threads].map(([sessionId, t]) => {
    add(machines, t)
    machines.count += t.vms.size
    return rounded({
      sessionId,
      title: sessionId ? (titles.get(sessionId) ?? null) : null,
      starts: t.starts,
      hours: t.hours,
      cost: t.cost,
      vms: [...t.vms.values()].map(rounded),
    })
  })
  threadList.sort((a, b) => b.cost - a.cost)
  return {
    workspaceId,
    month,
    computer: rounded({ ...computer, vms: [...computer.vms.values()].map(rounded) }),
    machines: rounded({ ...machines, threads: threadList }),
    snapshots: { saved: 0, cost: 0 },
    total: round(computer.cost + machines.cost, 4),
  }
}

/**
 * One workspace's VM costs for a month, its threads named (a deleted thread: no title). With
 * `reconcile`, each VM's own figure from the provider for the same month beside Brigade's.
 */
export async function workspaceVmCosts(
  workspaceId: string,
  month: Month,
  options: { reconcile?: boolean; now?: Date; ledger?: ProviderLedger | null } = {},
): Promise<WorkspaceVmCosts> {
  const now = options.now ?? new Date()
  const runs = await runsOf(month, workspaceId, now)
  const sessionIds = [...new Set(runs.map((r) => r.sessionId).filter((s): s is string => !!s))]
  const sessions = sessionIds.length
    ? await prisma.session.findMany({
        where: { id: { in: sessionIds }, workspaceId },
        select: { id: true, title: true },
      })
    : []
  const report = sumRuns(
    workspaceId,
    month,
    runs,
    now,
    new Map(sessions.map((s) => [s.id, s.title])),
  )
  const ledger = options.ledger === undefined ? configured : options.ledger
  if (options.reconcile && ledger) {
    const { from, to } = monthBounds(month)
    const until = to < now ? to : now
    const vms = [...report.computer.vms, ...report.machines.threads.flatMap((t) => t.vms)]
    let total: number | null = 0
    for (const vm of vms) {
      vm.boatCost =
        vm.sandboxId === '?' || until <= from
          ? null
          : await ledger
              .usage(vm.sandboxId, from, until)
              .then((u) => round(u.dollars, 4))
              .catch(() => null)
      total = total === null || vm.boatCost == null ? null : total + vm.boatCost
    }
    report.boatTotal = total === null ? null : round(total, 4)
  }
  return report
}

/** Every workspace's VM costs for a month, the costliest first, with the account's starts by day. */
export async function allVmCosts(month: Month, now = new Date()) {
  const runs = await runsOf(month, undefined, now)
  const byWorkspace = Map.groupBy(runs, (r) => r.workspaceId)
  const workspaces = await prisma.workspace.findMany({
    where: { id: { in: [...byWorkspace.keys()] } },
    select: { id: true, name: true },
  })
  const names = new Map(workspaces.map((w) => [w.id, w.name]))
  const reports = [...byWorkspace].map(([id, list]) => {
    const report = sumRuns(id, month, list, now)
    return {
      workspaceId: id,
      name: names.get(id) ?? null,
      computer: {
        starts: report.computer.starts,
        hours: report.computer.hours,
        cost: report.computer.cost,
      },
      machines: {
        count: report.machines.count,
        starts: report.machines.starts,
        hours: report.machines.hours,
        cost: report.machines.cost,
      },
      total: report.total,
    }
  })
  reports.sort((a, b) => b.total - a.total)
  // boat's included starts are the account's, per day: the days over them.
  const { from, to } = monthBounds(month)
  const perDay = new Map<string, number>()
  for (const run of runs)
    if (run.start !== 'found' && run.startedAt >= from && run.startedAt < to) {
      const day = run.startedAt.toISOString().slice(0, 10)
      perDay.set(day, (perDay.get(day) ?? 0) + 1)
    }
  const overIncluded = [...perDay]
    .filter(([, n]) => n > VM_PRICES.includedStarts.perDay)
    .map(([day, starts]) => ({ day, starts, extra: starts - VM_PRICES.includedStarts.perDay }))
  return {
    month,
    total: round(
      reports.reduce((sum, r) => sum + r.total, 0),
      4,
    ),
    workspaces: reports,
    starts: { total: [...perDay.values()].reduce((a, b) => a + b, 0), overIncluded },
    prices: VM_PRICES,
  }
}

/** The provider's account (its plan's starts and time left, its wallet), or null. */
export async function providerLimits(ledger: ProviderLedger | null = configured) {
  if (!ledger) return null
  return ledger.limits().catch((error: unknown) => ({ error: String(error) }))
}
