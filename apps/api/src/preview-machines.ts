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
//
// One operation on a machine at a time: whoever makes, starts, stops or destroys it holds its row
// (claimedUntil) for as long. Every change of who holds a machine (an `up`'s reserve, a stop, a
// destroy) is decided under one lock per workspace, on the row read under that lock: work the
// sweep listed earlier never acts on a machine an `up` took since, and starts in several threads
// at once never run more machines than MACHINES_RUNNING_MAX, a machine being stopped counted
// until the provider says it stopped. The provider's work is done outside the lock, the row held.
import type { ApiToRunner, PreviewMachineUp, RunnerToApi } from '@brigade/contracts'
import { machinesFromEnv, type ComputerRef, type MachineProvider } from '@brigade/providers'
import { Prisma, prisma } from './db.js'
import { featuresOfMember } from './features.js'
import type { PreviewMachine, Runner } from './generated/prisma/client.js'
import type { PreviewMachineStatus } from './generated/prisma/enums.js'
import { beginRun, MACHINE_SIZE, runMade, runStarted, runStopped } from './vm-costs.js'

/** The configured provider of preview machines; null without one (no cloud provider). */
const configured = machinesFromEnv(process.env)

/** Machines one workspace may have up at once: past that, a preview runs on the computer. */
export const MACHINES_RUNNING_MAX = 5
/**
 * How long an operation on a machine holds it (making, starting, stopping, destroying), from the
 * moment it took it: longer than any of the provider's calls takes (each request gives up after
 * a minute; a start waits for a stop under way first), so a claim never runs out under work still
 * going. Its only cost: a machine whose operation's process was lost waits that long.
 */
export const CLAIM_MS = 10 * 60_000
/** Longest one sweep goes on taking rows: what it did not reach waits for the next. */
const SWEEP_TIME_MS = 2 * 60_000
/** How long an `up` waits for another operation on its machine, asking every POLL_MS. */
export const BUSY_WAIT_MS = 2 * 60_000
const POLL_MS = 2_000
/** The provider's own stop is pushed back at most this often, while the runner says it is used. */
export const KEEP_ALIVE_EVERY_MS = 10 * 60_000
/**
 * A running machine the runner said nothing of for this long is stopped by the sweep: its
 * runner sleeps it after 30 minutes without use, so this one was forgotten (a runner gone), or
 * its stop failed (which leaves it running and due).
 */
export const UNUSED_STOP_MS = 45 * 60_000
/** A machine stopped this long is destroyed: the provider keeps a stopped disk for 14 days. */
export const STOPPED_DESTROY_MS = 12 * 24 * 3600_000
/** A making left this long without a machine recorded (cut short) is undone. */
export const ABANDONED_MS = 30 * 60_000
/** Rows one sweep looks at: only those with work due, the least recently touched first. */
const SWEEP_BATCH = 100

/**
 * What holds one of the workspace's slots: a machine up, being made or started, or being
 * stopped (until the provider says it stopped, it may still run, and bill).
 */
const UP: PreviewMachineStatus[] = ['creating', 'running', 'stopping']

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

/** The provider's name for a thread's machine, and the key that makes a retry give the same one. */
const making = (row: Pick<PreviewMachine, 'id' | 'generation'>) => ({
  name: `brigade-preview-${row.id}`,
  key: `brigade-preview-${row.id}-${row.generation}`,
})

/** What a machine's VM runs are of (src/vm-costs.ts): its thread's, at the machines' size. */
const ofMachine = (
  row: Pick<PreviewMachine, 'id' | 'organizationId' | 'workspaceId' | 'sessionId'>,
) => ({
  kind: 'machine' as const,
  machineId: row.id,
  sessionId: row.sessionId,
  organizationId: row.organizationId,
  workspaceId: row.workspaceId,
  size: MACHINE_SIZE,
})

/**
 * Make the machine under its key, its run written first (src/vm-costs.ts) and given its VM as
 * soon as the provider has it: a making retried under the same key is the same run.
 */
async function make(machines: MachineProvider, row: PreviewMachine) {
  const run = await beginRun(ofMachine(row), 'create', null)
  const ref = await machines.create({ ...making(row), onCreated: (made) => runMade(run, made.id) })
  await runStarted(run, ref.id, { resumedAt: null })
  return ref
}

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

type Session = { id: string; organizationId: string; workspaceId: string }

/**
 * Under a lock on the workspace: the thread's row, made the first time, held by this `up` while
 * it brings the machine up. `busy`: another operation holds it (a making, a stop, a destroy), so
 * the `up` waits; `over`: it needs a slot and the workspace has none free.
 */
async function reserve(
  session: Session,
): Promise<{ row: PreviewMachine } | { busy: true } | { over: number }> {
  return underLock(session.workspaceId, async (tx) => {
    const now = new Date()
    const row = await tx.previewMachine.findUnique({ where: { sessionId: session.id } })
    if (row && (row.status === 'destroying' || (row.claimedUntil && row.claimedUntil > now)))
      return { busy: true }
    if (!row || !UP.includes(row.status)) {
      const others = await tx.previewMachine.count({
        where: {
          workspaceId: session.workspaceId,
          status: { in: UP },
          sessionId: { not: session.id },
        },
      })
      if (others >= MACHINES_RUNNING_MAX) return { over: others }
    }
    const held = { claimedUntil: new Date(now.getTime() + CLAIM_MS), usedAt: now }
    if (!row)
      return {
        row: await tx.previewMachine.create({
          data: {
            organizationId: session.organizationId,
            workspaceId: session.workspaceId,
            sessionId: session.id,
            status: 'creating',
            ...held,
          },
        }),
      }
    // Stopped, or a stop whose process was lost: started again (the provider waits for a stop
    // under way). Being made or running: brought up as it is.
    const status =
      row.status === 'stopped' || row.status === 'stopping'
        ? refOf(row.providerRef)
          ? ('running' as const)
          : ('creating' as const)
        : row.status
    // Taken as read: a write meanwhile from outside the lock (a holder finishing) is waited for.
    const { count } = await tx.previewMachine.updateMany({
      where: { id: row.id, updatedAt: row.updatedAt },
      data: { ...held, status, ...(status !== row.status ? { stoppedAt: null } : {}) },
    })
    if (count === 0) return { busy: true }
    return { row: await tx.previewMachine.findUniqueOrThrow({ where: { id: row.id } }) }
  })
}

/**
 * Holding the row `reserve` gave: the machine running, made (or made again under a new key,
 * once the provider lost it) or started again. The row is released either way: after a failure,
 * the next `up` tries again, and a making's key gives the machine it may have made.
 */
async function bringUp(machines: MachineProvider, held: PreviewMachine) {
  const claim = held.claimedUntil!
  const mine = { id: held.id, claimedUntil: claim }
  try {
    let ref = refOf(held.providerRef)
    if (ref) {
      const status = await machines.status(ref).catch((error: unknown) => {
        if (missing(error)) return 'destroyed' as const
        throw error
      })
      if (status === 'destroyed') {
        // Lost at the provider (its disk expired, or someone deleted it): the next one is made
        // under a new key, written down before it is made, as the sweep undoes it by that key.
        const { count } = await prisma.previewMachine.updateMany({
          where: mine,
          data: {
            providerRef: Prisma.DbNull,
            status: 'creating',
            generation: { increment: 1 },
          },
        })
        if (count === 0) throw new Error('The preview machine was taken over meanwhile')
        held = await prisma.previewMachine.findUniqueOrThrow({ where: { id: held.id } })
        ref = null
      } else if (status !== 'running') {
        // Stopped, stopping or in error: the provider starts it again (boat's remedy for an
        // error is a resume), and waits for a stop under way to end first. Its run first.
        const run = await beginRun(ofMachine(held), 'resume', ref.id)
        await runStarted(run, ref.id, await machines.start(ref))
      }
    }
    const made = !ref
    if (!ref) ref = await make(machines, held)
    const { count } = await prisma.previewMachine.updateMany({
      where: mine,
      data: {
        providerRef: ref as unknown as Prisma.InputJsonValue,
        status: 'running',
        claimedUntil: null,
        stoppedAt: null,
        usedAt: new Date(),
        ...(made ? { keptAliveAt: new Date() } : {}),
      },
    })
    if (count === 0) throw new Error('The preview machine was taken over meanwhile')
    return ref
  } catch (error) {
    await prisma.previewMachine.updateMany({ where: mine, data: { claimedUntil: null } })
    throw error
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
  const waitUntil = Date.now() + BUSY_WAIT_MS
  for (;;) {
    const reserved = await reserve(session)
    if ('busy' in reserved) {
      if (Date.now() > waitUntil)
        throw new Error('The preview machine is busy (being made, stopped or removed): try again')
      await sleep(POLL_MS)
      continue
    }
    if ('over' in reserved)
      return {
        machine: null,
        reason:
          `${reserved.over} previews already run on machines of their own in this workspace, the ` +
          'most at once: this one runs on the cloud computer',
      }
    const ref = await bringUp(machines, reserved.row)
    const access = await machines.authorize(ref, publicKey)
    return { machine: { id: reserved.row.id, ...access, size: machines.size } }
  }
}

/**
 * Under the workspace's lock, which every change of who holds a machine takes (a reserve, a
 * stop, a destroy): each decides on its row as it is now, read under the lock, so none acts on
 * a machine another took meanwhile.
 */
function underLock<T>(workspaceId: string, work: (tx: Tx) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`preview-machines:${workspaceId}`}))`
    return work(tx as unknown as Tx)
  })
}

/** What the transitions read and write under the lock. */
type Tx = Pick<typeof prisma, 'previewMachine' | 'session'>

/**
 * A stop, from the row it holds (`stopping`, still counted as up): the provider's stop, then
 * `stopped`. When the provider fails, the row is running again and due for the sweep's next
 * stop. A process lost meanwhile leaves the row `stopping`, which the sweep takes up once its
 * claim ran out.
 */
async function finishStop(machines: MachineProvider, held: PreviewMachine, now: Date) {
  const ref = refOf(held.providerRef)
  const mine = { id: held.id, claimedUntil: held.claimedUntil! }
  try {
    if (ref) {
      const gone = await machines.stop(ref).then(
        () => false,
        (error: unknown) => {
          if (!missing(error)) throw error
          return true
        },
      )
      await runStopped(ref.id, new Date(), gone ? 'destroyed' : 'brigade')
    }
  } catch (error) {
    await prisma.previewMachine.updateMany({
      where: mine,
      data: {
        status: 'running',
        claimedUntil: null,
        // Due for the sweep's next stop, whenever it runs.
        usedAt: new Date(now.getTime() - UNUSED_STOP_MS - 60_000),
      },
    })
    throw error
  }
  await prisma.previewMachine.updateMany({
    where: mine,
    data: { status: 'stopped', stoppedAt: new Date(), claimedUntil: null },
  })
}

/**
 * A destroy, from the row it holds (`destroying`): the provider's destroy (a making cut short
 * is destroyed by its key, which gives the machine it may have made), then the row. When the
 * provider fails, the row stays `destroying`, due for the next sweep once its claim ran out.
 */
async function finishDestroy(machines: MachineProvider, held: PreviewMachine) {
  const ref = refOf(held.providerRef) ?? (await make(machines, held))
  await machines.destroy(ref).catch((error: unknown) => {
    if (!missing(error)) throw error
  })
  await runStopped(ref.id, new Date(), 'destroyed')
  await prisma.previewMachine.deleteMany({
    where: { id: held.id, claimedUntil: held.claimedUntil, status: 'destroying' },
  })
}

/** `sleep`: nobody used the preview for a while, or it stopped. Its disk is kept, at no cost. */
export async function machineSleep(
  machines: MachineProvider | null,
  runner: Pick<Runner, 'computerId'>,
  sessionId: string,
) {
  const session = machines && (await threadOf(runner, sessionId))
  if (!machines || !session) return
  const held = await underLock(session.workspaceId, async (tx) => {
    const now = new Date()
    const row = await tx.previewMachine.findUnique({ where: { sessionId } })
    // Being made, started or stopped by another: that one's to finish.
    if (!row || row.status !== 'running' || (row.claimedUntil && row.claimedUntil > now))
      return null
    return claim(tx, row, 'stopping')
  })
  if (held) await finishStop(machines, held, new Date())
}

/**
 * Hold a row read under the lock, as it was read (a write since, from outside the lock, leaves
 * it to be judged again), with a claim that runs from now, when it is taken. Null when it changed.
 */
async function claim(tx: Tx, row: PreviewMachine, status: 'stopping' | 'destroying') {
  const { count } = await tx.previewMachine.updateMany({
    where: { id: row.id, updatedAt: row.updatedAt },
    data: { status, claimedUntil: new Date(Date.now() + CLAIM_MS) },
  })
  return count === 0 ? null : tx.previewMachine.findUniqueOrThrow({ where: { id: row.id } })
}

/** `touch`: the preview is in use; the provider's own stop is pushed back now and then. */
export async function machineTouch(
  machines: MachineProvider | null,
  runner: Pick<Runner, 'computerId'>,
  sessionId: string,
  now = new Date(),
) {
  const session = machines && (await threadOf(runner, sessionId))
  if (!machines || !session) return
  // Under the lock: a sweep judging this machine idle sees the touch, or comes before it.
  const touched = await underLock(session.workspaceId, async (tx) => {
    const row = await tx.previewMachine.findUnique({ where: { sessionId } })
    const ref = refOf(row?.providerRef)
    if (!row || !ref || row.status !== 'running') return null
    const due = !row.keptAliveAt || now.getTime() - row.keptAliveAt.getTime() >= KEEP_ALIVE_EVERY_MS
    await tx.previewMachine.updateMany({
      where: { id: row.id, status: 'running' },
      data: { usedAt: now, ...(due ? { keptAliveAt: now } : {}) },
    })
    return due ? ref : null
  })
  if (touched) await machines.keepAlive(touched)
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

/**
 * What the sweep does with a row, as it is now: nothing, a stop, a destroy. `now`: the sweep's
 * time, for what is due; a claim is judged at the time it is read.
 */
export function dueFor(row: PreviewMachine, threadAlive: boolean, now: Date) {
  const before = (ms: number) => now.getTime() - ms
  // Held by an operation under way: not the sweep's, until its claim runs out.
  if (row.claimedUntil && row.claimedUntil.getTime() > Math.max(Date.now(), now.getTime()))
    return null
  if (!threadAlive || row.status === 'destroying') return 'destroy' as const
  if (row.status === 'stopped' && (row.stoppedAt?.getTime() ?? 0) < before(STOPPED_DESTROY_MS))
    return 'destroy' as const
  if (
    row.status === 'creating' &&
    !refOf(row.providerRef) &&
    row.updatedAt.getTime() < before(ABANDONED_MS)
  )
    return 'destroy' as const
  // A stop whose process was lost (its claim ran out), or a machine its runner forgot.
  if (row.status === 'stopping') return 'stop' as const
  if (row.status === 'running' && row.usedAt.getTime() < before(UNUSED_STOP_MS))
    return 'stop' as const
  return null
}

/**
 * One row of the sweep: under the workspace's lock, read again and judged as it is now (an `up`
 * may have taken it since the sweep listed it), then held (`stopping`, `destroying`) for the
 * provider's work, done outside the lock.
 */
export async function sweepMachine(
  machines: MachineProvider,
  id: string,
  workspaceId: string,
  now: Date,
) {
  const decided = await underLock(workspaceId, async (tx) => {
    const row = await tx.previewMachine.findUnique({ where: { id } })
    if (!row) return null
    const alive = (await tx.session.count({ where: { id: row.sessionId } })) > 0
    const due = dueFor(row, alive, now)
    if (!due) return null
    const held = await claim(tx, row, due === 'destroy' ? 'destroying' : 'stopping')
    return held && { due, held }
  })
  if (!decided) return null
  if (decided.due === 'destroy') await finishDestroy(machines, decided.held)
  else await finishStop(machines, decided.held, new Date())
  return decided.due
}

/**
 * Each minute, the rows with work due, and those only (so rows with none never hold others
 * back): a machine whose thread is gone (deleted, or its workspace) is destroyed, then its row;
 * one stopped for STOPPED_DESTROY_MS too; a running one its runner forgot (or whose stop failed)
 * is stopped, and a stop its process lost is taken up; a making cut short is undone; a
 * destruction that failed is tried again. Each is judged again as it is acted on (sweepMachine).
 * A failure leaves its row due, tried again next minute after the others.
 */
export async function sweepPreviewMachines(
  now = new Date(),
  machines: MachineProvider | null = configured,
) {
  if (!machines) return
  const ago = (ms: number) => new Date(now.getTime() - ms)
  const due = await prisma.$queryRaw<{ id: string; workspaceId: string }[]>`
    SELECT pm."id", pm."workspaceId" FROM "PreviewMachine" pm
    WHERE (pm."claimedUntil" IS NULL OR pm."claimedUntil" < ${now})
      AND (
        NOT EXISTS (SELECT 1 FROM "Session" s WHERE s."id" = pm."sessionId")
        OR pm."status" IN ('destroying', 'stopping')
        OR (pm."status" = 'stopped' AND pm."stoppedAt" < ${ago(STOPPED_DESTROY_MS)})
        OR (pm."status" = 'running' AND pm."usedAt" < ${ago(UNUSED_STOP_MS)})
        OR (pm."status" = 'creating' AND pm."providerRef" IS NULL AND pm."updatedAt" < ${ago(ABANDONED_MS)})
      )
    ORDER BY pm."updatedAt" ASC
    LIMIT ${SWEEP_BATCH}`
  const until = Date.now() + SWEEP_TIME_MS
  for (const row of due) {
    // A slow provider: the rest waits for the next sweep, which lists them again.
    if (Date.now() > until) break
    try {
      await sweepMachine(machines, row.id, row.workspaceId, now)
    } catch (error) {
      console.warn(`preview machine ${row.id}: sweep failed`, error)
    }
  }
}
