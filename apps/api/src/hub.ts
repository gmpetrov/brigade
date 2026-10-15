// The WebSocket hub: one socket per runner, one per open dashboard tab.
// Everything lives in this one API process; there is no broker.
import { createHash, randomUUID } from 'node:crypto'
import {
  ApiToBrowser,
  ApiToRunner,
  BrowserToApi,
  HEARTBEAT_PROTOCOL,
  MIN_PROTOCOL_VERSION,
  RESUME_PROTOCOL,
  RunnerToApi,
  type AgentEvent,
  type SequencedEvent,
} from '@brigade/contracts'
import type { WSContext } from 'hono/ws'
import { audit } from './audit.js'
import { onScopedWrite, prisma, scoped, type Prisma } from './db.js'
import { specFor } from './thread-spec.js'
import { ensureSetup, touch, wake } from './cloud.js'
import { handleConnectorCall } from './connector-calls.js'
import { handleCredentialRequest } from './credentials.js'
import { handleLibraryCall, handleMemoryUpdate } from './library-calls.js'
import { handleScheduleCall } from './schedules.js'
import { handleTaskCall } from './tasks.js'
import {
  handlePreviewCall,
  handlePreviewExpose,
  settlePreviewLogs,
  settlePreviewStart,
} from './app-previews.js'
import { endLogin, loginById, loginsOnComputer } from './logins.js'
import { runnerBundle } from './routes/runner-install.js'
import { reviewTurnEnded } from './pull-requests.js'
import { handoffThread, titleThread } from './work.js'
import { historyContext, pageStart } from './thread-history.js'
import { messagesToRequeue, turnsToResume, type QueuedMessage } from './recovery.js'
import type { SessionStatus } from './generated/prisma/enums.js'
import type { WorkspaceScope } from './scope.js'

type RunnerConn = {
  runnerId: string
  protocolVersion: number
  /** The bundle it was installed from, and the last one it was told about. */
  bundle?: string
  offered?: string
  computerId: string
  organizationId: string
  workspaceId: string
  ws: WSContext
  /** When it last said anything (Date.now()): see watchRunners. */
  heardAt: number
}

type BrowserConn = {
  scope: WorkspaceScope
  ws: WSContext
  sessions: Set<string>
  /** The dashboard is in view (its last presence message; until one comes, it is). */
  visible: boolean
}

const runners = new Map<string, RunnerConn>() // by computerId
const browsers = new Set<BrowserConn>()

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export function isOnline(computerId: string) {
  return runners.has(computerId)
}

/**
 * Forget a computer's runner connection: its computer stopped (src/cloud.ts's stopComputer),
 * or the runner went silent (watchRunners). Such a connection dies without closing: kept, it
 * looked online, so commands went into it and were lost, and the computer was never started
 * again for them.
 */
export function dropRunner(computerId: string) {
  const conn = runners.get(computerId)
  if (!conn) return
  runners.delete(computerId)
  conn.ws.close(1001, 'computer stopped')
  broadcast(conn.workspaceId, { type: 'computer.updated', computerId, online: false })
}

/** The protocol version of a computer's connected runner; undefined while it is offline. */
export function runnerProtocol(computerId: string) {
  return runners.get(computerId)?.protocolVersion
}

function send(ws: WSContext, message: ApiToRunner | ApiToBrowser) {
  ws.send(JSON.stringify(message))
}

/**
 * Send a command to a computer's runner. Returns false when it is offline.
 * Background work (touch: false) does not keep a cloud computer from its idle stop.
 */
export function sendToRunner(
  computerId: string,
  message: ApiToRunner,
  options: { touch?: boolean } = {},
): boolean {
  const conn = runners.get(computerId)
  if (!conn) return false
  if (options.touch !== false) touch(computerId)
  send(conn.ws, message)
  return true
}

const clipboards = new Map<
  string,
  { computerId: string; resolve: (text: string) => void; reject: (error: Error) => void }
>()

/**
 * Set a cloud computer's desktop clipboard to `text`, or read it. Resolves
 * with the clipboard text; rejects when the runner is offline or cannot.
 */
export function desktopClipboard(computerId: string, text?: string) {
  return new Promise<string>((resolve, reject) => {
    const requestId = randomUUID()
    const timer = setTimeout(() => {
      clipboards.delete(requestId)
      reject(new Error('The computer did not answer'))
    }, 5000)
    const settle =
      <T>(fn: (value: T) => void) =>
      (value: T) => {
        clearTimeout(timer)
        clipboards.delete(requestId)
        fn(value)
      }
    clipboards.set(requestId, { computerId, resolve: settle(resolve), reject: settle(reject) })
    const sent = sendToRunner(computerId, {
      type: 'desktop.clipboard',
      requestId,
      ...(text === undefined ? {} : { text }),
    })
    if (!sent) clipboards.get(requestId)?.reject(new Error('The computer is offline'))
  })
}

type FileResult = Extract<RunnerToApi, { type: 'thread.file.result' }>
const fileReads = new Map<string, { computerId: string; settle: (result: FileResult) => void }>()

/**
 * Read a file a thread mentions from its computer (a teammate's working folder
 * or the library mirror), for a person viewing it. Never wakes a stopped computer.
 */
export function readThreadFile(
  computerId: string,
  request: Omit<Extract<ApiToRunner, { type: 'thread.file.read' }>, 'type' | 'requestId'>,
) {
  return new Promise<FileResult>((resolve) => {
    const requestId = randomUUID()
    const fail = (error: string) =>
      settle({ type: 'thread.file.result', requestId, ok: false, error })
    const timer = setTimeout(() => fail('The computer did not answer'), 10_000)
    const settle = (result: FileResult) => {
      clearTimeout(timer)
      fileReads.delete(requestId)
      resolve(result)
    }
    fileReads.set(requestId, { computerId, settle })
    if (!sendToRunner(computerId, { type: 'thread.file.read', requestId, ...request }))
      fail('The computer is offline')
  })
}

/** Commands for cloud computers that are starting, sent when their runner connects. */
const queued = new Map<string, { message: ApiToRunner; at: number }[]>()
const QUEUE_TTL_MS = 10 * 60_000

/**
 * Send now, or for a cloud computer that is stopped or starting, start it and
 * send once its runner connects. A member's machine that is offline returns 'offline'.
 */
export async function dispatch(
  computer: { id: string; kind: string },
  message: ApiToRunner,
): Promise<'sent' | 'queued' | 'offline'> {
  if (sendToRunner(computer.id, message)) return 'sent'
  if (computer.kind !== 'cloud') return 'offline'
  const list = queued.get(computer.id) ?? []
  list.push({ message, at: Date.now() })
  queued.set(computer.id, list)
  // Not waited for: it asks the provider first, at times for seconds, and the answer
  // here is the same.
  wake(computer.id)
  return 'queued'
}

/**
 * When the served runner bundle changes (a rebuild, a deploy), tell each
 * connected runner installed from another one, once per bundle. Started by
 * the entry (src/jobs.ts): Workers allow no timers while modules load.
 */
/** A runner that says nothing for this long is gone: it says something every 30 s. */
const SILENT_MS = 90_000

/**
 * Forget runners that stopped saying anything, whose connection died without closing (a
 * cloud computer stopped or crashed, a laptop asleep): until then the computer looked
 * online, and commands sent to it were lost. Runners too old to send heartbeats stay until
 * their connection closes. Started by the entry (src/jobs.ts).
 */
export const watchRunners = () =>
  setInterval(() => {
    const now = Date.now()
    for (const conn of runners.values()) {
      if (conn.protocolVersion < HEARTBEAT_PROTOCOL || now - conn.heardAt < SILENT_MS) continue
      console.warn(
        `runner of ${conn.computerId} silent for ${Math.round((now - conn.heardAt) / 1000)} s: forgotten`,
      )
      dropRunner(conn.computerId)
    }
  }, 30_000)

/** Dashboards' sockets carry nothing for long stretches: say something before they look idle. */
export const pingBrowsers = () =>
  setInterval(() => {
    for (const conn of browsers) send(conn.ws, { type: 'ping' })
  }, 30_000)

export const offerRunnerUpdates = () =>
  setInterval(() => {
    void runnerBundle().then((bundle) => {
      if (!bundle) return
      for (const conn of runners.values()) {
        if (conn.protocolVersion < 3 || !conn.bundle || conn.bundle === bundle) continue
        if (conn.offered === bundle) continue
        conn.offered = bundle
        send(conn.ws, { type: 'update.available', bundle })
      }
    }, console.error)
  }, 60_000)

function flushQueue(computerId: string) {
  const list = queued.get(computerId) ?? []
  queued.delete(computerId)
  for (const { message, at } of list)
    if (Date.now() - at < QUEUE_TTL_MS) sendToRunner(computerId, message)
}

const libraryTimers = new Map<string, NodeJS.Timeout>()

/**
 * Tell the workspace's connected runners the library or memory changed, so
 * they fetch it again. Changes in quick succession go as one.
 */
export function notifyLibraryChanged(workspaceId: string) {
  if (libraryTimers.has(workspaceId)) return
  libraryTimers.set(
    workspaceId,
    setTimeout(() => {
      libraryTimers.delete(workspaceId)
      for (const conn of runners.values())
        if (conn.workspaceId === workspaceId && conn.protocolVersion >= 4)
          send(conn.ws, { type: 'library.changed' })
    }, 300),
  )
}

/** Tell dashboards a computer's status or connection changed. */
export function broadcastComputer(workspaceId: string, computerId: string) {
  broadcast(workspaceId, { type: 'computer.updated', computerId, online: isOnline(computerId) })
}

function broadcast(workspaceId: string, message: ApiToBrowser, sessionId?: string) {
  for (const b of browsers) {
    if (b.scope.workspaceId !== workspaceId) continue
    if (sessionId && !b.sessions.has(sessionId)) continue
    send(b.ws, message)
  }
}

/** Send to every open dashboard of one member, e.g. sign-in progress for their account. */
/** When each member last had a dashboard in view, for a while after they leave it. */
const lastLooked = new Map<string, number>()

/**
 * Whether a member is looking at a dashboard, or was in the last `withinMs`: what
 * would notify them is already in front of them.
 */
export function isLooking(memberId: string, withinMs: number) {
  for (const b of browsers) if (b.scope.memberId === memberId && b.visible) return true
  return Date.now() - (lastLooked.get(memberId) ?? 0) < withinMs
}

const leftView = (conn: BrowserConn) => {
  if (conn.visible) lastLooked.set(conn.scope.memberId, Date.now())
}

export function sendToMember(memberId: string, message: ApiToBrowser) {
  for (const b of browsers) if (b.scope.memberId === memberId) send(b.ws, message)
}

export function broadcastThreadStatus(workspaceId: string, sessionId: string, status: string) {
  broadcast(workspaceId, { type: 'thread.updated', sessionId, status })
}

/** Tell dashboards a task was created, changed or removed. */
export function broadcastTask(workspaceId: string, taskId: string) {
  broadcast(workspaceId, { type: 'task.updated', taskId })
}

const listTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Tell dashboards tickets or pull requests changed, so lists and sidebar badges
 * refetch. Coalesced: a burst of writes is one message, sent once they settle.
 */
export function notifyList(workspaceId: string, type: 'tickets.updated' | 'pulls.updated') {
  const key = `${workspaceId}:${type}`
  if (listTimers.has(key)) return
  listTimers.set(
    key,
    setTimeout(() => {
      listTimers.delete(key)
      broadcast(workspaceId, { type })
    }, 300),
  )
}

onScopedWrite((model, scope) => {
  if (model === 'Ticket') notifyList(scope.workspaceId, 'tickets.updated')
  else if (model === 'PullRequest' || model === 'PullRequestReview')
    notifyList(scope.workspaceId, 'pulls.updated')
})

/** A project was created, changed or removed: the sidebar and project pages refetch. */
export function broadcastProjects(workspaceId: string) {
  broadcast(workspaceId, { type: 'projects.updated' })
}

/** A schedule was created, changed, fired or removed. */
export function broadcastSchedule(workspaceId: string, scheduleId: string) {
  broadcast(workspaceId, { type: 'schedule.updated', scheduleId })
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

export async function authenticateRunner(authorization: string | undefined) {
  const token = authorization?.match(/^Bearer (.+)$/)?.[1]
  if (!token) return null
  return prisma.runner.findUnique({ where: { tokenHash: hashToken(token) } })
}

export function runnerSocket(runner: {
  id: string
  computerId: string
  organizationId: string
  workspaceId: string
}) {
  let conn: RunnerConn | undefined
  // Serialise event batches so sequence bookkeeping stays simple.
  let queue = Promise.resolve()

  return {
    onMessage(raw: unknown, ws: WSContext) {
      // Heard now, though its turn in the queue may come later.
      if (conn) conn.heardAt = Date.now()
      queue = queue
        .then(() => handle(raw, ws))
        .catch((error) => console.error('runner message failed', error))
    },
    onClose() {
      if (conn && runners.get(runner.computerId) === conn) {
        runners.delete(runner.computerId)
        broadcast(runner.workspaceId, {
          type: 'computer.updated',
          computerId: runner.computerId,
          online: false,
        })
      }
    },
  }

  async function handle(raw: unknown, ws: WSContext) {
    const json = JSON.parse(String(raw)) as { callId?: unknown }
    const parsed = RunnerToApi.safeParse(json)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      console.warn('bad runner message', issue)
      // A call the runner waits on is answered, or the teammate's tool would wait forever.
      if (typeof json?.callId === 'string')
        send(ws, {
          type: 'connector.result',
          callId: json.callId,
          ok: false,
          error: `Brigade could not read this call (${issue?.path.join('.') || 'message'}: ${issue?.message}). Try again differently.`,
        })
      return
    }
    const message = parsed.data

    if (message.type === 'hello') {
      const bundle = (await runnerBundle()) ?? undefined
      if (message.protocolVersion < MIN_PROTOCOL_VERSION) {
        send(ws, {
          type: 'update.required',
          minProtocolVersion: MIN_PROTOCOL_VERSION,
          ...(bundle ? { bundle } : {}),
        })
        ws.close(4000, 'update required')
        return
      }
      runners.get(runner.computerId)?.ws.close(4001, 'replaced by a newer connection')
      conn = {
        ...runner,
        runnerId: runner.id,
        protocolVersion: message.protocolVersion,
        ws,
        heardAt: Date.now(),
        ...(message.bundle ? { bundle: message.bundle } : {}),
        ...(bundle ? { offered: bundle } : {}),
      }
      runners.set(runner.computerId, conn)
      await prisma.runner.update({
        where: { id: runner.id },
        data: {
          // The installed bundle tells builds apart; the package version does not change.
          version: message.bundle
            ? `${message.version}+${message.bundle.slice(0, 12)}`
            : message.version,
          protocolVersion: message.protocolVersion,
          platform: message.platform,
          lastSeenAt: new Date(),
        },
      })
      const computer = await prisma.computer.update({
        where: { id: runner.computerId },
        data: { status: 'running' },
      })
      // A cloud computer set up by an older bootstrap gets the current root setup.
      if (computer.kind === 'cloud')
        void ensureSetup(computer, message.setup).catch((error) =>
          console.error(`setup on ${computer.id} failed`, error),
        )
      if (computer.kind === 'member_machine' && computer.memberId && message.machineLogins) {
        await syncMachineLogins(computer, computer.memberId, message.machineLogins)
      }
      // A runner that reconnects has lost any sign-in it was running.
      for (const login of loginsOnComputer(runner.computerId)) {
        endLogin(login.loginId)
        await prisma.account.updateMany({
          where: { id: login.accountId, status: 'signing_in' },
          data: { status: 'needs_sign_in' },
        })
        sendToMember(login.memberId, {
          type: 'account.login',
          accountId: login.accountId,
          state: 'failed',
          error: 'The computer restarted during sign-in. Sign in again.',
        })
      }
      // Turns and queued messages a restart may have cut off: the runner continues those it
      // lost (an older one closes and cancels them). Waiting threads too: a turn waiting on
      // a connector call's approval was still running there.
      const inProgress = await prisma.session.findMany({
        where: { computerId: runner.computerId, status: { in: ['running', 'waiting'] } },
        select: { id: true, status: true },
      })
      const runningThreads = inProgress.filter((s) => s.status === 'running').map((s) => s.id)
      const queuedMessages = await queuedMessagesOn(runner.computerId)
      const resumes = message.protocolVersion >= RESUME_PROTOCOL
      // A runner installed from another bundle updates itself once it is idle.
      send(ws, {
        type: 'welcome',
        runnerId: runner.id,
        computerId: runner.computerId,
        ...(bundle ? { bundle } : {}),
        runningThreads,
        queuedMessages: queuedMessages.map(({ sessionId, messageId }) => ({
          sessionId,
          messageId,
        })),
        ...(resumes
          ? {
              resume: await turnsToResume(
                runner,
                inProgress.map((s) => s.id),
              ),
              requeue: await messagesToRequeue(runner, queuedMessages),
            }
          : {}),
      })
      if (message.bundle && bundle && message.bundle !== bundle)
        console.log(
          `runner ${runner.id}: bundle ${message.bundle.slice(0, 12)} → ${bundle.slice(0, 12)}`,
        )
      touch(runner.computerId)
      flushQueue(runner.computerId)
      broadcast(runner.workspaceId, {
        type: 'computer.updated',
        computerId: runner.computerId,
        online: true,
      })
      return
    }
    if (!conn) return // must say hello first
    // Heard, which is all it says (onMessage).
    if (message.type === 'heartbeat') return

    if (message.type === 'events') {
      const bySession = Map.groupBy(message.events, (e) => e.sessionId)
      for (const [sessionId, events] of bySession) await storeEvents(sessionId, events, ws)
      return
    }

    if (message.type === 'account.login.prompt' || message.type === 'account.login.done') {
      const login = loginById(message.loginId)
      if (!login || login.computerId !== runner.computerId) return
      if (message.type === 'account.login.prompt') {
        login.last = {
          type: 'account.login',
          accountId: login.accountId,
          state: 'open_url',
          url: message.url,
          flow: message.flow,
          ...(message.userCode ? { userCode: message.userCode } : {}),
        }
        sendToMember(login.memberId, login.last)
        return
      }
      endLogin(login.loginId)
      if (message.ok) {
        const resolved = await prisma.ticket.updateManyAndReturn({
          where: {
            type: 'sign_in',
            status: 'open',
            payload: { path: ['accountId'], equals: login.accountId },
          },
          data: { status: 'resolved', resolvedByMemberId: login.memberId, resolvedAt: new Date() },
          select: { workspaceId: true },
        })
        for (const t of resolved) notifyList(t.workspaceId, 'tickets.updated')
      }
      await prisma.account.update({
        where: { id: login.accountId },
        data: message.ok
          ? {
              status: 'ready',
              exhaustedUntil: null,
              // A token cannot tell whose it is: the member may have said.
              email: message.email ?? login.email ?? null,
              plan: message.plan ?? null,
            }
          : { status: 'needs_sign_in' },
      })
      await audit({
        organizationId: runner.organizationId,
        workspaceId: runner.workspaceId,
        actor: { type: 'member', id: login.memberId },
        action: message.ok ? 'account.signed_in' : 'account.sign_in_failed',
        target: { type: 'account', id: login.accountId },
      })
      sendToMember(login.memberId, {
        type: 'account.login',
        accountId: login.accountId,
        state: message.ok ? 'done' : 'failed',
        ...(message.error ? { error: message.error } : {}),
      })
      return
    }

    if (message.type === 'credential.request') {
      // May wait for a person, like a connector call.
      void handleCredentialRequest(runner, message, (reply) => send(ws, reply)).catch((error) =>
        send(ws, {
          type: 'connector.result',
          callId: message.callId,
          ok: false,
          error: String(error),
        }),
      )
      return
    }

    if (message.type === 'task.call') {
      void handleTaskCall(runner, message, (reply) => send(ws, reply)).catch((error) =>
        send(ws, {
          type: 'connector.result',
          callId: message.callId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      return
    }

    if (message.type === 'schedule.call') {
      void handleScheduleCall(runner, message, (reply) => send(ws, reply)).catch((error) =>
        send(ws, {
          type: 'connector.result',
          callId: message.callId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      return
    }

    if (message.type === 'library.call') {
      void handleLibraryCall(runner, message, (reply) => send(ws, reply)).catch((error) =>
        send(ws, {
          type: 'connector.result',
          callId: message.callId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      return
    }

    if (message.type === 'memory.update') {
      void handleMemoryUpdate(runner, message).catch((error) =>
        console.warn(`runner ${runner.id}: memory update failed: ${String(error)}`),
      )
      return
    }

    if (message.type === 'thread.title') {
      void titleThread(runner, message).catch((error) =>
        console.warn(`runner ${runner.id}: thread title failed: ${String(error)}`),
      )
      return
    }

    if (message.type === 'thread.handoff') {
      // Sent when the teammate's turn ends; caps and the chain limit are checked there.
      void handoffThread(runner, message).catch((error) =>
        console.warn(`runner ${runner.id}: handoff failed: ${String(error)}`),
      )
      return
    }

    if (message.type === 'connector.call') {
      // Long-running (it may wait for a person): do not block the runner's other messages.
      void handleConnectorCall(runner, message, (reply) => send(ws, reply)).catch((error) =>
        send(ws, {
          type: 'connector.result',
          callId: message.callId,
          ok: false,
          error: String(error),
        }),
      )
      return
    }

    if (message.type === 'preview.call') {
      void handlePreviewCall(runner, message, (reply) => send(ws, reply)).catch((error) =>
        send(ws, {
          type: 'connector.result',
          callId: message.callId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      return
    }

    if (message.type === 'preview.expose') {
      void handlePreviewExpose(runner, message, (reply) => send(ws, reply)).catch((error) =>
        send(ws, {
          type: 'connector.result',
          callId: message.callId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      return
    }

    if (message.type === 'preview.logs.result') return settlePreviewLogs(runner.computerId, message)
    if (message.type === 'preview.start.result')
      return settlePreviewStart(runner.computerId, message)

    if (message.type === 'thread.file.result') {
      const read = fileReads.get(message.requestId)
      if (read?.computerId === runner.computerId) read.settle(message)
      return
    }

    if (message.type === 'desktop.clipboard.result') {
      const request = clipboards.get(message.requestId)
      if (!request || request.computerId !== runner.computerId) return
      if (message.error !== undefined) request.reject(new Error(message.error))
      else request.resolve(message.text ?? '')
      return
    }

    if (message.type === 'terminal.output' || message.type === 'terminal.exit')
      return relayTerminal(runner.computerId, message)

    if (message.type === 'command.failed')
      console.warn(`runner ${runner.id}: command ${message.commandId} failed: ${message.error}`)
  }

  async function storeEvents(sessionId: string, events: SequencedEvent[], ws: WSContext) {
    touch(runner.computerId)
    // A runner may only write events for threads on its own computer.
    const session = await prisma.session.findFirst({
      where: { id: sessionId, computerId: runner.computerId },
    })
    if (!session)
      return console.warn(`runner ${runner.id} sent events for a thread it does not run`)

    await prisma.sessionEvent.createMany({
      data: events.map((e) => ({
        organizationId: session.organizationId,
        workspaceId: session.workspaceId,
        sessionId,
        seq: e.seq,
        type: e.event.type,
        data: e.event as unknown as Prisma.InputJsonValue,
        at: new Date(e.event.at),
      })),
      skipDuplicates: true,
    })

    // Advance lastSeq over the contiguous run of stored events.
    const stored = await prisma.sessionEvent.findMany({
      where: { sessionId, seq: { gt: session.lastSeq } },
      orderBy: { seq: 'asc' },
      select: { seq: true, data: true },
    })
    let lastSeq = session.lastSeq
    const fresh: SequencedEvent[] = []
    for (const row of stored) {
      if (row.seq !== lastSeq + 1) break
      lastSeq = row.seq
      fresh.push({ sessionId, seq: row.seq, event: row.data as unknown as SequencedEvent['event'] })
    }
    if (lastSeq !== session.lastSeq) {
      const status = fresh.reduce<SessionStatus>(
        (current, e) => statusAfter(current, e.event),
        session.status,
      )
      await prisma.session.update({ where: { id: sessionId }, data: { lastSeq, status } })
      broadcast(session.workspaceId, { type: 'events', events: fresh }, sessionId)
      if (status !== session.status) broadcastThreadStatus(session.workspaceId, sessionId, status)
      await noteAccountState(session, fresh)
      await noteAccountSwitches(session, fresh)
      await noteTickets(session, fresh)
      // Not awaited: a review loop may call GitHub and prompt the next teammate.
      void noteTurnsEnded(session, fresh).catch(console.error)
    }
    send(ws, { type: 'ack', sessionId, seq: lastSeq })
  }
}

/** How far back a message may still be queued on a runner. */
const QUEUED_FOR_MS = 7 * 24 * 60 * 60_000

/**
 * The messages shown as queued on a computer's threads, in the order they
 * came, with their latest text: queued, and neither read (message.user) nor
 * cancelled since. The runner says which it lost.
 */
async function queuedMessagesOn(computerId: string): Promise<QueuedMessage[]> {
  const queued = await prisma.sessionEvent.findMany({
    where: {
      type: 'message.queued',
      at: { gte: new Date(Date.now() - QUEUED_FOR_MS) },
      session: { computerId },
    },
    select: { sessionId: true, seq: true },
  })
  if (queued.length === 0) return []
  const rows = await prisma.sessionEvent.findMany({
    where: {
      sessionId: { in: [...new Set(queued.map((q) => q.sessionId))] },
      type: { in: ['message.queued', 'message.user', 'message.cancelled'] },
      seq: { gte: Math.min(...queued.map((q) => q.seq)) },
    },
    orderBy: { seq: 'asc' },
    select: { sessionId: true, data: true },
  })
  const open = new Map<string, QueuedMessage>()
  for (const { sessionId, data } of rows) {
    const event = data as unknown as AgentEvent
    const messageId = 'messageId' in event ? event.messageId : undefined
    if (!messageId) continue
    const key = `${sessionId}:${messageId}`
    // Queued again (edited, or held for a person): it keeps its place, with the latest text.
    if (event.type === 'message.queued') open.set(key, { sessionId, messageId, queued: event })
    else open.delete(key)
  }
  return [...open.values()]
}

/** Each teammate whose turn ended: a review loop in the thread may move on. */
async function noteTurnsEnded(
  session: { id: string; organizationId: string; workspaceId: string; teammateId: string },
  events: SequencedEvent[],
) {
  let current: string | undefined
  for (const { seq, event } of events) {
    if (event.type === 'turn.started') current = event.teammateId
    if (event.type !== 'turn.completed') continue
    const started =
      event.teammateId || current
        ? null
        : await prisma.sessionEvent.findFirst({
            where: { sessionId: session.id, type: 'turn.started', seq: { lt: seq } },
            orderBy: { seq: 'desc' },
            select: { data: true },
          })
    const teammateId =
      event.teammateId ??
      current ??
      (started?.data as { teammateId?: string } | undefined)?.teammateId ??
      session.teammateId
    await reviewTurnEnded(
      { organizationId: session.organizationId, workspaceId: session.workspaceId },
      session.id,
      teammateId,
    )
  }
}

/** A thread's status follows from its events, so it survives disconnects and replays. */
function statusAfter(current: SessionStatus, event: AgentEvent): SessionStatus {
  switch (event.type) {
    case 'message.user':
    case 'approval.resolved':
      return 'running'
    case 'approval.requested':
    case 'question.asked':
    case 'ticket.opened':
      return 'waiting'
    case 'question.answered':
    case 'ticket.answered':
    case 'turn.started':
      return 'running'
    case 'turn.completed':
      return 'idle'
    case 'account.switched':
      return event.toAccountId ? current : 'paused'
    case 'control.changed':
      return event.controller === 'human' ? 'paused' : 'idle'
    case 'error':
      return 'failed'
    default:
      return current
  }
}

/**
 * A thread moved to another of its starter's accounts, or paused because none
 * has usage left: remember when the old one resets, and open a ticket on pause.
 */
async function noteAccountSwitches(
  session: { id: string; organizationId: string; workspaceId: string },
  events: SequencedEvent[],
) {
  const db = scoped(session)
  for (const { event } of events) {
    if (event.type !== 'account.switched') continue
    if (event.reason === 'usage_limit') {
      const until = event.resetsAt ? new Date(event.resetsAt) : new Date(Date.now() + 60 * 60_000)
      await prisma.account.updateMany({
        where: { id: event.fromAccountId },
        data: { exhaustedUntil: until },
      })
    }
    if (event.toAccountId) {
      await prisma.session.update({
        where: { id: session.id },
        data: { accountId: event.toAccountId },
      })
    } else {
      await db.ticket.create({
        data: {
          organizationId: session.organizationId,
          workspaceId: session.workspaceId,
          sessionId: session.id,
          type: 'usage_limit',
          title: 'Paused: every account has run out of usage',
          payload: { resetsAt: event.resetsAt },
        },
      })
    }
  }
}

/** Accounts already signed in on a member's own machine. */
async function syncMachineLogins(
  computer: { id: string; organizationId: string; workspaceId: string; name: string },
  memberId: string,
  logins: NonNullable<Extract<RunnerToApi, { type: 'hello' }>['machineLogins']>,
) {
  for (const login of logins) {
    const existing = await prisma.account.findFirst({
      where: { computerId: computer.id, memberId, provider: login.provider, source: 'machine' },
    })
    const identity = { email: login.email ?? null, plan: login.plan ?? null }
    if (existing) {
      await prisma.account.update({
        where: { id: existing.id },
        data: login.loggedIn
          ? { ...identity, status: existing.status === 'needs_sign_in' ? 'ready' : existing.status }
          : { status: 'needs_sign_in' },
      })
    } else if (login.loggedIn) {
      const hasDefault = await prisma.account.count({
        where: { memberId, provider: login.provider, isDefault: true },
      })
      await prisma.account.create({
        data: {
          organizationId: computer.organizationId,
          workspaceId: computer.workspaceId,
          memberId,
          computerId: computer.id,
          provider: login.provider,
          source: 'machine',
          label: `${login.provider === 'codex' ? 'Codex' : 'Claude'} on ${computer.name}`,
          status: 'ready',
          isDefault: hasDefault === 0,
          ...identity,
        },
      })
    }
  }
}

/**
 * Keep each account's usage snapshot, and notice when its login stopped
 * working. In a thread with several teammates, each turn says its account.
 */
async function noteAccountState(
  session: { id: string; organizationId: string; workspaceId: string; accountId: string | null },
  events: SequencedEvent[],
) {
  const byAccount = new Map<string, SequencedEvent[]>()
  let accountId = session.accountId
  for (const e of events) {
    if (e.event.type === 'turn.started') accountId = e.event.accountId
    if (accountId) byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), e])
    // What follows a switch is the new account's.
    if (e.event.type === 'account.switched' && e.event.toAccountId) accountId = e.event.toAccountId
  }
  for (const [id, list] of byAccount) await noteOneAccount(session, id, list)
}

async function noteOneAccount(
  session: { id: string; organizationId: string; workspaceId: string },
  accountId: string,
  events: SequencedEvent[],
) {
  const usage = events.findLast((e) => e.event.type === 'usage.updated' && e.event.limits?.length)
  const authFailed = events.some(
    (e) =>
      e.event.type === 'error' &&
      /log ?in|logged out|authenticat|credential|401|oauth/i.test(e.event.message),
  )
  // Only an actual reply proves the login works; a turn can complete after an error.
  const worked = events.some((e) => e.event.type === 'message.done')
  if (!usage && !authFailed && !worked) return
  const before = await prisma.account.findFirst({
    where: { id: accountId, workspaceId: session.workspaceId },
  })
  if (!before) return
  if (authFailed && before.status !== 'needs_sign_in') {
    // An expired login is a ticket for the member who owns the account.
    await scoped(session).ticket.create({
      data: {
        organizationId: session.organizationId,
        workspaceId: session.workspaceId,
        sessionId: session.id,
        type: 'sign_in',
        title: `Sign in again: ${before.label}`,
        payload: { accountId, memberId: before.memberId },
      },
    })
  }
  await prisma.account.update({
    where: { id: accountId },
    data: {
      ...(usage && usage.event.type === 'usage.updated'
        ? { lastUsage: usage.event.limits as Prisma.InputJsonValue, lastUsageAt: new Date() }
        : {}),
      ...(authFailed ? { status: 'needs_sign_in' } : worked ? { status: 'ready' } : {}),
    },
  })
}

/**
 * Keep the ticket queue in step with the thread: the harness asking before a
 * built-in tool call is a ticket, closed when answered; a usage-limit pause is
 * closed when someone prompts the thread again.
 */
async function noteTickets(
  session: { id: string; organizationId: string; workspaceId: string; teammateId: string },
  events: SequencedEvent[],
) {
  const db = scoped(session)
  for (const { event } of events) {
    if (event.type === 'approval.requested') {
      // Connector writes already have their ticket; its id is the approval id.
      const exists = await db.ticket.count({ where: { id: event.approvalId } })
      if (exists) continue
      const teammate = await eventTeammate(session, event)
      const input = JSON.stringify(event.input ?? null)
      await db.ticket.create({
        data: {
          organizationId: session.organizationId,
          workspaceId: session.workspaceId,
          sessionId: session.id,
          type: 'approval',
          title: `${teammate?.name ?? 'Teammate'}: ${event.toolName}${describeInput(event.input)}`,
          payload: {
            source: 'harness',
            teammateId: teammate?.id ?? session.teammateId,
            approvalId: event.approvalId,
            toolName: event.toolName,
            input:
              input.length <= 4000 ? (event.input as Prisma.InputJsonValue) : input.slice(0, 4000),
          },
        },
      })
    } else if (event.type === 'approval.resolved') {
      await db.ticket.updateMany({
        where: {
          sessionId: session.id,
          status: 'open',
          payload: { path: ['approvalId'], equals: event.approvalId },
        },
        data: {
          status: event.approved ? 'approved' : 'denied',
          resolvedByMemberId: event.memberId,
          resolvedAt: new Date(event.at),
        },
      })
    } else if (event.type === 'question.asked') {
      const teammate = await eventTeammate(session, event)
      const first = event.questions[0]?.question ?? 'a question'
      await db.ticket.create({
        data: {
          organizationId: session.organizationId,
          workspaceId: session.workspaceId,
          sessionId: session.id,
          type: 'question',
          title: `${teammate?.name ?? 'Teammate'} asks: ${first.length > 160 ? `${first.slice(0, 157)}...` : first}`,
          payload: {
            source: 'harness',
            teammateId: teammate?.id ?? session.teammateId,
            questionId: event.questionId,
            questions: event.questions as unknown as Prisma.InputJsonValue,
          },
        },
      })
    } else if (event.type === 'ticket.opened') {
      const teammate = await eventTeammate(session, event)
      const title = event.title.length > 160 ? `${event.title.slice(0, 157)}...` : event.title
      await db.ticket.create({
        data: {
          organizationId: session.organizationId,
          workspaceId: session.workspaceId,
          sessionId: session.id,
          type: 'request',
          title: `${teammate?.name ?? 'Teammate'}: ${title}`,
          payload: {
            source: 'harness',
            teammateId: teammate?.id ?? session.teammateId,
            requestId: event.requestId,
            asks: event.asks as unknown as Prisma.InputJsonValue,
          },
        },
      })
    } else if (event.type === 'ticket.answered') {
      await db.ticket.updateMany({
        where: {
          sessionId: session.id,
          status: 'open',
          payload: { path: ['requestId'], equals: event.requestId },
        },
        data: {
          status: event.answer.action === 'declined' ? 'denied' : 'resolved',
          resolvedByMemberId: event.memberId,
          resolvedAt: new Date(event.at),
        },
      })
    } else if (event.type === 'question.answered') {
      await db.ticket.updateMany({
        where: {
          sessionId: session.id,
          status: 'open',
          payload: { path: ['questionId'], equals: event.questionId },
        },
        data: {
          status: 'resolved',
          resolvedByMemberId: event.memberId,
          resolvedAt: new Date(event.at),
        },
      })
    } else if (event.type === 'message.user') {
      await db.ticket.updateMany({
        where: { sessionId: session.id, status: 'open', type: 'usage_limit' },
        data: {
          status: 'resolved',
          resolvedByMemberId: event.memberId,
          resolvedAt: new Date(event.at),
        },
      })
    }
  }
}

/** The teammate whose harness produced an event: one in the thread, else the starting one. */
async function eventTeammate(
  session: { id: string; workspaceId: string; teammateId: string },
  event: AgentEvent,
) {
  const seat = event.teammateId
    ? await prisma.threadTeammate.findFirst({
        where: { sessionId: session.id, teammateId: event.teammateId },
        include: { teammate: true },
      })
    : null
  return seat?.teammate ?? prisma.teammate.findUnique({ where: { id: session.teammateId } })
}

/** The part of a tool call a person needs to decide: the command, file or URL. */
function describeInput(input: unknown) {
  if (!input || typeof input !== 'object') return ''
  const i = input as Record<string, unknown>
  const value = [i.command, i.file_path, i.path, i.url, i.cmd].find((v) => typeof v === 'string')
  return typeof value === 'string'
    ? ` (${value.length > 120 ? `${value.slice(0, 117)}...` : value})`
    : ''
}

// ---------------------------------------------------------------------------
// Browsers
// ---------------------------------------------------------------------------

export function browserSocket(scope: WorkspaceScope) {
  const conn: BrowserConn = {
    scope,
    ws: undefined as unknown as WSContext,
    sessions: new Set(),
    visible: true,
  }
  return {
    onOpen(ws: WSContext) {
      conn.ws = ws
      browsers.add(conn)
    },
    async onMessage(raw: unknown, ws: WSContext) {
      const parsed = BrowserToApi.safeParse(JSON.parse(String(raw)))
      if (!parsed.success) return send(ws, { type: 'error', message: 'bad message' })
      const message = parsed.data
      if (message.type === 'unsubscribe') return void conn.sessions.delete(message.sessionId)
      if (message.type === 'presence') {
        if (!message.visible) leftView(conn)
        conn.visible = message.visible
        return
      }
      if (message.type === 'terminal.input' || message.type === 'terminal.close') {
        const terminal = terminals.get(message.terminalId)
        if (!terminal || terminal.conn !== conn) return
        if (message.type === 'terminal.close') terminals.delete(message.terminalId)
        sendToRunner(terminal.computerId, message)
        return
      }
      if (message.type === 'terminal.open') return openTerminal(conn, message)

      const session = await prisma.session.findFirst({
        where: {
          id: message.sessionId,
          organizationId: scope.organizationId,
          workspaceId: scope.workspaceId,
        },
      })
      if (!session) return send(ws, { type: 'error', message: 'thread not found' })
      conn.sessions.add(session.id)
      // Replay from storage; live events may interleave, and the client dedupes by seq.
      let afterSeq = message.afterSeq
      // Opened afresh: only the latest page, and what the whole thread needs from before it.
      if (message.tail && afterSeq === 0) {
        const firstSeq = await pageStart(session.id, session.lastSeq + 1)
        const context = await historyContext(session.id, firstSeq)
        send(ws, {
          type: 'history',
          sessionId: session.id,
          firstSeq,
          context,
          lastSeq: session.lastSeq,
        })
        afterSeq = firstSeq - 1
      }
      for (;;) {
        const rows = await prisma.sessionEvent.findMany({
          where: { sessionId: session.id, seq: { gt: afterSeq, lte: session.lastSeq } },
          orderBy: { seq: 'asc' },
          take: 500,
        })
        if (rows.length === 0) break
        send(ws, {
          type: 'events',
          events: rows.map((r) => ({
            sessionId: r.sessionId,
            seq: r.seq,
            event: r.data as unknown as SequencedEvent['event'],
          })),
        })
        afterSeq = rows.at(-1)!.seq
      }
    },
    onClose() {
      browsers.delete(conn)
      leftView(conn)
      for (const [id, terminal] of terminals) {
        if (terminal.conn !== conn) continue
        terminals.delete(id)
        sendToRunner(terminal.computerId, { type: 'terminal.close', terminalId: id })
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Takeover terminals: relayed between a dashboard and the runner, which runs the shell.
// ---------------------------------------------------------------------------

const terminals = new Map<string, { conn: BrowserConn; computerId: string; sessionId: string }>()

async function openTerminal(
  conn: BrowserConn,
  message: Extract<BrowserToApi, { type: 'terminal.open' }>,
) {
  const { scope } = conn
  const db = scoped(scope)
  const thread = await db.session.findFirst({
    where: { id: message.sessionId },
    include: {
      teammate: true,
      computer: true,
      teammates: { include: { teammate: true }, orderBy: { joinedAt: 'asc' } },
      task: { select: { id: true, title: true, description: true, completedAt: true } },
    },
  })
  const fail = (text: string) => {
    terminals.delete(message.terminalId)
    send(conn.ws, {
      type: 'terminal.output',
      terminalId: message.terminalId,
      data: `\r\n${text}\r\n`,
    })
    send(conn.ws, { type: 'terminal.exit', terminalId: message.terminalId, code: null })
  }
  if (!thread || thread.computer.kind !== 'cloud')
    return fail('Terminals are only available on the workspace computer')
  if (thread.controlledByMemberId !== scope.memberId) return fail('Take over the thread first')
  if (terminals.has(message.terminalId)) return
  terminals.set(message.terminalId, { conn, computerId: thread.computerId, sessionId: thread.id })
  const spec = await specFor(db, thread, { requireUsage: false }).catch(() => null)
  if (!spec) return fail('This thread has no account on this computer')
  await dispatch(thread.computer, {
    type: 'terminal.open',
    terminalId: message.terminalId,
    thread: spec,
    memberId: scope.memberId,
    cols: message.cols,
    rows: message.rows,
  })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'takeover.terminal_opened',
    target: { type: 'thread', id: thread.id },
  })
}

function relayTerminal(
  computerId: string,
  message: Extract<RunnerToApi, { type: 'terminal.output' | 'terminal.exit' }>,
) {
  const terminal = terminals.get(message.terminalId)
  if (!terminal || terminal.computerId !== computerId) return
  if (message.type === 'terminal.exit') terminals.delete(message.terminalId)
  send(terminal.conn.ws, message)
}
