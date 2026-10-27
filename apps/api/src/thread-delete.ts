// Deleting a thread for good: its rows, and every object it left in the bucket.
// The bucket goes first: if it fails, the thread is still there to delete again,
// rather than gone with its files left behind where nothing points to them.
import { DELETE_PROTOCOL } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit, type Actor } from './audit.js'
import {
  attachmentKey,
  deleteObject,
  folderArchiveKey,
  listObjects,
  repoBackupKey,
  threadFilesPrefix,
} from './bucket.js'
import { forgetPreviewAddress } from './cloud.js'
import { prisma, type Scope, type ScopedDb } from './db.js'
import { hubs, scheduleUpdated } from './hub.js'

/** While a teammate works in it, the thread's computer is still writing to it. */
const BUSY = new Set(['starting', 'running'])

/**
 * The bucket keys a thread owns: files given to it that no other thread has, files its
 * teammates sent from it, the files its events refer to, its teammates' folder archives
 * and its git backups.
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

  // Images and PDFs its teammates' tools returned (event-files.ts): the whole folder, also one
  // whose event the database never took.
  for (const key of await listObjects(threadFilesPrefix(scope, sessionId))) keys.add(key)

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
    select: { id: true, title: true, status: true, taskId: true, computerId: true },
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
  // A schedule whose runs report here only made sense for this thread: it goes too,
  // first, so no new run starts while its past runs are deleted below.
  const reporting = await db.schedule.findMany({
    where: { parentSessionId: sessionId },
    select: { id: true, title: true },
  })
  for (const schedule of reporting) {
    await db.schedule.deleteMany({ where: { id: schedule.id } })
    await audit({
      ...scope,
      actor,
      action: 'schedule.deleted',
      target: { type: 'schedule', id: schedule.id },
      data: { title: schedule.title, with: { type: 'thread', id: sessionId } },
    })
    void hubs.get(scope.workspaceId).broadcast(scheduleUpdated(schedule.id))
  }
  // Its runs are among the children, so they go here with their files.
  for (const child of children) await deleteThread(db, scope, actor, child.id)

  const { keys, attachmentIds } = await threadObjectKeys(db, scope, sessionId)
  const failed: string[] = []
  for (const key of keys) await deleteObject(key).catch(() => failed.push(key))
  if (failed.length)
    throw new HTTPException(502, {
      message: `Could not delete ${failed.length} of the thread's files from storage. Try again.`,
    })

  // First, the promise to empty its files folder again once a late upload can no longer
  // land: kept before the thread goes, so no deletion is ever without it.
  const notBefore = new Date(Date.now() + LATE_UPLOADS_MS)
  await prisma.bucketCleanup.upsert({
    where: { sessionId },
    create: { sessionId, prefix: threadFilesPrefix(scope, sessionId), notBefore },
    update: { notBefore },
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
  // Its preview's address on the gateway, which would otherwise outlive it.
  forgetPreviewAddress(sessionId)
  // Its folders on its computer go too, or nothing ever removes them there. A computer
  // offline now is told when it tries to archive one (runner-folders.ts, 410).
  const hub = hubs.get(scope.workspaceId)
  if (thread.computerId && ((await hub.runnerProtocol(thread.computerId)) ?? 0) >= DELETE_PROTOCOL)
    await hub.sendToRunner(
      thread.computerId,
      { type: 'thread.deleted', sessionId },
      { touch: false },
    )
  return { taskId: thread.taskId }
}

/**
 * A runner may still be uploading a reply's image (runner-files.ts) when its thread is
 * deleted: its signed URL works for 10 minutes after the thread check (UPLOAD_URL_SECONDS),
 * and would put the image back in the deleted thread's folder. So the folder is emptied
 * again once that long has passed, with a margin.
 */
const LATE_UPLOADS_MS = 15 * 60_000

/**
 * Empty again the files folders of deleted threads whose late uploads can no longer land
 * (BucketCleanup). A row goes only once its folder was emptied whole: one a sweep could
 * not finish is tried again by the next, however long the bucket refuses. A row whose
 * thread is still there (its deletion failed after the row was kept) just goes.
 */
export async function sweepDeletedThreadFiles(now = Date.now()) {
  const due = await prisma.bucketCleanup.findMany({
    where: { notBefore: { lte: new Date(now) } },
    orderBy: { notBefore: 'asc' },
    take: 500,
  })
  let removed = 0
  for (const row of due) {
    try {
      // Still there: its deletion did not go through, and its files are its own again.
      if (await prisma.session.findUnique({ where: { id: row.sessionId }, select: { id: true } })) {
        await prisma.bucketCleanup.delete({ where: { id: row.id } })
        continue
      }
      for (const key of await listObjects(row.prefix)) {
        await deleteObject(key)
        removed++
      }
      await prisma.bucketCleanup.delete({ where: { id: row.id } })
    } catch (error) {
      console.warn(`deleted thread ${row.sessionId}: files not emptied yet: ${String(error)}`)
    }
  }
  if (removed > 0) console.log(`deleted threads: removed ${removed} file(s) uploaded late`)
}
