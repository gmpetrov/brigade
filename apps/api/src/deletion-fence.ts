// A workspace being deleted (src/workspace-delete.ts) starts no new work: no thread, no turn, no
// cloud computer made, woken or replaced. Its fence is Workspace.deletingAt, set as its deletion
// starts and cleared when it is refused or fails; a fence older than its lease (a deletion cut
// short by a restart) no longer holds, so the workspace is never stuck.
import { HTTPException } from 'hono/http-exception'
import { prisma, type Prisma } from './db.js'

/** How long a deletion's fence holds without being set again. */
export const FENCE_LEASE_MS = 30 * 60_000

export const BEING_DELETED = 'This workspace is being deleted'

const holding = (now = Date.now()) => ({ gt: new Date(now - FENCE_LEASE_MS) })

/** Whether a deletion of the workspace is under way. */
export async function beingDeleted(
  workspaceId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  return (await db.workspace.count({ where: { id: workspaceId, deletingAt: holding() } })) > 0
}

/** 409 while a deletion of the workspace is under way. */
export async function refuseWhileDeleting(workspaceId: string) {
  if (await beingDeleted(workspaceId)) throw new HTTPException(409, { message: BEING_DELETED })
}

/**
 * Put up the fence for this deletion: false when another deletion of it holds one already. Set
 * again, it is renewed for as long as this one takes.
 */
export async function raiseFence(workspaceId: string, renew = false) {
  const now = new Date()
  const { count } = await prisma.workspace.updateMany({
    where: renew
      ? { id: workspaceId }
      : {
          id: workspaceId,
          OR: [
            { deletingAt: null },
            { deletingAt: { lte: new Date(now.getTime() - FENCE_LEASE_MS) } },
          ],
        },
    data: { deletingAt: now },
  })
  return count > 0
}

/** The deletion was refused or failed: the workspace works again. */
export async function lowerFence(workspaceId: string) {
  await prisma.workspace.updateMany({ where: { id: workspaceId }, data: { deletingAt: null } })
}
