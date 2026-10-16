// Apps: what members add and give to teammates. An App's accounts are its
// connections; each account has an owner (who connected it) and a reach.
import { HTTPException } from 'hono/http-exception'
import type { ConnectorKind } from './connectors/types.js'
import type { ScopedDb } from './db.js'
import type { WorkspaceScope } from './scope.js'

/** An App's key: its kind for a built-in App, custom:<connection id> for each custom app. */
export const appKey = (kind: ConnectorKind, connectionId: string) =>
  kind === 'webhook' ? `custom:${connectionId}` : kind

const admin = (scope: WorkspaceScope) => scope.role === 'owner' || scope.role === 'admin'

/** The workspace's App for a key, added the first time one of its accounts is connected. */
export async function appFor(
  db: ScopedDb,
  scope: WorkspaceScope,
  key: string,
  name: string | null = null,
) {
  const existing = await db.app.findFirst({ where: { key } })
  if (existing) return existing
  try {
    return await db.app.create({
      data: { key, name, createdByMemberId: scope.memberId } as never,
    })
  } catch (error) {
    // Two first accounts at once: the other request added it.
    const raced = await db.app.findFirst({ where: { key } })
    if (raced) return raced
    throw error
  }
}

/** An account: renamed, removed, given to teammates or opened to the workspace by its owner or an admin. */
export function requireAccountManager(
  scope: WorkspaceScope,
  connection: { createdByMemberId: string },
) {
  if (admin(scope) || connection.createdByMemberId === scope.memberId) return
  throw new HTTPException(403, {
    message: 'Only the member who connected this account, or an owner or admin, can do this',
  })
}

/**
 * The App as a whole (its tools, removing it): an owner or admin, or the member
 * who added it while every account in it is theirs.
 */
export function requireAppManager(
  scope: WorkspaceScope,
  app: { createdByMemberId: string },
  accounts: { createdByMemberId: string }[],
) {
  if (admin(scope)) return
  if (
    app.createdByMemberId === scope.memberId &&
    accounts.every((a) => a.createdByMemberId === scope.memberId)
  )
    return
  throw new HTTPException(403, {
    message: 'Only an owner or admin can change an App with accounts other members connected',
  })
}

/** Whether a teammate may use an account in a thread: everywhere, or only in its owner's threads. */
export const usableIn = (
  connection: { reach: 'mine' | 'workspace'; createdByMemberId: string },
  thread: { startedByMemberId: string },
) => connection.reach === 'workspace' || connection.createdByMemberId === thread.startedByMemberId
