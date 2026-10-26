// Buffers events until the API acknowledges them, so nothing is lost while
// disconnected. On reconnect, everything after the last ack is replayed.
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, SequencedEvent } from '@brigade/contracts'

type Stream = {
  lastSeq: number
  acked: number
  pending: SequencedEvent[]
  /** When each pending event was buffered, by seq: by this runner, or when it read them back. */
  bufferedAt: Map<number, number>
}

export class Outbox {
  private streams = new Map<string, Stream>()
  private readonly metaFile: string
  /** When each thread last moved to this computer (ThreadSpec.moved), taken in once. */
  private readonly arrivalsFile: string
  private arrivals: Record<string, string>

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.metaFile = join(dir, 'acked.json')
    this.arrivalsFile = join(dir, 'arrivals.json')
    this.arrivals = this.readJson<Record<string, string>>(this.arrivalsFile) ?? {}
    const acked = this.readJson<Record<string, number>>(this.metaFile) ?? {}
    for (const [sessionId, seq] of Object.entries(acked))
      this.streams.set(sessionId, { lastSeq: seq, acked: seq, pending: [], bufferedAt: new Map() })
    const now = Date.now()
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
      const sessionId = file.slice(0, -'.jsonl'.length)
      const stream = this.stream(sessionId)
      let torn = false
      for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
        // A line cut short when the computer lost power: that event never left.
        const event = parseLine(line)
        if (!event) {
          torn ||= line.length > 0
          continue
        }
        stream.lastSeq = Math.max(stream.lastSeq, event.seq)
        if (event.seq > stream.acked) {
          stream.pending.push(event)
          stream.bufferedAt.set(event.seq, now)
        }
      }
      // Rewritten without it, or the next event appended would join that line and be lost too.
      if (torn)
        writeAtomic(join(dir, file), stream.pending.map((e) => JSON.stringify(e) + '\n').join(''))
    }
  }

  /** Assign the next sequence number and buffer the event on disk. */
  push(sessionId: string, event: AgentEvent): SequencedEvent {
    const stream = this.stream(sessionId)
    const sequenced = { sessionId, seq: ++stream.lastSeq, event }
    stream.pending.push(sequenced)
    stream.bufferedAt.set(sequenced.seq, Date.now())
    appendFileSync(this.file(sessionId), JSON.stringify(sequenced) + '\n', { mode: 0o600 })
    return sequenced
  }

  ack(sessionId: string, seq: number) {
    const stream = this.streams.get(sessionId)
    if (!stream || seq <= stream.acked) return
    stream.acked = seq
    stream.pending = stream.pending.filter((e) => e.seq > seq)
    for (const buffered of stream.bufferedAt.keys())
      if (buffered <= seq) stream.bufferedAt.delete(buffered)
    if (stream.pending.length === 0) rmSync(this.file(sessionId), { force: true })
    else
      writeAtomic(
        this.file(sessionId),
        stream.pending.map((e) => JSON.stringify(e) + '\n').join(''),
      )
    writeAtomic(
      this.metaFile,
      JSON.stringify(Object.fromEntries([...this.streams].map(([id, s]) => [id, s.acked]))),
    )
  }

  /**
   * Keep these events in place of the pending ones with the same seq: their files taken
   * out (event-files.ts). Those acknowledged since are left alone.
   */
  replace(sessionId: string, events: SequencedEvent[]) {
    const stream = this.streams.get(sessionId)
    if (!stream) return
    const bySeq = new Map(events.map((e) => [e.seq, e]))
    let changed = false
    stream.pending = stream.pending.map((e) => {
      const replaced = bySeq.get(e.seq)
      if (!replaced) return e
      changed = true
      return replaced
    })
    if (changed)
      writeAtomic(
        this.file(sessionId),
        stream.pending.map((e) => JSON.stringify(e) + '\n').join(''),
      )
  }

  /** Forget a thread's pending events, as if acknowledged: it was deleted. */
  drop(sessionId: string) {
    const stream = this.streams.get(sessionId)
    if (stream) this.ack(sessionId, stream.lastSeq)
  }

  /**
   * The thread moved to this computer, its last event then numbered `seq`:
   * its events here go on after it. Whatever this computer still held of it
   * from before it left is out of date: dropped. True on a new arrival.
   */
  arrive(sessionId: string, at: string, seq: number) {
    if (this.arrivals[sessionId] === at) return false
    const stream = this.stream(sessionId)
    stream.pending = []
    stream.bufferedAt.clear()
    stream.lastSeq = stream.acked = seq
    rmSync(this.file(sessionId), { force: true })
    writeAtomic(
      this.metaFile,
      JSON.stringify(Object.fromEntries([...this.streams].map(([id, s]) => [id, s.acked]))),
    )
    this.arrivals[sessionId] = at
    writeAtomic(this.arrivalsFile, JSON.stringify(this.arrivals))
    return true
  }

  /** Every event of the thread is acknowledged: nothing of it left to send. */
  settled(sessionId: string) {
    return (this.streams.get(sessionId)?.pending.length ?? 0) === 0
  }

  /** The latest event of a thread the API has not acknowledged yet. */
  lastUnacknowledged(sessionId: string): AgentEvent | undefined {
    return this.streams.get(sessionId)?.pending.at(-1)?.event
  }

  /** A thread's events the API has not acknowledged yet, in order. */
  unacknowledgedFor(sessionId: string): AgentEvent[] {
    return this.streams.get(sessionId)?.pending.map((e) => e.event) ?? []
  }

  /**
   * The threads whose oldest unacknowledged event was buffered more than `ms` ago:
   * since when, and their unacknowledged events in order.
   */
  waiting(ms: number, now = Date.now()) {
    const waiting: { sessionId: string; since: number; events: SequencedEvent[] }[] = []
    for (const [sessionId, stream] of this.streams) {
      const oldest = stream.pending[0]
      const since = oldest && (stream.bufferedAt.get(oldest.seq) ?? now)
      if (since !== undefined && now - since > ms)
        waiting.push({ sessionId, since, events: stream.pending })
    }
    return waiting
  }

  /** Every event the API has not acknowledged yet, in order per thread. */
  unacknowledged(): SequencedEvent[] {
    return [...this.streams.values()].flatMap((s) => s.pending)
  }

  private stream(sessionId: string) {
    let stream = this.streams.get(sessionId)
    if (!stream)
      this.streams.set(
        sessionId,
        (stream = { lastSeq: 0, acked: 0, pending: [], bufferedAt: new Map() }),
      )
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

function parseLine(line: string): SequencedEvent | null {
  if (!line) return null
  try {
    return JSON.parse(line) as SequencedEvent
  } catch {
    return null
  }
}

/** Replace a file whole: a crash leaves the old one or the new one, never half of each. */
function writeAtomic(file: string, text: string) {
  const temp = `${file}.tmp`
  writeFileSync(temp, text, { mode: 0o600 })
  renameSync(temp, file)
}
