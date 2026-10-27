// Where a workspace hub runs (docs/workspace-hubs-plan.md): what differs between a hub in the
// API's own process (memory-host.ts: Node, and the Api object on Cloudflare) and a hub that is
// a Durable Object of its own, whose memory goes when it hibernates (src/hub-object.ts).
import type { WorkspaceScope } from '../scope.js'

/** One socket of a hub: a runner's or a dashboard's. Sends on a closed one are dropped. */
export type Socket = {
  send(text: string): void
  close(code: number, reason: string): void
}

/** The runner a socket was opened with: its token said so. */
export type RunnerInfo = {
  runnerId: string
  computerId: string
  organizationId: string
  workspaceId: string
}

/** What a runner's connection is: kept with the socket, so a hub that wakes knows it again. */
export type RunnerState = RunnerInfo & {
  kind: 'runner'
  /** This connection's own id: a call waiting on it is answered only on it. */
  id: string
  connectedAt: number
  /** From its hello on: before, it is not the computer's connection yet. */
  protocolVersion?: number
  /** The bundle it was installed from, and the last one it was told about. */
  bundle?: string
  offered?: string
  /** When its process started (its hello, its clock): previews reported before then are gone. */
  startedAt?: string
  /**
   * When it was last heard, as kept with the socket (Date.now()): a hub that wakes knows how
   * long it has been silent. Kept again once it is HEARD_KEEP_MS old, not at each message.
   */
  heardKept?: number
}

/** A runner's connection, in the hub's memory. */
export type RunnerConn = RunnerState & {
  socket: Socket
  /** When it last said anything (Date.now()), as a message: see WorkspaceHub.tick. */
  heardAt: number
  /** Its messages, one after another: sequence bookkeeping stays simple. */
  queue: Promise<void>
  /** Threads whose events are tried again soon, by id. */
  retries: Map<string, ReturnType<typeof setTimeout>>
  /** Said once per connection: a runner that uploads files itself sent one inline. */
  warnedInline: boolean
}

/**
 * A runner's connection made again from what its socket kept, when a hub that hibernated wakes.
 * Heard when it last was, as kept: the wake (an alarm, a call) is not the runner's word. A
 * message that woke the hub counts on its own (onRunnerMessage), as the keepalives the runtime
 * answered do (HubHost.heardAt).
 */
export function wokenRunner(state: RunnerState, socket: Socket): RunnerConn {
  return {
    ...state,
    socket,
    heardAt: state.heardKept ?? state.connectedAt,
    queue: Promise.resolve(),
    retries: new Map(),
    warnedInline: false,
  }
}

/** What a dashboard's connection is: kept with the socket, as a runner's. */
export type BrowserState = {
  kind: 'browser'
  id: string
  scope: WorkspaceScope
  /** The threads it follows. */
  sessions: string[]
  /**
   * Until when the dashboard is in view (Date.now()), from its presence messages: each holds
   * for a while, and the dashboard repeats them while in view. 0: not in view, or a socket that
   * never says (a thread's events, a terminal).
   */
  visibleUntil: number
  /** Takeover terminals relayed to it, by id. */
  terminals: { terminalId: string; computerId: string; sessionId: string }[]
}

export type BrowserConn = Omit<BrowserState, 'sessions'> & {
  socket: Socket
  sessions: Set<string>
}

export type HubHost = {
  /**
   * True when the hub's memory may go while its sockets stay (a hibernating Durable Object):
   * what must outlive it is saved (save), and nothing pings dashboards, which say they are
   * there themselves (keepalive).
   */
  hibernates: boolean
  /** Call the hub's onTimer(key) in `delayMs`; a key set again moves. */
  schedule(key: string, delayMs: number): void
  cancel(key: string): void
  /** Small state that must outlive the hub's memory; a process's hub keeps none. */
  load<T>(key: string): T | undefined
  /** Saved; undefined removes it. */
  save(key: string, value: unknown): void
  /** A connection's state changed: kept with its socket. */
  persist(conn: RunnerConn | BrowserConn): void
  /** When the platform last heard from the socket without waking the hub (a keepalive), if ever. */
  heardAt?(socket: Socket): number | undefined
}
