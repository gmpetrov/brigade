// A thread's history by pages: a long thread opens on its latest page, and
// older pages load as someone scrolls up. The few older events the whole
// thread needs (what it made, its preview, usage, open asks) come as context.
import {
  DELIVERABLE_EXTENSIONS,
  isOutputTool,
  OUTPUT_TOOLS,
  THREAD_PAGE_EVENTS,
  THREAD_PAGE_STARTS,
  type SequencedEvent,
} from '@brigade/contracts'
import { prisma, type Prisma } from './db.js'

type Row = { sessionId: string; seq: number; data: Prisma.JsonValue }
const sequenced = (r: Row): SequencedEvent => ({
  sessionId: r.sessionId,
  seq: r.seq,
  event: r.data as unknown as SequencedEvent['event'],
})

/** The first seq of the page that ends before `before`: a turn's start about a page back, else 1. */
export async function pageStart(sessionId: string, before: number) {
  const target = before - THREAD_PAGE_EVENTS
  if (target <= 1) return 1
  const start = await prisma.sessionEvent.findFirst({
    where: { sessionId, seq: { lte: target }, type: { in: THREAD_PAGE_STARTS } },
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
 * are outputs (with their results), the latest preview, usage limits, the latest
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
