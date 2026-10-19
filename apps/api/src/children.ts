// Child threads: a teammate starts work in a thread of its own, with a fresh
// context, and what it reports comes back to the thread it was started from
// (its parent). A parent is woken once every child it waits for has reported,
// with one short note for all of them; a schedule's run that reports to a
// thread wakes it only when it has something to say. The wake goes through a
// wake-up of kind `report`, so it waits like one for a parent that is busy,
// moving, taken over or offline. Children stay out of the sidebar: their
// parent shows them.
import { randomUUID } from 'node:crypto'
import {
  batchNote,
  CHILD_WAIT_MINUTES,
  CHILDREN_AT_WORK,
  childPrompt,
  ChildReport,
  clipReport,
  type ScheduleOperation,
  singleNote,
  WAKEUPS_IN_A_ROW,
  wakesParent,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit, type Actor } from './audit.js'
import { prisma, scoped, Prisma, type Scope, type ScopedDb } from './db.js'
import { broadcastThreadStatus, dispatch } from './hub.js'
import { loadThread } from './thread-spec.js'
import { fireReport, firedInARow } from './wakeups.js'
import { promptThread, startThread } from './work.js'

type ChildOperation = Extract<
  ScheduleOperation,
  { name: 'start_child' | 'list_children' | 'read_child' | 'cancel_child' | 'report' }
>

const CHILD_OPERATIONS = new Set([
  'start_child',
  'list_children',
  'read_child',
  'cancel_child',
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
async function parentChanged(scope: Scope, parentId: string) {
  const parent = await scoped(scope).session.findFirst({
    where: { id: parentId },
    select: { status: true },
  })
  if (parent) broadcastThreadStatus(scope.workspaceId, parentId, parent.status)
}

/** Wake the parent with a note: the teammate that started the child, else the parent's own. */
async function wakeParent(scope: Scope, parentId: string, teammateId: string | null, note: string) {
  const db = scoped(scope)
  const parent = await db.session.findFirst({
    where: { id: parentId },
    select: { id: true, teammateId: true, teammates: { select: { teammateId: true } } },
  })
  if (!parent) return
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
  // At once, rather than at the next minute's tick; it waits like any wake-up when it cannot go yet.
  await fireReport(wakeup.id)
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
    }),
  )
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

/**
 * A child's stored events (src/hub.ts): a new message clears its report, as the
 * child works again; the end of its turn settles its report (its last message
 * stands in for one it did not make) and sends it on; an error is a failed report.
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
    } else if (event.type === 'turn.completed' || event.type === 'error') {
      const row = await db.session.findFirst({
        where: { id: session.id },
        select: { report: true, reportDeliveredAt: true },
      })
      if (!row || row.reportDeliveredAt) continue
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
                  2_000,
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
    }
  }
}

/** Awaited children whose wait ran out: their parents hear what is done. Each minute (src/wakeups.ts). */
export async function settleOverdueChildren() {
  const overdue = await prisma.session.findMany({
    where: { awaited: true, reportDeliveredAt: null, awaitUntil: { lte: new Date() } },
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
    ...(report ? { report: { status: report.status, summary: report.summary } } : {}),
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
  const thread = await loadThread(db, child.id)
  if (thread.controlledByMemberId)
    return { error: 'A person has control of that thread right now. Try again later.' }
  await db.session.updateMany({
    where: { id: child.id },
    data: {
      report: Prisma.DbNull,
      reportDeliveredAt: null,
      awaited: true,
      awaitUntil: waitUntil(undefined),
      parentTeammateId: teammate.id,
      // Archived with its parent's old work, it comes back.
      archivedAt: null,
    },
  })
  const outcome = await promptThread(db, scope, thread, {
    text: `**${teammate.name}** wrote from the parent thread “${parent.title}”:\n\n${text}`,
    memberId: null,
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
    const report: ChildReport = {
      status: op.status,
      summary: op.summary,
      at: new Date().toISOString(),
    }
    await db.session.updateMany({
      where: { id: session.id },
      data: { report, reportDeliveredAt: null },
    })
    return {
      ok: true,
      note: 'Noted: it reaches the parent thread when your turn ends. End your turn now with a short closing line.',
    }
  }

  if (op.name === 'list_children') {
    const children = await db.session.findMany({
      where: { parentId: session.id },
      select: CHILD_SELECT,
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    return { children: children.map(brief) }
  }

  if (op.name === 'read_child') {
    const child = await ownChild(db, session.id, op.threadId)
    if (!child) return { error: 'No child of this thread has that id; list_children shows them' }
    const [final, pulls] = await Promise.all([
      lastMessage(child.id),
      db.pullRequest.findMany({
        where: { sessionId: child.id },
        select: { repository: true, number: true, title: true, state: true },
      }),
    ])
    return {
      ...brief(child),
      lastMessage: clipReport(final, 8_000),
      pullRequests: pulls.map((p) => ({
        ...p,
        url: `https://github.com/${p.repository}/pull/${p.number}`,
      })),
      next: 'To tell it more, message_thread with this threadId: it carries on and reports again.',
    }
  }

  if (op.name === 'cancel_child') {
    const child = await ownChild(db, session.id, op.threadId)
    if (!child) return { error: 'No child of this thread has that id; list_children shows them' }
    if (reportOf(child.report)) return { error: 'It already finished: nothing to cancel.' }
    const thread = await loadThread(db, child.id)
    if (thread.status === 'running' || thread.status === 'starting' || thread.status === 'waiting')
      await dispatch(thread.computer, {
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
  const assignee = ref
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
