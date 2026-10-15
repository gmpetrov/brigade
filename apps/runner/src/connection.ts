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
import { installedBundle } from './updater.js'

const BATCH = 200
/**
 * A ping this often keeps the socket from looking idle (Cloudflare closes
 * WebSockets that carry nothing), and one unanswered by the next tells a dead
 * connection from a quiet one. The API cannot see pings: a heartbeat message
 * tells it the same, the other way (HEARTBEAT_PROTOCOL).
 */
const HEARTBEAT_MS = 30_000
/** An upgrade that has not answered in this long is given up and retried. */
const HANDSHAKE_MS = 15_000

type Result = Extract<ApiToRunner, { type: 'connector.result' }>

type PendingCall = {
  resolve: (result: Result) => void
  reject: (error: Error) => void
  onPending: (ticketId: string, reason?: string, always?: boolean) => void
  onDecision: (decision: { ticketId: string; approved: boolean; memberId: string }) => void
}

export class Connection {
  private ws: WebSocket | undefined
  private calls = new Map<string, PendingCall>()
  private ready = false
  private backoff = 1000
  private closed = false

  constructor(
    private readonly config: RunnerConfig,
    private readonly outbox: Outbox,
    private readonly onCommand: (message: ApiToRunner) => void,
    private readonly hello: () => Promise<Partial<Extract<RunnerToApi, { type: 'hello' }>>>,
    /**
     * The bundle the API serves, on every connect. `required`: the API refuses
     * this runner's protocol. Returns true when the runner updates itself.
     */
    private readonly onBundle: (bundle: string | undefined, required: boolean) => boolean,
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
      }, HEARTBEAT_MS)
      const extra = await this.hello().catch(() => ({}))
      this.send({
        ...extra,
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        version: VERSION,
        platform: `${process.platform}-${process.arch}`,
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
        this.flush()
        this.onCommand(message)
        this.onBundle(message.bundle, false)
      } else if (message.type === 'ack') {
        this.outbox.ack(message.sessionId, message.seq)
      } else if (message.type === 'connector.pending') {
        this.calls.get(message.callId)?.onPending(message.ticketId, message.reason, message.always)
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
      } else {
        this.onCommand(message)
      }
    })
    ws.on('close', (code, reason) => {
      clearInterval(heartbeat)
      this.ready = false
      // Calls in flight cannot be answered on a new connection.
      for (const call of this.calls.values())
        call.reject(new Error('Lost the connection to Brigade during this call; try again'))
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
    const events = this.outbox.unacknowledged()
    for (let i = 0; i < events.length; i += BATCH)
      this.send({ type: 'events', events: events.slice(i, i + BATCH) })
  }

  /** Send one new event now if connected; otherwise it waits in the outbox for replay. */
  sendEvent(event: SequencedEvent) {
    if (this.ready) this.send({ type: 'events', events: [event] })
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

  /** Create, list or change the teammate's schedules. The API checks the thread. */
  async callSchedule(
    request: Omit<Extract<RunnerToApi, { type: 'schedule.call' }>, 'type' | 'callId'>,
  ): Promise<unknown> {
    const result = await this.call(
      { type: 'schedule.call', ...request },
      { onPending: () => undefined, onDecision: () => undefined },
    )
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
