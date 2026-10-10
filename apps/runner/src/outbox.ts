// Buffers events until the API acknowledges them, so nothing is lost while
// disconnected. On reconnect, everything after the last ack is replayed.
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, SequencedEvent } from '@brigade/contracts'

type Stream = { lastSeq: number; acked: number; pending: SequencedEvent[] }

export class Outbox {
  private streams = new Map<string, Stream>()
  private readonly metaFile: string

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.metaFile = join(dir, 'acked.json')
    const acked = this.readJson<Record<string, number>>(this.metaFile) ?? {}
    for (const [sessionId, seq] of Object.entries(acked))
      this.streams.set(sessionId, { lastSeq: seq, acked: seq, pending: [] })
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
      const sessionId = file.slice(0, -'.jsonl'.length)
      const stream = this.stream(sessionId)
      for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
        if (!line) continue
        const event = JSON.parse(line) as SequencedEvent
        stream.lastSeq = Math.max(stream.lastSeq, event.seq)
        if (event.seq > stream.acked) stream.pending.push(event)
      }
    }
  }

  /** Assign the next sequence number and buffer the event on disk. */
  push(sessionId: string, event: AgentEvent): SequencedEvent {
    const stream = this.stream(sessionId)
    const sequenced = { sessionId, seq: ++stream.lastSeq, event }
    stream.pending.push(sequenced)
    appendFileSync(this.file(sessionId), JSON.stringify(sequenced) + '\n', { mode: 0o600 })
    return sequenced
  }

  ack(sessionId: string, seq: number) {
    const stream = this.streams.get(sessionId)
    if (!stream || seq <= stream.acked) return
    stream.acked = seq
    stream.pending = stream.pending.filter((e) => e.seq > seq)
    if (stream.pending.length === 0) rmSync(this.file(sessionId), { force: true })
    else
      writeFileSync(
        this.file(sessionId),
        stream.pending.map((e) => JSON.stringify(e) + '\n').join(''),
        { mode: 0o600 },
      )
    writeFileSync(
      this.metaFile,
      JSON.stringify(Object.fromEntries([...this.streams].map(([id, s]) => [id, s.acked]))),
    )
  }

  /** The latest event of a thread the API has not acknowledged yet. */
  lastUnacknowledged(sessionId: string): AgentEvent | undefined {
    return this.streams.get(sessionId)?.pending.at(-1)?.event
  }

  /** Every event the API has not acknowledged yet, in order per thread. */
  unacknowledged(): SequencedEvent[] {
    return [...this.streams.values()].flatMap((s) => s.pending)
  }

  private stream(sessionId: string) {
    let stream = this.streams.get(sessionId)
    if (!stream) this.streams.set(sessionId, (stream = { lastSeq: 0, acked: 0, pending: [] }))
    return stream
  }

  private file(sessionId: string) {
    return join(this.dir, `${sessionId}.jsonl`)
  }

  private readJson<T>(file: string): T | null {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as T
    } catch {
      return null
    }
  }
}
