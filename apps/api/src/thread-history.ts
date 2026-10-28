// A thread's history by pages: a long thread opens on its latest page, and
// older pages load as someone scrolls up. The few older events the whole
// thread needs (what it made, its preview, usage, open asks) come as context.
import {
  DELIVERABLE_EXTENSIONS,
  isOutputTool,
  OUTPUT_TOOLS,
  THREAD_PAGE_EVENTS,
  THREAD_PAGE_MESSAGES,
  THREAD_PAGE_STARTS,
  THREAD_PROMPT_CHARS,
  THREAD_TIMELINE_MARKS,
  type SequencedEvent,
  type TimelineMessage,
} from '@brigade/contracts'
import { prisma, type Prisma } from './db.js'

type Row = { sessionId: string; seq: number; data: Prisma.JsonValue }
const sequenced = (r: Row): SequencedEvent => ({
  sessionId: r.sessionId,
  seq: r.seq,
  event: r.data as unknown as SequencedEvent['event'],
})

/**
 * The first seq of the page that ends before `before`: a turn's start about a page back, or
 * THREAD_PAGE_MESSAGES messages back when that comes first, else 1.
 */
export async function pageStart(sessionId: string, before: number) {
  const back = await prisma.sessionEvent.findFirst({
    where: { sessionId, type: 'message.user', seq: { lt: before } },
    orderBy: { seq: 'desc' },
    skip: THREAD_PAGE_MESSAGES - 1,
    select: { seq: true },
  })
  return startAt(sessionId, Math.max(before - THREAD_PAGE_EVENTS, back?.seq ?? 1))
}

/** Where a page holding `seq` starts: the turn's start or member's message at or before it, else 1. */
export async function startAt(sessionId: string, seq: number) {
  if (seq <= 1) return 1
  const start = await prisma.sessionEvent.findFirst({
    where: { sessionId, seq: { lte: seq }, type: { in: THREAD_PAGE_STARTS } },
    orderBy: { seq: 'desc' },
    select: { seq: true, type: true },
  })
  if (!start) return 1
  // A turn the member's message just before it started: the page starts with the message.
  if (start.type === 'turn.started') {
    const asked = await prisma.sessionEvent.findFirst({
      where: { sessionId, seq: start.seq - 1, type: 'message.user' },
      select: { seq: true },
    })
    if (asked) return asked.seq
  }
  return start.seq
}

/**
 * Where the page starting at `from` ends, not included: the first turn's start or member's
 * message about a page on, or the message after THREAD_PAGE_MESSAGES of them when that
 * comes first, else `until`, past which the dashboard has the thread already.
 */
export async function pageEnd(sessionId: string, from: number, until: number) {
  const [end, next] = await Promise.all([
    prisma.sessionEvent.findFirst({
      where: {
        sessionId,
        seq: { gte: from + THREAD_PAGE_EVENTS, lt: until },
        type: { in: THREAD_PAGE_STARTS },
      },
      orderBy: { seq: 'asc' },
      select: { seq: true },
    }),
    prisma.sessionEvent.findFirst({
      where: { sessionId, type: 'message.user', seq: { gte: from, lt: until } },
      orderBy: { seq: 'asc' },
      skip: THREAD_PAGE_MESSAGES,
      select: { seq: true },
    }),
  ])
  return Math.min(end?.seq ?? until, next?.seq ?? until)
}

/**
 * The messages people wrote in a thread, for its timeline: at most THREAD_TIMELINE_MARKS
 * marks, each the first of a group of messages in a row (markOf), with how many it stands
 * for. Only those first messages' starts are read and cut, in the database, so the answer
 * stays small however long the thread. Brigade's own messages (wake-ups, reports) are left out.
 */
export async function threadPrompts(sessionId: string): Promise<TimelineMessage[]> {
  const rows = await prisma.$queryRaw<
    { seq: number; at: Date; text: string | null; count: bigint; last: number }[]
  >`
    WITH mine AS (
      SELECT "seq", row_number() OVER (ORDER BY "seq") - 1 AS i, count(*) OVER () AS n
      FROM "SessionEvent"
      WHERE "sessionId" = ${sessionId} AND "type" = 'message.user' AND "data"->>'memberId' IS NOT NULL
    ), marks AS (
      SELECT min("seq") AS first, max("seq") AS last, count(*) AS count
      FROM mine
      GROUP BY floor(i * least(n, ${THREAD_TIMELINE_MARKS}) / n)
    )
    SELECT e."seq", e."at", left(e."data"->>'text', ${THREAD_PROMPT_CHARS}) AS "text", m.count, m.last
    FROM marks m JOIN "SessionEvent" e ON e."sessionId" = ${sessionId} AND e."seq" = m.first
    ORDER BY e."seq"`
  return rows.map((r) => ({
    seq: r.seq,
    at: r.at.toISOString(),
    text: r.text ?? '',
    count: Number(r.count),
    last: r.last,
  }))
}

/** The events from `from` up to, not including, `before`. */
export async function pageEvents(sessionId: string, from: number, before: number) {
  const rows = await prisma.sessionEvent.findMany({
    where: { sessionId, seq: { gte: from, lt: before } },
    orderBy: { seq: 'asc' },
    select: { sessionId: true, seq: true, data: true },
  })
  return rows.map(sequenced)
}

/** A message that may name a file made to hand over. */
const NAMES_DELIVERABLE = new RegExp(`\\.(?:${DELIVERABLE_EXTENSIONS})\\b`, 'i')

/** Asks still open count; each is closed by the event that answers it, with the same id. */
const ASKS = {
  'approval.requested': ['approval.resolved', 'approvalId'],
  'question.asked': ['question.answered', 'questionId'],
  'ticket.opened': ['ticket.answered', 'requestId'],
  'message.queued': ['message.user', 'messageId'],
} as const

/**
 * Of the events before `firstSeq`, those the whole thread needs: files and
 * images made, messages that name deliverables, calls to tools whose results
 * are outputs (with their results), the latest preview, the repositories
 * checked out, usage limits, the latest
 * turn's start and end, and approvals, questions, tickets and queued messages
 * still open.
 */
export async function historyContext(sessionId: string, firstSeq: number) {
  if (firstSeq <= 1) return []
  const before = { sessionId, seq: { lt: firstSeq } }
  const select = { sessionId: true, seq: true, type: true, data: true } as const
  const [rows, calls] = await Promise.all([
    prisma.sessionEvent.findMany({
      where: {
        ...before,
        type: {
          in: [
            'file.changed',
            'image.generated',
            'message.done',
            'preview.changed',
            'repositories.changed',
            'usage.updated',
            'turn.started',
            'turn.completed',
            'message.cancelled',
            ...Object.keys(ASKS),
            ...Object.values(ASKS).map(([answer]) => answer),
          ],
        },
      },
      orderBy: { seq: 'asc' },
      select,
    }),
    // Matched by name in the database: most tool calls are large and none of these.
    prisma.sessionEvent.findMany({
      where: {
        ...before,
        type: 'tool.started',
        OR: [...OUTPUT_TOOLS, 'mail'].map((name) => ({
          data: { path: ['toolName'], string_contains: name },
        })),
      },
      select,
    }),
  ])
  const started = calls.filter((r) => isOutputTool(String(field(r, 'toolName'))))
  const finished = started.length
    ? await prisma.sessionEvent.findMany({
        where: {
          ...before,
          type: 'tool.finished',
          OR: started.map((r) => ({
            data: { path: ['toolCallId'], equals: String(field(r, 'toolCallId')) },
          })),
        },
        select,
      })
    : []

  const closed = new Set<string>()
  for (const r of rows) {
    for (const [answer, id] of Object.values(ASKS))
      if (r.type === answer) closed.add(`${answer}:${field(r, id)}`)
    if (r.type === 'message.cancelled') closed.add(`message.user:${field(r, 'messageId')}`)
  }
  const last = (type: string, when: (r: Row) => boolean = () => true) =>
    rows.findLast((r) => r.type === type && when(r))
  const kept = [
    ...rows.filter((r) => {
      if (r.type === 'file.changed' || r.type === 'image.generated') return true
      // Few, and each teammate's latest says what the thread has checked out.
      if (r.type === 'repositories.changed') return true
      if (r.type === 'message.done') return NAMES_DELIVERABLE.test(String(field(r, 'text')))
      if (r.type in ASKS) {
        const [answer, id] = ASKS[r.type as keyof typeof ASKS]
        return !closed.has(`${answer}:${field(r, id)}`)
      }
      return false
    }),
    last('preview.changed'),
    last('usage.updated', (r) => !!(field(r, 'limits') as unknown[] | undefined)?.length),
    // With its end, if it ended: a turn on this page started after it, not with it.
    last('turn.started'),
    last('turn.completed'),
    ...started,
    ...finished,
  ].filter((r) => r !== undefined)
  return kept.sort((a, b) => a.seq - b.seq).map(sequenced)
}

const field = (row: Row, key: string) => (row.data as Record<string, unknown> | null)?.[key]
