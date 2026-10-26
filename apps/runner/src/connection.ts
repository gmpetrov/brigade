// The runner's one outbound WebSocket to the API. Nothing connects in.
import {
  ApiToRunner,
  PROTOCOL_VERSION,
  type RunnerToApi,
  type SequencedEvent,
  type ThreadAttachmentRef,
} from '@brigade/contracts'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { HOME, VERSION, type RunnerConfig } from './config.js'
import type { Outbox } from './outbox.js'
import type { SeenCommands } from './seen-commands.js'
import { installedBundle } from './updater.js'

/** When this process started: the API tells previews it lost from those it runs (hello). */
const STARTED_AT = new Date().toISOString()

const BATCH = 200
/**
 * And at most about this much JSON in one: Cloudflare refuses a WebSocket message over
 * 32 MiB, and a replay can bring many events that each hold an image. One event larger
 * than this still goes alone.
 */
const BATCH_CHARS = 8 * 1024 * 1024

/** Events in the batches they are sent in, by count and size, in order. */
export function eventBatches(events: SequencedEvent[]) {
  if (events.length <= 1) return events.length ? [events] : []
  const batches: SequencedEvent[][] = []
  let batch: SequencedEvent[] = []
  let chars = 0
  for (const event of events) {
    const size = JSON.stringify(event).length
    if (batch.length && (batch.length >= BATCH || chars + size > BATCH_CHARS)) {
      batches.push(batch)
      batch = []
      chars = 0
    }
    batch.push(event)
    chars += size
  }
  batches.push(batch)
  return batches
}
/**
 * A ping this often keeps the socket from looking idle (Cloudflare closes
 * WebSockets that carry nothing), and one unanswered by the next tells a dead
 * connection from a quiet one. The API cannot see pings: a heartbeat message
 * tells it the same, the other way (HEARTBEAT_PROTOCOL).
 */
const HEARTBEAT_MS = 30_000
/** An upgrade that has not answered in this long is given up and retried. */
const HANDSHAKE_MS = 15_000
/**
 * Events the API has not acknowledged in this long are sent again: one it failed to
 * store, or lost on the way, would otherwise wait for the next reconnect, and every
 * event of the thread after it with it.
 */
const RESEND_MS = 30_000
/** Not after this long: the thread most likely left this computer. Sent again on reconnect only. */
const RESEND_FOR_MS = 24 * 60 * 60_000
/** Events unacknowledged this long make their thread's page say so (events.waiting). */
const WAITING_MS = 3 * 60_000

type Result = Extract<ApiToRunner, { type: 'connector.result' }>

type PendingCall = {
  resolve: (result: Result) => void
  reject: (error: Error) => void
  onPending: (ticketId: string, reason?: string, always?: boolean) => void
  onDecision: (decision: { ticketId: string; approved: boolean; memberId: string }) => void
  /** The ticket it waits on for a person's decision, once the API said so. */
  ticketId?: string
}

/**
 * What the teammate's tool says of a call that waited on a person when the connection dropped:
 * the API keeps it with its ticket, makes it once someone decides, and tells the thread.
 */
export const STILL_WAITING =
  'This is still waiting for a person to approve it (its ticket is open). Do not make the call again: ' +
  'once they decide, Brigade makes it and its result comes to this thread as a message. End your turn, ' +
  'or go on with work that does not depend on it.'

export class Connection {
  private ws: WebSocket | undefined
  private calls = new Map<string, PendingCall>()
  /** Commands being taken now, by commandId: one sent again meanwhile waits for their ack. */
  private taking = new Set<string>()
  private ready = false
  private backoff = 1000
  private closed = false
  /** When each thread's events were last sent. */
  private sentAt = new Map<string, number>()
  /** The threads this connection last told the API wait, with since when (events.waiting). */
  private reported = new Map<string, string>()

  constructor(
    private readonly config: RunnerConfig,
    private readonly outbox: Outbox,
    /** Settles once the command is taken (a takeover, once the folder is back): then it is acknowledged. */
    private readonly onCommand: (message: ApiToRunner) => unknown,
    private readonly hello: () => Promise<Partial<Extract<RunnerToApi, { type: 'hello' }>>>,
    /**
     * The bundle the API serves, on every connect. `required`: the API refuses
     * this runner's protocol. Returns true when the runner updates itself.
     */
    private readonly onBundle: (bundle: string | undefined, required: boolean) => boolean,
    /**
     * The events to send now, of those given: the others hold files, sent with `send`
     * once those are in the bucket (event-files.ts). All of them when not given.
     */
    private readonly keepFiles?: (
      events: SequencedEvent[],
      send: (events: SequencedEvent[]) => void,
    ) => SequencedEvent[],
    /** Commands taken already (OUTBOX_PROTOCOL): acknowledged again and ignored. */
    private readonly seen?: SeenCommands,
  ) {}

  start() {
    const url = new URL('/runner/ws', this.config.apiUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.config.token}` },
      handshakeTimeout: HANDSHAKE_MS,
    })
    this.ws = ws
    let answered = true
    let heartbeat: ReturnType<typeof setInterval> | undefined

    ws.on('pong', () => (answered = true))
    ws.on('open', async () => {
      this.backoff = 1000
      heartbeat = setInterval(() => {
        if (!answered) return ws.terminate()
        answered = false
        ws.ping()
        this.send({ type: 'heartbeat' })
        this.checkWaiting()
      }, HEARTBEAT_MS)
      const extra = await this.hello().catch(() => ({}))
      this.send({
        ...extra,
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        version: VERSION,
        platform: `${process.platform}-${process.arch}`,
        startedAt: STARTED_AT,
        ...(installedBundle() ? { bundle: installedBundle() } : {}),
      })
    })
    ws.on('message', (raw) => {
      const parsed = ApiToRunner.safeParse(JSON.parse(String(raw)))
      if (!parsed.success) return console.warn('bad message from api', parsed.error.issues[0])
      const message = parsed.data
      if (message.type === 'welcome') {
        console.log(`connected to ${this.config.apiUrl} (workspace "${this.config.workspaceName}")`)
        this.ready = true
        // What it was told before, it forgot with the old connection.
        this.reported = new Map()
        this.flush()
        this.onCommand(message)
        this.onBundle(message.bundle, false)
      } else if (message.type === 'ack') {
        this.outbox.ack(message.sessionId, message.seq)
      } else if (message.type === 'connector.pending') {
        const call = this.calls.get(message.callId)
        if (call) call.ticketId = message.ticketId
        call?.onPending(message.ticketId, message.reason, message.always)
      } else if (message.type === 'connector.result') {
        const call = this.calls.get(message.callId)
        if (!call) return
        this.calls.delete(message.callId)
        if (message.decision) call.onDecision(message.decision)
        if (message.ok) call.resolve(message)
        else call.reject(new Error(message.error ?? 'The connector call failed'))
      } else if (message.type === 'update.available') {
        this.onBundle(message.bundle, false)
      } else if (message.type === 'update.required') {
        if (this.onBundle(message.bundle, true)) return
        console.error(
          `This runner is too old for the API (needs protocol ${message.minProtocolVersion}). Update it and start again.`,
        )
        process.exit(1)
      } else if ('commandId' in message && this.seen) {
        // Sent again by the API until acknowledged: one taken already is not taken twice. It is
        // acknowledged once taken, so a restart while it is being taken leaves it to be sent again.
        const { commandId } = message
        const seen = this.seen
        if (seen.has(commandId)) return this.send({ type: 'command.ack', commandIds: [commandId] })
        if (this.taking.has(commandId)) return
        this.taking.add(commandId)
        let taken: unknown
        try {
          // Now, in the order commands came; acknowledged once it settles.
          taken = this.onCommand(message)
        } catch (error) {
          taken = Promise.reject(error)
        }
        void Promise.resolve(taken)
          .catch((error: unknown) => console.warn(`command ${commandId} failed: ${String(error)}`))
          .finally(() => {
            this.taking.delete(commandId)
            seen.add(commandId)
            this.send({ type: 'command.ack', commandIds: [commandId] })
          })
      } else {
        this.onCommand(message)
      }
    })
    ws.on('close', (code, reason) => {
      clearInterval(heartbeat)
      this.ready = false
      // Calls in flight cannot be answered on a new connection. One waiting on a person is kept
      // by the API, which makes it once they decide: the teammate must not make it again.
      for (const call of this.calls.values())
        call.reject(
          new Error(
            call.ticketId
              ? STILL_WAITING
              : 'Lost the connection to Brigade during this call; try again',
          ),
        )
      this.calls.clear()
      if (this.closed) return
      if (code === 4401) {
        console.error(
          'The API does not recognise this runner. Link it again with `brigade-runner link <code>`.',
        )
        process.exit(1)
      }
      // Another runner linked to this computer (same runner.json) connected.
      // Reconnecting would only knock it off again, every second, forever.
      if (code === 4001) {
        console.error(
          `Another runner for this computer connected to ${this.config.apiUrl}, so this one is stopping. Run only one runner per ${HOME}, or give the other its own BRIGADE_HOME.`,
        )
        process.exit(1)
      }
      console.warn(
        `disconnected (${code}${reason.length ? ` ${reason}` : ''}); retrying in ${this.backoff / 1000}s`,
      )
      setTimeout(() => this.start(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, 10_000)
    })
    ws.on('error', (error) => console.warn(`connection error: ${error.message}`))
  }

  /** Replay everything the API has not acknowledged. */
  private flush() {
    this.sendEvents(this.outbox.unacknowledged())
  }

  private sendEvents(events: SequencedEvent[], now = Date.now()) {
    for (const e of events) this.sentAt.set(e.sessionId, now)
    const ready = this.keepFiles
      ? this.keepFiles(events, (kept) => this.ready && this.sendBatches(kept))
      : events
    this.sendBatches(ready)
  }

  private sendBatches(events: SequencedEvent[]) {
    for (const batch of eventBatches(events)) this.send({ type: 'events', events: batch })
  }

  /** Send one new event now if connected; otherwise it waits in the outbox for replay. */
  sendEvent(event: SequencedEvent) {
    if (this.ready) this.sendEvents([event])
  }

  /**
   * Send again what the API has not acknowledged for a while, and tell it which
   * threads' events have waited for minutes, when that changes: a thread must never
   * look at work for hours while nothing of it gets through.
   */
  private checkWaiting(now = Date.now()) {
    if (!this.ready) return
    for (const { sessionId, since, events } of this.outbox.waiting(RESEND_MS, now)) {
      if (now - since > RESEND_FOR_MS) continue
      if (now - (this.sentAt.get(sessionId) ?? 0) < RESEND_MS) continue
      console.warn(
        `thread ${sessionId}: ${events.length} events unacknowledged for ${Math.round((now - since) / 1000)} s, sending them again`,
      )
      this.sendEvents(events, now)
    }
    const waiting = this.outbox
      .waiting(WAITING_MS, now)
      .slice(0, 1000)
      .map(({ sessionId, since }) => ({ sessionId, since: new Date(since).toISOString() }))
    if (
      waiting.length === this.reported.size &&
      waiting.every((w) => this.reported.get(w.sessionId) === w.since)
    )
      return
    this.reported = new Map(waiting.map((w) => [w.sessionId, w.since]))
    this.send({ type: 'events.waiting', threads: waiting })
  }

  /**
   * Ask the API to make a connector call. It may first wait for a person's
   * approval. With the output come the files the call brought into the thread.
   */
  async callConnector(
    request: Omit<Extract<RunnerToApi, { type: 'connector.call' }>, 'type' | 'callId'>,
    hooks: Pick<PendingCall, 'onPending' | 'onDecision'>,
  ): Promise<{ output: unknown; attachments: ThreadAttachmentRef[] }> {
    const result = await this.call({ type: 'connector.call', ...request }, hooks)
    return { output: result.output, attachments: result.attachments ?? [] }
  }

  /** List the credentials the teammate may use, ask for one, or save one. Releases and saves may wait for a person. */
  async requestCredential(
    request: Omit<Extract<RunnerToApi, { type: 'credential.request' }>, 'type' | 'callId'>,
    hooks: Pick<PendingCall, 'onPending' | 'onDecision'>,
  ): Promise<unknown> {
    return (await this.call({ type: 'credential.request', ...request }, hooks)).output
  }

  /** Search the workspace, or save a file to its library. The API checks the grant. */
  async callLibrary(
    request: Omit<Extract<RunnerToApi, { type: 'library.call' }>, 'type' | 'callId'>,
  ): Promise<unknown> {
    const result = await this.call(
      { type: 'library.call', ...request },
      { onPending: () => undefined, onDecision: () => undefined },
    )
    return result.output
  }

  /** Create a task from a thread, or complete its task. The API checks the thread. */
  async callTask(
    request: Omit<Extract<RunnerToApi, { type: 'task.call' }>, 'type' | 'callId'>,
  ): Promise<unknown> {
    const result = await this.call(
      { type: 'task.call', ...request },
      { onPending: () => undefined, onDecision: () => undefined },
    )
    return result.output
  }

  /**
   * Create, list or change the teammate's schedules. The API checks the thread. A trigger
   * waits for an admin's approval, which the hooks show in the thread.
   */
  async callSchedule(
    request: Omit<Extract<RunnerToApi, { type: 'schedule.call' }>, 'type' | 'callId'>,
    hooks: Pick<PendingCall, 'onPending' | 'onDecision'> = {
      onPending: () => undefined,
      onDecision: () => undefined,
    },
  ): Promise<unknown> {
    const result = await this.call({ type: 'schedule.call', ...request }, hooks)
    return result.output
  }

  /** Read or save a repository's preview recipe. The API checks the thread. */
  async callPreview(
    request: Omit<Extract<RunnerToApi, { type: 'preview.call' }>, 'type' | 'callId'>,
  ): Promise<unknown> {
    const result = await this.call(
      { type: 'preview.call', ...request },
      { onPending: () => undefined, onDecision: () => undefined },
    )
    return result.output
  }

  /** The public origins of a thread's preview ports, by port. Cloud computers only. */
  async exposePreview(sessionId: string, ports: number[]): Promise<Record<number, string>> {
    const result = await this.call(
      { type: 'preview.expose', sessionId, ports },
      { onPending: () => undefined, onDecision: () => undefined },
    )
    return (result.output as { origins: Record<number, string> }).origins
  }

  /** What a person opens for a preview port: its address with the token. Never logged. */
  async previewUrl(sessionId: string, port: number): Promise<string> {
    const result = await this.call(
      { type: 'preview.expose', sessionId, ports: [port], token: true },
      { onPending: () => undefined, onDecision: () => undefined },
    )
    const url = (result.output as { urls?: Record<number, string> }).urls?.[port]
    if (!url) throw new Error('The API gave no address for the preview')
    return url
  }

  private call(
    message: DistributiveOmit<
      Extract<
        RunnerToApi,
        {
          type:
            | 'connector.call'
            | 'credential.request'
            | 'library.call'
            | 'task.call'
            | 'schedule.call'
            | 'preview.expose'
            | 'preview.call'
        }
      >,
      'callId'
    >,
    hooks: Pick<PendingCall, 'onPending' | 'onDecision'>,
  ): Promise<Result> {
    if (!this.ready) return Promise.reject(new Error('Not connected to Brigade; try again shortly'))
    const callId = randomUUID()
    return new Promise((resolve, reject) => {
      this.calls.set(callId, { resolve, reject, ...hooks })
      this.send({ ...message, callId } as RunnerToApi)
    })
  }

  send(message: RunnerToApi) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message))
  }

  close() {
    this.closed = true
    this.ws?.close()
  }
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never
