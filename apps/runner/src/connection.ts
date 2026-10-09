// The runner's one outbound WebSocket to the API. Nothing connects in.
import {
  ApiToRunner,
  PROTOCOL_VERSION,
  type RunnerToApi,
  type SequencedEvent,
} from '@brigade/contracts'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { VERSION, type RunnerConfig } from './config.js'
import type { Outbox } from './outbox.js'

const BATCH = 200

type PendingCall = {
  resolve: (output: unknown) => void
  reject: (error: Error) => void
  onPending: (ticketId: string, reason?: string) => void
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
  ) {}

  start() {
    const url = new URL('/runner/ws', this.config.apiUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.config.token}` } })
    this.ws = ws

    ws.on('open', async () => {
      this.backoff = 1000
      const extra = await this.hello().catch(() => ({}))
      this.send({
        ...extra,
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        version: VERSION,
        platform: `${process.platform}-${process.arch}`,
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
      } else if (message.type === 'ack') {
        this.outbox.ack(message.sessionId, message.seq)
      } else if (message.type === 'connector.pending') {
        this.calls.get(message.callId)?.onPending(message.ticketId, message.reason)
      } else if (message.type === 'connector.result') {
        const call = this.calls.get(message.callId)
        if (!call) return
        this.calls.delete(message.callId)
        if (message.decision) call.onDecision(message.decision)
        if (message.ok) call.resolve(message.output)
        else call.reject(new Error(message.error ?? 'The connector call failed'))
      } else if (message.type === 'update.required') {
        console.error(
          `This runner is too old for the API (needs protocol ${message.minProtocolVersion}). Update it and start again.`,
        )
        process.exit(1)
      } else {
        this.onCommand(message)
      }
    })
    ws.on('close', (code, reason) => {
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

  /** Ask the API to make a connector call. It may first wait for a person's approval. */
  callConnector(
    request: Omit<Extract<RunnerToApi, { type: 'connector.call' }>, 'type' | 'callId'>,
    hooks: Pick<PendingCall, 'onPending' | 'onDecision'>,
  ): Promise<unknown> {
    return this.call({ type: 'connector.call', ...request }, hooks)
  }

  /** List the workspace's credentials, or ask for one. A release may wait for a person. */
  requestCredential(
    request: Omit<Extract<RunnerToApi, { type: 'credential.request' }>, 'type' | 'callId'>,
    hooks: Pick<PendingCall, 'onPending' | 'onDecision'>,
  ): Promise<unknown> {
    return this.call({ type: 'credential.request', ...request }, hooks)
  }

  private call(
    message: DistributiveOmit<
      Extract<RunnerToApi, { type: 'connector.call' | 'credential.request' }>,
      'callId'
    >,
    hooks: Pick<PendingCall, 'onPending' | 'onDecision'>,
  ): Promise<unknown> {
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
