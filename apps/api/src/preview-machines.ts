// Previews on a machine of their own (docs/previews.md, the preview_machines feature). A thread's
// preview runs on a VM of its own at the cloud provider, while its code stays on the cloud
// computer, whose runner keeps the machine's copy in sync as it changes. The runner asks for the
// machine before it starts the app (up), says when nobody used the preview for a while (sleep:
// stopped, its disk kept, costing nothing) and that it is still in use (touch).
//
// Here: whether a thread gets one (its starter has the feature and turned it on in Preferences),
// making it, starting it again, letting the runner's key in, stopping it, and the sweep that
// destroys the machines whose thread is gone or that slept long enough. Everything is in the
// database (PreviewMachine), nothing in memory: any hub or job may pick up where another left.
import type { ApiToRunner, PreviewMachineUp, RunnerToApi } from '@brigade/contracts'
import { machinesFromEnv, type ComputerRef, type MachineProvider } from '@brigade/providers'
import { Prisma, prisma } from './db.js'
import { featuresOfMember } from './features.js'
import type { PreviewMachine, Runner } from './generated/prisma/client.js'

/** The configured provider of preview machines; null without one (no cloud provider). */
const configured = machinesFromEnv(process.env)

/** Machines one workspace may have running at once: past that, a preview runs on the computer. */
export const MACHINES_RUNNING_MAX = 5
/** How long whoever makes a machine holds the making: another `up` meanwhile waits for it. */
export const MAKING_CLAIM_MS = 3 * 60_000
/** How long an `up` waits for a machine another `up` is making, asking every MAKING_POLL_MS. */
export const MAKING_WAIT_MS = 2 * 60_000
const MAKING_POLL_MS = 2_000
/** The provider's own stop is pushed back at most this often, while the runner says it is used. */
export const KEEP_ALIVE_EVERY_MS = 10 * 60_000
/**
 * A running machine the runner said nothing of for this long is stopped by the sweep: its
 * runner sleeps it after 30 minutes without use, so this one was forgotten (a runner gone).
 */
export const UNUSED_STOP_MS = 45 * 60_000
/** A machine stopped this long is destroyed: the provider keeps a stopped disk for 14 days. */
export const STOPPED_DESTROY_MS = 12 * 24 * 3600_000
/** A making abandoned this long (its claim ran out, no machine recorded) is cleaned up. */
const ABANDONED_MS = 30 * 60_000

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

function refOf(value: unknown): ComputerRef | null {
  const ref = value as Partial<ComputerRef> | null
  return ref && typeof ref.provider === 'string' && typeof ref.id === 'string'
    ? { provider: ref.provider, id: ref.id }
    : null
}

/** The provider no longer has it (deleted, or never made). */
const missing = (error: unknown) =>
  (error as { response?: { status?: number } } | null)?.response?.status === 404

/**
 * Whether the thread's preview runs on a machine of its own: its starter has the feature and
 * turned it on (Member.previewMachines). Theirs to choose, as the threads are theirs.
 */
export async function wantsMachine(session: { startedByMemberId: string; workspaceId: string }) {
  const member = await prisma.member.findUnique({
    where: { id: session.startedByMemberId },
    select: { previewMachines: true },
  })
  if (!member?.previewMachines) return false
  const features = await featuresOfMember(session.startedByMemberId, session.workspaceId)
  return features.has('preview_machines')
}

/** The thread's row, made the first time (one per thread: two at once find the same). */
async function rowFor(session: { id: string; organizationId: string; workspaceId: string }) {
  const found = await prisma.previewMachine.findUnique({ where: { sessionId: session.id } })
  if (found) return found
  try {
    return await prisma.previewMachine.create({
      data: {
        organizationId: session.organizationId,
        workspaceId: session.workspaceId,
        sessionId: session.id,
      },
    })
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
      throw error
    return prisma.previewMachine.findUniqueOrThrow({ where: { sessionId: session.id } })
  }
}

/** The provider's name for a thread's machine, and the key that makes a retry give the same one. */
const making = (row: Pick<PreviewMachine, 'id' | 'generation'>) => ({
  name: `brigade-preview-${row.id}`,
  key: `brigade-preview-${row.id}-${row.generation}`,
})

/**
 * The thread's machine, running: made the first time (or again, when the provider no longer has
 * it), started again when it was stopped. One making at a time: an `up` that finds another making
 * it waits for that one.
 */
export async function runningMachine(machines: MachineProvider, rowId: string) {
  const waitUntil = Date.now() + MAKING_WAIT_MS
  for (;;) {
    const row = await prisma.previewMachine.findUniqueOrThrow({ where: { id: rowId } })
    const ref = refOf(row.providerRef)
    if (ref) {
      const status = await machines.status(ref).catch((error: unknown) => {
        if (missing(error)) return 'destroyed' as const
        throw error
      })
      if (status === 'destroyed') {
        // Gone at the provider (its disk expired, or someone deleted it): the next one is made
        // under a new key, and only by the `up` that cleared this one.
        await prisma.previewMachine.updateMany({
          where: {
            id: row.id,
            generation: row.generation,
            providerRef: { equals: row.providerRef! },
          },
          data: {
            providerRef: Prisma.DbNull,
            status: 'creating',
            generation: { increment: 1 },
            claimedUntil: null,
          },
        })
        continue
      }
      // Stopped, stopping or in error: the provider starts it again (boat's remedy for an error
      // is a resume), and waits for a stop under way to end first.
      if (status !== 'running') await machines.start(ref)
      await prisma.previewMachine.update({
        where: { id: row.id },
        data: { status: 'running', stoppedAt: null, usedAt: new Date() },
      })
      return ref
    }

    // None yet: whoever claims the making makes it.
    const now = new Date()
    const claimed = await prisma.previewMachine.updateMany({
      where: {
        id: row.id,
        generation: row.generation,
        providerRef: { equals: Prisma.DbNull },
        OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }],
      },
      data: { status: 'creating', claimedUntil: new Date(now.getTime() + MAKING_CLAIM_MS) },
    })
    if (claimed.count === 0) {
      if (Date.now() > waitUntil)
        throw new Error('The preview machine is still being made: try again in a moment')
      await sleep(MAKING_POLL_MS)
      continue
    }
    const made = await machines.create(making(row))
    await prisma.previewMachine.update({
      where: { id: row.id },
      data: {
        providerRef: made as unknown as Prisma.InputJsonValue,
        status: 'running',
        claimedUntil: null,
        usedAt: new Date(),
        keptAliveAt: new Date(),
        stoppedAt: null,
      },
    })
    return made
  }
}

/** The thread, when it is on the runner's computer; with whether that is a cloud computer. */
async function threadOf(runner: Pick<Runner, 'computerId'>, sessionId: string) {
  return prisma.session.findFirst({
    where: { id: sessionId, computerId: runner.computerId },
    select: {
      id: true,
      organizationId: true,
      workspaceId: true,
      startedByMemberId: true,
      computer: { select: { kind: true } },
    },
  })
}

/**
 * `up`: the thread's machine, running, with the runner's key let in; or null to run the preview
 * on the computer as before (the feature or its starter's preference is off, too many run).
 */
export async function machineUp(
  machines: MachineProvider | null,
  runner: Pick<Runner, 'computerId'>,
  sessionId: string,
  publicKey: string,
): Promise<PreviewMachineUp> {
  const session = await threadOf(runner, sessionId)
  if (!session) throw new Error('Unknown thread')
  if (!machines || session.computer.kind !== 'cloud') return { machine: null }
  if (!(await wantsMachine(session))) return { machine: null }
  const others = await prisma.previewMachine.count({
    where: {
      workspaceId: session.workspaceId,
      status: { in: ['creating', 'running'] },
      sessionId: { not: sessionId },
    },
  })
  if (others >= MACHINES_RUNNING_MAX)
    return {
      machine: null,
      reason:
        `${others} previews already run on machines of their own in this workspace, the most at ` +
        'once: this one runs on the cloud computer',
    }
  const row = await rowFor(session)
  const ref = await runningMachine(machines, row.id)
  const access = await machines.authorize(ref, publicKey)
  return { machine: { id: row.id, ...access, size: machines.size } }
}

/** `sleep`: nobody used the preview for a while, or it stopped. Its disk is kept, at no cost. */
export async function machineSleep(
  machines: MachineProvider | null,
  runner: Pick<Runner, 'computerId'>,
  sessionId: string,
) {
  if (!machines || !(await threadOf(runner, sessionId))) return
  const row = await prisma.previewMachine.findUnique({ where: { sessionId } })
  const ref = refOf(row?.providerRef)
  if (!row || !ref) return
  const { count } = await prisma.previewMachine.updateMany({
    where: { id: row.id, status: 'running' },
    data: { status: 'stopped', stoppedAt: new Date() },
  })
  if (count === 0) return
  await machines.stop(ref).catch((error: unknown) => {
    if (!missing(error)) throw error
  })
}

/** `touch`: the preview is in use; the provider's own stop is pushed back now and then. */
export async function machineTouch(
  machines: MachineProvider | null,
  runner: Pick<Runner, 'computerId'>,
  sessionId: string,
  now = new Date(),
) {
  if (!machines || !(await threadOf(runner, sessionId))) return
  const row = await prisma.previewMachine.findUnique({ where: { sessionId } })
  const ref = refOf(row?.providerRef)
  if (!row || !ref || row.status !== 'running') return
  const due = !row.keptAliveAt || now.getTime() - row.keptAliveAt.getTime() >= KEEP_ALIVE_EVERY_MS
  await prisma.previewMachine.update({
    where: { id: row.id },
    data: { usedAt: now, ...(due ? { keptAliveAt: now } : {}) },
  })
  if (due) await machines.keepAlive(ref)
}

/**
 * A runner's preview.machine call, answered like a connector call. A failure is said to the
 * runner, which then runs the preview on the computer and says why.
 */
export async function handlePreviewMachine(
  runner: Pick<Runner, 'computerId'>,
  call: Extract<RunnerToApi, { type: 'preview.machine' }>,
  reply: (message: ApiToRunner) => void,
  machines: MachineProvider | null = configured,
) {
  const done = (output: unknown) =>
    reply({ type: 'connector.result', callId: call.callId, ok: true, output })
  const fail = (error: string) =>
    reply({ type: 'connector.result', callId: call.callId, ok: false, error })
  try {
    if (call.action === 'up') {
      if (!call.publicKey) return fail('Give the key to let in')
      return done(await machineUp(machines, runner, call.sessionId, call.publicKey))
    }
    if (call.action === 'sleep') await machineSleep(machines, runner, call.sessionId)
    else await machineTouch(machines, runner, call.sessionId)
    return done({ ok: true })
  } catch (error) {
    console.warn(`preview machine ${call.action} for ${call.sessionId} failed`, error)
    return fail(error instanceof Error ? error.message : String(error))
  }
}

/** Destroy a machine at the provider, unless it no longer has it. */
async function destroyed(machines: MachineProvider, ref: ComputerRef) {
  await machines.destroy(ref).catch((error: unknown) => {
    if (!missing(error)) throw error
  })
}

/**
 * Each minute: a machine whose thread is gone (deleted, or its workspace) is destroyed, then its
 * row; one stopped for STOPPED_DESTROY_MS too; a running one its runner forgot is stopped; a
 * making abandoned without a machine recorded is undone. A failure is tried again next minute.
 */
export async function sweepPreviewMachines(
  now = new Date(),
  machines: MachineProvider | null = configured,
) {
  if (!machines) return
  const rows = await prisma.previewMachine.findMany({ orderBy: { updatedAt: 'asc' }, take: 500 })
  if (rows.length === 0) return
  const alive = new Set(
    (
      await prisma.session.findMany({
        where: { id: { in: rows.map((r) => r.sessionId) } },
        select: { id: true },
      })
    ).map((s) => s.id),
  )
  for (const row of rows) {
    try {
      await sweepOne(machines, row, alive.has(row.sessionId), now)
    } catch (error) {
      console.warn(`preview machine ${row.id}: sweep failed`, error)
    }
  }
}

async function sweepOne(
  machines: MachineProvider,
  row: PreviewMachine,
  threadAlive: boolean,
  now: Date,
) {
  const ref = refOf(row.providerRef)
  const since = (at: Date | null) => (at ? now.getTime() - at.getTime() : 0)
  const claimed = row.claimedUntil !== null && row.claimedUntil.getTime() > now.getTime()

  if (!ref) {
    // Being made right now: left to its making.
    if (claimed) return
    if (row.claimedUntil !== null && (threadAlive ? since(row.updatedAt) >= ABANDONED_MS : true)) {
      // A making that may have reached the provider before it was cut short: asked again under
      // the same key, the provider gives that machine (or makes one), which is destroyed.
      const { count } = await prisma.previewMachine.updateMany({
        where: { id: row.id, updatedAt: row.updatedAt },
        data: { claimedUntil: new Date(now.getTime() + MAKING_CLAIM_MS) },
      })
      if (count === 0) return
      const made = await machines.create(making(row))
      await destroyed(machines, made)
      await prisma.previewMachine.deleteMany({ where: { id: row.id } })
      return
    }
    // Never made, and its thread gone: nothing to destroy.
    if (!threadAlive)
      await prisma.previewMachine.deleteMany({ where: { id: row.id, updatedAt: row.updatedAt } })
    return
  }

  if (!threadAlive || (row.status === 'stopped' && since(row.stoppedAt) >= STOPPED_DESTROY_MS)) {
    await destroyed(machines, ref)
    await prisma.previewMachine.deleteMany({ where: { id: row.id, updatedAt: row.updatedAt } })
    return
  }

  if (row.status === 'running' && since(row.usedAt) >= UNUSED_STOP_MS) {
    const { count } = await prisma.previewMachine.updateMany({
      where: { id: row.id, updatedAt: row.updatedAt },
      data: { status: 'stopped', stoppedAt: now },
    })
    if (count > 0)
      await machines.stop(ref).catch((error: unknown) => {
        if (!missing(error)) throw error
      })
  }
}
