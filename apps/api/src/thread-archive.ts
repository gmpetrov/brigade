// Archiving a thread puts away what waited on a person there: its tickets and pull
// requests leave Home, the sidebar and the app badge, and an unfinished task leaves the
// board. Hidden, not cancelled: unarchiving brings it all back, and so does anything new
// that waits on a person there, so a teammate still at work is never left unheard.
import { onScopedWrite, scoped, type Scope } from './db.js'
import { broadcastThreadStatus } from './hub.js'
import { archiveWithThread, unarchiveWithThread } from './tasks.js'

/** A thread and its children, archived or back; its task goes and comes back with it. */
export async function setThreadArchived(scope: Scope, threadId: string, on: boolean) {
  const db = scoped(scope)
  const thread = await db.session.findFirst({
    where: { id: threadId },
    select: { id: true, status: true, updatedAt: true, taskId: true },
  })
  if (!thread) return
  const at = on ? new Date() : null
  await db.session.updateMany({
    where: { id: thread.id },
    // Its place in the list stays where it was.
    data: { archivedAt: at, updatedAt: thread.updatedAt },
  })
  // Its children go and come back with it.
  await db.session.updateMany({ where: { parentId: thread.id }, data: { archivedAt: at } })
  // Archived is put away for everyone: no longer for later for anyone (src/later.ts).
  if (at) await db.threadLater.deleteMany({ where: { sessionId: thread.id } })
  if (thread.taskId)
    await (at
      ? archiveWithThread(scope, thread.taskId, at)
      : unarchiveWithThread(scope, thread.taskId))
  broadcastThreadStatus(scope.workspaceId, thread.id, thread.status)
}

/** Something new waits on a person in an archived thread, or one of its children: it is back. */
async function bringBack(scope: Scope, sessionId: string) {
  const db = scoped(scope)
  const session = await db.session.findFirst({
    where: { id: sessionId },
    select: { parentId: true },
  })
  if (!session) return
  const root = await db.session.findFirst({
    where: { id: session.parentId ?? sessionId, archivedAt: { not: null } },
    select: { id: true },
  })
  if (root) await setThreadArchived(scope, root.id, false)
}

onScopedWrite((model, scope, operation, result) => {
  if (operation !== 'create') return
  const row = result as { sessionId?: string | null; status?: string; state?: string }
  if (!row.sessionId) return
  if (
    (model === 'Ticket' && row.status === 'open') ||
    (model === 'PullRequest' && row.state === 'open')
  )
    void bringBack(scope, row.sessionId).catch((error) =>
      console.warn(`thread-archive: ${row.sessionId} not brought back: ${String(error)}`),
    )
  // A quiet thread (a mailbox rule's) that needs a person: in the sidebar from now on.
  if (model === 'Ticket' && row.status === 'open')
    void scoped(scope)
      .session.updateMany({
        where: { id: row.sessionId, quiet: true, surfacedAt: null },
        data: { surfacedAt: new Date() },
      })
      .catch((error) => console.warn(`thread-archive: ${row.sessionId} not surfaced: ${String(error)}`))
})
