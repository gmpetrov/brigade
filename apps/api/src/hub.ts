// The WebSocket hubs: one per workspace (docs/workspace-hubs-plan.md), with the sockets of its
// runners (one per computer) and of its open dashboard tabs. A workspace's hub, and what waits on
// its sockets, is reached only through hubs.get(workspaceId): an operation (src/hub/operations.ts)
// runs in the hub, wherever it lives, and its result comes back. A hub lives in the API's own
// process (src/hub/memory-host.ts: Node, and the Api object on Cloudflare), or on Cloudflare in a
// Durable Object of its own (src/hub-object.ts), as its workspace's hubMode says.
import { createHash } from 'node:crypto'
import type { ApiToBrowser } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { onScopedWrite, prisma } from './db.js'
import { inHub, runningHub } from './hub/context.js'
import { localHub } from './hub/memory-host.js'
import { NOTIFY, runOperation, type Hub, type OperationName } from './hub/operations.js'
import { noteFailure } from './ops/failures.js'
import { hubElsewhere } from './platform/node.js'

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

/** An operation's outcome as it crosses from one object to another: its value, or its error. */
export type Outcome =
  { ok: true; value: unknown } | { ok: false; error: { message: string; status?: number } }

/**
 * An error as one line: its kind and message, or what was thrown. A hub object reset mid-operation
 * fails it with an error whose message can be empty: its name and kind still say what it was.
 */
export const describeError = (error: unknown) =>
  error instanceof Error
    ? `${error.name}: ${error.message || '(no message)'}`
    : `thrown ${typeof error}: ${String(error)}`

/**
 * Run an operation in the workspace's hub here: the running one when it is the workspace's (a
 * hub object's own), else this process's.
 */
async function runHere(workspaceId: string, name: OperationName, args: unknown[]) {
  const running = runningHub()
  const hub = running?.workspaceId === workspaceId ? running : localHub(workspaceId)
  return copy(await inHub(hub, () => runOperation(hub, name, copy(args))))
}

/** runHere, for a caller in another object: its outcome, an error included. */
export async function outcomeHere(
  workspaceId: string,
  name: OperationName,
  args: unknown[],
): Promise<Outcome> {
  try {
    return { ok: true, value: await runHere(workspaceId, name, args) }
  } catch (error) {
    if (error instanceof HTTPException)
      return { ok: false, error: { message: error.message, status: error.status } }
    // Said here, with its stack: the caller in another object gets only a line.
    console.error(`hub ${workspaceId}: ${name} failed`, error)
    noteFailure('hub-op', `${name}: ${describeError(error)}`, { workspaceId })
    return { ok: false, error: { message: `${name} failed in the hub: ${describeError(error)}` } }
  }
}

/** The value of an outcome from another object, or its error thrown again here. */
export function valueOf(outcome: Outcome) {
  if (outcome.ok) return outcome.value
  const { message, status } = outcome.error
  if (status) throw new HTTPException(status as ContentfulStatusCode, { message })
  throw new Error(message)
}

async function call(workspaceId: string, name: OperationName, args: unknown[]) {
  const where = hubElsewhere(workspaceId)
  const remote = where instanceof Promise ? await where : where
  const run = remote
    ? async () => valueOf(await remote(name, args))
    : () => runHere(workspaceId, name, args)
  if (!NOTIFY.has(name)) return run()
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
