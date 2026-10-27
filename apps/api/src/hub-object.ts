// A workspace's hub as a Durable Object of its own, on Cloudflare (docs/workspace-hubs-plan.md,
// Phase 2): its runners' and dashboards' sockets, and what waits on them, apart from every other
// workspace's. One workspace's oversized payload, loop or slow handler resets its own object
// only. Named by its workspace's id, it takes the sockets of a workspace whose hubMode is
// 'object' (src/front.ts routes them here) and the operations other code asks of its hub
// (hubs.get, src/hub.ts).
//
// It hibernates between messages: its sockets are accepted with the Hibernation API, each
// connection's state is kept with its socket (serializeAttachment), what must outlive its memory
// in its own storage, its timers as one alarm, and keepalives are answered by the runtime without
// waking it. So the constructor does nothing but say so; the hub is made again on the first event
// after a wake.
import { KEEPALIVE } from '@brigade/contracts'
import { DurableObject } from 'cloudflare:workers'
import { HUB_HEADER, MISDIRECTED, workspaceOfSocket } from './hub/route.js'
import type { Api } from './worker.js'

type Env = {
  API: DurableObjectNamespace<Api>
  /**
   * Hyperdrive in front of the database, caching off (its cache serves reads older than the
   * latest writes): a hub object that wakes connects again, which Hyperdrive makes quick. Unset,
   * it connects to DATABASE_URL directly.
   */
  HUB_DB?: Hyperdrive
}

type Hub = import('./hub/workspace-hub.js').WorkspaceHub
type Host = import('./hub/host.js').HubHost
type RunnerConn = import('./hub/host.js').RunnerConn
type BrowserConn = import('./hub/host.js').BrowserConn
type RunnerState = import('./hub/host.js').RunnerState
type BrowserState = import('./hub/host.js').BrowserState
type Outcome = import('./hub.js').Outcome
type OperationName = import('./hub/operations.js').OperationName
type Failure = import('./ops/failures.js').Failure

/** Timers this short wait in memory: the object is awake meanwhile anyway. Longer ones are its alarm. */
const IN_MEMORY_MS = 10_000
/** How many connections a hub object keeps to the database, and how soon it lets them go. */
const POOL = { max: 3, idleTimeoutMillis: 5_000 }

/** A socket of this object, with its WebSocket kept for its attachment. */
type ObjectSocket = {
  send(text: string): void
  close(code: number, reason: string): void
  ws: WebSocket
}

const socketOf = (ws: WebSocket): ObjectSocket => ({
  ws,
  send(text) {
    if (ws.readyState === WebSocket.OPEN) ws.send(text)
  },
  close(code, reason) {
    try {
      ws.close(code, reason)
    } catch {
      // Closed already.
    }
  },
})

/** What a connection keeps with its socket: what a wake needs to know it again. */
function stateOf(conn: RunnerConn | BrowserConn): RunnerState | BrowserState {
  if (conn.kind === 'runner') {
    const { socket: _s, heardAt: _h, queue: _q, retries: _r, warnedInline: _w, ...state } = conn
    return state
  }
  const { socket: _s, sessions, ...state } = conn
  return { ...state, sessions: [...sessions] }
}

type Ready = {
  workspaceId: string
  hub: Hub
  host: ObjectHost
  run: <T>(fn: () => T) => T
}

class ObjectHost implements Host {
  readonly hibernates = true
  hub!: Hub
  run!: <T>(fn: () => T) => T
  private readonly memory = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly ctx: DurableObjectState) {}

  private timers() {
    return this.ctx.storage.kv.get<Record<string, number>>('timers') ?? {}
  }

  private async arm(timers: Record<string, number>) {
    const next = Math.min(...Object.values(timers))
    if (!Number.isFinite(next)) return this.ctx.storage.deleteAlarm()
    const current = await this.ctx.storage.getAlarm()
    if (current === null || current > next) await this.ctx.storage.setAlarm(next)
  }

  schedule(key: string, delayMs: number) {
    this.cancel(key)
    if (delayMs <= IN_MEMORY_MS) {
      const timer = setTimeout(() => {
        this.memory.delete(key)
        void this.run(() => this.hub.onTimer(key)).catch((error: unknown) =>
          console.error(`hub ${this.hub.workspaceId}: timer ${key} failed`, error),
        )
      }, delayMs)
      this.memory.set(key, timer)
      return
    }
    const timers = { ...this.timers(), [key]: Date.now() + delayMs }
    this.ctx.storage.kv.put('timers', timers)
    void this.arm(timers)
  }

  cancel(key: string) {
    clearTimeout(this.memory.get(key))
    this.memory.delete(key)
    const timers = this.timers()
    if (!(key in timers)) return
    delete timers[key]
    this.ctx.storage.kv.put('timers', timers)
  }

  /** The alarm went: the timers due run, then it is set for the next. */
  async due(now = Date.now()) {
    const timers = this.timers()
    const due = Object.entries(timers).filter(([, at]) => at <= now)
    for (const [key] of due) delete timers[key]
    this.ctx.storage.kv.put('timers', timers)
    for (const [key] of due)
      await this.run(() => this.hub.onTimer(key)).catch((error: unknown) =>
        console.error(`hub ${this.hub.workspaceId}: timer ${key} failed`, error),
      )
    await this.arm(this.timers())
  }

  load<T>(key: string) {
    return this.ctx.storage.kv.get<T>(`hub:${key}`)
  }

  save(key: string, value: unknown) {
    if (value === undefined) this.ctx.storage.kv.delete(`hub:${key}`)
    else this.ctx.storage.kv.put(`hub:${key}`, value)
  }

  persist(conn: RunnerConn | BrowserConn) {
    const { ws } = conn.socket as ObjectSocket
    try {
      ws.serializeAttachment(stateOf(conn))
    } catch {
      // Closed meanwhile: nothing to keep.
    }
  }

  heardAt(socket: { send(text: string): void }) {
    const { ws } = socket as ObjectSocket
    return this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime()
  }
}

export class WorkspaceHubObject extends DurableObject<Env> {
  private ready?: Promise<Ready>
  /** Its connections, by id: made again from their sockets after a wake. */
  private readonly conns = new Map<string, RunnerConn | BrowserConn>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // A runner's or a dashboard's keepalive is answered by the runtime: the object sleeps on.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(KEEPALIVE, KEEPALIVE))
  }

  /** The hub, made on the first event since the object woke. */
  private hub(workspaceId?: string): Promise<Ready> {
    this.ready ??= this.make(workspaceId).catch((error: unknown) => {
      this.ready = undefined
      throw error
    })
    return this.ready
  }

  private async make(given?: string): Promise<Ready> {
    const kept = this.ctx.storage.kv.get<string>('workspace')
    const workspaceId = kept ?? given ?? this.ctx.id.name
    if (!workspaceId) throw new Error('A hub object without its workspace')
    if (given && given !== workspaceId)
      throw new Error(`The hub of ${workspaceId} was asked for ${given}`)
    if (!kept) this.ctx.storage.kv.put('workspace', workspaceId)
    const [{ newPrismaClient, withPrismaClient }, { inHub }, { runIn }, failures, hubs] =
      await Promise.all([
        import('./db.js'),
        import('./hub/context.js'),
        import('./hub/place.js'),
        import('./ops/failures.js'),
        import('./hub/workspace-hub.js'),
      ])
    const client = newPrismaClient(
      this.env.HUB_DB?.connectionString ?? process.env.DATABASE_URL!,
      POOL,
    )
    const host = new ObjectHost(this.ctx)
    const hub = new hubs.WorkspaceHub(workspaceId, host)
    // Its failures are counted where the checks run: the Api object.
    const sink = (failure: Failure) =>
      this.ctx.waitUntil(
        import('./api-object.js')
          .then(({ apiObject }) => apiObject(this.env.API).noteFailures([failure]))
          .catch((error: unknown) => console.error(`failure not counted: ${String(error)}`)),
      )
    const run = <T>(fn: () => T): T =>
      withPrismaClient(client, () =>
        failures.withFailureSink(sink, () =>
          runIn({ kind: 'hub', workspaceId }, () => inHub(hub, fn)),
        ),
      )
    host.hub = hub
    host.run = run
    const ready = { workspaceId, hub, host, run }
    const sockets = this.ctx.getWebSockets()
    for (const ws of sockets) this.adopt(ready, ws)
    // Each wake, with what it found: how often hubs wake shows in the logs.
    console.log(`hub ${workspaceId}: woke with ${sockets.length} sockets`)
    return ready
  }

  /** A socket as the hub knows it: made again from its attachment after a wake. */
  private adopt({ hub }: Ready, ws: WebSocket) {
    const state = ws.deserializeAttachment() as RunnerState | BrowserState | null
    if (!state) return undefined
    const known = this.conns.get(state.id)
    if (known) return known
    let conn: RunnerConn | BrowserConn
    if (state.kind === 'runner') {
      const runner: RunnerConn = {
        ...state,
        socket: socketOf(ws),
        // Heard now: the wake is its message, or the runtime heard it (heardAt).
        heardAt: Date.now(),
        queue: Promise.resolve(),
        retries: new Map(),
        warnedInline: false,
      }
      if (runner.protocolVersion === undefined) hub.arriving.add(runner)
      else {
        const other = hub.runners.get(runner.computerId)
        if (!other || other.connectedAt < runner.connectedAt)
          hub.runners.set(runner.computerId, runner)
      }
      conn = runner
    } else {
      const browser: BrowserConn = {
        ...state,
        socket: socketOf(ws),
        sessions: new Set(state.sessions),
      }
      hub.browsers.add(browser)
      conn = browser
    }
    this.conns.set(state.id, conn)
    return conn
  }

  /** A runner's or a dashboard's socket, routed here by src/front.ts. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const workspaceId = workspaceOfSocket(request)
    if (!workspaceId) return new Response('No workspace named', { status: 400 })
    const ready = await this.hub(workspaceId)
    return ready.run(() => this.accept(ready, request, url))
  }

  private async accept(ready: Ready, request: Request, url: URL): Promise<Response> {
    if (request.headers.get('upgrade') !== 'websocket')
      return new Response('Expected a WebSocket', { status: 426 })
    const runnerSocket = url.pathname === '/runner/ws'
    if (!runnerSocket && url.pathname !== '/api/ws')
      return new Response('Not found', { status: 404 })
    const { prisma } = await import('./db.js')
    const workspace = await prisma.workspace.findUnique({
      where: { id: ready.workspaceId },
      select: { organizationId: true, hubMode: true },
    })
    if (!workspace) return refuse(4404, 'unknown workspace')
    const { noteHubMode } = await import('./platform/node.js')
    noteHubMode(ready.workspaceId, workspace.hubMode)
    // Its hub is the Api object's still (or again): the front passes the socket on there.
    if (workspace.hubMode !== 'object')
      return new Response('This workspace’s hub is in the Api object', {
        status: MISDIRECTED,
        headers: { [HUB_HEADER]: 'api' },
      })
    const { connectionId } = await import('./hub/workspace-hub.js')
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    if (runnerSocket) {
      const { authenticateRunner } = await import('./hub.js')
      const runner = await authenticateRunner(request.headers.get('authorization') ?? undefined)
      if (!runner || runner.workspaceId !== ready.workspaceId)
        return refuse(4401, 'unknown runner token')
      this.ctx.acceptWebSocket(server, ['runner', `computer:${runner.computerId}`])
      const conn: RunnerConn = {
        kind: 'runner',
        id: connectionId(),
        runnerId: runner.id,
        computerId: runner.computerId,
        organizationId: runner.organizationId,
        workspaceId: runner.workspaceId,
        connectedAt: Date.now(),
        socket: socketOf(server),
        heardAt: Date.now(),
        queue: Promise.resolve(),
        retries: new Map(),
        warnedInline: false,
      }
      server.serializeAttachment(stateOf(conn))
      this.conns.set(conn.id, conn)
      ready.hub.arriving.add(conn)
      ready.hub.noteConnect(conn.computerId)
    } else {
      const [{ auth }, { resolveScope }] = await Promise.all([
        import('./auth.js'),
        import('./scope.js'),
      ])
      const session = await auth.api.getSession({ headers: request.headers })
      const scope = session
        ? await resolveScope({
            userId: session.user.id,
            activeOrganizationId: workspace.organizationId,
            activeWorkspaceId: ready.workspaceId,
          })
        : null
      if (!scope) return refuse(4401, 'unauthorized')
      this.ctx.acceptWebSocket(server, ['browser'])
      const conn: BrowserConn = {
        kind: 'browser',
        id: connectionId(),
        scope,
        socket: socketOf(server),
        sessions: new Set(),
        visibleUntil: 0,
        terminals: [],
      }
      server.serializeAttachment(stateOf(conn))
      this.conns.set(conn.id, conn)
      ready.hub.browserOpened(conn)
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const ready = await this.hub()
    const conn = this.adopt(ready, ws)
    if (!conn) return
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message)
    const [{ onRunnerMessage }, { onBrowserMessage }] = await Promise.all([
      import('./hub/runner-messages.js'),
      import('./hub/browser-messages.js'),
    ])
    await ready.run(() =>
      conn.kind === 'runner'
        ? onRunnerMessage(ready.hub, conn, text)
        : onBrowserMessage(ready.hub, conn, text),
    )
  }

  override async webSocketClose(ws: WebSocket) {
    const ready = await this.hub()
    const conn = this.adopt(ready, ws)
    if (!conn) return
    this.conns.delete(conn.id)
    const { onRunnerClose } = await import('./hub/runner-messages.js')
    ready.run(() =>
      conn.kind === 'runner' ? onRunnerClose(ready.hub, conn) : ready.hub.browserClosed(conn),
    )
  }

  override async webSocketError(ws: WebSocket, error: unknown) {
    console.warn(`hub socket error: ${String(error)}`)
    await this.webSocketClose(ws)
  }

  override async alarm() {
    const ready = await this.hub()
    await ready.host.due()
  }

  /**
   * An operation of this hub, asked by code in another object (hubs.get). One that came here while
   * the workspace's hub is the Api object's is passed on there, once.
   */
  async call(
    workspaceId: string,
    name: OperationName,
    args: unknown[],
    forwarded: boolean,
  ): Promise<Outcome> {
    const ready = await this.hub(workspaceId)
    return ready.run(async () => {
      const { hubModeOf } = await import('./platform/node.js')
      if (!forwarded && (await hubModeOf(workspaceId)) !== 'object') {
        const { apiObject } = await import('./api-object.js')
        return apiObject(this.env.API).hubCall(workspaceId, name, args, true) as Promise<Outcome>
      }
      const { outcomeHere } = await import('./hub.js')
      return outcomeHere(workspaceId, name, args)
    })
  }

  /** The workspace's hub goes back to the Api object: its sockets close, and connect there again. */
  async closeAll(code: number, reason: string) {
    for (const ws of this.ctx.getWebSockets())
      try {
        ws.close(code, reason)
      } catch {
        // Closed already.
      }
  }
}

/** A socket refused once open, with a code the runner or dashboard knows (as src/app.ts does). */
function refuse(code: number, reason: string) {
  const pair = new WebSocketPair()
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
  server.accept()
  server.close(code, reason)
  return new Response(null, { status: 101, webSocket: client })
}
