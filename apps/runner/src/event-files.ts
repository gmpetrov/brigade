// Images and PDFs a teammate's tools return (a screenshot it read, a page it captured,
// a PDF it read) arrive in its events as base64, hundreds of kB each. Before the events
// leave for the hub, each file goes to the thread's bucket folder (/runner/files, straight
// to R2), and the event keeps its name in its place (STORED_FILE), which the dashboard
// shows from there: the socket never carries the bytes. The outbox keeps the event so
// rewritten, so a file is uploaded once however often its event is sent.
import { createHash } from 'node:crypto'
import { STORED_FILE, THREAD_FILE_MAX, type SequencedEvent } from '@brigade/contracts'
import type { StoreImage } from './reply-images.js'
import { UploadError } from './uploads.js'

/** Shorter strings stay in the event: a small icon is not worth a trip to the bucket. */
const MIN_LENGTH = 4096

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const DATA_URL = /^data:(?:image\/[\w.+-]+|application\/pdf);base64,/

/** The types kept apart, by their leading bytes. SVG is not one: it is text, and can run script. */
const KINDS = [
  { ext: 'png', type: 'image/png', is: (b: Buffer) => b[0] === 0x89 && ascii(b, 1, 4) === 'PNG' },
  {
    ext: 'jpg',
    type: 'image/jpeg',
    is: (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  { ext: 'gif', type: 'image/gif', is: (b: Buffer) => ascii(b, 0, 4) === 'GIF8' },
  {
    ext: 'webp',
    type: 'image/webp',
    is: (b: Buffer) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
  },
  { ext: 'pdf', type: 'application/pdf', is: (b: Buffer) => ascii(b, 0, 5) === '%PDF-' },
]
const ascii = (b: Buffer, from: number, to: number) => b.toString('latin1', from, to)

export type EventFile = { name: string; type: string; bytes: Buffer }

/** The base64 of a string that may be a file, and its kind by its first bytes; undefined for most. */
function kindOf(text: string) {
  if (text.length < MIN_LENGTH) return undefined
  const base64 = DATA_URL.test(text) ? text.slice(text.indexOf(',') + 1) : text
  // Its first bytes first: most long strings are not files, and need not be decoded.
  const kind = KINDS.find((k) => k.is(Buffer.from(base64.slice(0, 16), 'base64')))
  return kind && { kind, base64 }
}

/** The file's size from its base64, without decoding it. */
const decodedSize = (base64: string) =>
  Math.floor((base64.length * 3) / 4) - (base64.match(/=*$/)?.[0].length ?? 0)

/**
 * The image or PDF a string holds whole, in base64 or as a data: URL; `tooLarge` with its
 * size when it is over THREAD_FILE_MAX (not decoded); undefined for anything else.
 */
export function fileIn(text: string): EventFile | { tooLarge: number } | undefined {
  const found = kindOf(text)
  if (!found || !BASE64.test(found.base64)) return undefined
  const size = decodedSize(found.base64)
  if (size > THREAD_FILE_MAX) return { tooLarge: size }
  const bytes = Buffer.from(found.base64, 'base64')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return { name: `${sha256}.${found.kind.ext}`, type: found.kind.type, bytes }
}

/** Whether a value may hold a file: only the first bytes of long strings are read. */
export function hasFile(value: unknown): boolean {
  if (typeof value === 'string') return kindOf(value) !== undefined
  if (Array.isArray(value)) return value.some(hasFile)
  if (isPlain(value)) return Object.values(value).some(hasFile)
  return false
}

/** The note in place of a file the thread cannot keep. */
export const tooLargeNote = (size: number) =>
  `[file too large to keep: ${Math.ceil(size / 1024 / 1024)} MB]`
const REFUSED_NOTE = '[file not kept: Brigade refused it]'

/** The value with each file in it replaced by STORED_FILE and its name, the files in `files`. */
export function replaceFiles(value: unknown, files: Map<string, EventFile>): unknown {
  if (typeof value === 'string') {
    const file = fileIn(value)
    if (!file) return value
    if ('tooLarge' in file) return tooLargeNote(file.tooLarge)
    files.set(file.name, file)
    return `${STORED_FILE}${file.name}`
  }
  if (Array.isArray(value)) return value.map((v) => replaceFiles(v, files))
  if (isPlain(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, replaceFiles(v, files)]),
    )
  return value
}

/** The value with each named stored file that could not be kept replaced by a note. */
function noteRefused(value: unknown, refused: Set<string>): unknown {
  if (typeof value === 'string')
    return value.startsWith(STORED_FILE) && refused.has(value.slice(STORED_FILE.length))
      ? REFUSED_NOTE
      : value
  if (Array.isArray(value)) return value.map((v) => noteRefused(v, refused))
  if (isPlain(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, noteRefused(v, refused)]),
    )
  return value
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype

/** Files known to be in their thread's folder: not uploaded again. */
const REMEMBERED = 1000

/** The thread was deleted: its events are not wanted any more. */
class Gone extends Error {}

/**
 * Takes the events about to be sent, and holds back those with files until their files
 * are in the bucket. Per thread, one upload run at a time; other threads' events go on.
 */
export class EventFiles {
  /** Per thread with a run in flight: the events it holds, and those that came since. */
  private runs = new Map<string, { inFlight: Set<number>; queued: Map<number, SequencedEvent> }>()
  private kept = new Set<string>()

  constructor(
    private readonly options: {
      store: StoreImage
      outbox: {
        /** Keep the events so rewritten in place of those with the same seq. */
        replace(sessionId: string, events: SequencedEvent[]): void
        /** Forget the thread's events: it was deleted. */
        drop(sessionId: string): void
      }
    },
  ) {}

  /**
   * The events to send now. Those with files are sent with `send` once their files are
   * uploaded and the outbox holds them without; on a failure they stay in the outbox,
   * as they were, for the next time they are sent (a reconnect, or the resend of events
   * left unacknowledged).
   */
  take(events: SequencedEvent[], send: (events: SequencedEvent[]) => void): SequencedEvent[] {
    const now: SequencedEvent[] = []
    const held = new Map<string, SequencedEvent[]>()
    for (const event of events) {
      const run = this.runs.get(event.sessionId)
      if (run?.inFlight.has(event.seq)) continue
      if (!hasFile(event.event)) now.push(event)
      else if (run) run.queued.set(event.seq, event)
      else held.set(event.sessionId, [...(held.get(event.sessionId) ?? []), event])
    }
    for (const [sessionId, ofThread] of held) void this.run(sessionId, ofThread, send)
    return now
  }

  private async run(
    sessionId: string,
    events: SequencedEvent[],
    send: (events: SequencedEvent[]) => void,
  ) {
    const run = { inFlight: new Set(events.map((e) => e.seq)), queued: new Map() }
    this.runs.set(sessionId, run)
    let batch = events
    try {
      while (batch.length > 0) {
        const done: SequencedEvent[] = []
        try {
          // One event at a time: a replay of many screenshots is never decoded all at once.
          for (const event of batch) done.push(await this.keep(sessionId, event))
        } finally {
          // What is done stays done, should a later one fail.
          if (done.length > 0) {
            this.options.outbox.replace(sessionId, done)
            send(done)
          }
        }
        batch = [...run.queued.values()]
        run.queued.clear()
        run.inFlight = new Set(batch.map((e) => e.seq))
      }
    } catch (error) {
      if (error instanceof Gone) {
        console.warn(`thread ${sessionId} was deleted: its events are dropped`)
        this.options.outbox.drop(sessionId)
      } else
        console.warn(
          `thread ${sessionId}: could not keep the files of its events, trying again later: ${String(error)}`,
        )
    } finally {
      this.runs.delete(sessionId)
    }
  }

  /** The event with its files in the bucket, each named in its place. */
  private async keep(sessionId: string, sequenced: SequencedEvent): Promise<SequencedEvent> {
    const files = new Map<string, EventFile>()
    let event = replaceFiles(sequenced.event, files) as SequencedEvent['event']
    const refused = new Set<string>()
    for (const file of files.values()) {
      const key = `${sessionId}/${file.name}`
      if (this.kept.has(key)) continue
      try {
        await this.options.store(sessionId, file.name, file.bytes, file.type)
      } catch (error) {
        if (!(error instanceof UploadError)) throw error
        if (error.status === 410) throw new Gone()
        // It will not be taken however often it is sent: the event goes on without it.
        if (error.status === 400 || error.status === 413) {
          console.warn(`thread ${sessionId}: the file ${file.name} was refused: ${error.message}`)
          refused.add(file.name)
          continue
        }
        throw error
      }
      this.kept.add(key)
      if (this.kept.size > REMEMBERED) this.kept.delete(this.kept.values().next().value!)
    }
    if (refused.size > 0) event = noteRefused(event, refused) as SequencedEvent['event']
    return { ...sequenced, event }
  }
}
