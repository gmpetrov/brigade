// A cloud computer's disk that stays full once its runner freed what it could
// (caches, dependencies of quiet threads, archived folders): a ticket asks the
// workspace's owners and admins to act, and closes once there is room again.
import { prisma, scoped } from './db.js'

/** After a person dismissed one, none again for this long while the disk stays full. */
const DISMISSED_FOR_MS = 24 * 60 * 60_000

type Runner = { organizationId: string; workspaceId: string; computerId: string }

/** What the runner said (a `disk` message): open the ticket, or close it. */
export async function noteDisk(runner: Runner, disk: { full: boolean; used: number }) {
  const db = scoped(runner)
  const ofComputer = {
    type: 'disk_full' as const,
    payload: { path: ['computerId'], equals: runner.computerId },
  }
  if (!disk.full) {
    await db.ticket.updateMany({
      where: { ...ofComputer, status: 'open' },
      data: { status: 'resolved', resolvedAt: new Date() },
    })
    return
  }
  const open = await db.ticket.findFirst({
    where: { ...ofComputer, status: 'open' },
    select: { id: true, payload: true },
  })
  if (open) {
    // How full it says, kept to the percent.
    const said = (open.payload as { used?: number }).used ?? 0
    if (Math.round(said * 100) !== Math.round(disk.used * 100))
      await db.ticket.update({
        where: { id: open.id },
        data: {
          payload: {
            computerId: runner.computerId,
            used: disk.used,
            reason: diskFullReason(disk.used),
          },
        },
      })
    return
  }
  const dismissed = await db.ticket.count({
    where: {
      ...ofComputer,
      resolvedByMemberId: { not: null },
      resolvedAt: { gte: new Date(Date.now() - DISMISSED_FOR_MS) },
    },
  })
  if (dismissed) return
  const computer = await prisma.computer.findFirst({
    where: { id: runner.computerId, workspaceId: runner.workspaceId },
    select: { kind: true },
  })
  // A member's own machine is theirs to clean up; its runner never says this anyway.
  if (computer?.kind !== 'cloud') return
  await db.ticket.create({
    data: {
      organizationId: runner.organizationId,
      workspaceId: runner.workspaceId,
      type: 'disk_full',
      title: "The cloud computer's disk is full",
      payload: {
        computerId: runner.computerId,
        used: disk.used,
        reason: diskFullReason(disk.used),
      },
    },
  })
}

/** What the ticket says. */
export function diskFullReason(used: number) {
  return (
    `The disk is ${Math.round(used * 100)}% full, and Brigade has already freed what it could: ` +
    "tool caches, the dependencies of quiet threads, the folders of threads nobody uses. Teammates' " +
    'work may fail until there is room. Delete the threads you no longer need, which removes their ' +
    'folders, or give the computer a larger disk. This closes by itself once there is room again.'
  )
}
