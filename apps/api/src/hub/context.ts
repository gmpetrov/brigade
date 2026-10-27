// Which workspace hub the running code belongs to (docs/workspace-hubs-plan.md). A hub's state
// (its sockets, the requests waiting on its runners, its timers) is only ever reached from code
// the hub runs: an operation called through hubs.get(workspaceId), or a message on one of its
// sockets. Anywhere else, currentHub() throws, rather than read state that, once each hub is a
// Durable Object of its own, lives in another object.
import { AsyncLocalStorage } from 'node:async_hooks'
import type { WorkspaceHub } from './workspace-hub.js'

const running = new AsyncLocalStorage<WorkspaceHub>()

/** Run `fn` as the hub's: what it calls reaches the hub with currentHub(). */
export const inHub = <T>(hub: WorkspaceHub, fn: () => T): T => running.run(hub, fn)

/** The hub running now, if any. */
export const runningHub = (): WorkspaceHub | undefined => running.getStore()

/**
 * The hub running now: the workspace's, when one is named. Throws outside a hub, or in another
 * workspace's: such code must go through hubs.get(workspaceId).
 */
export function currentHub(workspaceId?: string): WorkspaceHub {
  const hub = running.getStore()
  if (!hub) throw new Error('A workspace hub was reached outside it: go through hubs.get()')
  if (workspaceId && hub.workspaceId !== workspaceId)
    throw new Error(`The hub of ${hub.workspaceId} was reached for ${workspaceId}`)
  return hub
}
