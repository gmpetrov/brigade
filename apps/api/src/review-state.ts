// Where a pull request's review stands, read from its thread (src/reviews.ts): shared by the
// pull requests' lists (src/pull-requests.ts) and the Tasks board (src/tasks.ts), so Needs you
// says the same everywhere.
import type { MergeStatus } from '@brigade/contracts'
import type { Prisma } from './db.js'

/** A merge Brigade makes (Resolve conflicts), or one that stopped and waits on a person. */
const MERGE_STATES = ['stuck', 'resolving', 'merging'] as const

/**
 * A merge's status as the dashboard reads it. The column keeps the review loop's old values,
 * which only the API deployed before reviews in child threads may still write: none.
 */
export const mergeStatusOf = (status: string): MergeStatus =>
  (MERGE_STATES as readonly string[]).includes(status) ? (status as MergeStatus) : 'none'

/** For the database: a pull request with no merge under way and none stopped. */
export const NO_MERGE = { notIn: [...MERGE_STATES] as (typeof MERGE_STATES)[number][] }

/** A thread's statuses while at work, or asking a person something. */
const AT_WORK_OR_ASKING = ['starting', 'running', 'waiting'] as const

/** What a review's state reads of its thread. */
export const REVIEW_THREAD = {
  id: true,
  status: true,
  parentId: true,
  awaited: true,
  reportDeliveredAt: true,
  teammate: { select: { id: true, name: true } },
} as const

type ReviewThread = {
  parentId: string | null
  awaited: boolean
  reportDeliveredAt: Date | null
  status: string
}

/**
 * Whether a review is under way. A child thread's: its report has not reached the thread
 * that waits for it, while that thread waits or it still works (a wait past its deadline
 * does not end a review at work; the author asking again waits for it again). A review's
 * own thread: while it is at work.
 */
export function reviewUnderWay(thread: ReviewThread) {
  const working = (AT_WORK_OR_ASKING as readonly string[]).includes(thread.status)
  return thread.parentId ? !thread.reportDeliveredAt && (thread.awaited || working) : working
}

/** The same for the database, the other way round: a review's thread that is done. */
export const REVIEW_DONE = {
  OR: [
    { parentId: null, status: { notIn: [...AT_WORK_OR_ASKING] } },
    { parentId: { not: null }, reportDeliveredAt: { not: null } },
    { parentId: { not: null }, awaited: false, status: { notIn: [...AT_WORK_OR_ASKING] } },
  ],
} satisfies Prisma.SessionWhereInput

/**
 * Whether a pull request already read waits on a person, as waitingOnPerson says in the
 * database: open, with no merge under way and its review done, or a merge that stopped.
 */
export function pullWaitsOnPerson(p: {
  state: string
  mergeStatus: string
  reviewSession: ReviewThread | null
}) {
  const merge = mergeStatusOf(p.mergeStatus)
  return (
    p.state === 'open' &&
    (merge === 'stuck' ||
      (merge === 'none' && !(p.reviewSession && reviewUnderWay(p.reviewSession))))
  )
}
