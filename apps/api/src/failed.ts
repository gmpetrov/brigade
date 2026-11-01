// What failed and waits on a person: one rule for everything that counts what waits on someone
// (Home's Waiting on you and its count beside Home, the sidebar, the app badge, pushes, Tasks'
// Needs you, a list item's state, the Board), so they all agree.
//
// A thread that failed waits on a person: until someone writes in it or tries it again, nothing
// moves. Not a child thread (its failure goes to the teammate of the thread it reports to), nor
// one archived, nor a playbook's run nobody joined (out of the sidebar, as in GET /threads), nor
// a routine's run (its routine waits instead, below). Not while the runner may still try it again
// on its own either: after an error that passes (retriedOnItsOwn), it waits once that error is
// RETRY_GRACE_MS old, so a turn that comes back on its own a minute later never made a sound.
// It waits on whoever started it, unless they put it away for later, and only while recent:
// Home, the sidebar and pushes look back RECENT_FAILURES (failedThreadsOf). The boards, which
// every member shares, take it whoever started it (failedWaitingAmong).
//
// A routine waits on its owner when its last firing could not start (its lastError), unless the
// question ticket that firing opened is still open (schedules.ts, fire: that ticket waits
// instead), or when its latest run failed, with the same grace, unless that run's thread was
// archived or its owner put it away for later (failingRoutines).
import { RETRY_GRACE_MS, retriedOnItsOwn } from '@brigade/contracts'
import type { Prisma, ScopedDb } from './db.js'
import { latestEvents } from './latest-events.js'

const DAY = 24 * 60 * 60_000
/** How far back a failed thread waits on its starter: Home's window. */
export const RECENT_FAILURES = 14 * DAY
/** The most failed threads read for a member at once, the latest first. */
const LISTED = 100
/** The longest an error's line is kept. */
const ERROR_CHARS = 500

/** A failed thread that may wait on a person, whoever started it. */
export const FAILED_THREAD = {
  status: 'failed',
  parentId: null,
  scheduleId: null,
  archivedAt: null,
  OR: [{ playbookRunId: null, quiet: false }, { surfacedAt: { not: null } }],
} satisfies Prisma.SessionWhereInput

/** Since when a failure waits on a person, and what its error said (one line), if anything. */
export type Failure = { at: Date; error: string | null }

/** An error event's message as one line: its first, trimmed and cut short. Null when empty. */
export function errorLine(data: unknown): string | null {
  const message = (data as { message?: unknown } | null | undefined)?.message
  if (typeof message !== 'string') return null
  const line = message
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  return line ? line.slice(0, ERROR_CHARS) : null
}

/**
 * Since when a failed thread waits on a person, from its last error event: at once, unless the
 * runner tries it again on its own (a passing error), then RETRY_GRACE_MS later. A thread that
 * never ran (its computer offline) has no error event: from its last change.
 */
export function failure(
  updatedAt: Date,
  lastError: { at: Date; data: unknown } | undefined,
): Failure {
  if (!lastError) return { at: updatedAt, error: null }
  const error = errorLine(lastError.data)
  const message = (lastError.data as { message?: unknown } | null)?.message
  const passes = typeof message === 'string' && retriedOnItsOwn(message)
  return {
    at: passes ? new Date(lastError.at.getTime() + RETRY_GRACE_MS) : lastError.at,
    error,
  }
}

/** Each failed thread's failure, waiting yet or not ({@link failure}). */
async function failuresOf(db: ScopedDb, threads: { id: string; updatedAt: Date }[]) {
  const errors = await latestEvents(
    db,
    threads.map((t) => t.id),
    'error',
  )
  const byThread = new Map(errors.map((e) => [e.sessionId, e]))
  return new Map(threads.map((t) => [t.id, failure(t.updatedAt, byThread.get(t.id))]))
}

/** The earliest of these failures that does not wait yet: when to look again. */
function nextOf(failures: Iterable<Failure>, now: Date) {
  let next: Date | null = null
  for (const f of failures) if (f.at > now && (!next || f.at < next)) next = f.at
  return next
}

/**
 * Among these threads, those that failed and wait on a person, whoever started them (the
 * boards' rule: Tasks, a list's items, the Board): by thread, since when and why.
 */
export async function failedWaitingAmong(
  db: ScopedDb,
  sessionIds: string[],
  now = new Date(),
): Promise<Map<string, Failure>> {
  if (!sessionIds.length) return new Map()
  const threads = await db.session.findMany({
    where: { id: { in: sessionIds }, ...FAILED_THREAD },
    select: { id: true, updatedAt: true },
  })
  const failures = await failuresOf(db, threads)
  return new Map([...failures].filter(([, f]) => f.at <= now))
}

export type FailedThread = Failure & {
  id: string
  title: string
  teammate: { id: string; name: string }
}

/**
 * The failed threads waiting on this member: those they started, not put away for later, active
 * in the last RECENT_FAILURES; the latest first. `next`: when one that does not wait yet (a retry
 * may still come) will, if any.
 */
export async function failedThreadsOf(db: ScopedDb, memberId: string, now = new Date()) {
  const threads = await db.session.findMany({
    where: {
      ...FAILED_THREAD,
      startedByMemberId: memberId,
      laters: { none: { memberId } },
      updatedAt: { gte: new Date(now.getTime() - RECENT_FAILURES) },
    },
    orderBy: { updatedAt: 'desc' },
    take: LISTED,
    select: {
      id: true,
      title: true,
      updatedAt: true,
      teammate: { select: { id: true, name: true } },
    },
  })
  const failures = await failuresOf(db, threads)
  const waiting = threads.flatMap((t): FailedThread[] => {
    const f = failures.get(t.id)!
    return f.at <= now ? [{ id: t.id, title: t.title, teammate: t.teammate, ...f }] : []
  })
  waiting.sort((a, b) => b.at.getTime() - a.at.getTime())
  return { threads: waiting, next: nextOf(failures.values(), now) }
}

export type FailingRoutine = Failure & {
  scheduleId: string
  title: string
  ownerMemberId: string
  /** Its latest run, when it failed: where to try it again. */
  runId: string | null
  /** The thread that run reports to, when it reports to one. */
  runParentId: string | null
  /** Its last firing could not start (`error` says why); else its latest run failed. */
  couldNotStart: boolean
}

/** Each routine's failure, waiting yet or not; `where` narrows to one owner's. */
async function routineFailures(db: ScopedDb, where: { ownerMemberId?: string }) {
  const schedules = await db.schedule.findMany({
    where: {
      pausedAt: null,
      ...(where.ownerMemberId ? { ownerMemberId: where.ownerMemberId } : {}),
    },
    select: {
      id: true,
      title: true,
      ownerMemberId: true,
      lastError: true,
      updatedAt: true,
      sessions: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          id: true,
          status: true,
          parentId: true,
          archivedAt: true,
          updatedAt: true,
          laters: { select: { memberId: true } },
          parent: { select: { laters: { select: { memberId: true } } } },
        },
      },
    },
  })
  const notStarted = schedules.filter((s) => s.lastError)
  // The question ticket a firing that could not start opened: while open, it waits instead.
  const [asked, runs] = await Promise.all([
    notStarted.length
      ? db.ticket.findMany({
          where: {
            type: 'question',
            status: 'open',
            OR: notStarted.map((s) => ({ payload: { path: ['scheduleId'], equals: s.id } })),
          },
          select: { payload: true },
        })
      : [],
    failuresOf(
      db,
      schedules.flatMap((s) => {
        const run = s.sessions[0]
        const putAway = (run?.laters ?? [])
          .concat(run?.parent?.laters ?? [])
          .some((l) => l.memberId === s.ownerMemberId)
        return run?.status === 'failed' && !run.archivedAt && !putAway ? [run] : []
      }),
    ),
  ])
  const ticketed = new Set(asked.map((t) => (t.payload as { scheduleId?: string }).scheduleId))
  return schedules.flatMap((s): FailingRoutine[] => {
    const run = s.sessions[0]
    const failed = run && runs.get(run.id)
    const of = {
      scheduleId: s.id,
      title: s.title,
      ownerMemberId: s.ownerMemberId,
      runId: failed ? run.id : null,
      runParentId: failed ? run.parentId : null,
    }
    if (s.lastError)
      return ticketed.has(s.id)
        ? []
        : [{ ...of, couldNotStart: true, at: s.updatedAt, error: s.lastError }]
    return failed ? [{ ...of, couldNotStart: false, ...failed }] : []
  })
}

/**
 * Routines waiting on their owner (`where.ownerMemberId`: one member's): their last firing could
 * not start, or their latest run failed. The latest first.
 */
export async function failingRoutines(
  db: ScopedDb,
  where: { ownerMemberId?: string } = {},
  now = new Date(),
): Promise<FailingRoutine[]> {
  return (await routineFailures(db, where))
    .filter((r) => r.at <= now)
    .sort((a, b) => b.at.getTime() - a.at.getTime())
}

/**
 * What failed and waits on this member: their failed threads and routines, and when to ask again
 * (`recheckAt`): a failure the runner may still try again on its own waits from then on.
 */
export async function failuresWaitingOn(db: ScopedDb, memberId: string, now = new Date()) {
  const [threads, routines] = await Promise.all([
    failedThreadsOf(db, memberId, now),
    routineFailures(db, { ownerMemberId: memberId }),
  ])
  const next = [threads.next, nextOf(routines, now)].filter((d): d is Date => !!d)
  return {
    threads: threads.threads,
    routines: routines.filter((r) => r.at <= now).sort((a, b) => b.at.getTime() - a.at.getTime()),
    recheckAt: next.length ? new Date(Math.min(...next.map((d) => d.getTime()))) : null,
  }
}
