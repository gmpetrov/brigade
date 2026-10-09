// The WebSocket hub: one socket per runner, one per open dashboard tab.
// Everything lives in this one API process; there is no broker.
import { createHash } from 'node:crypto'
import {
  ApiToBrowser,
  ApiToRunner,
  BrowserToApi,
  MIN_PROTOCOL_VERSION,
  RunnerToApi,
  type AgentEvent,
  type SequencedEvent,
} from '@brigade/contracts'
import type { WSContext } from 'hono/ws'
import { audit } from './audit.js'
import { prisma, scoped, type Prisma } from './db.js'
import { specFor } from './thread-spec.js'
import { ensureRunning, touch } from './cloud.js'
import { handleConnectorCall } from './connector-calls.js'
import { endLogin, loginById, loginsOnComputer } from './logins.js'
import type { SessionStatus } from './generated/prisma/enums.js'
import type { WorkspaceScope } from './scope.js'

type RunnerConn = {
  runnerId: string
  computerId: string
  organizationId: string
  workspaceId: string
  ws: WSContext
}

type BrowserConn = {
  scope: WorkspaceScope
  ws: WSContext
  sessions: Set<string>
}

const runners = new Map<string, RunnerConn>() // by computerId
const browsers = new Set<BrowserConn>()

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export function isOnline(computerId: string) {
  return runners.has(computerId)
}

function send(ws: WSContext, message: ApiToRunner | ApiToBrowser) {
  ws.send(JSON.stringify(message))
}

/** Send a command to a computer's runner. Returns false when it is offline. */
export function sendToRunner(computerId: string, message: ApiToRunner): boolean {
  const conn = runners.get(computerId)
  if (!conn) return false
  touch(computerId)
  send(conn.ws, message)
  return true
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
  await ensureRunning(computer.id)
  return 'queued'
}

function flushQueue(computerId: string) {
  const list = queued.get(computerId) ?? []
  queued.delete(computerId)
  for (const { message, at } of list)
    if (Date.now() - at < QUEUE_TTL_MS) sendToRunner(computerId, message)
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
export function sendToMember(memberId: string, message: ApiToBrowser) {
  for (const b of browsers) if (b.scope.memberId === memberId) send(b.ws, message)
}

export function broadcastThreadStatus(workspaceId: string, sessionId: string, status: string) {
  broadcast(workspaceId, { type: 'thread.updated', sessionId, status })
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
    const parsed = RunnerToApi.safeParse(JSON.parse(String(raw)))
    if (!parsed.success) return console.warn('bad runner message', parsed.error.issues[0])
    const message = parsed.data

    if (message.type === 'hello') {
      if (message.protocolVersion < MIN_PROTOCOL_VERSION) {
        send(ws, { type: 'update.required', minProtocolVersion: MIN_PROTOCOL_VERSION })
        ws.close(4000, 'update required')
        return
      }
      runners.get(runner.computerId)?.ws.close(4001, 'replaced by a newer connection')
      conn = { ...runner, runnerId: runner.id, ws }
      runners.set(runner.computerId, conn)
      await prisma.runner.update({
        where: { id: runner.id },
        data: {
          version: message.version,
          protocolVersion: message.protocolVersion,
          platform: message.platform,
          lastSeenAt: new Date(),
        },
      })
      const computer = await prisma.computer.update({
        where: { id: runner.computerId },
        data: { status: 'running' },
      })
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
      send(ws, { type: 'welcome', runnerId: runner.id, computerId: runner.computerId })
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
      await prisma.account.update({
        where: { id: login.accountId },
        data: message.ok
          ? {
              status: 'ready',
              exhaustedUntil: null,
              email: message.email ?? null,
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
      await noteAccountState(session.accountId, fresh)
      await noteAccountSwitches(session, fresh)
    }
    send(ws, { type: 'ack', sessionId, seq: lastSeq })
  }
}

/** A thread's status follows from its events, so it survives disconnects and replays. */
function statusAfter(current: SessionStatus, event: AgentEvent): SessionStatus {
  switch (event.type) {
    case 'message.user':
    case 'approval.resolved':
      return 'running'
    case 'approval.requested':
      return 'waiting'
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
      await prisma.ticket.create({
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

/** Keep the account's usage snapshot, and notice when its login stopped working. */
async function noteAccountState(accountId: string | null, events: SequencedEvent[]) {
  if (!accountId) return
  const usage = events.findLast((e) => e.event.type === 'usage.updated' && e.event.limits?.length)
  const authFailed = events.some(
    (e) =>
      e.event.type === 'error' &&
      /log ?in|logged out|authenticat|credential|401|oauth/i.test(e.event.message),
  )
  // Only an actual reply proves the login works; a turn can complete after an error.
  const worked = events.some((e) => e.event.type === 'message.done')
  if (!usage && !authFailed && !worked) return
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

// ---------------------------------------------------------------------------
// Browsers
// ---------------------------------------------------------------------------

export function browserSocket(scope: WorkspaceScope) {
  const conn: BrowserConn = { scope, ws: undefined as unknown as WSContext, sessions: new Set() }
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
    include: { teammate: true, computer: true },
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
