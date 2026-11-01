import { z } from 'zod'

// The Board (docs/board.md): what moves across a workspace's lists, threads and routines,
// computed from them on each read. It has no store of its own.

/** Where a card stands: what waits on a person, what moves, what was done this week. */
export const BoardColumn = z.enum(['needs_you', 'in_progress', 'done'])
export type BoardColumn = z.infer<typeof BoardColumn>

/** Why a card waits on a person, or what it waits on while it moves. */
export const BoardReason = z.enum([
  /** An open ticket or question in the thread or one of its children. */
  'ticket',
  /** The teammate waits on an answer or a decision (waiting), or a person took it over (paused). */
  'waiting',
  /** A pull request is ready for a person to merge or decide. */
  'pull',
  /** The thread failed and a person tries it again or writes (src/failed.ts). */
  'failed',
  /** A routine's run failed, or the routine could not start one. */
  'routine_failed',
  /** The teammate is working, or its children it waits for are. */
  'working',
  /** It waits on a wake-up it set. */
  'wakeup',
  /** A pull request of it is being reviewed or fixed. */
  'review',
])
export type BoardReason = z.infer<typeof BoardReason>

export const BoardThread = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  teammate: z.object({ id: z.string(), name: z.string() }),
  /** The routine whose run it is: its card shows the routine, never the run. */
  routine: z.object({ id: z.string(), title: z.string() }).nullable(),
})
export type BoardThread = z.infer<typeof BoardThread>

export const BoardPull = z.object({
  repository: z.string(),
  number: z.number(),
  state: z.string(),
  url: z.string(),
})
export type BoardPull = z.infer<typeof BoardPull>

export const BoardCard = z.object({
  /** item:<id>, thread:<id> or routine:<id>. */
  key: z.string(),
  /** A list's line, a thread on no list, or a routine (a failed run, or one it could not start). */
  kind: z.enum(['item', 'thread', 'routine']),
  column: BoardColumn,
  /** Plain text: a line's text without its Markdown, a thread's or a routine's title. */
  title: z.string(),
  /** The thread to open, or null for a line with no thread (only pull requests) or a routine. */
  href: z.string().nullable(),
  list: z
    .object({ documentId: z.string(), title: z.string(), section: z.string().nullable() })
    .nullable(),
  projectId: z.string().nullable(),
  threads: z.array(BoardThread),
  pulls: z.array(BoardPull),
  reason: BoardReason.nullable(),
  /** A line on the card: the thread's error, a routine's error, what was done. */
  note: z.string().nullable(),
  /** Since when it stands where it is, for the order within a column: newest first. */
  at: z.string(),
  /** Who declared or ticked it done, and when: in the Done column only. */
  done: z.object({ at: z.string(), by: z.string().nullable() }).nullable(),
})
export type BoardCard = z.infer<typeof BoardCard>

/** How a routine's runs went, from its last week: what its row's badge says. */
export const RoutineHealth = z.enum(['ok', 'degraded', 'failed', 'paused', 'new'])
export type RoutineHealth = z.infer<typeof RoutineHealth>

/** How a run ended, from its report (a run that reports to a thread) or its status. */
export const RunOutcome = z.enum([
  'running',
  'report',
  'nothing',
  'needs_person',
  'failed',
  'cancelled',
  /** A run that reports to nobody ended: Brigade can't tell what it found. */
  'ended',
])
export type RunOutcome = z.infer<typeof RunOutcome>

export const BoardRoutine = z.object({
  id: z.string(),
  title: z.string(),
  cron: z.string(),
  timezone: z.string(),
  teammate: z.object({ id: z.string(), name: z.string() }),
  projectId: z.string().nullable(),
  health: RoutineHealth,
  /** Its runs of the last 7 days, and how many of those failed. */
  week: z.object({ runs: z.number(), failed: z.number() }),
  /** Its runs of today, in its time zone: those that found nothing are counted, not listed. */
  today: z.object({
    runs: z.number(),
    nothing: z.number(),
    /** Pull requests its runs opened today. */
    pulls: z.array(z.object({ number: z.number(), url: z.string() })),
  }),
  /** Its run at work now. */
  running: z.object({ id: z.string(), since: z.string() }).nullable(),
  /** Its last finished run. */
  last: z
    .object({
      id: z.string(),
      at: z.string(),
      outcome: RunOutcome,
      /** The start of its report. */
      summary: z.string().nullable(),
    })
    .nullable(),
  /** Why its last firing could not start; cleared by the next start. */
  error: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  /** The lists its runs worked on this week: it shows when the Board is filtered on one. */
  listIds: z.array(z.string()),
})
export type BoardRoutine = z.infer<typeof BoardRoutine>

/** A thread that stopped without being done: idle, nothing pending. */
export const BoardStopped = z.object({
  /** thread:<id>, or item:<id> for a list's line whose threads all stopped. */
  key: z.string(),
  title: z.string(),
  href: z.string(),
  teammate: z.object({ id: z.string(), name: z.string() }),
  projectId: z.string().nullable(),
  list: z.object({ documentId: z.string(), title: z.string() }).nullable(),
  /** The thread to mark done or archive (for a line: its last thread). */
  threadId: z.string(),
  /** May this member mark it done or archive it (its starter, or anyone once others may write in it). */
  canClose: z.boolean(),
  idleSince: z.string(),
  /** It leaves the Board then, as closed with no activity, unless something happens in it. */
  closesAt: z.string(),
})
export type BoardStopped = z.infer<typeof BoardStopped>

export const Board = z.object({
  cards: z.array(BoardCard),
  stopped: z.array(BoardStopped),
  /** Threads that closed with no activity in the last 7 days: neither done nor archived. */
  closed: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      projectId: z.string().nullable(),
      closedAt: z.string(),
    }),
  ),
  routines: z.array(BoardRoutine),
  /** Every list with a card or a stopped line, for the filters. */
  lists: z.array(
    z.object({
      documentId: z.string(),
      title: z.string(),
      path: z.string(),
      projectId: z.string().nullable(),
    }),
  ),
})
export type Board = z.infer<typeof Board>

/** A thread stopped without being done leaves the Board after this long without activity. */
export const STOPPED_DAYS = 7
/** The Done column shows what was done in this many days. */
export const DONE_DAYS = 7
