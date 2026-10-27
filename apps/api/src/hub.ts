// The WebSocket hubs: one per workspace (docs/workspace-hubs-plan.md), with the sockets of its
// runners (one per computer) and of its open dashboard tabs. A workspace's hub, and what waits on
// its sockets, is reached only through hubs.get(workspaceId): an operation (src/hub/operations.ts)
// runs in the hub, wherever it lives, and its result comes back. The hubs live in the API's own
// process (src/hub/memory-host.ts).
import { createHash } from 'node:crypto'
import type { ApiToBrowser } from '@brigade/contracts'
import { onScopedWrite, prisma } from './db.js'
import { inHub } from './hub/context.js'
import { localHub } from './hub/memory-host.js'
import { NOTIFY, runOperation, type Hub, type OperationName } from './hub/operations.js'

export type { Hub } from './hub/operations.js'
export type { ComputerPresence, ListType } from './hub/workspace-hub.js'
export { browserSocket, runnerSocket } from './hub/memory-host.js'
export { withTeammateIds } from './hub/thread-events.js'

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

/** The runner a socket or a request comes from, by its token. */
export async function authenticateRunner(authorization: string | undefined) {
  const token = authorization?.match(/^Bearer (.+)$/)?.[1]
  if (!token) return null
  return prisma.runner.findUnique({ where: { tokenHash: hashToken(token) } })
}

/**
 * Arguments and results copied as they would be between Durable Objects, so a test catches what
 * cannot cross (a function, a class instance) before an object of its own does (HUB_COPY=1).
 */
const copy = <T>(value: T): T =>
  process.env.HUB_COPY === '1' && value !== undefined ? structuredClone(value) : value

async function call(workspaceId: string, name: OperationName, args: unknown[]) {
  const hub = localHub(workspaceId)
  const run = () => inHub(hub, () => runOperation(hub, name, copy(args)))
  if (!NOTIFY.has(name)) return copy(await run())
  try {
    await run()
  } catch (error) {
    console.error(`hub ${workspaceId}: ${name} failed`, error)
  }
  return undefined
}

const made = new Map<string, Hub>()

export const hubs = {
  /**
   * The workspace's hub: each operation runs there. Those that only tell dashboards (NOTIFY)
   * never fail, so they can go without waiting.
   */
  get(workspaceId: string): Hub {
    let hub = made.get(workspaceId)
    if (!hub) {
      hub = new Proxy({} as Hub, {
        get: (_, name) =>
          // Not a promise itself: `await hubs.get(id)` is the hub.
          typeof name !== 'string' || name === 'then'
            ? undefined
            : (...args: unknown[]) => call(workspaceId, name as OperationName, args),
      })
      if (made.size > 10_000) made.clear()
      made.set(workspaceId, hub)
    }
    return hub
  },
}

/** A thread's status or state changed: its page and the sidebar show it. */
export const threadUpdated = (sessionId: string, status: string): ApiToBrowser => ({
  type: 'thread.updated',
  sessionId,
  status,
})

/** A task was created, changed or removed. */
export const taskUpdated = (taskId: string): ApiToBrowser => ({ type: 'task.updated', taskId })

/** A schedule was created, changed, fired or removed. */
export const scheduleUpdated = (scheduleId: string): ApiToBrowser => ({
  type: 'schedule.updated',
  scheduleId,
})

/** A project was created, changed or removed: the sidebar and project pages refetch. */
export const projectsUpdated: ApiToBrowser = { type: 'projects.updated' }

// Writes through a scoped client tell the lists that show them.
onScopedWrite((model, scope) => {
  const notify = (type: Parameters<Hub['notifyList']>[0]) =>
    void hubs.get(scope.workspaceId).notifyList(type)
  if (model === 'Ticket') notify('tickets.updated')
  else if (model === 'PullRequest' || model === 'PullRequestReview') notify('pulls.updated')
  else if (model === 'MailMessage' || model === 'MailAddress' || model === 'MailDomain')
    notify('mail.updated')
  else if (model === 'Teammate') notify('teammates.updated')
  else if (model === 'Connection' || model === 'Grant') notify('connections.updated')
})
