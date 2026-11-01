// Archiving a thread puts away what waited on a person there: its tickets and pull
// requests leave Home, the sidebar and the app badge, and an unfinished task leaves the
// board. Hidden, not cancelled: unarchiving brings it all back, and so does anything new
// that waits on a person there, so a teammate still at work is never left unheard.
import { onScopedWrite, scoped, type Scope } from './db.js'
import { hubs, threadUpdated } from './hub.js'
import { archiveWithThread, unarchiveWithThread } from './tasks.js'
import { reopenThread } from './thread-done.js'

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
  void hubs.get(scope.workspaceId).broadcast(threadUpdated(thread.id, thread.status))
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
  const row = result as {
    sessionId?: string | null
    status?: string
    state?: string
    type?: string
    payload?: unknown
  }
  if (!row.sessionId) return
  if (
    (model === 'Ticket' && row.status === 'open') ||
    (model === 'PullRequest' && row.state === 'open')
  ) {
    void bringBack(scope, row.sessionId).catch((error) =>
      console.warn(`thread-archive: ${row.sessionId} not brought back: ${String(error)}`),
    )
    // New work is open in it: its root is no longer done (src/thread-done.ts).
    void reopenThread(scope, row.sessionId).catch((error) =>
      console.warn(`thread-archive: ${row.sessionId} not reopened: ${String(error)}`),
    )
  }
  // A quiet thread (a mailbox rule's, an Inbox hand-over) that needs a person: in the sidebar
  // from now on. Not for a reply to approve in its own conversation: the Inbox shows it.
  if (model === 'Ticket' && row.status === 'open') {
    const sessionId = row.sessionId
    void draftInInbox(scope, sessionId, row)
      .then((inInbox) =>
        inInbox
          ? undefined
          : scoped(scope).session.updateMany({
              where: { id: sessionId, quiet: true, surfacedAt: null },
              data: { surfacedAt: new Date() },
            }),
      )
      .catch((error) =>
        console.warn(`thread-archive: ${row.sessionId} not surfaced: ${String(error)}`),
      )
  }
})

/**
 * An email_send or gmail_send waiting for approval that answers a mail of this thread's
 * conversation: the Inbox shows it there as a reply to approve (inbox.ts, draftsOf), so the
 * thread stays quiet.
 */
async function draftInInbox(
  scope: Scope,
  sessionId: string,
  ticket: { type?: string; payload?: unknown },
) {
  const payload = (ticket.payload ?? {}) as {
    operation?: unknown
    connectionId?: unknown
    input?: { replyTo?: unknown; replyToMessageId?: unknown }
  }
  if (ticket.type !== 'approval' || typeof payload.operation !== 'string') return false
  // Brigade's address names the mail it answers by its id; Gmail by Gmail's, in its account's box.
  const where = /^email_send(_|$)/.test(payload.operation)
    ? typeof payload.input?.replyTo === 'string'
      ? { id: payload.input.replyTo }
      : null
    : payload.operation === 'gmail_send' &&
        typeof payload.input?.replyToMessageId === 'string' &&
        typeof payload.connectionId === 'string'
      ? { box: `gmail:${payload.connectionId}`, sourceId: payload.input.replyToMessageId }
      : null
  if (!where) return false
  const db = scoped(scope)
  const answered = await db.mailMessage.findFirst({
    where,
    select: { box: true, conversationId: true },
  })
  if (!answered) return false
  return (
    (await db.mailMessage.count({
      where: { box: answered.box, conversationId: answered.conversationId, sessionId },
    })) > 0
  )
}
