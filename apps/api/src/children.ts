// Child threads: a teammate starts work in a thread of its own, with a fresh
// context, and what it reports comes back to the thread it was started from
// (its parent). A parent is woken once every child it waits for has reported,
// with one short note for all of them; a schedule's run that reports to a
// thread wakes it only when it has something to say. The wake goes through a
// wake-up of kind `report`, so it waits like one for a parent that is busy,
// moving, taken over or offline. Children stay out of the sidebar: their
// parent shows them. A sub-thread may start its own, one level further
// (SUBTHREAD_DEPTH), and a tree has at most SUBTHREADS_AT_WORK at work at once
// (docs/sub-threads.md). A thread may follow another it may write in
// (follow_thread): its report wakes that thread too, the same way.
import { randomUUID } from 'node:crypto'
import {
  batchNote,
  parentMessage,
  CHILD_WAIT_MINUTES,
  childPrompt,
  ChildReport,
  clipReport,
  type PostedVerdict,
  FOLLOWERS_PER_THREAD,
  followNote,
  REPORT_AFTER_PERSON_MINUTES,
  REPORT_MAX,
  REPORT_START,
  REVIEW_LOOKS,
  type PlaybookManifest,
  type ScheduleOperation,
  singleNote,
  verdictLine,
  WAKEUPS_IN_A_ROW,
  wakesParent,
  loginOf,
  loginName,
  SUBTHREAD_DEPTH,
  SUBTHREADS_AT_WORK,
  SUBTHREADS_PROTOCOL,
  type SubthreadComputer,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { attachToThread } from './attachments.js'
import { audit, type Actor } from './audit.js'
import { prisma, scoped, Prisma, type Scope, type ScopedDb } from './db.js'
import { hubs, threadUpdated } from './hub.js'
import { markOnChiefsWord } from './chief-answers.js'
import { looksTaken, REVIEW_THREAD, reviewUnderWay } from './review-state.js'
import { askedBy, loadThread, noSuchTeammate } from './thread-spec.js'
import { fireNow, firedInARow, wakeupHold, wakeupMessageId } from './wakeups.js'
import { promptThread, startThread } from './work.js'
import { usableAccounts } from './routes/accounts.js'
import { peopleMayWrite, writableThread } from './started-threads.js'

type ChildOperation = Extract<
  ScheduleOperation,
  {
    name:
      'start_child' | 'list_children' | 'read_child' | 'cancel_child' | 'follow_thread' | 'report'
  }
>

const CHILD_OPERATIONS = new Set([
  'start_child',
  'list_children',
  'read_child',
  'cancel_child',
  'follow_thread',
  'report',
])

export const isChildOperation = (op: ScheduleOperation): op is ChildOperation =>
  CHILD_OPERATIONS.has(op.name)

type Session = {
  id: string
  title: string
  teammateId: string
  startedByMemberId: string
  accountId: string | null
  computerId: string
  projectId: string | null
  effort: string | null
  private: boolean
  othersMayPrompt: boolean
  parentId: string | null
  /** The thread at the top of its tree (null at the top, and on sub-threads from before it). */
  rootId?: string | null
  /** A playbook run's thread: its children are part of the run. */
  playbookRunId: string | null
  /** In a playbook's run: the teammate setting it works as; null, the one its runs start with. */
  playbookTeammate?: string | null
  /** Its work goes on Chief's word (src/chief-answers.ts): a child it starts goes on it too. */
  chiefWordSeq?: number | null
}

/** A report as stored, or null when there is none (or it is not one Brigade wrote). */
export const reportOf = (value: unknown): ChildReport | null =>
  value ? (ChildReport.safeParse(value).data ?? null) : null

const CHILD_SELECT = {
  id: true,
  title: true,
  status: true,
  origin: true,
  awaited: true,
  awaitUntil: true,
  report: true,
  reportDeliveredAt: true,
  reportDueAt: true,
  parentId: true,
  parentTeammateId: true,
  wakeEach: true,
  createdAt: true,
  teammate: { select: { id: true, name: true } },
  schedule: { select: { id: true, title: true } },
} as const

/** Every thread below this one: its children, theirs, and so on. */
export async function descendants(db: ScopedDb, id: string) {
  const ids: string[] = []
  for (let level = [id]; level.length;) {
    const rows = await db.session.findMany({
      where: { parentId: { in: level } },
      select: { id: true },
    })
    level = rows.map((r) => r.id)
    ids.push(...level)
  }
  return ids
}

/**
 * The verdicts of those of these threads that review a pull request, by thread: the latest
 * each posted on GitHub (github_review_pull_request), as Brigade recorded it, with the
 * commit it read; or none yet, for one whose pull request it reviews. Its report is the
 * reviewer's own words, which may say otherwise: the note that brings the report says
 * this first (verdictLine). In a transaction when given one.
 */
export async function reviewVerdicts(
  db: Pick<ScopedDb, 'pullRequest' | 'pullRequestReview'>,
  ids: string[],
): Promise<Map<string, PostedVerdict>> {
  const verdicts = new Map<string, PostedVerdict>()
  if (!ids.length) return verdicts
  const posted = await db.pullRequestReview.findMany({
    where: { sessionId: { in: ids } },
    orderBy: { createdAt: 'desc' },
    select: {
      sessionId: true,
      verdict: true,
      sha: true,
      pullRequest: { select: { number: true } },
    },
  })
  for (const r of posted)
    if (r.sessionId && !verdicts.has(r.sessionId))
      verdicts.set(r.sessionId, { number: r.pullRequest.number, verdict: r.verdict, sha: r.sha })
  const silent = ids.filter((id) => !verdicts.has(id))
  if (silent.length)
    for (const p of await db.pullRequest.findMany({
      where: { reviewSessionId: { in: silent } },
      select: { number: true, reviewSessionId: true },
    }))
      if (p.reviewSessionId)
        verdicts.set(p.reviewSessionId, { number: p.number, verdict: null, sha: null })
  return verdicts
}

/** How long a review's report that went to its child but never showed there still holds the child's. */
const UNSHOWN_HOLD_MS = 30 * 60_000

/**
 * Why a child thread does not report yet: a review of a pull request it opened is under way in a
 * child of its own (src/reviews.ts), or that review's report is still to wake it. It reports to
 * its parent once the review is done (it approved, or the child stopped it), so the end of its
 * turn meanwhile sends nothing, and `report` waits. Null when nothing holds it.
 */
export async function reviewHold(
  db: ScopedDb,
  sessionId: string,
): Promise<{ number: number; reviewer: string } | null> {
  const pulls = await db.pullRequest.findMany({
    where: { sessionId, state: 'open', reviewSession: { parentId: sessionId } },
    select: { number: true, reviewSession: { select: REVIEW_THREAD } },
  })
  if (!pulls.length) return null
  const running = pulls.find((p) => p.reviewSession && reviewUnderWay(p.reviewSession))
  if (running) return { number: running.number, reviewer: running.reviewSession!.teammate.name }
  const pull = pulls[0]!
  return (await reportUnread(db, sessionId))
    ? { number: pull.number, reviewer: pull.reviewSession!.teammate.name }
    : null
}

/**
 * A report is in for this thread, and wakes it when it can take it (queued behind the turn at
 * work, say): the turn that reads it reports, not one before. One that never showed a while after
 * it went (a person took the thread over meanwhile) holds nothing more (UNSHOWN_HOLD_MS).
 */
async function reportUnread(db: ScopedDb, sessionId: string) {
  const last = await db.wakeup.findFirst({
    where: { sessionId, kind: 'report', status: { in: ['pending', 'fired'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, firedAt: true },
  })
  return (
    !!last &&
    (last.status === 'pending' ||
      (!!last.firedAt &&
        Date.now() - last.firedAt.getTime() < UNSHOWN_HOLD_MS &&
        !(await db.sessionEvent.findFirst({
          where: {
            sessionId,
            type: 'message.user',
            data: { path: ['messageId'], equals: wakeupMessageId(last.id) },
          },
          select: { seq: true },
        }))))
  )
}

/**
 * Why a sub-thread with sub-threads of its own does not report yet (docs/sub-threads.md): one it
 * waits for is still at work, or their report is still to wake it. It reports up once it has read
 * them, from the turn their note brings (or once its wait ran out, which wakes it too), so the end
 * of a turn meanwhile sends nothing, and `report` waits. The number still at work, or 0 for a
 * note still to read; null when nothing holds it.
 */
export async function childrenHold(db: ScopedDb, sessionId: string): Promise<number | null> {
  const waiting = await db.session.count({
    where: { parentId: sessionId, origin: 'child', awaited: true, reportDeliveredAt: null },
  })
  if (waiting) return waiting
  const had = await db.session.count({ where: { parentId: sessionId, origin: 'child' } })
  return had && (await reportUnread(db, sessionId)) ? 0 : null
}

/**
 * A review started in a child thread (src/reviews.ts), which waits for it until `until`: the
 * child reports to its parent once it is done, so a report it made in this turn, or a
 * conversation's last word still to go, waits for it too, and its parent's wait outlasts the
 * review's. Its parent asking for it (request_review on a pull request its child opened) waits
 * for the child again, as message_thread does, as long: one it did not wait for (start_child
 * with wait false) too, with a wait of its own.
 */
export async function holdForReview(
  scope: Scope,
  childId: string,
  options: { until: Date; askedBy?: string },
) {
  const db = scoped(scope)
  const child = await db.session.findFirst({ where: { id: childId }, select: { parentId: true } })
  if (!child?.parentId) return
  if (options.askedBy)
    await db.session.updateMany({
      where: { id: childId },
      data: {
        report: Prisma.DbNull,
        reportDeliveredAt: null,
        reportDueAt: null,
        awaited: true,
        awaitUntil: waitUntil(undefined),
        parentTeammateId: options.askedBy,
      },
    })
  else
    await db.session.updateMany({
      where: { id: childId, reportDeliveredAt: null },
      data: { report: Prisma.DbNull, reportDueAt: null },
    })
  await outlast(db, childId, options.until)
  await parentChanged(scope, child.parentId)
}

/**
 * A child set a wake-up for `wakeAt` (src/wakeups.ts): its parent waits for it past then, as for
 * a review, to hear what the turn it brings finds.
 */
export async function outlastWakeup(scope: Scope, childId: string, wakeAt: Date) {
  const db = scoped(scope)
  await outlast(db, childId, wakeAt)
  const child = await db.session.findFirst({ where: { id: childId }, select: { parentId: true } })
  if (child?.parentId) await parentChanged(scope, child.parentId)
}

/** How long a child's parent waits for it past the review it waits for: it hears the review first. */
const OUTLAST_MS = 60 * 60_000

/**
 * A child waits for its review until `until`: its parent waits for it a while longer, while it
 * does, so that the child hears first when that review runs late. A wait already longer stays;
 * an awaited child without one gets one, so the sweep still settles it (settleOverdueChildren).
 */
async function outlast(db: ScopedDb, childId: string, until: Date) {
  const later = new Date(until.getTime() + OUTLAST_MS)
  await db.session.updateMany({
    where: {
      id: childId,
      awaited: true,
      reportDeliveredAt: null,
      // None set is waiting for ever, which nothing awaited does: it gets one.
      OR: [{ awaitUntil: null }, { awaitUntil: { lt: later } }],
    },
    data: { awaitUntil: later },
  })
}

/**
 * Dashboards showing the parent refresh its children: told with the parent's own status. A
 * child's review changed: the thread at the top, which shows that child, too.
 */
export async function parentChanged(scope: Scope, parentId: string) {
  const parent = await scoped(scope).session.findFirst({
    where: { id: parentId },
    select: { status: true, parent: { select: { id: true, status: true } } },
  })
  if (!parent) return
  const hub = hubs.get(scope.workspaceId)
  void hub.broadcast(threadUpdated(parentId, parent.status))
  if (parent.parent) void hub.broadcast(threadUpdated(parent.parent.id, parent.parent.status))
}

/**
 * The parent's wake-up with a note, stored: the teammate that started the child, else the
 * parent's own. Null when the parent is gone. In a transaction when given one.
 */
async function reportWakeup(
  db: Pick<ScopedDb, 'session' | 'wakeup'>,
  parentId: string,
  teammateId: string | null,
  note: string,
  sourceId?: string,
) {
  const parent = await db.session.findFirst({
    where: { id: parentId },
    select: { id: true, teammateId: true, teammates: { select: { teammateId: true } } },
  })
  if (!parent) return null
  const seated = parent.teammates.some((t) => t.teammateId === teammateId)
  const wakeup = await db.wakeup.create({
    data: {
      sessionId: parent.id,
      teammateId: seated && teammateId ? teammateId : parent.teammateId,
      note,
      kind: 'report',
      wakeAt: new Date(),
      ...(sourceId ? { sourceId } : {}),
    } as never,
  })
  return wakeup.id
}

/**
 * What a parent's wake-up for one child's report delivered at `deliveredAt` keeps as its
 * sourceId: auto-merge finds it by this, to hold the child's pull requests until the parent
 * read the report (src/pull-requests.ts).
 */
export const reportSource = (childId: string, deliveredAt: Date) =>
  `report:${childId}:${deliveredAt.getTime()}`

/** The report a child had when read: an update made with it applies only while it still has it. */
/**
 * A turn's end played again (settleStrandedChildren) holds only while the child is as it was read
 * then: idle, no event since. Each write it makes is conditional on that, in the same statement.
 */
export type TurnFence = { id: string; lastSeq: number }
const AT_WORK = ['starting', 'running', 'waiting'] as const
const fenced = (fence: TurnFence | undefined, id: string) =>
  fence && fence.id === id ? { lastSeq: fence.lastSeq, status: { notIn: [...AT_WORK] } } : {}

const sameReport = (report: unknown) =>
  report == null ? { equals: Prisma.DbNull } : { equals: report as Prisma.InputJsonValue }

/**
 * Bring the awaited children's reports to their parent once they all reported, or once
 * the wait ran out: one note for all of them. Settles of one parent take turns (a lock), so
 * two at once wake it once per report. Each claim (reportDeliveredAt) and each release past the
 * wait (awaited: false) applies only to the child as it was read, and the note names only those
 * it changed. A child that changed since is settled from what it is now: released, its report
 * goes on its own (deliverReport); still awaited, this settles once more.
 */
export async function settleAwaited(
  scope: Scope,
  parentId: string,
  again = true,
  fence?: TurnFence,
) {
  const db = scoped(scope)
  // One settle of a parent's children at a time: two at once (two children finishing, or a
  // report coming in as the wait runs out) would each claim part of the batch and wake the
  // parent twice. Reading, claiming and storing the wake-up hold the parent's lock together.
  const settled = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`settle:${parentId}`}, 0))`
    const waiting = await tx.session.findMany({
      where: { parentId, awaited: true, reportDeliveredAt: null },
      select: CHILD_SELECT,
      orderBy: { createdAt: 'asc' },
    })
    if (!waiting.length) return null
    const now = new Date()
    const due = waiting.some((c) => c.awaitUntil && c.awaitUntil <= now)
    const unfinished = waiting.filter((c) => !reportOf(c.report))
    if (unfinished.length && !due) return null
    const finished = waiting.filter((c) => reportOf(c.report))
    const stamp = new Date(now.getTime())
    // A report written, or a release made, since it was read here (outside this lock) leaves
    // the child to what it is now.
    const unchanged = (c: (typeof waiting)[number]) => ({
      ...fenced(fence, c.id),
      id: c.id,
      awaited: true,
      reportDeliveredAt: null,
      report: sameReport(c.report),
    })
    const delivered: typeof waiting = []
    for (const c of finished) {
      const { count } = await tx.session.updateMany({
        where: unchanged(c),
        data: { reportDeliveredAt: stamp },
      })
      if (count) delivered.push(c)
    }
    // Past the wait, the others no longer hold it back: they report later on their own.
    const released: typeof waiting = []
    for (const c of unfinished) {
      const { count } = await tx.session.updateMany({
        where: unchanged(c),
        data: { awaited: false },
      })
      if (count) released.push(c)
    }
    // A review's verdict goes ahead of its report's words.
    const verdicts = await reviewVerdicts(
      tx,
      delivered.map((c) => c.id),
    )
    const wakeupId =
      delivered.length || released.length
        ? await reportWakeup(
            tx,
            parentId,
            (delivered[0] ?? released[0])!.parentTeammateId,
            batchNote(
              delivered.map((c) => ({
                id: c.id,
                title: c.title,
                teammate: c.teammate.name,
                report: reportOf(c.report)!,
                review: verdicts.get(c.id),
              })),
              released.map((c) => ({ id: c.id, title: c.title, teammate: c.teammate.name })),
            ),
          )
        : null
    const missed = waiting.filter((c) => !delivered.includes(c) && !released.includes(c))
    return { wakeupId, changed: delivered.length + released.length > 0, missed }
  })
  if (!settled) return
  // At once, rather than at the next minute's tick; it waits like any wake-up when it cannot go yet.
  if (settled.wakeupId) await fireNow(settled.wakeupId)
  if (settled.changed) await parentChanged(scope, parentId)
  // Those changed since they were read here.
  if (!settled.missed.length) return
  const current = await db.session.findMany({
    where: { id: { in: settled.missed.map((c) => c.id) }, reportDeliveredAt: null },
    select: { id: true, awaited: true, report: true },
  })
  // Released past the wait before its report was claimed: it goes on its own, with the wake-up
  // auto-merge holds the child's pull requests by. Out of the lock: deliverReport takes its own.
  for (const c of current)
    if (!c.awaited && reportOf(c.report)) await deliverReport(scope, c.id, fence)
  // Its report came in after it was read here (or changed): settle from what it is now.
  if (again && current.some((c) => c.awaited)) await settleAwaited(scope, parentId, false, fence)
}

/**
 * A child's report is in: to its parent now, with the others it waits for, or not at all. One that
 * needs its parent (needs_parent) goes now, alone, whatever the parent waits for: the others it
 * waits for still come together, and its answer (message_thread) makes it awaited again.
 */
export async function deliverReport(scope: Scope, childId: string, fence?: TurnFence) {
  const db = scoped(scope)
  const child = await db.session.findFirst({ where: { id: childId }, select: CHILD_SELECT })
  const report = reportOf(child?.report)
  if (!child?.parentId || !report || child.reportDeliveredAt) return
  const now = report.status === 'needs_parent'
  if (child.awaited && !now) {
    await settleAwaited(scope, child.parentId, true, fence)
    // Released past the wait since it was read here, its report not claimed: it goes on its own.
    const current = await db.session.findFirst({
      where: { id: childId },
      select: { awaited: true, reportDeliveredAt: true },
    })
    if (current && !current.awaited && !current.reportDeliveredAt)
      return deliverReport(scope, childId, fence)
    return
  }
  const parentId = child.parentId
  const stamp = new Date()
  // With wake `each`, every report wakes it, nothing new included: it asked to hear each.
  const wakes = wakesParent(report.status) || child.wakeEach
  // Claimed and its parent's wake-up stored in one transaction: a report delivered that wakes its
  // parent always has its wake-up (reportSource), which is what auto-merge holds by. One without
  // was delivered before wake-ups kept it, and holds nothing (src/pull-requests.ts).
  // Only the report it read: a newer one written meanwhile (the child's next turn) is not stamped
  // with this one's wake or none; its own delivery, as that turn ends, claims it.
  const { count, wakeupId } = await db.$transaction(async (tx) => {
    const { count } = await tx.session.updateMany({
      where: {
        ...fenced(fence, child.id),
        id: child.id,
        reportDeliveredAt: null,
        report: { equals: child.report as Prisma.InputJsonValue },
      },
      data: { reportDeliveredAt: stamp },
    })
    const wakeupId =
      count && wakes
        ? await reportWakeup(
            tx,
            parentId,
            child.parentTeammateId,
            singleNote({
              id: child.id,
              title: child.title,
              teammate: child.teammate.name,
              schedule: child.schedule?.title ?? null,
              report,
              // It was waited for once (start_child, message_thread), and the wait ran out. Not
              // one that needs its parent while it still waits for it.
              late: !child.awaited && !!child.awaitUntil,
              // A review's verdict goes ahead of its report's words.
              review: (await reviewVerdicts(tx, [child.id])).get(child.id),
            }),
            reportSource(child.id, stamp),
          )
        : null
    return { count, wakeupId }
  })
  await parentChanged(scope, parentId)
  if (!count) return
  if (!wakes) {
    // No turn of the parent follows to look at the child's pull requests again: auto-merge held
    // them while the report was not in (src/pull-requests.ts), so it looks now. Imported here:
    // pull-requests.ts reaches this file through reviews.ts.
    const { autoMergeTurnEnded } = await import('./pull-requests.js')
    await autoMergeTurnEnded(scope, child.id).catch((error: unknown) =>
      console.warn(`auto-merge after ${child.id}'s report failed: ${String(error)}`),
    )
    return
  }
  // At once, rather than at the next minute's tick; it waits like any wake-up when it cannot go yet.
  if (wakeupId) await fireNow(wakeupId)
}

/**
 * A thread's report is in: each thread that follows it (follow_thread) hears it once, at once,
 * whatever its parent's wait. Claiming each one (deliveredAt) and storing its wake-up are one
 * transaction: two calls wake it once, and one that fails between them leaves the follow
 * undelivered, for the minute's sweep to retry (wakeWaitingFollowers). The thread's next turn
 * clears them (noteChildEvents), so a new report wakes them again.
 */
export async function wakeFollowers(
  scope: Scope,
  sessionId: string,
  /** A thread at the top keeps no report: what its turn ended on stands for one (noteFollowedEvents). */
  ended?: ChildReport,
  /**
   * When the turn `ended` ended: only the follows made before it, and not yet told of it (none
   * delivered, or delivered before it). A thread at the top is told by the time of its turn's end,
   * not by a flag a new message resets, which a restart could lose.
   */
  before?: Date,
) {
  const db = scoped(scope)
  const due = followsDue(before)
  const [thread, follows] = await Promise.all([
    db.session.findFirst({ where: { id: sessionId }, select: CHILD_SELECT }),
    db.threadFollow.findMany({
      where: { sessionId, ...due },
      select: { id: true, followerId: true },
      orderBy: { createdAt: 'asc' },
    }),
  ])
  const report = ended ?? reportOf(thread?.report)
  if (!thread || !report || !follows.length) return
  const note = followNote({
    id: thread.id,
    title: thread.title,
    teammate: thread.teammate.name,
    report,
  })
  const access = await db.session.findFirst({
    where: { id: sessionId },
    select: { startedByMemberId: true, othersMayPrompt: true, computerId: true },
  })
  for (const follow of follows) {
    // Its people may no longer read it (the thread was closed to others, a member left): the
    // follow is claimed, and the report goes nowhere.
    const follower = await db.session.findFirst({
      where: { id: follow.followerId },
      select: { id: true, startedByMemberId: true },
    })
    const allowed = !!follower && !!access && (await peopleMayWrite(db, follower, access))
    let wakeupId: string | null
    try {
      // The follower's own teammate; a deleted follower is claimed with no wake-up.
      wakeupId = await db.$transaction(async (tx) => {
        const { count } = await tx.threadFollow.updateMany({
          where: { id: follow.id, ...due },
          // A thread at the top's follow is marked with the end it heard, so a later end is news.
          data: { deliveredAt: before ?? new Date() },
        })
        return count && allowed ? reportWakeup(tx, follow.followerId, null, note) : null
      })
    } catch (error) {
      console.error(`follower ${follow.followerId} of ${sessionId}: could not wake`, error)
      continue
    }
    // Stored: an archived follower comes back with it, a busy one queues it, and one that
    // cannot fire now goes at the minute's tick.
    if (wakeupId) await fireNow(wakeupId)
  }
}

/**
 * The follows still to hear a report: none delivered; for a thread at the top, by the end of its
 * turn (`before`), those made before it and not delivered since it.
 */
const followsDue = (before?: Date) =>
  (before
    ? {
        createdAt: { lt: before },
        OR: [{ deliveredAt: null }, { deliveredAt: { lt: before } }],
      }
    : { deliveredAt: null }) satisfies Prisma.ThreadFollowWhereInput

/**
 * Follows a report should have woken but did not (a failure before the wake-up was stored):
 * woken now, once. Each minute, with the overdue children (settleOverdueChildren). Not while
 * the followed thread is in a turn: a report it makes there goes when the turn ends.
 */
async function wakeWaitingFollowers(workspaceId?: string) {
  const waiting = await prisma.threadFollow.findMany({
    where: {
      ...(workspaceId ? { workspaceId } : {}),
      deliveredAt: null,
      session: {
        report: { not: Prisma.DbNull },
        status: { notIn: ['starting', 'running', 'waiting'] },
      },
    },
    select: { sessionId: true, organizationId: true, workspaceId: true },
    distinct: ['sessionId'],
    take: 100,
  })
  for (const f of waiting)
    await wakeFollowers(
      { organizationId: f.organizationId, workspaceId: f.workspaceId },
      f.sessionId,
    ).catch((error: unknown) => console.error(`followers of ${f.sessionId}: could not wake`, error))
  // Threads at the top keep no report: what their last turn ended on is read again from their
  // events, for the follows made before it that it did not reach (its wake-up failed, or the API
  // restarted before it went).
  const top = await prisma.threadFollow.findMany({
    where: { ...(workspaceId ? { workspaceId } : {}), ...topFollowsDue(new Date()) },
    select: { sessionId: true, organizationId: true, workspaceId: true },
    distinct: ['sessionId'],
    take: 100,
  })
  for (const f of top) {
    const ended = await turnEnded(f.sessionId)
    if (!ended) continue
    await wakeFollowers(
      { organizationId: f.organizationId, workspaceId: f.workspaceId },
      f.sessionId,
      ended.report,
      ended.at,
    ).catch((error: unknown) => console.error(`followers of ${f.sessionId}: could not wake`, error))
  }
}

/**
 * Follows of a thread at the top still to hear its last turn (wakeWaitingFollowers): the thread at
 * rest, its turn over a while ago (its own delivery had its chance, STRANDED_AFTER_MS) and within
 * the hour (STRANDED_WITHIN_MS), as for a child's stranded turn.
 */
const topFollowsDue = (now: Date) =>
  ({
    session: {
      parentId: null,
      status: { notIn: ['starting', 'running', 'waiting'] },
      updatedAt: {
        lte: new Date(now.getTime() - STRANDED_AFTER_MS),
        gte: new Date(now.getTime() - STRANDED_WITHIN_MS),
      },
    },
  }) satisfies Prisma.ThreadFollowWhereInput

/**
 * What a thread at the top last ended a turn on, as its followers hear it (noteFollowedEvents), and
 * when; null when no turn has ended since its last message, or that turn waits on a person.
 */
async function turnEnded(sessionId: string): Promise<{ report: ChildReport; at: Date } | null> {
  const last = (types: string[]) =>
    prisma.sessionEvent.findFirst({
      where: { sessionId, type: { in: types } },
      orderBy: { seq: 'desc' },
      select: { seq: true, data: true, at: true },
    })
  const [end, asked] = await Promise.all([
    last(['turn.completed', 'error']),
    last(['message.user']),
  ])
  const data = end?.data as StoredEvent | undefined
  if (!end || !data || (asked && asked.seq > end.seq)) return null
  if (data.type === 'error' ? data.retrying === true : data.waiting) return null
  return {
    at: end.at,
    report:
      data.type === 'error'
        ? { status: 'failed', summary: 'It stopped on an error.', at: end.at.toISOString() }
        : {
            status: 'report',
            summary: clipReport(
              (await lastMessage(sessionId)) || 'It ended without a word.',
              REPORT_MAX,
            ),
            at: end.at.toISOString(),
            fromLastMessage: true,
          },
  }
}

/**
 * A thread at the top that others follow (follow_thread): it keeps no report, so the end of each
 * of its turns tells them what its last message said, once, by the time it ended (a follow is
 * marked with the end it heard: a later one is news, whatever happened between). Not a turn still waiting on a person's answer (a Codex teammate's ask), nor one
 * the runner tries again. Its followers hear it once its events are stored; one that fails to wake
 * is woken by the minute's sweep (wakeWaitingFollowers), which reads that end again from the events.
 */
export async function noteFollowedEvents(
  session: { id: string; organizationId: string; workspaceId: string; parentId: string | null },
  events: { event: { type: string; at: string; retrying?: boolean; waiting?: boolean } }[],
) {
  if (session.parentId) return
  const ends = events.filter(
    ({ event }) =>
      (event.type === 'turn.completed' && !event.waiting) ||
      (event.type === 'error' && event.retrying !== true),
  )
  if (!ends.length) return
  const scope: Scope = { organizationId: session.organizationId, workspaceId: session.workspaceId }
  const db = scoped(scope)
  if (!(await db.threadFollow.count({ where: { sessionId: session.id } }))) return
  for (const { event } of ends) {
    const report: ChildReport =
      event.type === 'error'
        ? { status: 'failed', summary: 'It stopped on an error.', at: event.at }
        : {
            status: 'report',
            summary: clipReport(
              (await lastMessage(session.id)) || 'It ended without a word.',
              REPORT_MAX,
            ),
            at: event.at,
            fromLastMessage: true,
          }
    // Told by the time its turn ended: the same end seen twice, or by the sweep, tells them once.
    await wakeFollowers(scope, session.id, report, new Date(event.at))
  }
}

/** What a child's latest answer said: its report when it ended its turn without one. */
async function lastMessage(sessionId: string) {
  const event = await prisma.sessionEvent.findFirst({
    where: { sessionId, type: 'message.done' },
    orderBy: { seq: 'desc' },
    select: { data: true },
  })
  return (event?.data as { text?: string } | undefined)?.text?.trim() ?? ''
}

/** Whether the latest message the child read is a person's, not Brigade's (its task, its parent's, a wake-up). */
async function lastFromPerson(sessionId: string) {
  const event = await prisma.sessionEvent.findFirst({
    where: { sessionId, type: 'message.user' },
    orderBy: { seq: 'desc' },
    select: { data: true },
  })
  return !!(event?.data as { memberId?: string | null } | undefined)?.memberId
}

/**
 * A conversation a person had with a child, closed: its last message goes to its parent as its
 * report, once. When the person has been quiet long enough (settleOverdueChildren) or asks for
 * it (POST /threads/:id/report). False when there is none to close: it reported, or works again.
 */
export async function reportConversation(scope: Scope, childId: string) {
  const db = scoped(scope)
  const report: ChildReport = {
    status: 'report',
    summary: clipReport((await lastMessage(childId)) || 'It ended without a word.', REPORT_MAX),
    at: new Date().toISOString(),
    fromLastMessage: true,
    afterPerson: true,
  }
  // Claimed by clearing its due time: the sweep and a person's click send it once.
  const { count } = await db.session.updateMany({
    where: {
      id: childId,
      reportDueAt: { not: null },
      reportDeliveredAt: null,
      status: { notIn: ['starting', 'running', 'waiting'] },
    },
    data: { report, reportDueAt: null },
  })
  if (!count) return false
  // Its own page no longer offers to send it.
  await parentChanged(scope, childId)
  await deliverReport(scope, childId)
  await wakeFollowers(scope, childId)
  return true
}

/**
 * A child its review held from reporting (reviewHold), once that review stopped with no word to
 * it (its pull request was closed), or its wake-up held (wakeupHold), once that one was cancelled
 * or missed: its last message goes to its parent, as at the end of its turn. Not while it works,
 * asks a person or talks with one, nor while something else still holds it: what ends that reports.
 */
export async function reportHeld(scope: Scope, childId: string) {
  const db = scoped(scope)
  const child = await db.session.findFirst({
    where: { id: childId },
    select: {
      parentId: true,
      status: true,
      report: true,
      reportDeliveredAt: true,
      reportDueAt: true,
    },
  })
  if (!child?.parentId || child.reportDeliveredAt || child.reportDueAt || reportOf(child.report))
    return
  if (
    !['idle', 'done'].includes(child.status) ||
    (await reviewHold(db, childId)) ||
    (await wakeupHold(db, childId)) ||
    (await childrenHold(db, childId)) !== null
  )
    return
  const report: ChildReport = {
    status: 'report',
    summary: clipReport((await lastMessage(childId)) || 'It ended without a word.', REPORT_MAX),
    at: new Date().toISOString(),
    fromLastMessage: true,
  }
  const { count } = await db.session.updateMany({
    where: { id: childId, reportDeliveredAt: null, report: { equals: Prisma.DbNull } },
    data: { report },
  })
  if (!count) return
  await deliverReport(scope, childId)
  await wakeFollowers(scope, childId)
}

/**
 * A child's stored events (src/hub.ts): a new message clears its report, as the
 * child works again; the end of its turn settles its report (its last message
 * stands in for one it did not make) and sends it on; an error is a failed report.
 * While a review of its pull request is under way in a child of its own (reviewHold), the end
 * of a turn sends nothing: the review's report wakes it, and that turn reports. So with a wake-up
 * of its own still to come (wakeupHold): the turn it brings reports.
 * A turn that answered a person, with no report, sends nothing yet: they may still be
 * talking it through, so its last message goes once they have been quiet a while
 * (reportConversation). An error the runner tries the turn again after (stopped for memory, a
 * passing error) ends nothing: the report waits for the try, which the child's work goes on in.
 */
export async function noteChildEvents(
  session: {
    id: string
    organizationId: string
    workspaceId: string
    parentId: string | null
    /** Chief's thread deciding a question (#724): no report, nothing wakes its parent. */
    chiefDecisionId?: string | null
  },
  events: {
    event: { type: string; at: string; message?: string; retrying?: boolean; waiting?: boolean }
  }[],
  /**
   * A turn's end played again (settleStrandedChildren): each write holds only while the child is
   * as it was read (fence), and one still held tells nobody. Its followers are left to theirs
   * (wakeWaitingFollowers).
   */
  options: { fence?: TurnFence } = {},
) {
  if (!session.parentId) return
  const scope: Scope = { organizationId: session.organizationId, workspaceId: session.workspaceId }
  const db = scoped(scope)
  const { fence } = options
  const same = fenced(fence, session.id)
  if (session.chiefDecisionId) {
    // One still at work when Chief stopped deciding each question: settled as reporting nothing.
    if (events.some(({ event }) => event.type === 'turn.completed' || event.type === 'error'))
      await db.session.updateMany({
        where: { ...same, id: session.id, reportDeliveredAt: null },
        data: {
          report: { status: 'nothing', summary: 'Decided.', at: new Date().toISOString() },
          reportDeliveredAt: new Date(),
        } as never,
      })
    return
  }
  for (const { event } of events) {
    if (event.type === 'message.user') {
      const row = await db.session.findFirst({
        where: { id: session.id },
        select: { report: true },
      })
      const report = reportOf(row?.report)
      // A report made in this very turn (its call can reach Brigade before the turn's first event) stays.
      if (report && Date.parse(report.at) < Date.parse(event.at))
        await db.session.updateMany({
          where: { ...same, id: session.id },
          data: { report: Prisma.DbNull, reportDeliveredAt: null },
        })
      // It works again: a conversation's report waits for its next quiet time.
      await db.session.updateMany({
        where: { ...same, id: session.id, reportDueAt: { not: null } },
        data: { reportDueAt: null },
      })
      // It works again: those that follow it hear its next report too.
      await db.threadFollow.updateMany({
        where: {
          sessionId: session.id,
          deliveredAt: { not: null },
          ...(fence ? { session: same } : {}),
        },
        data: { deliveredAt: null },
      })
    } else if (
      event.type === 'turn.completed' ||
      (event.type === 'error' && event.retrying !== true)
    ) {
      const row = await db.session.findFirst({
        where: { id: session.id },
        select: { report: true, reportDeliveredAt: true },
      })
      if (!row || row.reportDeliveredAt) continue
      // Its pull request's review is under way, or its report is still to wake it: it reports
      // once that is done, from the turn the review's report brings. A wake-up it set too, ahead
      // of a person's conversation: the turn it brings reports. Sub-threads of its own it waits
      // for too: the turn their note brings reports up.
      if (
        !reportOf(row.report) &&
        event.type === 'turn.completed' &&
        ((await reviewHold(db, session.id)) ||
          (await wakeupHold(db, session.id)) ||
          (await childrenHold(db, session.id)) !== null)
      ) {
        if (!fence) await parentChanged(scope, session.parentId)
        continue
      }
      if (
        !reportOf(row.report) &&
        event.type === 'turn.completed' &&
        (await lastFromPerson(session.id))
      ) {
        const { count } = await db.session.updateMany({
          where: { ...same, id: session.id, reportDeliveredAt: null },
          data: {
            reportDueAt: new Date(Date.parse(event.at) + REPORT_AFTER_PERSON_MINUTES * 60_000),
          },
        })
        if (!count && fence) continue
        // It and its parent show it as in a conversation, with a way to send it now.
        await parentChanged(scope, session.id)
        await parentChanged(scope, session.parentId)
        continue
      }
      // Over, its turn still waits on a person's answer to its ticket or question: a Codex
      // teammate's asks hold no turn (codex-asks.ts in apps/runner). It is not done: the turn
      // their answer brings reports, as a turn paused on an ask would once it went on.
      if (!reportOf(row.report) && event.type === 'turn.completed' && event.waiting) {
        if (!fence) await parentChanged(scope, session.parentId)
        continue
      }
      if (!reportOf(row.report)) {
        const report: ChildReport =
          event.type === 'error'
            ? {
                status: 'failed',
                summary: event.message ?? 'It stopped on an error.',
                at: event.at,
              }
            : {
                status: 'report',
                summary: clipReport(
                  (await lastMessage(session.id)) || 'It ended without a word.',
                  REPORT_MAX,
                ),
                at: event.at,
                fromLastMessage: true,
              }
        const { count } = await db.session.updateMany({
          where: { ...same, id: session.id, reportDeliveredAt: null },
          data: { report },
        })
        // Its next turn began since it was read: that turn's end reports.
        if (!count && fence) continue
      }
      await deliverReport(scope, session.id, fence)
      if (!fence) await wakeFollowers(scope, session.id)
    }
  }
}

/**
 * Awaited children whose wait ran out: their parents hear what is done. Each minute, for one
 * workspace or all (src/wakeups.ts).
 */
export async function settleOverdueChildren(workspaceId?: string) {
  const scope = workspaceId ? { workspaceId } : {}
  const overdue = await prisma.session.findMany({
    where: { ...scope, awaited: true, reportDeliveredAt: null, awaitUntil: { lte: new Date() } },
    select: { parentId: true, organizationId: true, workspaceId: true },
    distinct: ['parentId'],
    take: 100,
  })
  for (const c of overdue)
    if (c.parentId)
      await settleAwaited(
        { organizationId: c.organizationId, workspaceId: c.workspaceId },
        c.parentId,
      ).catch((error: unknown) =>
        console.error(`children of ${c.parentId}: could not settle`, error),
      )
  // Conversations with a person gone quiet: their last word goes to the parent.
  const quiet = await prisma.session.findMany({
    where: {
      ...scope,
      reportDueAt: { lte: new Date() },
      reportDeliveredAt: null,
      status: { notIn: ['starting', 'running', 'waiting'] },
    },
    select: { id: true, organizationId: true, workspaceId: true },
    take: 100,
  })
  for (const c of quiet)
    await reportConversation(
      { organizationId: c.organizationId, workspaceId: c.workspaceId },
      c.id,
    ).catch((error: unknown) => console.error(`child ${c.id}: could not report`, error))
  // Turns whose end never reached Brigade's report keeping (an API restart cut it short).
  await settleStrandedChildren(workspaceId)
  // And followers a report did not reach.
  await wakeWaitingFollowers(workspaceId)
}

/** A child's turn ended this long ago, and nothing changed it since: its end was settled by now. */
export const STRANDED_AFTER_MS = 2 * 60_000
/** One without a report is looked at this long after its turn ended: a hold may keep it longer. */
export const STRANDED_WITHIN_MS = 60 * 60_000

/**
 * Children whose turn ended but whose report never went on: what the end of a turn does
 * (noteChildEvents) runs once its events are stored, and is not awaited, so an API restart at that
 * moment (a deploy) drops it, and nothing else brings it. Idle a while, with no report delivered
 * nor a conversation's due: one with a report in (and no other child its parent waits for still
 * at work, which settles it); one without, whose turn ended within the hour (one a review or a
 * wake-up holds stays held: it is only looked at again).
 */
function strandedWhere(now: Date) {
  return {
    parentId: { not: null },
    reportDeliveredAt: null,
    reportDueAt: null,
    status: { notIn: ['starting', 'running', 'waiting'] },
    updatedAt: { lte: new Date(now.getTime() - STRANDED_AFTER_MS) },
    OR: [
      {
        report: { not: Prisma.DbNull },
        NOT: {
          awaited: true,
          parent: {
            children: {
              some: { awaited: true, reportDeliveredAt: null, report: { equals: Prisma.DbNull } },
            },
          },
        },
      },
      {
        report: { equals: Prisma.DbNull },
        updatedAt: { gte: new Date(now.getTime() - STRANDED_WITHIN_MS) },
      },
    ],
  } satisfies Prisma.SessionWhereInput
}

type StoredEvent = {
  type: string
  at: string
  message?: string
  retrying?: boolean
  waiting?: boolean
}

/**
 * Each stranded child's turn end, played again as it came (noteChildEvents): its last message
 * read too when its report predates it, as the one cut short may have been that message's own.
 * Each step claims what it changes, so one the first try did settle is not settled twice; and
 * only while the child is still as read here (fence: idle, at the same event), so a next turn
 * that begins meanwhile is never answered with the one before.
 */
export async function settleStrandedChildren(workspaceId?: string, now = new Date()) {
  const stranded = await prisma.session.findMany({
    where: { ...(workspaceId ? { workspaceId } : {}), ...strandedWhere(now) },
    select: {
      id: true,
      organizationId: true,
      workspaceId: true,
      parentId: true,
      chiefDecisionId: true,
      report: true,
      lastSeq: true,
    },
    take: 100,
  })
  for (const child of stranded) {
    const last = async (types: string[]) =>
      (await prisma.sessionEvent.findFirst({
        where: { sessionId: child.id, type: { in: types }, seq: { lte: child.lastSeq } },
        orderBy: { seq: 'desc' },
        select: { seq: true, data: true },
      })) ?? null
    const [ended, asked] = await Promise.all([
      last(['turn.completed', 'error']),
      last(['message.user']),
    ])
    const end = ended?.data as StoredEvent | undefined
    // No turn ended since its last message (one still to come, or tried again): nothing to settle.
    if (!ended || !end || end.retrying === true || (asked && asked.seq > ended.seq)) continue
    const report = reportOf(child.report)
    const message = asked?.data as StoredEvent | undefined
    const events = [
      ...(message && (!report || Date.parse(report.at) < Date.parse(message.at)) ? [message] : []),
      end,
    ]
    await noteChildEvents(
      child,
      events.map((event) => ({ event })),
      { fence: { id: child.id, lastSeq: child.lastSeq } },
    ).catch((error: unknown) =>
      console.error(`child ${child.id}: could not settle its turn`, error),
    )
  }
}

/** Workspaces with children or followers due to hear now (src/jobs.ts). */
export async function dueChildren(now = new Date()) {
  const busy = ['starting', 'running', 'waiting'] as const
  const [overdue, quiet, followers, stranded, top] = await Promise.all([
    prisma.session.findMany({
      where: { awaited: true, reportDeliveredAt: null, awaitUntil: { lte: now } },
      distinct: ['workspaceId'],
      select: { workspaceId: true },
    }),
    prisma.session.findMany({
      where: { reportDueAt: { lte: now }, reportDeliveredAt: null, status: { notIn: [...busy] } },
      distinct: ['workspaceId'],
      select: { workspaceId: true },
    }),
    prisma.threadFollow.findMany({
      where: {
        deliveredAt: null,
        session: { report: { not: Prisma.DbNull }, status: { notIn: [...busy] } },
      },
      distinct: ['workspaceId'],
      select: { workspaceId: true },
    }),
    prisma.session.findMany({
      where: strandedWhere(now),
      distinct: ['workspaceId'],
      select: { workspaceId: true },
    }),
    prisma.threadFollow.findMany({
      where: topFollowsDue(now),
      distinct: ['workspaceId'],
      select: { workspaceId: true },
    }),
  ])
  return [...overdue, ...quiet, ...followers, ...stranded, ...top].map((r) => r.workspaceId)
}

/** Wait this long for a child: what the teammate asked, else the default. */
const waitUntil = (minutes: number | undefined) =>
  new Date(Date.now() + (minutes ?? CHILD_WAIT_MINUTES) * 60_000)

/**
 * The files a child's report sends (its runner sent them first, POST /runner/attachments):
 * given to its parent, where its runner puts them in each teammate's working folder before
 * its next turn. Where each is there, or why they could not be.
 */
async function reportFiles(
  db: ScopedDb,
  scope: Scope,
  childId: string,
  parentId: string,
  ids: string[],
): Promise<string[] | { error: string }> {
  const sent = await db.attachment.count({
    where: { id: { in: ids }, sessionId: childId, source: 'teammate', status: 'ready' },
  })
  if (sent !== new Set(ids).size)
    return { error: 'A file of this report was not found here: call report again' }
  const { refs } = await attachToThread(db, scope, parentId, ids, null)
  return refs.map((r) => r.path)
}

/** A thread's child by id: only its own. */
async function ownChild(db: ScopedDb, parentId: string, id: string) {
  return db.session.findFirst({ where: { id, parentId }, select: CHILD_SELECT })
}

/** What a teammate is told about a child. */
const brief = (c: {
  id: string
  title: string
  status: string
  awaited: boolean
  report: unknown
  createdAt: Date
  teammate: { name: string }
  schedule: { title: string } | null
}) => {
  const report = reportOf(c.report)
  return {
    threadId: c.id,
    title: c.title,
    teammate: c.teammate.name,
    status: report ? 'finished' : c.status,
    waitingForIt: c.awaited && !report,
    ...(c.schedule ? { schedule: c.schedule.title } : {}),
    startedAt: c.createdAt.toISOString(),
    ...(report
      ? { report: { status: report.status, summary: clipReport(report.summary, REPORT_START) } }
      : {}),
  }
}

/** What a teammate is told about a thread it follows, or may: its own wait, not the parent's. */
const followedBrief = (c: Parameters<typeof brief>[0], following: boolean) => ({
  ...brief(c),
  waitingForIt: following && !reportOf(c.report),
  following,
})

/** How far back list_children looks for the children of a playbook's other runs. */
const OTHER_RUNS_DAYS = 7

/**
 * Who a child of a playbook's thread goes to, when the playbook has teammate settings: by a
 * setting's key (developer), the teammate it names, working as that key; by name, one of its
 * teammates, as a key it holds (this thread's first); unset, this thread's own teammate and key.
 * `key` null: the one its runs start with. Outside such a playbook: nothing to change.
 */
async function playbookHandoff(
  db: ScopedDb,
  session: Session,
  ref: string | undefined,
): Promise<{ teammateId?: string; key?: string | null } | { error: string }> {
  if (!session.playbookRunId) return {}
  const run = await db.playbookRun.findFirst({
    where: { id: session.playbookRunId },
    include: { installation: { select: { manifest: true, settings: true } } },
  })
  if (!run) return {}
  const manifest = run.installation.manifest as PlaybookManifest
  const settings = (run.installation.settings ?? {}) as Record<string, unknown>
  const keys = (manifest.settings ?? []).filter((s) => s.type === 'teammate').map((s) => s.key)
  if (!keys.length) return {}
  const as = (key: string) => (key === manifest.teammate ? null : key)
  const idOf = (key: string) =>
    typeof settings[key] === 'string' ? (settings[key] as string) : undefined
  if (!ref) return { key: session.playbookTeammate ?? null }
  const byKey = keys.find((k) => k === ref.toLowerCase())
  if (byKey) {
    const teammateId = idOf(byKey)
    const live =
      teammateId && (await db.teammate.findFirst({ where: { id: teammateId, archivedAt: null } }))
    if (!live)
      return {
        error:
          `${manifest.name}'s ${byKey} is not picked, or its teammate is archived: open a ticket ` +
          'so a person picks another, and say what is waiting on it.',
      }
    return { teammateId, key: as(byKey) }
  }
  const named = await db.teammate.findFirst({
    where: {
      OR: [{ id: ref }, { name: { equals: ref, mode: 'insensitive' } }],
      archivedAt: null,
    },
  })
  const held = named ? keys.filter((k) => idOf(k) === named.id) : []
  if (!named || !held.length) {
    const names = await db.teammate.findMany({
      where: { id: { in: keys.map(idOf).filter((id): id is string => !!id) } },
      select: { id: true, name: true },
    })
    return {
      error:
        `In a run of ${manifest.name}, hand work to one of its teammates, by its key: ` +
        keys
          .map((k) => `${k} (${names.find((n) => n.id === idOf(k))?.name ?? 'not picked'})`)
          .join(', '),
    }
  }
  const own = session.playbookTeammate ?? manifest.teammate!
  return { teammateId: named.id, key: as(held.includes(own) ? own : held[0]!) }
}

/** The playbook installation of a run's thread; null outside one, and in a dry run (it waits for nothing). */
async function installationOf(db: ScopedDb, playbookRunId: string | null) {
  if (!playbookRunId) return null
  const run = await db.playbookRun.findFirst({
    where: { id: playbookRunId },
    select: { installationId: true, dryRun: true },
  })
  return run && !run.dryRun ? run.installationId : null
}

/** A thread this one follows, by id: read like a child, but not its own to message. */
async function followedThread(db: ScopedDb, followerId: string, id: string) {
  return db.session.findFirst({
    where: { id, followers: { some: { followerId } } },
    select: CHILD_SELECT,
  })
}

/**
 * follow_thread: the thread is woken by another's report, as that thread's parent is: a thread it
 * may write in (message_thread's rule, writableThread), e.g. another sub-thread of its tree or a
 * builder thread it started, whose turn's end tells it then (noteFollowedEvents); or, in a
 * playbook's run, a child of another run of the same installation (three runs whose customers
 * reported the same bug wait for one fix, then each answers its own customer).
 */
async function followThread(
  db: ScopedDb,
  scope: Scope,
  session: Session,
  teammate: { id: string },
  actor: Actor,
  threadId: string,
): Promise<object | { error: string }> {
  if (threadId === session.id) return { error: 'A thread cannot follow itself.' }
  const thread = await db.session.findFirst({
    where: { id: threadId },
    select: { ...CHILD_SELECT, playbookRunId: true, parent: { select: { parentId: true } } },
  })
  if (!thread) return { error: 'No thread of this workspace has that id.' }
  if (thread.parentId === session.id)
    return { error: 'That is your own child thread: its report already comes to you.' }
  const installationId = await installationOf(db, session.playbookRunId)
  // A run's child, not a review under one (that reports to its child, which reports on).
  const otherRun =
    !!installationId &&
    !!thread.parentId &&
    !thread.parent?.parentId &&
    (await installationOf(db, thread.playbookRunId)) === installationId
  const access = await db.session.findFirst({
    where: { id: thread.id },
    select: { startedByMemberId: true, othersMayPrompt: true, computerId: true },
  })
  if (
    !otherRun &&
    (!(await writableThread(db, session, teammate, thread.id)) ||
      !access ||
      !(await peopleMayWrite(db, session, access)))
  )
    return {
      error: installationId
        ? 'You may follow a thread of your own tree, or a child thread of another run of this same playbook; list_children shows those.'
        : 'You may follow only a thread you may write in (message_thread’s rule): a thread of your own tree, one you started, or another thread at the top you are a teammate of.',
    }
  const report = reportOf(thread.report)
  const existing = await db.threadFollow.findFirst({
    where: { sessionId: thread.id, followerId: session.id },
    select: { id: true },
  })
  if (!existing) {
    const followers = await db.threadFollow.count({ where: { sessionId: thread.id } })
    if (followers >= FOLLOWERS_PER_THREAD)
      return {
        error: `That thread already has ${followers} threads following it, the most it may. Start a child thread of your own instead.`,
      }
    try {
      await db.threadFollow.create({
        data: {
          sessionId: thread.id,
          followerId: session.id,
          // Already reported: told now, below; woken only by a report after this one.
          deliveredAt: report ? new Date() : null,
        } as never,
      })
    } catch (error) {
      // Followed by another call meanwhile: one follow is enough.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'))
        throw error
    }
    await audit({
      ...scope,
      actor,
      action: 'thread.followed',
      target: { type: 'thread', id: thread.id },
      data: { followerId: session.id },
    })
    // Dashboards showing it list its followers.
    void hubs.get(scope.workspaceId).broadcast(threadUpdated(thread.id, thread.status))
  }
  return {
    following: followedBrief(thread, true),
    note: report
      ? 'It has already reported (above; read_child gives all of it): act on it now. If it reports again, you are woken here.'
      : 'Following. You are woken here once, with a short note, when it reports (read_child then gives all of it). ' +
        'Finish what you do now (e.g. tell your customer the team is on it), then end your turn: never wait or poll.',
  }
}

/** Tell a child more from its parent (message_thread): it carries on, and its parent waits for it again. */
export async function messageChild(
  db: ScopedDb,
  scope: Scope,
  parent: { id: string; title: string; chiefWordSeq?: number | null },
  teammate: { id: string; name: string },
  childId: string,
  text: string,
): Promise<{ error: string } | { ok: true; note: string }> {
  const child = await ownChild(db, parent.id, childId)
  if (!child)
    return {
      error:
        'That is not a child of this thread, nor a thread it started, nor a thread you work in. message_thread writes only in your child threads (list_children), the threads you started (start_thread) and the other threads at the top you are a teammate of.',
    }
  // A review whose pull request is merged or closed: work it is asked for now is another pull
  // request's, which Brigade would show as unreviewed, with Merge. That one gets its own review.
  // Its pull request, also once a newer review replaced this one on it.
  const reviewed = await db.pullRequest.findFirst({
    where: { OR: [{ reviewSessionId: child.id }, { reviews: { some: { sessionId: child.id } } }] },
    select: { id: true, number: true, state: true },
  })
  if (reviewed && reviewed.state !== 'open')
    return {
      error:
        `This thread reviewed #${reviewed.number}, which is ${reviewed.state}. To have its fixes in a new ` +
        'pull request reviewed, call request_review on that one, with this reviewer: Brigade then shows ' +
        'the person that it is in review.',
    }
  // Its pull request's reviews took their last look: past it, more rarely settle what is left.
  if (reviewed && (await looksTaken(db, reviewed.id)) >= REVIEW_LOOKS)
    return {
      error:
        `The reviews of #${reviewed.number} took their ${REVIEW_LOOKS} looks, the most Brigade allows. ` +
        'Tell the person where it stands: what is still open, and what you recommend. They can have ' +
        'it read again with Review again on the pull request.',
    }
  const thread = await loadThread(db, child.id)
  if (thread.controlledByMemberId)
    return { error: 'A person has control of that thread right now. Try again later.' }
  // On a member's own machine (start_child's `mine`): only on that member's word, each time.
  const machine = await machineRefusal(db, parent, thread)
  if (machine) return { error: machine }
  const until = waitUntil(undefined)
  // Set to work again: under its tree's cap, unless it is a review (which the cap leaves out).
  const reopened = await reopenInTree(
    db,
    child.id,
    {
      // One whose every report wakes its parent (wake `each`) still does, rather than wait with others.
      ...(child.wakeEach ? {} : { awaited: true, awaitUntil: until }),
      parentTeammateId: teammate.id,
      // Archived with its parent's old work, it comes back.
      archivedAt: null,
    },
    { capped: !reviewed },
  )
  if ('error' in reopened) return reopened
  // A child thread asking its review to look again: its own parent waits for it that long too.
  if (reviewed) await outlast(db, parent.id, until)
  // Work handed on Chief's word goes on it there too; a review stays the review it is.
  if (!reviewed) await markOnChiefsWord(db, child.id, { chiefWordSeq: parent.chiefWordSeq ?? null })
  let outcome: Awaited<ReturnType<typeof promptThread>>
  try {
    outcome = await promptThread(db, scope, thread, {
      text: parentMessage({ from: teammate.name, parentTitle: parent.title, text }),
      memberId: null,
      // Whoever asked for it in the parent asks in the child too.
      onBehalfOf: await askedBy(db, parent.id),
    })
  } catch (error) {
    // Nothing went: its report and its place are as they were.
    await reopened.undo()
    throw error
  }
  if (outcome === 'offline') {
    await reopened.undo()
    return { error: "That child thread's computer is offline." }
  }
  await parentChanged(scope, parent.id)
  return {
    ok: true,
    note: 'Sent. It carries on and reports again; you are woken with its report. End your turn now.',
  }
}

/**
 * A teammate's child tools, from a thread on this runner's computer (src/schedules.ts
 * hands them over). The child runs on the parent's starter's accounts, on its computer,
 * with its access: who may see or write in the parent may in the child.
 */
export async function handleChildCall(
  db: ScopedDb,
  scope: Scope,
  session: Session,
  teammate: { id: string; name: string },
  op: ChildOperation,
): Promise<object | { error: string }> {
  const actor: Actor = { type: 'teammate', id: teammate.id }

  if (op.name === 'report') {
    if (!session.parentId)
      return {
        error:
          'This thread has no parent: report is only for a child thread. Just reply to the person.',
      }
    const held = await reviewHold(db, session.id)
    if (held)
      return {
        error:
          `#${held.number} is still in review by ${held.reviewer}: do not report yet. End your turn now; ` +
          'you are woken here with its report. Report once it approves, or once you stop asking it ' +
          'to look again because it goes in circles, with its verdict.',
      }
    if (await wakeupHold(db, session.id))
      return {
        error:
          'You have a wake-up still to come in this thread: do not report yet. End your turn now, and ' +
          'report from the turn it brings; or, if you are done, cancel it (cancel_wakeup) and report.',
      }
    // A question for its parent goes at once; anything else waits for its own sub-threads.
    const below = op.status === 'needs_parent' ? null : await childrenHold(db, session.id)
    if (below !== null)
      return {
        error: below
          ? `${below === 1 ? 'A sub-thread' : `${below} sub-threads`} you wait for ${below === 1 ? 'is' : 'are'} still at work: do not report yet. End your turn now; you are woken here once they reported, and report from that turn. If you no longer need one, cancel it (cancel_child) first.`
          : 'Your sub-threads’ reports are still to reach you: end your turn now, and report from the turn they bring.',
      }
    // Its files are its parent's now: in each of its teammates' folders before its next turn.
    const files = op.files?.length
      ? await reportFiles(db, scope, session.id, session.parentId, op.files)
      : []
    if (!Array.isArray(files)) return files
    const report: ChildReport = {
      status: op.status,
      summary: op.summary,
      at: new Date().toISOString(),
      ...(files.length ? { files } : {}),
    }
    await db.session.updateMany({
      where: { id: session.id },
      data: { report, reportDeliveredAt: null, reportDueAt: null },
    })
    return {
      ok: true,
      note:
        `Noted${files.length ? `, with ${files.length === 1 ? 'its file' : `its ${files.length} files`}` : ''}: ` +
        'it reaches the parent thread when your turn ends. End your turn now with a short closing line.',
    }
  }

  if (op.name === 'list_children') {
    const children = await db.session.findMany({
      where: { parentId: session.id },
      select: CHILD_SELECT,
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    // In a playbook's run: its other runs' recent children too, which follow_thread may follow.
    const installationId = await installationOf(db, session.playbookRunId)
    if (!installationId) return { children: children.map(brief) }
    const others = await db.session.findMany({
      where: {
        id: { not: session.id },
        // A run's child, not a review under one.
        parentId: { not: null },
        parent: { parentId: null },
        NOT: { parentId: session.id },
        playbookRun: { installationId, dryRun: false },
        createdAt: { gte: new Date(Date.now() - OTHER_RUNS_DAYS * 24 * 60 * 60_000) },
      },
      select: {
        ...CHILD_SELECT,
        followers: { where: { followerId: session.id }, select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    })
    return {
      children: children.map(brief),
      fromOtherRuns: others.map((c) => followedBrief(c, c.followers.length > 0)),
    }
  }

  if (op.name === 'read_child') {
    const own = await ownChild(db, session.id, op.threadId)
    const child = own ?? (await followedThread(db, session.id, op.threadId))
    if (!child)
      return {
        error:
          'No child of this thread, nor a thread it follows, has that id; list_children shows them',
      }
    // A thread it follows: only while its people may still write there (it may have been closed
    // to them since), as on delivery.
    if (!own) {
      const access = await db.session.findFirst({
        where: { id: child.id },
        select: { startedByMemberId: true, othersMayPrompt: true, computerId: true },
      })
      if (!access || !(await peopleMayWrite(db, session, access)))
        return {
          error:
            'The people of this thread may no longer read that one: it is not shown here. Ask a person who may.',
        }
    }
    const [final, pulls, files, verdicts] = await Promise.all([
      lastMessage(child.id),
      db.pullRequest.findMany({
        where: { sessionId: child.id },
        select: { repository: true, number: true, title: true, state: true },
      }),
      // What it sent to this thread, in each of its teammates' working folders.
      db.threadAttachment.findMany({
        where: { sessionId: session.id, attachment: { sessionId: child.id } },
        select: { path: true, attachment: { select: { size: true, contentType: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      reviewVerdicts(db, [child.id]),
    ])
    const report = reportOf(child.report)
    const verdict = verdicts.get(child.id)
    return {
      ...(own ? brief(child) : followedBrief(child, true)),
      // A review's verdict, ahead of its report's words.
      ...(verdict ? { verdict: verdictLine(verdict) } : {}),
      ...(report ? { report: { status: report.status, summary: report.summary } } : {}),
      ...(files.length
        ? {
            files: files.map((f) => ({
              path: f.path,
              size: f.attachment.size,
              contentType: f.attachment.contentType,
            })),
          }
        : {}),
      // A report made of its last message is not said twice.
      ...(final && final !== report?.summary ? { lastMessage: clipReport(final, 8_000) } : {}),
      pullRequests: pulls.map((p) => ({
        ...p,
        url: `https://github.com/${p.repository}/pull/${p.number}`,
      })),
      next: own
        ? 'To tell it more, message_thread with this threadId: it carries on and reports again.'
        : 'You follow it; it is not yours to message. If it reports again, you are woken here.',
    }
  }

  if (op.name === 'follow_thread')
    return followThread(db, scope, session, teammate, actor, op.threadId)

  if (op.name === 'cancel_child') {
    const child = await ownChild(db, session.id, op.threadId)
    if (!child) return { error: 'No child of this thread has that id; list_children shows them' }
    if (reportOf(child.report)) return { error: 'It already finished: nothing to cancel.' }
    const thread = await loadThread(db, child.id)
    if (thread.status === 'running' || thread.status === 'starting' || thread.status === 'waiting')
      await hubs.get(thread.computer.workspaceId).dispatch(thread.computer, {
        type: 'thread.interrupt',
        commandId: randomUUID(),
        sessionId: thread.id,
      })
    const report: ChildReport = {
      status: 'cancelled',
      summary: `Cancelled by ${teammate.name}.`,
      at: new Date().toISOString(),
    }
    await db.session.updateMany({
      where: { id: child.id },
      data: { report, awaited: false, reportDeliveredAt: new Date() },
    })
    await audit({
      ...scope,
      actor,
      action: 'child.cancelled',
      target: { type: 'thread', id: child.id },
      data: { parentId: session.id },
    })
    // The others it waited for may all be in now.
    await settleAwaited(scope, session.id)
    await parentChanged(scope, session.id)
    // Those following it no longer wait for it either.
    await wakeFollowers(scope, child.id)
    return { cancelled: brief({ ...child, report }) }
  }

  // start_child
  const level = await levelOf(db, session)
  if (level >= SUBTHREAD_DEPTH)
    return {
      error:
        `This sub-thread is ${level} levels deep, the most Brigade allows: do the work here, or say ` +
        'in your report what else is needed.',
    }
  if ((await firedInARow(db, session.id)) >= WAKEUPS_IN_A_ROW)
    return {
      error:
        `You were woken ${WAKEUPS_IN_A_ROW} times in a row in this thread with no word from a person. ` +
        'Start no more work: tell the person where things stand, or open a ticket if you need them.',
    }
  const ref = op.teammate?.trim()
  // In a playbook's run, work goes to one of its teammates, by its setting's key (developer):
  // the child has that teammate's Apps alone.
  const handoff = await playbookHandoff(db, session, ref)
  if ('error' in handoff) return handoff
  const assignee = handoff.teammateId
    ? await db.teammate.findFirst({ where: { id: handoff.teammateId, archivedAt: null } })
    : ref
      ? ((await db.teammate.findFirst({ where: { id: ref, archivedAt: null } })) ??
        (await db.teammate.findFirst({
          where: { name: { equals: ref, mode: 'insensitive' }, archivedAt: null },
        })))
      : await db.teammate.findFirst({ where: { id: teammate.id } })
  if (!assignee) return { error: await noSuchTeammate(db, ref ?? teammate.name) }
  const parent = await loadThread(db, session.id)
  const login = loginOf(assignee.harness, assignee.model)
  // Where it runs: its parent's computer, or one chosen, refused at once with why.
  const target = await childComputer(db, scope, session, parent.computer, op.computer, login)
  if ('error' in target) return target
  // The files it is handed: its parent's runner sent them first, from this thread.
  const files = op.files?.length ? [...new Set(op.files)] : []
  if (
    files.length &&
    (await db.attachment.count({
      where: { id: { in: files }, sessionId: session.id, source: 'teammate', status: 'ready' },
    })) !== files.length
  )
    return { error: 'A file for this sub-thread was not found here: call start_child again.' }
  const each = op.wake === 'each'
  const awaited = op.wait && !each
  const rootId = session.rootId ?? (session.parentId ? await treeRoot(db, session) : session.id)
  // One start at a time in a tree, counted and started under its lock: two at once never both
  // take the last place.
  // The tree's cap is checked with the sub-thread's row, under the tree's lock, in one short
  // transaction (startThread's guard): two starts at once never both take the last place.
  let working = 0
  try {
    const { thread, outcome } = await startThread(db, scope, {
      teammate: assignee,
      computer: target.computer,
      memberId: session.startedByMemberId,
      // Its parent's account when it runs where its parent does, with the same login.
      accountId:
        target.computer.id === parent.computer.id &&
        login === loginOf(parent.teammate.harness, parent.teammate.model)
          ? session.accountId
          : null,
      title: op.title,
      text: childPrompt({
        from: teammate.name,
        parentTitle: session.title,
        instructions: op.instructions,
        inputs: {
          ...(op.repos?.length ? { repos: op.repos } : {}),
          ...(target.computer.id !== parent.computer.id ? { computer: target.computer.name } : {}),
        },
      }),
      ...(files.length ? { attachmentIds: files } : {}),
      origin: {
        kind: 'child',
        parent: { ...session, rootId },
        byTeammateId: teammate.id,
        awaited,
        ...(awaited ? { awaitUntil: waitUntil(op.timeoutMinutes) } : {}),
        ...(each ? { wakeEach: true } : {}),
        ...(handoff.key !== undefined ? { playbookTeammate: handoff.key } : {}),
      },
      projectId: session.projectId,
      effort: (parent.effort as never) ?? null,
      // Started on Chief's word: the child's work goes on it too (src/chief-answers.ts).
      chiefWord: session.chiefWordSeq != null,
      guard: {
        lock: `tree:${rootId}`,
        check: async (tx) => {
          working = await treeAtWork(tx, rootId)
          return working >= SUBTHREADS_AT_WORK ? treeFull(working) : null
        },
      },
    })
    if (outcome === 'offline')
      return {
        error: `${target.computer.id === parent.computer.id ? 'This computer' : target.computer.name} is offline; the sub-thread could not start.`,
      }
    await parentChanged(scope, session.id)
    return {
      threadId: thread.id,
      title: thread.title,
      teammate: assignee.name,
      level: level + 1,
      computer: target.computer.name,
      atWorkInTree: working + 1,
      note: each
        ? 'Started. Each of its reports wakes you here, as it comes. Go on with your work, then end your turn: do not wait or poll.'
        : op.wait
          ? 'Started. When every child you wait for has reported, you are woken here with one note for all of them. ' +
            'Start the others you need now, then end your turn: do not wait or poll.'
          : 'Started. You are woken here only if it reports something, needs you, or fails.',
    }
  } catch (error) {
    if (error instanceof HTTPException) return { error: error.message }
    throw error
  }
}

/** A reopening that took a sub-thread's place in its tree (reopenInTree), to give back. */
export type Reopened = { undo: () => Promise<void> }

/**
 * A sub-thread set to work again (a message to it, a retry): its report cleared, with `data`, under
 * its tree's lock with the tree's cap, in one transaction, so that reopening finished ones never
 * makes more than SUBTHREADS_AT_WORK at work. One failed or done is idle again, so that it counts at
 * once. Call it once everything else that could refuse the message has passed, and `undo` if the
 * message still does not go: it puts back what it was, unless it changed since. Why it may not, or
 * the place it took.
 */
export async function reopenInTree(
  db: ScopedDb,
  childId: string,
  data: Prisma.SessionUpdateManyMutationInput,
  options: { capped?: boolean } = {},
): Promise<{ error: string } | Reopened> {
  const child = await db.session.findFirst({
    where: { id: childId },
    select: {
      id: true,
      parentId: true,
      rootId: true,
      origin: true,
      report: true,
      reportDeliveredAt: true,
      reportDueAt: true,
      status: true,
      awaited: true,
      awaitUntil: true,
      _count: { select: { reviewsOf: true } },
    },
  })
  const none: Reopened = { undo: async () => {} }
  if (!child) return none
  const ended = ['failed', 'done'].includes(child.status)
  const clear = {
    ...data,
    report: Prisma.DbNull,
    reportDeliveredAt: null,
    reportDueAt: null,
    ...(ended ? { status: 'idle' as const } : {}),
  } satisfies Prisma.SessionUpdateManyMutationInput
  const undo = async () => {
    // Only while nothing came since: no new report, no turn under way.
    await db.session.updateMany({
      where: {
        id: childId,
        report: { equals: Prisma.DbNull },
        reportDeliveredAt: null,
        status: ended ? 'idle' : child.status,
      },
      data: {
        report: (child.report ?? Prisma.DbNull) as Prisma.InputJsonValue,
        reportDeliveredAt: child.reportDeliveredAt,
        reportDueAt: child.reportDueAt,
        status: child.status,
        awaited: child.awaited,
        awaitUntil: child.awaitUntil,
      },
    })
  }
  // A review is left out of the cap (treeAtWork), so never refused for it.
  if (
    options.capped === false ||
    !child.parentId ||
    child.origin !== 'child' ||
    child._count.reviewsOf > 0
  ) {
    await db.session.updateMany({ where: { id: childId }, data: clear })
    return { undo }
  }
  const rootId = await treeRoot(db, child)
  const full = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tree:${rootId}`}, 0))`
    const now = await tx.session.findFirst({
      where: { id: childId },
      select: { report: true, reportDeliveredAt: true, status: true },
    })
    const atWork =
      !!now &&
      !reportOf(now.report) &&
      !now.reportDeliveredAt &&
      !['failed', 'done'].includes(now.status)
    if (!atWork) {
      const working = await treeAtWork(tx, rootId)
      if (working >= SUBTHREADS_AT_WORK)
        return (
          `Its tree already has ${working} sub-threads at work, the most it may (${SUBTHREADS_AT_WORK}): ` +
          'it would be one more. Wait for one to report, or cancel one, then try again.'
        )
    }
    await tx.session.updateMany({ where: { id: childId }, data: clear })
    return null
  })
  return full ? { error: full } : { undo }
}

/**
 * Why `sender` may not send work to a thread on another computer that is a member's own machine:
 * only on the word of that member (the person who asked in `sender`), as for start_child's `mine`.
 * Null when it may: the same computer, or a cloud computer.
 */
export async function machineRefusal(
  db: ScopedDb,
  sender: { id: string },
  target: { computerId: string },
): Promise<string | null> {
  const from = await db.session.findFirst({
    where: { id: sender.id },
    select: { computerId: true },
  })
  if (!from || from.computerId === target.computerId) return null
  const machine = await db.computer.findFirst({
    where: { id: target.computerId },
    select: { kind: true, memberId: true },
  })
  if (machine?.kind !== 'member_machine') return null
  return (await askedBy(db, sender.id)) === machine.memberId
    ? null
    : "That thread runs on a person's own machine: only that person may send it work, from a thread they asked in. Tell the person here instead."
}

/** A thread's level in its tree: 0 at the top, 1 a sub-thread, 2 a sub-thread's (SUBTHREAD_DEPTH). */
export async function levelOf(db: ScopedDb, t: { parentId: string | null }) {
  if (!t.parentId) return 0
  const parent = await db.session.findFirst({
    where: { id: t.parentId },
    select: { parentId: true },
  })
  return parent?.parentId ? 2 : 1
}

/** The thread at the top of a sub-thread's tree (an older one has no rootId: its parent's). */
async function treeRoot(
  db: ScopedDb,
  t: { id: string; parentId: string | null; rootId?: string | null },
) {
  if (t.rootId) return t.rootId
  if (!t.parentId) return t.id
  const parent = await db.session.findFirst({
    where: { id: t.parentId },
    select: { parentId: true, rootId: true },
  })
  return parent?.rootId ?? parent?.parentId ?? t.parentId
}

/** The threads of a tree below its top, by its id: those started before rootId are its children. */
export const inTree = (rootId: string) =>
  ({ OR: [{ rootId }, { parentId: rootId }] }) satisfies Prisma.SessionWhereInput

/**
 * The sub-threads at work in a tree, at both levels: started by a teammate (start_child), no
 * report yet, not failed or done. Not a schedule's runs that report there, nor the review of a pull
 * request, which Brigade starts (one per pull request, its looks capped by REVIEW_LOOKS): the cap is
 * on the work teammates hand out, and a review is never refused for it.
 */
export async function treeAtWork(db: Pick<ScopedDb, 'session'>, rootId: string) {
  return db.session.count({
    where: {
      ...inTree(rootId),
      origin: 'child',
      reviewsOf: { none: {} },
      reportDeliveredAt: null,
      report: { equals: Prisma.DbNull },
      status: { notIn: ['failed', 'done'] },
    },
  })
}

/** Why a tree takes no more sub-threads now. */
const treeFull = (working: number) =>
  `This tree already has ${working} sub-threads at work, the most it may (${SUBTHREADS_AT_WORK}, ` +
  'over both levels). Do this part yourself, wait for their reports, or cancel one.'

/** The protocol of a computer's runner: its own now, else the last it said (0: never). */
async function protocolOf(scope: Scope, computerId: string) {
  const live = await Promise.resolve(hubs.get(scope.workspaceId).runnerProtocol(computerId)).catch(
    () => undefined,
  )
  if (live !== undefined) return live
  const row = await prisma.runner.findFirst({
    where: { computerId },
    select: { protocolVersion: true },
  })
  return row?.protocolVersion ?? 0
}

type ComputerRow = { id: string; name: string; kind: string; workspaceId: string }

/**
 * The computer a sub-thread runs on (start_child's `computer`): its parent's (same, unset); the
 * cloud computer (cloud); or a machine of the member the tree works for (mine, by name when they
 * have several), never another member's. Refused at once, with why, rather than another one: it is
 * offline, its runner is older than SUBTHREADS_PROTOCOL, or the teammate's login has no account
 * signed in there for that member.
 */
async function childComputer(
  db: ScopedDb,
  scope: Scope,
  session: Session,
  parentComputer: ComputerRow,
  choice: SubthreadComputer | undefined,
  login: Parameters<typeof loginName>[0],
): Promise<{ computer: ComputerRow } | { error: string }> {
  if (!choice || choice === 'same') return { computer: parentComputer }
  let computer: ComputerRow | null
  if (choice === 'cloud') {
    computer = await db.computer.findFirst({
      where: { kind: 'cloud', status: { in: ['running', 'stopped', 'starting'] } },
      select: { id: true, name: true, kind: true, workspaceId: true },
    })
    if (!computer)
      return {
        error:
          'This workspace has no cloud computer to run it on. Run it here (computer: same), or ask the person to set one up.',
      }
  } else {
    // Only on the word of the member it belongs to: not for another member asking in a thread
    // shared with them, nor for an outside event or a schedule's run, which nobody asked here.
    if ((await askedBy(db, session.id)) !== session.startedByMemberId)
      return {
        error:
          'Only the person whose machine it is may send work to it, from a thread they asked in: here, ' +
          'run it on this computer or the cloud computer.',
      }
    const machines = await db.computer.findMany({
      where: { kind: 'member_machine', memberId: session.startedByMemberId },
      select: { id: true, name: true, kind: true, workspaceId: true },
      orderBy: { updatedAt: 'desc' },
    })
    const name = typeof choice === 'object' ? choice.mine.toLowerCase() : null
    const named = name ? machines.filter((m) => m.name.toLowerCase() === name) : machines
    if (!machines.length)
      return {
        error:
          'The person this work is for has no machine of their own connected to Brigade. Run it here or on the cloud computer.',
      }
    if (!named.length)
      return {
        error: `None of their machines is called that. Theirs: ${machines.map((m) => `“${m.name}”`).join(', ')}.`,
      }
    if (named.length > 1)
      return {
        error: `They have several machines: say which, by name (computer: { mine: "…" }). Theirs: ${machines.map((m) => `“${m.name}”`).join(', ')}.`,
      }
    computer = named[0]!
  }
  if (computer.id === parentComputer.id) return { computer }
  // A member's machine runs only while it is on; a cloud computer starts when work comes.
  if (computer.kind === 'member_machine') {
    const presence = await Promise.resolve(hubs.get(scope.workspaceId).presence([computer.id]))
    if (!presence[computer.id]?.online)
      return {
        error: `${computer.name} is offline: the sub-thread cannot start there. Run it elsewhere, or ask the person to open Brigade on it.`,
      }
  }
  if ((await protocolOf(scope, computer.id)) < SUBTHREADS_PROTOCOL)
    return {
      error: `Brigade on ${computer.name} is too old to run a sub-thread started from another computer. It updates by itself after a quiet while; run it here meanwhile.`,
    }
  const accounts = await usableAccounts(db, {
    memberId: session.startedByMemberId,
    computerId: computer.id,
    provider: login,
  })
  if (!accounts.length)
    return {
      error: `No ${loginName(login)} account is signed in on ${computer.name} for this teammate. Run it elsewhere, or ask the person to sign in there under Accounts.`,
    }
  return { computer }
}
