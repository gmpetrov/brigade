// The API's platform on Cloudflare Workers (see ./types.ts). An alias in
// wrangler.jsonc puts this module in place of ./node.ts.
import { env } from 'cloudflare:workers'
import { defineWebSocketHelper, WSContext } from 'hono/ws'
import { currentPlace } from '../hub/place.js'
import type { HubCall, HubStub, RunnerBundleFile, Upstream, UpstreamEvents } from './types.js'

type Bindings = {
  ASSETS: { fetch(input: string): Promise<Response> }
  RUNNER_BUNDLE_SHA256?: string
}
const bindings = env as unknown as Bindings

/** A request body of exactly `size` bytes, sent with that length rather than in chunks. */
export const fixedLength = (body: ReadableStream<Uint8Array>, size: number) => ({
  body: body.pipeThrough(new FixedLengthStream(size)),
  headers: {},
})

/**
 * Hono's upgradeWebSocket for Workers, which also calls onOpen (Hono's own
 * never does): the hub registers a browser and refuses one there.
 */
export const upgradeWebSocket = defineWebSocketHelper(async (c, events) => {
  if (c.req.header('upgrade') !== 'websocket') return
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
  server.binaryType = 'arraybuffer'
  const ws = new WSContext({
    close: (code, reason) => {
      try {
        server.close(code, reason)
      } catch {
        // Already closed, or the connection is gone.
      }
    },
    get protocol() {
      return server.protocol
    },
    raw: server,
    get readyState() {
      return server.readyState as 0 | 1 | 2 | 3
    },
    url: null,
    // As the ws package does on Node: a send on a socket that closed is dropped, not
    // thrown (the hub sends to sockets that may have gone).
    send: (source) => {
      if (server.readyState === WebSocket.OPEN) server.send(source)
    },
  })
  server.addEventListener('close', (e) => events.onClose?.(e, ws))
  server.addEventListener('message', (e) => events.onMessage?.(e, ws))
  server.addEventListener('error', (e) => events.onError?.(e, ws))
  server.accept()
  setTimeout(() => events.onOpen?.(new Event('open'), ws), 0)
  // The first subprotocol the client asked for (the desktop's 'binary'), as ws picks on
  // Node: a browser drops a socket whose answer names none of those it asked for.
  const protocol = c.req.header('sec-websocket-protocol')?.split(',')[0]?.trim()
  return new Response(null, {
    status: 101,
    webSocket: client,
    ...(protocol ? { headers: { 'sec-websocket-protocol': protocol } } : {}),
  })
})

export function connectSocket(
  url: string,
  init: { protocol: string; headers: Record<string, string> },
  events: UpstreamEvents,
): Upstream {
  let socket: WebSocket | undefined
  let closed = false
  void fetch(url.replace(/^ws/, 'http'), {
    headers: { ...init.headers, upgrade: 'websocket', 'sec-websocket-protocol': init.protocol },
  }).then(
    (response) => {
      const ws = response.webSocket
      if (!ws) return events.onError()
      ws.accept()
      ws.binaryType = 'arraybuffer'
      if (closed) return ws.close()
      socket = ws
      ws.addEventListener('message', (e) => {
        if (typeof e.data !== 'string') events.onMessage(e.data as ArrayBuffer)
      })
      ws.addEventListener('close', () => events.onClose())
      ws.addEventListener('error', () => events.onError())
      events.onOpen()
    },
    () => events.onError(),
  )
  return {
    send: (data) => socket?.send(data),
    close: () => {
      closed = true
      socket?.close()
    },
  }
}

/** Set at deploy, from the bundle put in the Worker's static assets. */
export async function runnerBundleSha256(): Promise<string | null> {
  return bindings.RUNNER_BUNDLE_SHA256 || null
}

export async function runnerBundleFile(): Promise<RunnerBundleFile | null> {
  const sha256 = await runnerBundleSha256()
  if (!sha256) return null
  const response = await bindings.ASSETS.fetch('https://assets.local/runner/brigade-runner.tgz')
  if (!response.ok || !response.body) return null
  const length = response.headers.get('content-length')
  return { sha256, size: length ? Number(length) : null, body: response.body }
}

// ---------------------------------------------------------------------------
// Workspaces' hubs (docs/workspace-hubs-plan.md): in the Api object, or in a Durable Object of
// their own (src/hub-object.ts), as each workspace's hubMode says.
// ---------------------------------------------------------------------------

type HubBindings = {
  /** The workspaces' hub objects; unset, every hub is the Api object's. */
  HUBS?: DurableObjectNamespace<import('../hub-object.js').WorkspaceHubObject>
  API?: DurableObjectNamespace<import('../worker.js').Api>
}
const hubBindings = env as unknown as HubBindings

type HubMode = 'api' | 'object'

/** How long a workspace's hub mode is taken as read: a call that reaches the wrong place is passed on. */
const MODE_TTL_MS = 10_000
/** Each workspace's hub mode, as last read: data, the same for every object of the isolate. */
const modes = new Map<string, { mode: HubMode; at: number }>()

/** Where the workspace's hub runs, as its row says (cached for MODE_TTL_MS). */
export async function hubModeOf(workspaceId: string): Promise<HubMode> {
  const cached = modes.get(workspaceId)
  if (cached && Date.now() - cached.at < MODE_TTL_MS) return cached.mode
  const { prisma } = await import('../db.js')
  const row = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { hubMode: true },
  })
  const mode = row?.hubMode ?? 'api'
  noteHubMode(workspaceId, mode)
  return mode
}

/** A mode just read or changed. */
export function noteHubMode(workspaceId: string, mode: HubMode) {
  if (modes.size > 10_000) modes.clear()
  modes.set(workspaceId, { mode, at: Date.now() })
}

/**
 * The workspace's hub object. An object stays where it was first asked for, and each of its
 * queries crosses to Neon in Frankfurt (src/api-object.ts): asked first from here (the Api
 * object, or this Worker's isolates, placed next to the database), it is made here, without a
 * hint. A hint of `weur` made the Api object in Amsterdam: 13 ms per query instead of 2 to 3.
 */
export function hubStub(workspaceId: string): HubStub {
  const namespace = hubBindings.HUBS
  if (!namespace) throw new Error('This Worker has no hub objects (HUBS)')
  return namespace.get(namespace.idFromName(workspaceId)) as unknown as HubStub
}

const objectCall =
  (workspaceId: string): HubCall =>
  (name, args) =>
    hubStub(workspaceId).call(workspaceId, name, args, false)

const apiCall =
  (workspaceId: string): HubCall =>
  async (name, args) => {
    const { apiObject } = await import('../api-object.js')
    return apiObject(hubBindings.API!).hubCall(workspaceId, name, args, false) as Promise<
      import('../hub.js').Outcome
    >
  }

/**
 * The operation call of a workspace's hub when it runs in another object than the code: its own
 * object, or the Api object. Null when it is here: in this hub object, or in the Api object for a
 * workspace whose hub is still there.
 */
export function hubElsewhere(workspaceId: string): HubCall | null | Promise<HubCall | null> {
  if (!hubBindings.HUBS) return null
  const place = currentPlace()
  if (place?.kind === 'hub' && place.workspaceId === workspaceId) return null
  const decide = (mode: HubMode): HubCall | null =>
    mode === 'object'
      ? objectCall(workspaceId)
      : place?.kind === 'api'
        ? null
        : apiCall(workspaceId)
  const cached = modes.get(workspaceId)
  if (cached && Date.now() - cached.at < MODE_TTL_MS) return decide(cached.mode)
  return hubModeOf(workspaceId).then(decide)
}

/** Whether the workspace's hub, and its sockets, are not this process's (an Api object's) to hold. */
export async function hubIsElsewhere(workspaceId: string) {
  return Boolean(hubBindings.HUBS) && (await hubModeOf(workspaceId)) === 'object'
}

/**
 * Move a workspace's hub (POST /ops/hubs): to its own object, made here next to the database, or
 * back to the Api object. The sockets on the side it leaves close, and connect again where it is.
 */
export async function moveHub(workspaceId: string, mode: HubMode) {
  if (!hubBindings.HUBS) throw new Error('This Worker has no hub objects (HUBS)')
  const { prisma } = await import('../db.js')
  await prisma.workspace.update({ where: { id: workspaceId }, data: { hubMode: mode } })
  noteHubMode(workspaceId, mode)
  // Made here, next to the database, before any socket asks for it; and told, before its next
  // read of the mode.
  await hubStub(workspaceId).moved(workspaceId, mode)
  if (mode === 'object') {
    const { localHubs } = await import('../hub/memory-host.js')
    localHubs()
      .find((hub) => hub.workspaceId === workspaceId)
      ?.closeAll(1012, 'its hub moved')
  }
}

// ---------------------------------------------------------------------------
// Jobs on Queues (docs/workspace-hubs-plan.md, Phase 3)
// ---------------------------------------------------------------------------

type JobBindings = {
  JOBS?: Queue<import('../jobs.js').JobMessage>
  /** '1': the jobs go through JOBS (wrangler.jsonc). */
  JOBS_ON_QUEUE?: string
  /** The dead letters of JOBS: a producer only to read its backlog. */
  JOBS_DEAD?: Queue<import('../jobs.js').JobMessage>
}
const jobBindings = env as unknown as JobBindings

/** Whether jobs go through the JOBS queue: the Api object then runs no timers of its own. */
export const jobsOnQueue = () => Boolean(jobBindings.JOBS) && jobBindings.JOBS_ON_QUEUE === '1'

/**
 * Run a job's message soon (src/jobs.ts): on the JOBS queue, whose consumer runs it apart from
 * everything else; without it, here, in the background, as on Node.
 */
export async function enqueue(message: import('../jobs.js').JobMessage, delaySeconds = 0) {
  if (jobsOnQueue()) {
    await jobBindings.JOBS!.send(message, delaySeconds ? { delaySeconds } : {})
    return
  }
  const run = () =>
    void import('../jobs.js').then(({ runJob }) => runJob(message)).catch(() => undefined)
  if (delaySeconds) setTimeout(run, delaySeconds * 1000)
  else run()
}

/** The jobs' queue and its dead letters, as Cloudflare counts them; null without the queue. */
export async function jobQueues() {
  const { JOBS, JOBS_DEAD } = jobBindings
  if (!jobsOnQueue() || !JOBS || !JOBS_DEAD) return null
  const health = async (queue: Queue<unknown>) => {
    const m = await queue.metrics()
    return { backlog: m.backlogCount, oldestAt: m.oldestMessageTimestamp ?? null }
  }
  const [jobs, dead] = await Promise.all([health(JOBS), health(JOBS_DEAD)])
  return { jobs, dead }
}
