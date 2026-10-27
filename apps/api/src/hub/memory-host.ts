// Hubs in the API's own process: on Node (a server, development, tests), and in the Api object
// on Cloudflare for workspaces whose hub is not an object of its own yet (hubMode 'api',
// docs/workspace-hubs-plan.md). Their state is in memory, as it always was: a restart forgets
// it, and what must survive one is in Postgres.
import type { WSContext } from 'hono/ws'
import type { WorkspaceScope } from '../scope.js'
import { onBrowserMessage } from './browser-messages.js'
import { inHub } from './context.js'
import type { BrowserConn, HubHost, RunnerConn, RunnerInfo, Socket } from './host.js'
import { onRunnerClose, onRunnerMessage } from './runner-messages.js'
import { connectionId, WorkspaceHub } from './workspace-hub.js'

/** This process's hubs, by workspace: made on first use. */
const local = new Map<string, WorkspaceHub>()

class MemoryHost implements HubHost {
  readonly hibernates = false
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  hub!: WorkspaceHub

  schedule(key: string, delayMs: number) {
    clearTimeout(this.timers.get(key))
    const timer = setTimeout(() => {
      this.timers.delete(key)
      void inHub(this.hub, () => this.hub.onTimer(key)).catch((error: unknown) =>
        console.error(`hub ${this.hub.workspaceId}: timer ${key} failed`, error),
      )
    }, delayMs)
    timer.unref?.()
    this.timers.set(key, timer)
  }

  cancel(key: string) {
    clearTimeout(this.timers.get(key))
    this.timers.delete(key)
  }

  load<T>(): T | undefined {
    return undefined
  }

  save() {}

  persist() {}

  /** Timers due, for the minute's log. */
  get pending() {
    return this.timers.size
  }
}

/** The workspace's hub in this process. */
export function localHub(workspaceId: string) {
  let hub = local.get(workspaceId)
  if (!hub) {
    const host = new MemoryHost()
    hub = new WorkspaceHub(workspaceId, host)
    host.hub = hub
    local.set(workspaceId, hub)
  }
  return hub
}

/** Every hub of this process, for the jobs that watch them. */
export const localHubs = () => [...local.values()]

/** Hubs with nothing open or waiting go: a workspace that comes back gets a new one. */
export function pruneLocalHubs() {
  for (const [id, hub] of local)
    if (hub.idle() && (hub.host as MemoryHost).pending === 0) local.delete(id)
}

const socketOf = (ws: WSContext): Socket => ({
  send: (text) => ws.send(text),
  close: (code, reason) => ws.close(code, reason),
})

/** The one outbound socket of each runner, in this process: scoped by its token. */
export function runnerSocket(runner: Omit<RunnerInfo, 'runnerId'> & { id: string }) {
  const info: RunnerInfo = {
    runnerId: runner.id,
    computerId: runner.computerId,
    organizationId: runner.organizationId,
    workspaceId: runner.workspaceId,
  }
  const hub = localHub(info.workspaceId)
  let conn: RunnerConn | undefined
  const open = (ws: WSContext) => {
    if (conn) return conn
    conn = {
      kind: 'runner',
      id: connectionId(),
      ...info,
      connectedAt: Date.now(),
      socket: socketOf(ws),
      heardAt: Date.now(),
      queue: Promise.resolve(),
      retries: new Map(),
      warnedInline: false,
    }
    inHub(hub, () => {
      hub.arriving.add(conn!)
      hub.noteConnect(info.computerId)
    })
    return conn
  }
  return {
    onOpen(ws: WSContext) {
      open(ws)
    },
    onMessage(raw: unknown, ws: WSContext) {
      const c = open(ws)
      return inHub(hub, () => onRunnerMessage(hub, c, String(raw)))
    },
    onClose() {
      if (conn) inHub(hub, () => onRunnerClose(hub, conn!))
    },
  }
}

/** A dashboard's live socket, in this process: scoped by its session. */
export function browserSocket(scope: WorkspaceScope) {
  const hub = localHub(scope.workspaceId)
  let conn: BrowserConn | undefined
  const open = (ws: WSContext) => {
    if (conn) return conn
    conn = {
      kind: 'browser',
      id: connectionId(),
      scope,
      socket: socketOf(ws),
      sessions: new Set(),
      visibleUntil: 0,
      terminals: [],
    }
    inHub(hub, () => hub.browserOpened(conn!))
    return conn
  }
  return {
    onOpen(ws: WSContext) {
      open(ws)
    },
    onMessage(raw: unknown, ws: WSContext) {
      const c = open(ws)
      return inHub(hub, () => onBrowserMessage(hub, c, String(raw)))
    },
    onClose() {
      if (conn) inHub(hub, () => hub.browserClosed(conn!))
    },
  }
}
