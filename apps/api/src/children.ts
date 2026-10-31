// Child threads: a teammate starts work in a thread of its own, with a fresh
// context, and what it reports comes back to the thread it was started from
// (its parent). A parent is woken once every child it waits for has reported,
// with one short note for all of them; a schedule's run that reports to a
// thread wakes it only when it has something to say. The wake goes through a
// wake-up of kind `report`, so it waits like one for a parent that is busy,
// moving, taken over or offline. Children stay out of the sidebar: their
// parent shows them. Another thread of the same playbook may follow a child
// (follow_thread): its report wakes that thread too, the same way.
import { randomUUID } from 'node:crypto'
import {
  batchNote,
  parentMessage,
  CHILD_WAIT_MINUTES,
  CHILDREN_AT_WORK,
  childPrompt,
  ChildReport,
  clipReport,
  FOLLOWERS_PER_THREAD,
  followNote,
  REPORT_AFTER_PERSON_MINUTES,
  REPORT_MAX,
  REPORT_START,
  REVIEW_LOOKS,
  type PlaybookManifest,
  type ScheduleOperation,
  singleNote,
  WAKEUPS_IN_A_ROW,
  wakesParent,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { attachToThread } from './attachments.js'
import { audit, type Actor } from './audit.js'
import { prisma, scoped, Prisma, type Scope, type ScopedDb } from './db.js'
import { hubs, threadUpdated } from './hub.js'
import { looksTaken } from './review-state.js'
import { askedBy, loadThread } from './thread-spec.js'
import { fireNow, firedInARow } from './wakeups.js'
import { promptThread, startThread } from './work.js'

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
  /** A playbook run's thread: its children are part of the run. */
  playbookRunId: string | null
  /** In a playbook's run: the teammate setting it works as; null, the one its runs start with. */
  playbookTeammate?: string | null
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

/** Dashboards showing the parent refresh its children: told with the parent's own status. */
export async function parentChanged(scope: Scope, parentId: string) {
  const parent = await scoped(scope).session.findFirst({
    where: { id: parentId },
    select: { status: true },
  })
  if (parent) void hubs.get(scope.workspaceId).broadcast(threadUpdated(parentId, parent.status))
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
    } as never,
  })
  return wakeup.id
}

/** Wake the parent with a note: the teammate that started the child, else the parent's own. */
async function wakeParent(scope: Scope, parentId: string, teammateId: string | null, note: string) {
  const id = await reportWakeup(scoped(scope), parentId, teammateId, note)
  // At once, rather than at the next minute's tick; it waits like any wake-up when it cannot go yet.
  if (id) await fireNow(id)
}

/**
 * Bring the awaited children's reports to their parent once they all reported, or once
 * the wait ran out: one note for all of them. Claiming them (reportDeliveredAt) is one
 * update, so two children finishing at once wake the parent once.
 */
export async function settleAwaited(scope: Scope, parentId: string) {
  const db = scoped(scope)
  const waiting = await db.session.findMany({
    where: { parentId, awaited: true, reportDeliveredAt: null },
    select: CHILD_SELECT,
    orderBy: { createdAt: 'asc' },
  })
  if (!waiting.length) return
  const now = new Date()
  const due = waiting.some((c) => c.awaitUntil && c.awaitUntil <= now)
  const unfinished = waiting.filter((c) => !reportOf(c.report))
  if (unfinished.length && !due) return
  const finishedIds = waiting.filter((c) => reportOf(c.report)).map((c) => c.id)
  const stamp = new Date(now.getTime())
  const claimed = finishedIds.length
    ? await db.session.updateMany({
        where: { id: { in: finishedIds }, reportDeliveredAt: null },
        data: { reportDeliveredAt: stamp },
      })
    : { count: 0 }
  // Past the wait, the others no longer hold it back: they report later on their own.
  if (unfinished.length)
    await db.session.updateMany({
      where: { id: { in: unfinished.map((c) => c.id) }, reportDeliveredAt: null },
      data: { awaited: false },
    })
  if (!claimed.count && !unfinished.length) return
  const mine = claimed.count
    ? waiting.filter((c) => finishedIds.includes(c.id))
    : ([] as typeof waiting)
  // Another call claimed some of them meanwhile: only those this one set.
  const delivered =
    claimed.count === finishedIds.length
      ? mine
      : (
          await db.session.findMany({
            where: { id: { in: finishedIds }, reportDeliveredAt: stamp },
            select: { id: true },
          })
        ).map((r) => mine.find((c) => c.id === r.id)!)
  if (!delivered.length && !unfinished.length) return
  const note = batchNote(
    delivered.map((c) => ({
      id: c.id,
      title: c.title,
      teammate: c.teammate.name,
      report: reportOf(c.report)!,
    })),
    unfinished.map((c) => ({ id: c.id, title: c.title, teammate: c.teammate.name })),
  )
  const teammateId = (delivered[0] ?? unfinished[0])!.parentTeammateId
  await wakeParent(scope, parentId, teammateId, note)
  await parentChanged(scope, parentId)
}

/** A child's report is in: to its parent now, with the others it waits for, or not at all. */
export async function deliverReport(scope: Scope, childId: string) {
  const db = scoped(scope)
  const child = await db.session.findFirst({ where: { id: childId }, select: CHILD_SELECT })
  const report = reportOf(child?.report)
  if (!child?.parentId || !report || child.reportDeliveredAt) return
  if (child.awaited) return settleAwaited(scope, child.parentId)
  const { count } = await db.session.updateMany({
    where: { id: child.id, reportDeliveredAt: null },
    data: { reportDeliveredAt: new Date() },
  })
  await parentChanged(scope, child.parentId)
  if (!count || !wakesParent(report.status)) return
  await wakeParent(
    scope,
    child.parentId,
    child.parentTeammateId,
    singleNote({
      id: child.id,
      title: child.title,
      teammate: child.teammate.name,
      schedule: child.schedule?.title ?? null,
      report,
      // It was waited for once (start_child, message_thread), and the wait ran out.
      late: !!child.awaitUntil,
    }),
  )
}

/**
 * A thread's report is in: each thread that follows it (follow_thread) hears it once, at once,
 * whatever its parent's wait. Claiming each one (deliveredAt) and storing its wake-up are one
 * transaction: two calls wake it once, and one that fails between them leaves the follow
 * undelivered, for the minute's sweep to retry (wakeWaitingFollowers). The thread's next turn
 * clears them (noteChildEvents), so a new report wakes them again.
 */
export async function wakeFollowers(scope: Scope, sessionId: string) {
  const db = scoped(scope)
  const [thread, follows] = await Promise.all([
    db.session.findFirst({ where: { id: sessionId }, select: CHILD_SELECT }),
    db.threadFollow.findMany({
      where: { sessionId, deliveredAt: null },
      select: { id: true, followerId: true },
      orderBy: { createdAt: 'asc' },
    }),
  ])
  const report = reportOf(thread?.report)
  if (!thread || !report || !follows.length) return
  const note = followNote({
    id: thread.id,
    title: thread.title,
    teammate: thread.teammate.name,
    report,
  })
  for (const follow of follows) {
    let wakeupId: string | null
    try {
      // The follower's own teammate; a deleted follower is claimed with no wake-up.
      wakeupId = await db.$transaction(async (tx) => {
        const { count } = await tx.threadFollow.updateMany({
          where: { id: follow.id, deliveredAt: null },
          data: { deliveredAt: new Date() },
        })
        return count ? reportWakeup(tx, follow.followerId, null, note) : null
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
 * A child's stored events (src/hub.ts): a new message clears its report, as the
 * child works again; the end of its turn settles its report (its last message
 * stands in for one it did not make) and sends it on; an error is a failed report.
 * A turn that answered a person, with no report, sends nothing yet: they may still be
 * talking it through, so its last message goes once they have been quiet a while
 * (reportConversation).
 */
export async function noteChildEvents(
  session: { id: string; organizationId: string; workspaceId: string; parentId: string | null },
  events: { event: { type: string; at: string; message?: string } }[],
) {
  if (!session.parentId) return
  const scope: Scope = { organizationId: session.organizationId, workspaceId: session.workspaceId }
  const db = scoped(scope)
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
          where: { id: session.id },
          data: { report: Prisma.DbNull, reportDeliveredAt: null },
        })
      // It works again: a conversation's report waits for its next quiet time.
      await db.session.updateMany({
        where: { id: session.id, reportDueAt: { not: null } },
        data: { reportDueAt: null },
      })
      // It works again: those that follow it hear its next report too.
      await db.threadFollow.updateMany({
        where: { sessionId: session.id, deliveredAt: { not: null } },
        data: { deliveredAt: null },
      })
    } else if (event.type === 'turn.completed' || event.type === 'error') {
      const row = await db.session.findFirst({
        where: { id: session.id },
        select: { report: true, reportDeliveredAt: true },
      })
      if (!row || row.reportDeliveredAt) continue
      if (
        !reportOf(row.report) &&
        event.type === 'turn.completed' &&
        (await lastFromPerson(session.id))
      ) {
        await db.session.updateMany({
          where: { id: session.id, reportDeliveredAt: null },
          data: {
            reportDueAt: new Date(Date.parse(event.at) + REPORT_AFTER_PERSON_MINUTES * 60_000),
          },
        })
        // It and its parent show it as in a conversation, with a way to send it now.
        await parentChanged(scope, session.id)
        await parentChanged(scope, session.parentId)
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
        await db.session.updateMany({
          where: { id: session.id, reportDeliveredAt: null },
          data: { report },
        })
      }
      await deliverReport(scope, session.id)
      await wakeFollowers(scope, session.id)
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
  // And followers a report did not reach.
  await wakeWaitingFollowers(workspaceId)
}

/** Workspaces with children or followers due to hear now (src/jobs.ts). */
export async function dueChildren(now = new Date()) {
  const busy = ['starting', 'running', 'waiting'] as const
  const [overdue, quiet, followers] = await Promise.all([
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
  ])
  return [...overdue, ...quiet, ...followers].map((r) => r.workspaceId)
}

/** The children a thread has at work: started, and no report yet. */
async function atWork(db: ScopedDb, parentId: string) {
  const children = await db.session.findMany({
    where: { parentId, reportDeliveredAt: null, status: { notIn: ['failed', 'done'] } },
    select: { report: true },
  })
  return children.filter((c) => !reportOf(c.report)).length
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
 * follow_thread: the thread is woken by another's report, as that thread's parent is. Only a
 * child thread (it ends with a report) of a run of the same playbook installation: three runs
 * whose customers reported the same bug wait for one fix, then each answers its own customer.
 */
async function followThread(
  db: ScopedDb,
  scope: Scope,
  session: Session,
  actor: Actor,
  threadId: string,
): Promise<object | { error: string }> {
  if (threadId === session.id) return { error: 'A thread cannot follow itself.' }
  const thread = await db.session.findFirst({
    where: { id: threadId },
    select: { ...CHILD_SELECT, playbookRunId: true },
  })
  if (!thread) return { error: 'No thread of this workspace has that id.' }
  if (thread.parentId === session.id)
    return { error: 'That is your own child thread: its report already comes to you.' }
  if (!thread.parentId)
    return {
      error:
        'Only a child thread can be followed: it is the kind that ends with a report. list_children shows those of your playbook’s other runs.',
    }
  const installationId = await installationOf(db, session.playbookRunId)
  if (!installationId)
    return {
      error:
        'follow_thread is for a playbook’s run, to wait for a child of another run of the same playbook. Here, start a child thread of your own.',
    }
  if ((await installationOf(db, thread.playbookRunId)) !== installationId)
    return {
      error:
        'You may follow only a child thread of another run of this same playbook; list_children shows them.',
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
  parent: { id: string; title: string },
  teammate: { id: string; name: string },
  childId: string,
  text: string,
): Promise<{ error: string } | { ok: true; note: string }> {
  const child = await ownChild(db, parent.id, childId)
  if (!child)
    return {
      error:
        'That is not a child of this thread. message_thread writes only in your child threads (list_children) or a started task’s thread (taskId).',
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
  await db.session.updateMany({
    where: { id: child.id },
    data: {
      report: Prisma.DbNull,
      reportDeliveredAt: null,
      reportDueAt: null,
      awaited: true,
      awaitUntil: waitUntil(undefined),
      parentTeammateId: teammate.id,
      // Archived with its parent's old work, it comes back.
      archivedAt: null,
    },
  })
  const outcome = await promptThread(db, scope, thread, {
    text: parentMessage({ from: teammate.name, parentTitle: parent.title, text }),
    memberId: null,
    // Whoever asked for it in the parent asks in the child too.
    onBehalfOf: await askedBy(db, parent.id),
  })
  if (outcome === 'offline') return { error: "That child thread's computer is offline." }
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
        parentId: { not: null },
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
    const [final, pulls, files] = await Promise.all([
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
    ])
    const report = reportOf(child.report)
    return {
      ...(own ? brief(child) : followedBrief(child, true)),
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

  if (op.name === 'follow_thread') return followThread(db, scope, session, actor, op.threadId)

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
  if (session.parentId)
    return {
      error:
        'This is a child thread: it cannot start children of its own. Do the work here, or say in your report what else is needed.',
    }
  if ((await firedInARow(db, session.id)) >= WAKEUPS_IN_A_ROW)
    return {
      error:
        `You were woken ${WAKEUPS_IN_A_ROW} times in a row in this thread with no word from a person. ` +
        'Start no more work: tell the person where things stand, or open a ticket if you need them.',
    }
  const working = await atWork(db, session.id)
  if (working >= CHILDREN_AT_WORK)
    return {
      error: `This thread already has ${working} child threads at work, the most it may. Wait for their reports, or cancel one.`,
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
  if (!assignee) return { error: `No teammate is called "${ref}"; list_tasks lists them` }
  const parent = await loadThread(db, session.id)
  try {
    const { thread, outcome } = await startThread(db, scope, {
      teammate: assignee,
      computer: parent.computer,
      memberId: session.startedByMemberId,
      accountId: assignee.harness === parent.teammate.harness ? session.accountId : null,
      title: op.title,
      text: childPrompt({
        from: teammate.name,
        parentTitle: session.title,
        instructions: op.instructions,
      }),
      origin: {
        kind: 'child',
        parent: session,
        byTeammateId: teammate.id,
        awaited: op.wait,
        ...(op.wait ? { awaitUntil: waitUntil(op.timeoutMinutes) } : {}),
        ...(handoff.key !== undefined ? { playbookTeammate: handoff.key } : {}),
      },
      projectId: session.projectId,
      effort: (parent.effort as never) ?? null,
    })
    if (outcome === 'offline')
      return { error: 'This computer is offline; the child could not start.' }
    await parentChanged(scope, session.id)
    return {
      threadId: thread.id,
      title: thread.title,
      teammate: assignee.name,
      note: op.wait
        ? 'Started. When every child you wait for has reported, you are woken here with one note for all of them. ' +
          'Start the others you need now, then end your turn: do not wait or poll.'
        : 'Started. You are woken here only if it reports something or fails.',
    }
  } catch (error) {
    if (error instanceof HTTPException) return { error: error.message }
    throw error
  }
}
