// Deleting a thread for good: its rows, and every object it left in the bucket.
// The bucket goes first: if it fails, the thread is still there to delete again,
// rather than gone with its files left behind where nothing points to them.
import { HTTPException } from 'hono/http-exception'
import { audit, type Actor } from './audit.js'
import { attachmentKey, deleteObject, folderArchiveKey, repoBackupKey } from './bucket.js'
import { prisma, type Scope, type ScopedDb } from './db.js'

/** While a teammate works in it, the thread's computer is still writing to it. */
const BUSY = new Set(['starting', 'running'])

/**
 * The bucket keys a thread owns: files given to it that no other thread has, files its
 * teammates sent from it, its teammates' folder archives and its git backups.
 */
export async function threadObjectKeys(db: ScopedDb, scope: Scope, sessionId: string) {
  const keys = new Set<string>()

  // A file in several threads (one email two triggers matched) stays for the others.
  const given = await db.threadAttachment.findMany({
    where: { sessionId },
    select: { attachmentId: true },
  })
  const shared = given.length
    ? await db.threadAttachment.findMany({
        where: {
          attachmentId: { in: given.map((g) => g.attachmentId) },
          sessionId: { not: sessionId },
        },
        select: { attachmentId: true },
      })
    : []
  const sharedIds = new Set(shared.map((s) => s.attachmentId))
  const sent = await db.attachment.findMany({ where: { sessionId }, select: { id: true } })
  const own = [
    ...given.map((g) => g.attachmentId).filter((id) => !sharedIds.has(id)),
    ...sent.map((s) => s.id),
  ]
  for (const id of own) keys.add(attachmentKey(scope, id))

  // Folder archives and git backups are keyed by thread and teammate. The audit log has
  // each one, also for a teammate that has left the thread since.
  const seats = await db.threadTeammate.findMany({
    where: { sessionId },
    select: { teammateId: true },
  })
  for (const { teammateId } of seats) keys.add(folderArchiveKey(scope, { sessionId, teammateId }))
  const stored = await prisma.auditEntry.findMany({
    where: {
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      targetType: 'thread',
      targetId: sessionId,
      action: { in: ['folder.archived', 'repo.backed_up'] },
    },
    select: { action: true, data: true },
  })
  for (const entry of stored) {
    const data = (entry.data ?? {}) as Record<string, unknown>
    if (typeof data.teammateId !== 'string') continue
    try {
      if (entry.action === 'folder.archived')
        keys.add(folderArchiveKey(scope, { sessionId, teammateId: data.teammateId }))
      else if (typeof data.repository === 'string' && typeof data.folder === 'string')
        keys.add(
          repoBackupKey(scope, {
            repository: data.repository,
            sessionId,
            teammateId: data.teammateId,
            folder: data.folder,
          }),
        )
    } catch {
      // Not a key Brigade could have written: nothing of ours to delete there.
    }
  }

  return { keys: [...keys], attachmentIds: own }
}

/** Delete a thread, its files in the bucket and everything that hangs off it. */
export async function deleteThread(db: ScopedDb, scope: Scope, actor: Actor, sessionId: string) {
  const thread = await db.session.findFirst({
    where: { id: sessionId },
    select: { id: true, title: true, status: true, taskId: true },
  })
  if (!thread) throw new HTTPException(404, { message: 'Thread not found' })
  if (BUSY.has(thread.status))
    throw new HTTPException(409, {
      message: 'A teammate is working in this thread. Stop it first.',
    })
  // Its child threads go with it, their files too: none may be at work.
  const children = await db.session.findMany({
    where: { parentId: sessionId },
    select: { id: true, status: true },
  })
  if (children.some((c) => BUSY.has(c.status)))
    throw new HTTPException(409, {
      message: 'One of its child threads is at work. Stop it first, or wait for it to finish.',
    })
  for (const child of children) await deleteThread(db, scope, actor, child.id)
  // A schedule whose runs reported here stops, and its owner hears why.
  const reporting = await db.schedule.findMany({
    where: { parentSessionId: sessionId },
    select: { id: true, title: true, ownerMemberId: true, pausedAt: true },
  })
  for (const schedule of reporting) {
    await db.schedule.updateMany({
      where: { id: schedule.id },
      data: { parentSessionId: null, pausedAt: schedule.pausedAt ?? new Date(), nextRunAt: null },
    })
    if (!schedule.pausedAt)
      await db.ticket.create({
        data: {
          type: 'question',
          title: `Schedule "${schedule.title}" is paused: the thread it reported to, “${thread.title}”, was deleted. Resume it to run its runs as threads of their own.`,
          payload: { scheduleId: schedule.id, memberId: schedule.ownerMemberId },
        } as never,
      })
  }

  const { keys, attachmentIds } = await threadObjectKeys(db, scope, sessionId)
  const failed: string[] = []
  for (const key of keys) await deleteObject(key).catch(() => failed.push(key))
  if (failed.length)
    throw new HTTPException(502, {
      message: `Could not delete ${failed.length} of the thread's files from storage. Try again.`,
    })

  // Its events, seats, reads, pins, tickets, comments and summary go with it (cascades);
  // the files given only to it are deleted here, as they belong to no other thread.
  await db.attachment.deleteMany({ where: { id: { in: attachmentIds } } })
  await db.session.delete({ where: { id: sessionId } })
  await audit({
    ...scope,
    actor,
    action: 'thread.deleted',
    target: { type: 'thread', id: sessionId },
    data: { title: thread.title, objects: keys.length },
  })
  return { taskId: thread.taskId }
}
