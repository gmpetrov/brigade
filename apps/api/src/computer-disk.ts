// A cloud computer's disk that stays full once its runner freed what it could (caches,
// dependencies of quiet threads, archived folders): kept on the computer for Brigade's
// operators, whom the disk: alert tells (src/ops/checks.ts). Members are not asked: nothing
// they can do frees it (deleting threads frees no more than archiving their folders did), and
// a larger disk is not theirs to choose yet.
import { Prisma, prisma, scoped } from './db.js'

/** What takes room on a full disk, as the runner measured it (largestInHomes). */
export type DiskEntry = { path: string; bytes: number }

/** Computer.disk: set while the disk stays full, null otherwise. */
export type DiskState = {
  used: number
  /** When it was first said full, as an ISO time; kept while it stays full. */
  since: string
  /** When it was last said full. */
  at: string
  largest?: DiskEntry[]
}

type Runner = { organizationId: string; workspaceId: string; computerId: string }

/** What the runner said (a `disk` message). */
export async function noteDisk(
  runner: Runner,
  disk: { full: boolean; used: number; largest?: DiskEntry[] },
  now = new Date(),
) {
  // A ticket an older API opened asked members to delete threads: it closes.
  await scoped(runner).ticket.updateMany({
    where: {
      type: 'disk_full',
      status: 'open',
      payload: { path: ['computerId'], equals: runner.computerId },
    },
    data: { status: 'resolved', resolvedAt: now },
  })
  const where = { id: runner.computerId, workspaceId: runner.workspaceId }
  if (!disk.full) {
    await prisma.computer.updateMany({
      where: { ...where, NOT: { disk: { equals: Prisma.DbNull } } },
      data: { disk: Prisma.DbNull },
    })
    return
  }
  const computer = await prisma.computer.findFirst({ where, select: { kind: true, disk: true } })
  // A member's machine is theirs to clean up; its runner never says this anyway.
  if (computer?.kind !== 'cloud') return
  const was = computer.disk as DiskState | null
  const state: DiskState = {
    used: disk.used,
    since: was?.since ?? now.toISOString(),
    at: now.toISOString(),
    ...(disk.largest?.length ? { largest: disk.largest } : {}),
  }
  await prisma.computer.updateMany({ where, data: { disk: state as Prisma.InputJsonValue } })
}

/** The cloud computers whose disk stays full, for the disk: alert. */
export const fullDisks = async () =>
  (
    await prisma.computer.findMany({
      where: { kind: 'cloud', NOT: { disk: { equals: Prisma.DbNull } } },
      select: { id: true, disk: true },
    })
  ).map((c) => ({ id: c.id, disk: c.disk as DiskState }))

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`

/** What the disk: alert says of a computer's full disk. */
export function diskDetail(state: DiskState) {
  const largest = state.largest?.length
    ? ` Largest in teammates' homes: ${state.largest.map((e) => `${e.path} ${gb(e.bytes)}`).join(', ')}.`
    : ''
  return (
    `The disk is ${Math.round(state.used * 100)}% full since ${state.since.slice(0, 16)}Z, and the runner ` +
    `has freed what it could (caches, dependencies of quiet threads, archived thread folders).${largest} ` +
    'What is left is in use, or outside thread folders where nothing frees it on its own: free it by hand ' +
    '(docs/monitoring.md). Members are not asked.'
  )
}
