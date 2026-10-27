// What code outside a workspace's hub may ask of it (docs/workspace-hubs-plan.md): each
// operation runs in the hub, wherever it is, with its arguments and result copied across (they
// cross to another Durable Object once hubs are objects of their own). hubs.get(workspaceId)
// gives them as async methods (src/hub.ts).
import type { AccountRef, ApiToBrowser, ApiToRunner } from '@brigade/contracts'
import type { Computer } from '../generated/prisma/client.js'
import type { Scope } from '../db.js'
import type { ListType, WorkspaceHub } from './workspace-hub.js'

// Modules whose functions run in the hub are loaded when an operation first needs them, so that
// importing the hub's interface loads none of the API.
const cloud = () => import('../cloud.js')
const replace = () => import('../cloud-replace.js')
const held = () => import('../held-calls.js')
const logins = () => import('../logins.js')
const move = () => import('../move.js')

type Actor = { type: 'member' | 'system'; id: string }

export const operations = {
  // Its computers' connections.
  isOnline: (hub: WorkspaceHub, computerId: string) => hub.isOnline(computerId),
  isRestarting: (hub: WorkspaceHub, computerId: string) => hub.isRestarting(computerId),
  runnerProtocol: (hub: WorkspaceHub, computerId: string) => hub.runnerProtocol(computerId),
  presence: (hub: WorkspaceHub, computerIds: string[]) => hub.presence(computerIds),

  // Its dashboards.
  isLooking: (hub: WorkspaceHub, memberId: string, withinMs: number) =>
    hub.isLooking(memberId, withinMs),
  eventsWaitingSince: (hub: WorkspaceHub, sessionIds: string[]) =>
    Object.fromEntries(sessionIds.map((id) => [id, hub.eventsWaitingSince(id)])),

  // Sending to runners.
  sendToRunner: (
    hub: WorkspaceHub,
    computerId: string,
    message: ApiToRunner,
    options?: { touch?: boolean },
  ) => hub.sendToRunner(computerId, message, options),
  dispatch: (
    hub: WorkspaceHub,
    computer: { id: string; kind: string; organizationId?: string; workspaceId?: string },
    message: ApiToRunner,
  ) => hub.dispatch(computer, message),
  askRunner: (
    hub: WorkspaceHub,
    computerId: string,
    message: Extract<ApiToRunner, { requestId: string }>,
    timeoutMs: number,
    options?: { touch?: boolean; offline?: string },
  ) => hub.askRunner(computerId, message, timeoutMs, options),
  dropRunner: (hub: WorkspaceHub, computerId: string) => hub.dropRunner(computerId),
  resendCommands: (hub: WorkspaceHub, waiting: { computerId: string; since: number }[]) =>
    hub.resendCommands(waiting),

  // Telling dashboards (and runners, for the library). Never fail their caller (notify).
  broadcast: (hub: WorkspaceHub, message: ApiToBrowser, sessionId?: string) =>
    hub.broadcast(message, sessionId),
  broadcastComputer: (hub: WorkspaceHub, computerId: string, status?: string) =>
    hub.broadcastComputer(computerId, status),
  sendToMember: (hub: WorkspaceHub, memberId: string, message: ApiToBrowser) =>
    hub.sendToMember(memberId, message),
  notifyLibraryChanged: (hub: WorkspaceHub) => hub.notifyLibraryChanged(),
  notifyList: (hub: WorkspaceHub, type: ListType) => hub.notifyList(type),

  // Its cloud computers (src/cloud.ts, src/cloud-replace.ts).
  touch: (hub: WorkspaceHub, computerId: string) => hub.touch(computerId),
  ensureRunning: async (_hub: WorkspaceHub, computerId: string) =>
    (await cloud()).ensureRunning(computerId),
  provisionComputer: async (
    _hub: WorkspaceHub,
    computer: { id: string; organizationId: string; workspaceId: string; kind: string },
    created: boolean,
  ) => (await cloud()).provisionComputer(computer, created),
  isProvisioning: async (_hub: WorkspaceHub, computerId: string) =>
    (await cloud()).isProvisioning(computerId),
  stopComputer: async (
    _hub: WorkspaceHub,
    computer: { id: string; organizationId: string; workspaceId: string; providerRef: unknown },
    actor: Actor,
  ) => (await cloud()).stopComputer(computer, actor),
  shutDown: async (_hub: WorkspaceHub, computer: Computer) => (await cloud()).shutDown(computer),
  enforcePlan: async (_hub: WorkspaceHub, computer: Computer) =>
    (await cloud()).enforcePlan(computer),
  checkIdle: async (_hub: WorkspaceHub, computer: Computer) => (await cloud()).checkIdle(computer),
  backupComputer: async (_hub: WorkspaceHub, computerId: string, timeoutMs?: number) =>
    (await replace()).backupComputer(computerId, timeoutMs),
  driveReplacement: async (_hub: WorkspaceHub, id: string) => (await replace()).drive(id),

  // Sign-ins (src/logins.ts).
  startLogin: async (
    _hub: WorkspaceHub,
    input: { accountId: string; memberId: string; computerId: string; account: AccountRef },
    computer: { id: string; kind: string },
  ) => (await logins()).startLogin(input, computer),
  loginStates: async (_hub: WorkspaceHub, accountIds: string[]) =>
    (await logins()).loginStates(accountIds),
  submitLoginCode: async (
    _hub: WorkspaceHub,
    accountId: string,
    memberId: string,
    code: string,
    email?: string,
  ) => (await logins()).submitLoginCode(accountId, memberId, code, email),
  cancelLogin: async (_hub: WorkspaceHub, accountId: string) =>
    (await logins()).cancelLogin(accountId),

  // Calls held for a person (src/held-calls.ts).
  runHeld: async (_hub: WorkspaceHub, id: string) => (await held()).runHeld(id),

  // Threads moving between computers (src/move.ts).
  advanceMove: async (
    _hub: WorkspaceHub,
    scope: Scope,
    sessionId: string,
    released?: { ok: boolean; error?: string },
  ) => (await move()).advanceMove(scope, sessionId, released),

  // The process's jobs.
  tick: (hub: WorkspaceHub) => hub.tick(),
  sizes: (hub: WorkspaceHub) => hub.sizes(),
}

export type Operations = typeof operations
export type OperationName = keyof Operations

/** Operations that only tell: a failure is logged, never thrown at their caller. */
export const NOTIFY = new Set<OperationName>([
  'broadcast',
  'broadcastComputer',
  'sendToMember',
  'notifyLibraryChanged',
  'notifyList',
  'touch',
])

type Rest<F> = F extends (hub: WorkspaceHub, ...args: infer A) => unknown ? A : never

/** A workspace's hub, as code outside it reaches it: each operation, async. */
export type Hub = {
  [K in OperationName]: (
    ...args: Rest<Operations[K]>
  ) => Promise<Awaited<ReturnType<Operations[K]>>>
}

/** Run an operation in the hub (the caller has set the hub as running: inHub). */
export function runOperation(hub: WorkspaceHub, name: OperationName, args: unknown[]) {
  const operation = operations[name] as (hub: WorkspaceHub, ...args: unknown[]) => unknown
  if (typeof operation !== 'function') throw new Error(`No hub operation ${String(name)}`)
  return operation(hub, ...args)
}
