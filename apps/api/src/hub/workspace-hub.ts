// One workspace's hub (docs/workspace-hubs-plan.md): the sockets of its runners and dashboards,
// and everything that waits on them. Nothing in it is shared with another workspace's hub, so
// each can live in a Durable Object of its own (src/hub-object.ts), or all of them in the API's
// one process (memory-host.ts). Its methods are reached through hubs.get(workspaceId)
// (operations.ts), or by its sockets' messages (runner-messages.ts, browser-messages.ts).
import { randomUUID } from 'node:crypto'
import {
  HEARTBEAT_PROTOCOL,
  OUTBOX_PROTOCOL,
  type ApiToBrowser,
  type ApiToRunner,
  type RunnerToApi,
} from '@brigade/contracts'
import { wake } from '../cloud.js'
import { prisma } from '../db.js'
import { movesOn } from '../move.js'
import { noteFailure } from '../ops/failures.js'
import {
  asOfNow,
  commandMessage,
  isDurable,
  keepCommand,
  noteSent,
  pendingCommands,
  RESEND_MS,
  unclaim,
  type DurableCommand,
} from '../runner-commands.js'
import { runnerBundle } from '../routes/runner-install.js'
import { packCommand, takesParts, unpackCommand } from '../spec-parts.js'
import type { BrowserConn, HubHost, RunnerConn } from './host.js'

/** Longest an update's restart may take: past it, the computer is offline after all. */
const RESTART_MS = 2 * 60_000
/**
 * Commands without a commandId (a sign-in, a terminal) wait this long for a runner that is
 * starting or restarting. They are a person's, live: past it, they are dropped.
 */
const QUEUE_TTL_MS = 10 * 60_000
/** Kept with the hub when it may hibernate only up to this size: larger ones stay in memory. */
const QUEUE_SAVED_MAX = 512 * 1024
/** A runner that says nothing for this long is gone: it says something every 30 s. */
export const SILENT_MS = 90_000
/** How often a hub checks its runners are still there, and offers them updates. */
export const TICK_MS = 30_000
/** One presence message holds this long: past it, a phone that suspended the app is not looking. */
const PRESENCE_MS = 75_000
/** Debounced broadcasts wait this long for the burst to settle. */
const SETTLE_MS = 300
/** A computer whose runner connects this many times within a minute is in a reconnect storm. */
export const STORM_CONNECTS = 10

/** Runner answers settled by request id (askRunner). */
const ANSWERS = new Set<RunnerToApi['type']>([
  'thread.file.result',
  'thread.file.written',
  'thread.source.result',
  'thread.code.result',
  'desktop.clipboard.result',
  'preview.logs.result',
  'preview.start.result',
  'project.describe.result',
  'computer.backup.result',
])

export type RunnerAnswer = Extract<RunnerToApi, { requestId: string }>

/** A request to a runner, waiting for its answer by request id (askRunner). */
type Asking = { computerId: string; settle: (answer: RunnerAnswer | { error: string }) => void }

type Restart = { until: number; protocolVersion: number }
type Queued = { message: ApiToRunner; at: number }

/** A computer's connection as dashboards and other code see it (status, lists). */
export type ComputerPresence = {
  online: boolean
  restarting: boolean
  protocolVersion?: number
  bundle?: string
  startedAt?: string
}

/** Lists a dashboard refetches when told (notifyList). */
export type ListType =
  'tickets.updated' | 'pulls.updated' | 'mail.updated' | 'teammates.updated' | 'connections.updated'

export class WorkspaceHub {
  /** Runners that said hello, by computer: each computer's one connection. */
  readonly runners = new Map<string, RunnerConn>()
  /** Runners connected that have not said hello yet. */
  readonly arriving = new Set<RunnerConn>()
  readonly browsers = new Set<BrowserConn>()

  /** Computers whose runner restarts into an update: their commands wait for the next one. */
  private readonly restarting: Map<string, Restart>
  /** Commands without a commandId waiting for a runner, by computer. */
  private readonly queued: Map<string, Queued[]>
  /** Threads whose runner says their events wait unacknowledged, with since when. */
  private readonly eventsWaiting: Map<string, { computerId: string; since: string }>
  /** When each member last had a dashboard in view, for a while after they leave it. */
  private readonly lastLooked: Map<string, number>
  /** When each cloud computer was last in use: its idle stop counts from it (src/cloud.ts). */
  private readonly lastActive: Map<string, number>
  /** Requests waiting on a runner's answer, by request id. */
  private readonly asking = new Map<string, Asking>()
  /** Debounced broadcasts due. */
  private readonly debounced = new Set<string>()
  /** When each computer's runner last connected, within the last minute: reconnect storms. */
  private readonly connects = new Map<string, number[]>()
  /** State other modules keep for this hub (local()). */
  private readonly locals = new Map<string, unknown>()

  constructor(
    readonly workspaceId: string,
    readonly host: HubHost,
  ) {
    this.restarting = new Map(host.load<[string, Restart][]>('restarting') ?? [])
    this.queued = new Map(host.load<[string, Queued[]][]>('queued') ?? [])
    this.eventsWaiting = new Map(
      host.load<[string, { computerId: string; since: string }][]>('events-waiting') ?? [],
    )
    this.lastLooked = new Map(host.load<[string, number][]>('last-looked') ?? [])
    this.lastActive = new Map(host.load<[string, number][]>('last-active') ?? [])
  }

  /**
   * State a module keeps for this hub, made on first use: the requests and sign-ins waiting on
   * its runners. In memory: a hub that hibernates starts it afresh (durable() outlives it).
   */
  local<T>(key: string, make: () => T): T {
    if (!this.locals.has(key)) this.locals.set(key, make())
    return this.locals.get(key) as T
  }

  /**
   * A map a module keeps for this hub that outlives its memory: saved with the hub on each
   * change (a sign-in under way, a call waiting on a person).
   */
  durable<V>(key: string): DurableMap<V> {
    return this.local(`durable:${key}`, () => new DurableMap<V>(this.host, key))
  }

  // -------------------------------------------------------------------------
  // Runners
  // -------------------------------------------------------------------------

  isRestarting(computerId: string) {
    return (this.restarting.get(computerId)?.until ?? 0) > Date.now()
  }

  isOnline(computerId: string) {
    return this.runners.has(computerId) || this.isRestarting(computerId)
  }

  /** The protocol version of a computer's connected runner; undefined while it is offline. */
  runnerProtocol(computerId: string) {
    return (
      this.runners.get(computerId)?.protocolVersion ??
      (this.isRestarting(computerId) ? this.restarting.get(computerId)?.protocolVersion : undefined)
    )
  }

  /** How each computer of the workspace is connected, for lists and statuses. */
  presence(computerIds: string[]): Record<string, ComputerPresence> {
    return Object.fromEntries(
      computerIds.map((id) => {
        const conn = this.runners.get(id)
        const protocolVersion = this.runnerProtocol(id)
        return [
          id,
          {
            online: this.isOnline(id),
            restarting: this.isRestarting(id),
            ...(protocolVersion !== undefined ? { protocolVersion } : {}),
            ...(conn?.bundle ? { bundle: conn.bundle } : {}),
            ...(conn?.startedAt ? { startedAt: conn.startedAt } : {}),
          },
        ]
      }),
    )
  }

  /** Whether this is the computer's connection now, and not restarting: a call waiting on it can still hear. */
  isCurrent(computerId: string, connectionId: string) {
    return this.runners.get(computerId)?.id === connectionId && !this.isRestarting(computerId)
  }

  send(conn: { socket: { send(text: string): void } }, message: ApiToRunner | ApiToBrowser) {
    conn.socket.send(JSON.stringify(message))
  }

  /**
   * Send a command to a computer's runner. False when it is offline. Background work (touch:
   * false) does not keep a cloud computer from its idle stop.
   */
  sendToRunner(computerId: string, message: ApiToRunner, options: { touch?: boolean } = {}) {
    const conn = this.runners.get(computerId)
    // A runner restarting into an update takes nothing more: the next one gets it (dispatch).
    if (!conn || this.isRestarting(computerId)) return false
    if (options.touch !== false) this.touch(computerId)
    this.send(conn, message)
    return true
  }

  /** Mark a cloud computer as in use, which postpones its idle stop (src/cloud.ts). */
  touch(computerId: string, now = Date.now()) {
    const saved = this.lastActive.get(computerId) ?? 0
    this.lastActive.set(computerId, now)
    // Kept with a hub that may hibernate, at most every half minute: its idle stop counts from it.
    if (this.host.hibernates && now - saved > 30_000)
      this.host.save('last-active', [...this.lastActive])
  }

  /** When a cloud computer was last in use, as far as this hub knows. */
  lastActiveAt(computerId: string) {
    return this.lastActive.get(computerId)
  }

  /** Answer a runner on the connection a call came from, while it is still the computer's. */
  replyOn(computerId: string, connectionId: string, message: ApiToRunner) {
    const conn = this.runners.get(computerId)
    if (conn?.id !== connectionId) return false
    this.send(conn, message)
    return true
  }

  /**
   * Forget a computer's runner connection: its computer stopped (src/cloud.ts's stopComputer),
   * or the runner went silent (tick). Such a connection dies without closing: kept, it looked
   * online, so commands went into it and were lost, and the computer was never started again.
   */
  dropRunner(computerId: string) {
    const conn = this.runners.get(computerId)
    if (!conn) return
    this.runners.delete(computerId)
    conn.socket.close(1001, 'computer stopped')
    // Its close comes after it is forgotten, so onRunnerClose does not do this: kept, its
    // threads would alert as waiting for as long as the computer stays off.
    const waited = this.forgetEventsWaiting(computerId)
    if (waited.length) void this.broadcastEventsWaiting(waited).catch(console.error)
    this.broadcastComputer(computerId)
  }

  /** A runner restarts into an update: until the next connects, it stays online and its commands wait. */
  noteRestarting(computerId: string, protocolVersion: number) {
    this.restarting.set(computerId, { until: Date.now() + RESTART_MS, protocolVersion })
    this.saveRestarting()
    this.host.schedule(`restart:${computerId}`, RESTART_MS)
    this.broadcastComputer(computerId)
  }

  /** The next runner connected: the restart is over. */
  restarted(computerId: string) {
    if (!this.restarting.delete(computerId)) return
    this.saveRestarting()
    this.host.cancel(`restart:${computerId}`)
  }

  private saveRestarting() {
    this.host.save('restarting', this.restarting.size ? [...this.restarting] : undefined)
  }

  /** An update's restart that took too long: the computer is offline, as if its runner had stopped. */
  private async restartTimedOut(computerId: string) {
    this.restarting.delete(computerId)
    this.saveRestarting()
    if (this.runners.has(computerId)) return
    // A cloud computer's, for operators: a laptop may well sleep through its restart.
    const computer = await prisma.computer
      .findUnique({ where: { id: computerId }, select: { kind: true } })
      .catch(() => null)
    if (computer?.kind === 'cloud')
      noteFailure('runner-restart', `runner of ${computerId} not back after its update`, {
        workspaceId: this.workspaceId,
      })
    this.broadcastComputer(computerId)
    // A thread waiting to leave it leaves without its folders.
    await movesOn(computerId).catch(console.error)
  }

  /** A runner's socket opened: counted, to tell a reconnect storm (docs/monitoring.md). */
  noteConnect(computerId: string, now = Date.now()) {
    const recent = (this.connects.get(computerId) ?? []).filter((at) => now - at < 60_000)
    recent.push(now)
    this.connects.set(computerId, recent)
    if (recent.length === STORM_CONNECTS) {
      console.warn(`runner of ${computerId}: ${recent.length} connections within a minute`)
      noteFailure(
        'runner-reconnects',
        `runner of ${computerId} connected ${recent.length} times in a minute`,
        {
          workspaceId: this.workspaceId,
        },
      )
    }
  }

  // -------------------------------------------------------------------------
  // Requests to runners
  // -------------------------------------------------------------------------

  /**
   * Ask a computer's runner and wait for its answer by request id (`message.requestId`), or an
   * error: offline, or no answer in time. Never wakes a stopped computer.
   */
  askRunner(
    computerId: string,
    message: Extract<ApiToRunner, { requestId: string }>,
    timeoutMs: number,
    options: { touch?: boolean; offline?: string } = {},
  ): Promise<RunnerAnswer | { error: string }> {
    return new Promise((resolve) => {
      const { requestId } = message
      const timer = setTimeout(() => settle({ error: 'The computer did not answer' }), timeoutMs)
      const settle = (answer: RunnerAnswer | { error: string }) => {
        clearTimeout(timer)
        this.asking.delete(requestId)
        resolve(answer)
      }
      this.asking.set(requestId, { computerId, settle })
      if (!this.sendToRunner(computerId, message, options))
        settle({ error: options.offline ?? 'The computer is offline' })
    })
  }

  /** A runner's answer: settles what asked, when that computer was asked. True if it was an answer. */
  answered(computerId: string, message: RunnerToApi) {
    if (!ANSWERS.has(message.type) || !('requestId' in message)) return false
    const asking = this.asking.get(message.requestId)
    if (asking?.computerId === computerId) asking.settle(message as RunnerAnswer)
    return true
  }

  /** Requests waiting on a computer whose runner went: they fail now rather than at their timeout. */
  private failAsking(computerId: string, error: string) {
    for (const asking of [...this.asking.values()])
      if (asking.computerId === computerId) asking.settle({ error })
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /**
   * Send now, or for a cloud computer that is stopped or starting, start it and send once its
   * runner connects; the same, without starting it, while its runner restarts into an update. A
   * member's machine that is offline returns 'offline'. A command with a commandId is kept until
   * its runner acknowledges it, and sent again when it reconnects (src/runner-commands.ts):
   * queued, it survives a restart of the API or of this hub.
   */
  async dispatch(
    computer: { id: string; kind: string; organizationId?: string; workspaceId?: string },
    message: ApiToRunner,
  ): Promise<'sent' | 'queued' | 'offline'> {
    const updating = this.isRestarting(computer.id)
    const conn = this.runners.get(computer.id)
    if (!conn && computer.kind !== 'cloud' && !updating) return 'offline'
    // Its specs' large parts by hash (src/spec-parts.ts): a kept command stays small, and goes so
    // to a runner that fetches them (sendKept sends an older one the whole). One not kept is packed
    // only for the runner connected now, and sent whole should another have connected meanwhile.
    const whole = message
    if (isDurable(message) || (conn && takesParts(conn.protocolVersion ?? 0)))
      message = await packCommand(this.workspaceId, message)
    if (isDurable(message)) {
      // Kept already (a stable id tried again after a restart): it goes, or went, from that row.
      if ((await keepCommand({ ...computer, workspaceId: this.workspaceId }, message)) !== 'kept')
        return 'queued'
      const now = this.runners.get(computer.id)
      if (now && !this.isRestarting(computer.id)) {
        await this.sendKept(computer.id, now, message)
        return 'sent'
      }
    } else if (
      this.sendToRunner(computer.id, this.runners.get(computer.id) === conn ? message : whole)
    ) {
      return 'sent'
    } else {
      const list = this.queued.get(computer.id) ?? []
      list.push({ message: whole, at: Date.now() })
      this.queued.set(computer.id, list)
      this.saveQueued()
    }
    // Not waited for: it asks the provider first, at times for seconds, and the answer here is
    // the same.
    if (!updating) wake(computer.id)
    return 'queued'
  }

  private saveQueued() {
    if (!this.host.hibernates) return
    const entries = [...this.queued].filter(([, list]) => list.length)
    const json = JSON.stringify(entries)
    // A message too large to keep stays in memory: the hub is awake while its computer starts.
    if (json.length > QUEUE_SAVED_MAX) {
      console.warn(
        `hub ${this.workspaceId}: queued commands too large to keep (${json.length} chars)`,
      )
      return
    }
    this.host.save('queued', entries.length ? entries : undefined)
  }

  /** Send a kept command on this connection, unless an older runner took it already. */
  async sendKept(computerId: string, conn: RunnerConn, kept: DurableCommand) {
    const protocol = conn.protocolVersion ?? 0
    // Not where its thread is now: not sent.
    if (!(await asOfNow(computerId, kept))) return
    // Claimed, as it is now (runner-commands.ts).
    const claimed = await noteSent(kept.commandId, protocol)
    if (!claimed) return
    // Built before its thread last arrived here: brought up to date.
    const message = await asOfNow(computerId, claimed)
    if (!message) return
    // Kept with its specs' large parts by hash: whole for a runner that cannot fetch them. One that
    // cannot be made whole (a part gone) stays pending, not sent: a ticket says so after a day.
    let whole: ApiToRunner = message
    if (!takesParts(protocol))
      try {
        whole = await unpackCommand(this.workspaceId, message)
      } catch (error) {
        console.error(`command ${message.commandId} not sent: ${String(error)}`)
        noteFailure('spec-parts', `command ${message.commandId} not sent: ${String(error)}`)
        await unclaim(message.commandId)
        return
      }
    if (this.runners.get(computerId) !== conn) return
    this.touch(computerId)
    this.send(conn, whole)
  }

  /** A runner said hello: what waited for it goes, the kept commands first, in order. */
  async flushQueue(computerId: string, conn: RunnerConn) {
    for (const command of await pendingCommands(computerId)) {
      if (this.runners.get(computerId) !== conn) return
      const message = await commandMessage(command.id)
      if (message) await this.sendKept(computerId, conn, message)
    }
    const list = this.queued.get(computerId) ?? []
    this.queued.delete(computerId)
    this.saveQueued()
    // Queued whole (dispatch packs only for the runner connected then).
    for (const { message, at } of list)
      if (Date.now() - at < QUEUE_TTL_MS) this.sendToRunner(computerId, message)
  }

  /**
   * Each minute, for each of this workspace's computers with commands waiting: commands its
   * connected runner has not acknowledged a while after they were sent (the connection died
   * before anyone noticed) go again; a cloud computer that is not up is started again (a start
   * a restart cut off). Commands not through in a day are given up by the job (giveUp).
   */
  async resendCommands(waiting: { computerId: string; since: number }[], now = Date.now()) {
    for (const { computerId, since } of waiting) {
      const conn = this.runners.get(computerId)
      if (this.isRestarting(computerId)) continue
      if (conn) {
        for (const command of await pendingCommands(computerId, now)) {
          const due =
            !command.sentAt ||
            ((conn.protocolVersion ?? 0) >= OUTBOX_PROTOCOL &&
              now - command.sentAt.getTime() > RESEND_MS)
          if (!due) continue
          const message = await commandMessage(command.id)
          if (message) await this.sendKept(computerId, conn, message)
        }
      } else if (now - since > 60_000) {
        const computer = await prisma.computer.findUnique({
          where: { id: computerId },
          select: { kind: true, status: true },
        })
        if (computer?.kind === 'cloud' && computer.status !== 'destroyed') wake(computerId)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Dashboards
  // -------------------------------------------------------------------------

  /** Send to the workspace's dashboards, or to those following a thread. */
  broadcast(message: ApiToBrowser, sessionId?: string) {
    for (const b of this.browsers) {
      if (sessionId && !b.sessions.has(sessionId)) continue
      this.send(b, message)
    }
  }

  /** Whether a computer is there now, for dashboards: its threads say so without fetching anything. */
  computerUpdated(computerId: string, status?: string): ApiToBrowser {
    return {
      type: 'computer.updated',
      computerId,
      online: this.isOnline(computerId),
      restarting: this.isRestarting(computerId),
      ...(status ? { status } : {}),
    }
  }

  /** Tell dashboards a computer's status or connection changed. */
  broadcastComputer(computerId: string, status?: string) {
    this.broadcast(this.computerUpdated(computerId, status))
  }

  /** Send to every open dashboard of one member, e.g. sign-in progress for their account. */
  sendToMember(memberId: string, message: ApiToBrowser) {
    for (const b of this.browsers) if (b.scope.memberId === memberId) this.send(b, message)
  }

  /**
   * Tell the workspace's connected runners the library or memory changed, so they fetch it
   * again, and its dashboards, so open documents can show they changed. Changes in quick
   * succession go as one.
   */
  notifyLibraryChanged() {
    this.debounce('library')
  }

  /**
   * Tell dashboards a list changed (tickets, pull requests, mail, teammates, Apps), so lists and
   * sidebar badges refetch. Coalesced: a burst of writes is one message, sent once they settle.
   */
  notifyList(type: ListType) {
    this.debounce(`list:${type}`)
  }

  private debounce(key: string) {
    if (this.debounced.has(key)) return
    this.debounced.add(key)
    this.host.schedule(`debounce:${key}`, SETTLE_MS)
  }

  private flushDebounced(key: string) {
    this.debounced.delete(key)
    if (key === 'library') {
      for (const conn of this.runners.values())
        if ((conn.protocolVersion ?? 0) >= 4) this.send(conn, { type: 'library.changed' })
      this.broadcast({ type: 'library.updated' })
    } else if (key.startsWith('list:')) {
      this.broadcast({ type: key.slice('list:'.length) as ListType })
    }
  }

  /**
   * Whether a member is looking at a dashboard of this workspace, or was in the last
   * `withinMs`: what would notify them is already in front of them.
   */
  isLooking(memberId: string, withinMs: number) {
    const now = Date.now()
    for (const b of this.browsers)
      if (b.scope.memberId === memberId && b.visibleUntil > now) return true
    return now - (this.lastLooked.get(memberId) ?? 0) < withinMs
  }

  /** A presence message: in view for a while, or left it. */
  notePresence(conn: BrowserConn, visible: boolean) {
    if (visible) conn.visibleUntil = Date.now() + PRESENCE_MS
    else this.leftView(conn)
    this.host.persist(conn)
  }

  leftView(conn: BrowserConn) {
    const now = Date.now()
    if (conn.visibleUntil > now) {
      this.lastLooked.set(conn.scope.memberId, now)
      for (const [id, at] of this.lastLooked)
        if (now - at > 24 * 60 * 60_000) this.lastLooked.delete(id)
      this.host.save('last-looked', [...this.lastLooked])
    }
    conn.visibleUntil = 0
  }

  // -------------------------------------------------------------------------
  // Threads whose events wait
  // -------------------------------------------------------------------------

  /** Since when a thread's events have not reached Brigade, or null. */
  eventsWaitingSince(sessionId: string) {
    return this.eventsWaiting.get(sessionId)?.since ?? null
  }

  /** The runner's threads whose events wait, as it says now; returns the ids whose state changed. */
  setEventsWaiting(computerId: string, own: Map<string, string>, listed: Set<string>) {
    const changed: string[] = []
    for (const [id, w] of [...this.eventsWaiting])
      if (w.computerId === computerId && !listed.has(id)) {
        this.eventsWaiting.delete(id)
        changed.push(id)
      }
    for (const [id, since] of own) {
      this.eventsWaiting.set(id, { computerId, since })
      changed.push(id)
    }
    this.saveEventsWaiting()
    return changed
  }

  /** Threads whose events waited on a computer whose runner went: they wait on it now, as it shows. */
  forgetEventsWaiting(computerId: string) {
    const gone = [...this.eventsWaiting]
      .filter(([, w]) => w.computerId === computerId)
      .map(([id]) => id)
    for (const id of gone) this.eventsWaiting.delete(id)
    if (gone.length) this.saveEventsWaiting()
    return gone
  }

  /** Every thread whose events wait, with its computer and since when: the ops checks look. */
  threadsWaiting() {
    return [...this.eventsWaiting].map(([sessionId, w]) => ({ sessionId, ...w }))
  }

  waitingOn(computerId: string) {
    return new Map(
      [...this.eventsWaiting]
        .filter(([, w]) => w.computerId === computerId)
        .map(([id, w]) => [id, w.since]),
    )
  }

  private saveEventsWaiting() {
    this.host.save('events-waiting', this.eventsWaiting.size ? [...this.eventsWaiting] : undefined)
    this.host.reportWaiting?.(this.threadsWaiting())
  }

  /** Tell dashboards whether these threads' events wait now. */
  async broadcastEventsWaiting(ids: string[]) {
    if (!ids.length) return
    const sessions = await prisma.session.findMany({
      where: { id: { in: ids }, workspaceId: this.workspaceId },
      select: { id: true, status: true },
    })
    for (const s of sessions)
      this.broadcast({
        type: 'thread.updated',
        sessionId: s.id,
        status: s.status,
        eventsWaitingSince: this.eventsWaitingSince(s.id),
      })
  }

  // -------------------------------------------------------------------------
  // Terminals
  // -------------------------------------------------------------------------

  /** The dashboard a takeover terminal is relayed to. */
  terminalOf(terminalId: string) {
    for (const b of this.browsers) {
      const terminal = b.terminals.find((t) => t.terminalId === terminalId)
      if (terminal) return { conn: b, terminal }
    }
    return undefined
  }

  addTerminal(
    conn: BrowserConn,
    terminal: { terminalId: string; computerId: string; sessionId: string },
  ) {
    conn.terminals = [
      ...conn.terminals.filter((t) => t.terminalId !== terminal.terminalId),
      terminal,
    ]
    this.host.persist(conn)
  }

  removeTerminal(conn: BrowserConn, terminalId: string) {
    conn.terminals = conn.terminals.filter((t) => t.terminalId !== terminalId)
    this.host.persist(conn)
  }

  // -------------------------------------------------------------------------
  // Connections opening and closing
  // -------------------------------------------------------------------------

  /** A runner's connection said hello: it is the computer's now, any other one is replaced. */
  takeOver(conn: RunnerConn) {
    const before = this.runners.get(conn.computerId)
    if (before && before !== conn) before.socket.close(4001, 'replaced by a newer connection')
    this.arriving.delete(conn)
    this.runners.set(conn.computerId, conn)
    this.restarted(conn.computerId)
    this.host.persist(conn)
    this.scheduleTick()
  }

  /**
   * A runner's connection closed. Returns true when it was the computer's, and the computer is
   * offline now (not restarting into an update): the caller tells what waited on it.
   */
  runnerClosed(conn: RunnerConn) {
    for (const timer of conn.retries.values()) clearTimeout(timer)
    this.arriving.delete(conn)
    if (this.runners.get(conn.computerId) !== conn) return false
    this.runners.delete(conn.computerId)
    // Restarting into an update: the next runner takes over in a moment (restarting).
    if (this.isRestarting(conn.computerId)) return false
    this.failAsking(conn.computerId, 'The computer went offline')
    return true
  }

  browserOpened(conn: BrowserConn) {
    this.browsers.add(conn)
    this.scheduleTick()
  }

  /** A dashboard's connection closed: its terminals close on their runners. */
  browserClosed(conn: BrowserConn) {
    this.browsers.delete(conn)
    this.leftView(conn)
    for (const t of conn.terminals)
      this.sendToRunner(t.computerId, { type: 'terminal.close', terminalId: t.terminalId })
    conn.terminals = []
  }

  // -------------------------------------------------------------------------
  // Time
  // -------------------------------------------------------------------------

  /** A timer of this hub's is due (host.schedule). */
  async onTimer(key: string) {
    if (key.startsWith('restart:')) return this.restartTimedOut(key.slice('restart:'.length))
    if (key.startsWith('debounce:')) return this.flushDebounced(key.slice('debounce:'.length))
    if (key === 'tick') {
      await this.tick()
      this.scheduleTick()
      return
    }
    // A thread's release that its runner never answered (src/move.ts).
    if (key.startsWith('move:')) {
      const { releaseTimedOut } = await import('../move.js')
      return releaseTimedOut(this, key.slice('move:'.length))
    }
  }

  /**
   * The next tick, while there is something to watch. A hub that hibernates wakes for it only as
   * often as a runner may stay silent: a dashboard needs no ping from it.
   */
  private scheduleTick() {
    if (this.runners.size || this.arriving.size || (!this.host.hibernates && this.browsers.size))
      this.host.schedule('tick', this.host.hibernates ? SILENT_MS : TICK_MS)
  }

  /**
   * Every half minute while sockets are open: runners that stopped saying anything, whose
   * connection died without closing (a cloud computer stopped or crashed, a laptop asleep), are
   * forgotten (until then the computer looked online, and commands sent to it were lost);
   * runners installed from another bundle than the one served are told once; dashboards hear
   * something, before their socket looks idle, unless they keep it alive themselves.
   */
  async tick(now = Date.now()) {
    for (const conn of [...this.runners.values()]) {
      if ((conn.protocolVersion ?? 0) < HEARTBEAT_PROTOCOL) continue
      const heard = Math.max(conn.heardAt, this.host.heardAt?.(conn.socket) ?? 0)
      if (now - heard < SILENT_MS) continue
      console.warn(
        `runner of ${conn.computerId} silent for ${Math.round((now - heard) / 1000)} s: forgotten`,
      )
      // A cloud computer's, for operators: a member's laptop that sleeps goes silent too.
      const computer = await prisma.computer
        .findUnique({ where: { id: conn.computerId }, select: { kind: true } })
        .catch(() => null)
      if (computer?.kind === 'cloud')
        noteFailure('runner-silent', `runner of ${conn.computerId} silent`, {
          workspaceId: this.workspaceId,
        })
      if (this.runners.get(conn.computerId) === conn) this.dropRunner(conn.computerId)
    }
    const bundle = await runnerBundle().catch(() => null)
    if (bundle)
      for (const conn of this.runners.values()) {
        if ((conn.protocolVersion ?? 0) < 3 || !conn.bundle || conn.bundle === bundle) continue
        if (conn.offered === bundle) continue
        conn.offered = bundle
        this.host.persist(conn)
        this.send(conn, { type: 'update.available', bundle })
      }
    if (!this.host.hibernates) for (const conn of this.browsers) this.send(conn, { type: 'ping' })
    // Again while runners are connected: the checks forget a report that is not renewed.
    if (this.eventsWaiting.size) this.host.reportWaiting?.(this.threadsWaiting())
  }

  /** Every socket closes: the workspace's hub moved, and they connect again to where it is now. */
  closeAll(code: number, reason: string) {
    for (const conn of [...this.runners.values(), ...this.arriving, ...this.browsers])
      conn.socket.close(code, reason)
  }

  /** What this hub holds now, for the minute's log (docs/workspace-hubs-plan.md, Phase 0). */
  sizes() {
    let queued = 0
    for (const list of this.queued.values()) queued += list.length
    let terminals = 0
    for (const b of this.browsers) terminals += b.terminals.length
    return {
      runners: this.runners.size + this.arriving.size,
      browsers: this.browsers.size,
      queued,
      asking: this.asking.size,
      restarting: this.restarting.size,
      eventsWaiting: this.eventsWaiting.size,
      terminals,
    }
  }

  /** Nothing open or waiting: a process may let the hub go. */
  idle() {
    const s = this.sizes()
    if (!Object.values(s).every((n) => n === 0) || this.debounced.size) return false
    // What other modules keep: empty maps and sets are nothing.
    for (const value of this.locals.values()) {
      if (value instanceof Map || value instanceof Set || value instanceof DurableMap) {
        if (value.size) return false
      } else if (value && typeof value === 'object') {
        for (const inner of Object.values(value))
          if ((inner instanceof Map || inner instanceof Set) && inner.size) return false
      } else return false
    }
    return true
  }
}

/** A map kept with the hub (WorkspaceHub.durable): each change is saved. */
export class DurableMap<V> {
  private readonly map: Map<string, V>

  constructor(
    private readonly host: HubHost,
    private readonly key: string,
  ) {
    this.map = new Map(host.load<[string, V][]>(key) ?? [])
  }

  get(id: string) {
    return this.map.get(id)
  }

  has(id: string) {
    return this.map.has(id)
  }

  set(id: string, value: V) {
    this.map.set(id, value)
    this.save()
  }

  delete(id: string) {
    const had = this.map.delete(id)
    if (had) this.save()
    return had
  }

  values() {
    return [...this.map.values()]
  }

  entries() {
    return [...this.map.entries()]
  }

  get size() {
    return this.map.size
  }

  /** Saved after a change to a value in place. */
  save() {
    this.host.save(this.key, this.map.size ? [...this.map] : undefined)
  }
}

/** A connection's id. */
export const connectionId = () => randomUUID()
