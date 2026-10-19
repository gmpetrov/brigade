// Later: a member puts a thread away for later, for themselves only, as they pin one. It
// leaves their sidebar's list (the filter's Later shows it) and what waits on them: its
// tickets and pull requests leave their Home, sidebar, app badge and notifications. Like
// an archive, anything new there brings it back: a message or a teammate's turn in it, or
// a ticket or pull request opened in it or one of its children.
import { onScopedWrite, prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { broadcastThreadStatus, notifyList } from './hub.js'

/** The threads this member put away for later: id, and since when. */
export async function latersOf(db: ScopedDb, memberId: string) {
  const rows = await db.threadLater.findMany({
    where: { memberId },
    select: { sessionId: true, laterAt: true },
  })
  return new Map(rows.map((r) => [r.sessionId, r.laterAt] as const))
}

/** Who put which thread away in a workspace, as `memberId:sessionId`, for notifications. */
export async function latersIn(workspaceId: string) {
  const rows = await prisma.threadLater.findMany({
    where: { workspaceId },
    select: { memberId: true, sessionId: true },
  })
  return new Set(rows.map((r) => laterKey(r.memberId, r.sessionId)))
}

export const laterKey = (memberId: string, sessionId: string) => `${memberId}:${sessionId}`

/** Put away for this member, or back in their list. Not a child: it shows in its parent. */
export async function setLater(
  db: ScopedDb,
  scope: Scope & { memberId: string },
  thread: { id: string; status: string },
  on: boolean,
) {
  if (on)
    await db.threadLater.upsert({
      where: { memberId_sessionId: { memberId: scope.memberId, sessionId: thread.id } },
      create: {
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        memberId: scope.memberId,
        sessionId: thread.id,
      },
      update: { laterAt: new Date() },
    })
  else
    await db.threadLater.deleteMany({ where: { memberId: scope.memberId, sessionId: thread.id } })
  changed(scope, thread)
}

/** Something new in a thread, or in one of its children: back in everyone's list. */
export async function bringBackFromLater(scope: Scope, sessionId: string) {
  const db = scoped(scope)
  const session = await db.session.findFirst({
    where: { id: sessionId },
    select: { id: true, parentId: true, status: true },
  })
  if (!session) return
  const root = session.parentId
    ? await db.session.findFirst({
        where: { id: session.parentId },
        select: { id: true, status: true },
      })
    : session
  if (!root) return
  const { count } = await db.threadLater.deleteMany({ where: { sessionId: root.id } })
  if (count) changed(scope, root)
}

/**
 * Its row moves in the sidebar, and what waits on the member changes: the dashboards
 * read the list, tickets and pull requests again.
 */
function changed(scope: Scope, thread: { id: string; status: string }) {
  broadcastThreadStatus(scope.workspaceId, thread.id, thread.status)
  notifyList(scope.workspaceId, 'tickets.updated')
  notifyList(scope.workspaceId, 'pulls.updated')
}

onScopedWrite((model, scope, operation, result) => {
  if (operation !== 'create') return
  const row = result as { sessionId?: string | null; status?: string; state?: string }
  if (!row.sessionId) return
  if (
    (model === 'Ticket' && row.status === 'open') ||
    (model === 'PullRequest' && row.state === 'open')
  )
    void bringBackFromLater(scope, row.sessionId).catch((error) =>
      console.warn(`later: ${row.sessionId} not brought back: ${String(error)}`),
    )
})
