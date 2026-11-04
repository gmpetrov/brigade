// A quiet thread's events, kept cold (docs/decisions.md, "Cold events"). Most of what a thread
// stores is its teammates' work in detail: replies streamed piece by piece (message.delta), tool
// calls with their inputs and outputs, the harness's copies of sub-agents' messages, reasoning.
// They are read only to show the thread again, page by page, and once a thread has been quiet a
// while, seldom at all. So after COLD_AFTER_MS without a new event they go to the bucket, in
// gzipped chunks of JSON lines, and leave SessionEvent, which then grows with the threads at work
// rather than with every thread there ever was. The other events stay in the database: messages,
// turns, tickets, previews, what a thread made, the cards it offered. Lists, Home, a page's start
// and its context read those there, unchanged. A chunk holds every event of its range, those
// that stayed too, so a page is read whole from it (threadEvents).
//
// A chunk is put in the bucket and checked there first; one transaction then records it, moves
// the thread's coldSeq over it and removes its heavy events (SessionEvent's append-only rule lets
// that transaction alone do so, migration 20261104160000_cold_events). Each step is safe to run
// twice: a run that lost the race to another leaves the thread as the other left it.
import {
  isOutputTool,
  OFFER_CHOICES_TOOL,
  SUGGEST_REPLIES_TOOL,
  type SequencedEvent,
} from '@brigade/contracts'
import { coldEventsKey, deleteObject, objectSize, putObject, streamObject } from './bucket.js'
import { prisma, type Prisma, type Scope } from './db.js'
import { noteFailure } from './ops/failures.js'

/** A thread with no new event for this long has its events kept cold. */
export const COLD_AFTER_MS = 30 * 24 * 60 * 60_000

export type ColdLimits = {
  /** The most events a chunk holds. */
  events: number
  /** About the most bytes of them a chunk holds, as the database stores them (compressed). */
  storedBytes: number
  /**
   * A run starts no chunk after this long. Well within JOB_DEADLINE_MS: the queue's consumer runs
   * a batch's jobs one after the other, and a long one would hold back the others (a schedule's
   * time, a wake-up).
   */
  runMs: number
  /** Threads one run looks at, the quietest first. */
  threads: number
}

const LIMITS: ColdLimits = { events: 1000, storedBytes: 1_000_000, runMs: 20_000, threads: 50 }

/** An event a thread's page alone reads: it goes once its chunk is in the bucket. */
export function goesCold(type: string, data: unknown) {
  if (type === 'message.delta') return true
  const event = data as { toolName?: unknown; source?: unknown } | null
  if (type === 'tool.started' || type === 'tool.finished') {
    const toolName = typeof event?.toolName === 'string' ? event.toolName : ''
    // What a thread made (historyContext) and the cards it offered (Home, choices) are read
    // from the database.
    return !(
      isOutputTool(toolName) ||
      toolName.endsWith(SUGGEST_REPLIES_TOOL) ||
      toolName.endsWith(OFFER_CHOICES_TOOL)
    )
  }
  // The harness's copies and reasoning; notes and the runner's own words stay (Home reads notes).
  if (type === 'raw') return event?.source === 'harness' || event?.source === 'reasoning'
  return false
}

/** The threads due: quiet long enough, not at work, with events not kept cold yet. */
const due = (now: Date) =>
  ({
    updatedAt: { lt: new Date(now.getTime() - COLD_AFTER_MS) },
    status: { notIn: ['starting', 'running'] },
    lastSeq: { gt: prisma.session.fields.coldSeq },
  }) satisfies Prisma.SessionWhereInput

/** Workspaces with a thread whose events are due to be kept cold. */
export async function dueColdEvents(now: Date) {
  const rows = await prisma.session.groupBy({ by: ['workspaceId'], where: due(now) })
  return rows.map((r) => r.workspaceId)
}

type Thread = {
  id: string
  organizationId: string
  workspaceId: string
  coldSeq: number
  lastSeq: number
}

/**
 * Keep the events of a workspace's quiet threads cold (of every workspace's without one), a
 * chunk at a time, the quietest threads first, for at most `limits.runMs`: what is left waits
 * for the next run.
 */
export async function keepEventsCold(
  workspaceId?: string,
  now = new Date(),
  limits: ColdLimits = LIMITS,
) {
  const until = Date.now() + limits.runMs
  const threads = await prisma.session.findMany({
    where: { ...(workspaceId ? { workspaceId } : {}), ...due(now) },
    orderBy: { updatedAt: 'asc' },
    take: limits.threads,
    select: { id: true, organizationId: true, workspaceId: true, coldSeq: true, lastSeq: true },
  })
  let chunks = 0
  let moved = 0
  for (const thread of threads) {
    let current: Thread | undefined = thread
    while (current && current.coldSeq < current.lastSeq && Date.now() < until) {
      const chunk = await keepChunkCold(current, limits)
      if (!chunk) break
      chunks++
      moved += chunk.moved
      current = { ...current, coldSeq: chunk.lastSeq }
    }
    if (Date.now() >= until) break
  }
  if (chunks) console.log(`cold events: ${chunks} chunk(s) in the bucket, ${moved} event(s) moved`)
  return { chunks, moved }
}

/** A run that found the thread kept cold by another meanwhile: it leaves it as the other did. */
class Raced extends Error {}

/**
 * The thread's next chunk, from the event after coldSeq: put in the bucket, then recorded and its
 * heavy events removed. Undefined when there is nothing to keep, or another run did it meanwhile.
 */
async function keepChunkCold(thread: Thread, limits: ColdLimits) {
  const firstSeq = thread.coldSeq + 1
  // Where it ends: about storedBytes of events, read by their size first rather than whole.
  const sizes = await prisma.$queryRaw<{ seq: number; size: number }[]>`
    SELECT "seq", pg_column_size("data")::int AS "size"
    FROM "SessionEvent"
    WHERE "sessionId" = ${thread.id} AND "seq" >= ${firstSeq}::int AND "seq" <= ${thread.lastSeq}::int
    ORDER BY "seq"
    LIMIT ${limits.events}::int`
  if (!sizes.length) {
    console.warn(`cold events: thread ${thread.id} holds no event from ${firstSeq} on`)
    return undefined
  }
  let lastSeq = sizes[0]!.seq
  let total = 0
  for (const { seq, size } of sizes) {
    if (total > 0 && total + size > limits.storedBytes) break
    total += size
    lastSeq = seq
  }
  const rows = await prisma.sessionEvent.findMany({
    where: { sessionId: thread.id, seq: { gte: firstSeq, lte: lastSeq } },
    orderBy: { seq: 'asc' },
    select: { seq: true, type: true, at: true, data: true },
  })
  const text = rows
    .map((r) => JSON.stringify({ seq: r.seq, type: r.type, at: r.at.toISOString(), data: r.data }))
    .join('\n')
  const body = await gzip(text)
  const key = coldEventsKey(thread, thread.id, firstSeq, lastSeq)
  await putObject(key, body, 'application/gzip')
  // In the bucket whole before anything leaves the database.
  const size = await objectSize(key)
  if (size !== body.byteLength)
    throw new Error(`cold events: ${key} holds ${size} bytes, not ${body.byteLength}`)
  const heavy = rows.filter((r) => goesCold(r.type, r.data)).map((r) => r.seq)
  try {
    await prisma.$transaction(async (tx) => {
      // The one transaction SessionEvent's rule lets remove this thread's events, those a
      // chunk recorded below holds.
      await tx.$queryRaw`SELECT set_config('brigade.cold_session', ${thread.id}, true)`
      const claimed = await tx.$executeRaw`
        UPDATE "Session" SET "coldSeq" = ${lastSeq}::int
        WHERE "id" = ${thread.id} AND "coldSeq" = ${thread.coldSeq}::int`
      if (claimed !== 1) throw new Raced()
      await tx.coldEventChunk.create({
        data: {
          organizationId: thread.organizationId,
          workspaceId: thread.workspaceId,
          sessionId: thread.id,
          firstSeq,
          lastSeq,
          events: rows.length,
          moved: heavy.length,
          bytes: Buffer.byteLength(text),
          storedBytes: body.byteLength,
        },
      })
      if (heavy.length) {
        const removed = await tx.$executeRaw`
          DELETE FROM "SessionEvent" WHERE "sessionId" = ${thread.id} AND "seq" = ANY(${heavy}::int[])`
        if (removed !== heavy.length)
          throw new Error(
            `cold events: ${removed} of ${heavy.length} events of ${thread.id} removed`,
          )
      }
    })
  } catch (error) {
    if (!(error instanceof Raced)) throw error
    // Kept by the other run under another key (a range it cut elsewhere): this copy is no one's.
    const kept = await prisma.coldEventChunk.findUnique({
      where: { sessionId_firstSeq: { sessionId: thread.id, firstSeq } },
      select: { lastSeq: true },
    })
    if (kept?.lastSeq !== lastSeq) await deleteObject(key).catch(() => undefined)
    return undefined
  }
  return { lastSeq, moved: heavy.length }
}

async function gzip(text: string) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** An event as stored: its row in SessionEvent, or its line in a chunk. */
export type StoredEvent = {
  sessionId: string
  seq: number
  type: string
  at: Date
  data: Prisma.JsonValue
}

export const sequenced = (row: StoredEvent): SequencedEvent => ({
  sessionId: row.sessionId,
  seq: row.seq,
  event: row.data as unknown as SequencedEvent['event'],
})

type Read = {
  /** At most this many events in each batch. */
  batch?: number
  /** Types left out (a run log's streamed text). */
  without?: string[]
}

/** Past every seq: an Int column's largest value. */
export const LAST_SEQ = 2_147_483_647

/**
 * A thread's events from `from` up to, not including, `before`, in seq order and in batches:
 * those kept cold from their chunks in the bucket, the others from the database. Read as the
 * events are kept as it goes: a chunk recorded while a batch was read from the database (whose
 * heavy events left it meanwhile) is read again from the bucket.
 */
export async function* threadEvents(
  sessionId: string,
  from: number,
  before: number,
  options: Read = {},
): AsyncGenerator<StoredEvent[]> {
  const batch = options.batch ?? 500
  let next = from
  while (next < before) {
    const thread = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { organizationId: true, workspaceId: true, coldSeq: true },
    })
    if (!thread) return
    if (next <= thread.coldSeq) {
      const end = Math.min(before, thread.coldSeq + 1)
      yield* coldEvents(thread, sessionId, next, end, batch, options.without)
      next = end
      continue
    }
    const rows = await databaseEvents(sessionId, next, before, batch, options.without)
    if (!rows.length) return
    const now = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { coldSeq: true },
    })
    if (now && now.coldSeq >= next) continue
    yield rows
    next = rows.at(-1)!.seq + 1
  }
}

/** The thread's events in the database from `from` up to `before`, at most `take`. */
function databaseEvents(
  sessionId: string,
  from: number,
  before: number,
  take: number,
  without?: string[],
): Promise<StoredEvent[]> {
  return prisma.sessionEvent.findMany({
    where: {
      sessionId,
      seq: { gte: from, lt: before },
      ...(without?.length ? { type: { notIn: without } } : {}),
    },
    orderBy: { seq: 'asc' },
    take,
    select: { sessionId: true, seq: true, type: true, at: true, data: true },
  })
}

/** Every one of them, by batches. */
async function* allDatabaseEvents(
  sessionId: string,
  from: number,
  before: number,
  batch: number,
  without?: string[],
) {
  let next = from
  while (next < before) {
    const rows = await databaseEvents(sessionId, next, before, batch, without)
    if (!rows.length) return
    yield rows
    next = rows.at(-1)!.seq + 1
  }
}

/**
 * The thread's events kept cold from `from` up to `end`, from their chunks. A range no chunk
 * holds, or whose chunk the bucket no longer has or cannot be read, comes from what the database
 * still holds of it: its messages, turns and tickets, without the detail of its work.
 */
async function* coldEvents(
  scope: Scope,
  sessionId: string,
  from: number,
  end: number,
  batch: number,
  without?: string[],
): AsyncGenerator<StoredEvent[]> {
  const chunks = await prisma.coldEventChunk.findMany({
    where: { sessionId, lastSeq: { gte: from }, firstSeq: { lt: end } },
    orderBy: { firstSeq: 'asc' },
    select: { firstSeq: true, lastSeq: true },
  })
  let out: StoredEvent[] = []
  const full = () => out.length >= batch
  const take = () => {
    const rows = out
    out = []
    return rows
  }
  let next = from
  for (const chunk of [...chunks, { firstSeq: end, lastSeq: end - 1 }]) {
    if (next >= end) break
    if (chunk.firstSeq > next) {
      for await (const rows of allDatabaseEvents(
        sessionId,
        next,
        Math.min(chunk.firstSeq, end),
        batch,
        without,
      )) {
        out.push(...rows)
        if (full()) yield take()
      }
      next = Math.min(chunk.firstSeq, end)
    }
    if (chunk.lastSeq < chunk.firstSeq) continue
    const upTo = Math.min(end, chunk.lastSeq + 1)
    const key = coldEventsKey(scope, sessionId, chunk.firstSeq, chunk.lastSeq)
    try {
      const body = await streamObject(key)
      if (!body) throw new Error('not in the bucket')
      for await (const row of chunkEvents(sessionId, body)) {
        if (row.seq < next) continue
        if (row.seq >= upTo) break
        next = row.seq + 1
        if (without?.includes(row.type)) continue
        out.push(row)
        if (full()) yield take()
      }
    } catch (error) {
      // Brigade's own data lost or broken: its operators hear of it (src/ops/checks.ts).
      noteFailure('job:cold-events', error, { workspaceId: scope.workspaceId })
      console.error(
        `cold events: ${key} not read (${String(error)}): events ${next}-${upTo - 1} of thread ${sessionId} as the database has them`,
      )
      for await (const rows of allDatabaseEvents(sessionId, next, upTo, batch, without)) {
        out.push(...rows)
        if (full()) yield take()
      }
    }
    next = upTo
  }
  if (out.length) yield take()
}

/** A chunk's events, one line at a time as the bucket sends them: a chunk is never held whole. */
async function* chunkEvents(
  sessionId: string,
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StoredEvent> {
  const reader = body
    .pipeThrough(new DecompressionStream('gzip'))
    .pipeThrough(new TextDecoderStream())
    .getReader()
  let rest = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (value) rest += value
      let start = 0
      for (let at = rest.indexOf('\n'); at >= 0; at = rest.indexOf('\n', start)) {
        const line = rest.slice(start, at)
        start = at + 1
        if (line) yield parseLine(sessionId, line)
      }
      rest = rest.slice(start)
      if (done) break
    }
    if (rest) yield parseLine(sessionId, rest)
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function parseLine(sessionId: string, line: string): StoredEvent {
  const { seq, type, at, data } = JSON.parse(line) as {
    seq: number
    type: string
    at: string
    data: Prisma.JsonValue
  }
  return { sessionId, seq, type, at: new Date(at), data }
}
