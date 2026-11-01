// A thread's done (docs/board.md): the work asked in it, declared delivered. A fact someone
// declares, never one read from its silence. Its teammate declares it (complete_thread), which
// Brigade refuses while anything is still open in the thread or its children; a person marks it
// done, or reopens it, from the thread's menu, whatever is open. What shows a person or new work
// is there again (their message, their mail, a ticket or a pull request opened in it) reopens
// it; the teammate's own wake-ups, a child's report, a schedule's run and Brigade's notes do not.
// A merge wakes the teammate, to declare it or say what remains.
import { parseList, plainItemText, type ScheduleOperation } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit } from './audit.js'
import { reportOf } from './children.js'
import { Prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { hubs, threadUpdated } from './hub.js'
import type { WorkspaceScope } from './scope.js'
import { fireNow, MERGE_SOURCE } from './wakeups.js'

type DoneOperation = Extract<ScheduleOperation, { name: 'complete_thread' }>

export const isDoneOperation = (op: ScheduleOperation): op is DoneOperation =>
  op.name === 'complete_thread'

const NOT_DONE = { doneAt: null, doneSummary: null, doneByType: null, doneById: null }

/** What the teammate set to be woken for: its own wake-ups, not a merge's nor a reply's. */
const OWN_WAKEUP = {
  status: 'pending',
  kind: 'wakeup',
  sourceId: null,
} satisfies Prisma.WakeupWhereInput

/**
 * Nothing open in the thread or its children, as the database says at the write itself: the
 * declaration's guard, so that what opens meanwhile is not missed. What opens just after it
 * reopens the thread (thread-archive.ts).
 */
const NOTHING_OPEN = {
  tickets: { none: { status: 'open' } },
  pullRequests: { none: { state: 'open' } },
  wakeups: { none: OWN_WAKEUP },
  children: {
    none: {
      OR: [
        { tickets: { some: { status: 'open' } } },
        { pullRequests: { some: { state: 'open' } } },
        // A child it waits for: started, not failed, and no report yet.
        {
          awaited: true,
          reportDeliveredAt: null,
          status: { notIn: ['failed', 'done'] },
          report: { equals: Prisma.DbNull },
        },
      ],
    },
  },
} satisfies Prisma.SessionWhereInput

/** Changed: the thread's views read it again. */
const changed = (scope: Scope, thread: { id: string; status: string }) =>
  void hubs.get(scope.workspaceId).broadcast(threadUpdated(thread.id, thread.status))

/**
 * What is still open in a thread, in words its teammate acts on: its tickets and questions, and
 * its children's; pull requests opened from it or its children not merged or closed; children it
 * waits for that have not reported (a review among them); wake-ups it set; a person's message
 * queued for it; list items it works on that are not ticked, unless what remains of one is a line
 * of its own. Empty when nothing is.
 */
export async function openWork(db: ScopedDb, sessionId: string): Promise<string[]> {
  const children = await db.session.findMany({
    where: { parentId: sessionId },
    select: {
      id: true,
      title: true,
      awaited: true,
      report: true,
      reportDeliveredAt: true,
      status: true,
      reviewsOf: { select: { repository: true, number: true } },
    },
    orderBy: { createdAt: 'asc' },
  })
  const ids = [sessionId, ...children.map((c) => c.id)]
  const where = (id: string | null) => {
    const child = children.find((c) => c.id === id)
    return child ? ` in the child thread “${child.title}”` : ''
  }
  const [tickets, pulls, wakeups, queued, items] = await Promise.all([
    db.ticket.findMany({
      where: { sessionId: { in: ids }, status: 'open' },
      select: { type: true, title: true, sessionId: true },
      orderBy: { createdAt: 'asc' },
      take: 20,
    }),
    db.pullRequest.findMany({
      where: { sessionId: { in: ids }, state: 'open' },
      select: { repository: true, number: true, title: true, sessionId: true },
      orderBy: { createdAt: 'asc' },
      take: 20,
    }),
    db.wakeup.findMany({
      where: { sessionId, ...OWN_WAKEUP },
      select: { id: true, note: true, wakeAt: true },
      orderBy: { wakeAt: 'asc' },
    }),
    queuedFromPeople(db, sessionId),
    untickedItems(db, sessionId),
  ])
  const open: string[] = []
  for (const t of tickets)
    open.push(
      `The ${t.type === 'question' ? 'question' : 'ticket'} “${t.title}”${where(t.sessionId)} is ` +
        'still open: it waits on a person.',
    )
  for (const p of pulls)
    open.push(
      `Pull request #${p.number} in ${p.repository} (“${p.title}”)${where(p.sessionId)} is still ` +
        'open: its work is delivered once it is merged, or closed.',
    )
  for (const c of children) {
    if (!c.awaited || c.reportDeliveredAt || ['failed', 'done'].includes(c.status)) continue
    if (reportOf(c.report)) continue
    const review = c.reviewsOf[0]
    open.push(
      review
        ? `The review of pull request #${review.number} in ${review.repository} (the child thread ` +
            `“${c.title}”) has not reported yet: you are woken when it does.`
        : `The child thread “${c.title}” has not reported yet: you are woken when it does, or ` +
            'cancel it (cancel_child) if it is no longer needed.',
    )
  }
  for (const w of wakeups)
    open.push(
      `Your wake-up at ${w.wakeAt.toISOString()} (“${w.note.slice(0, 120)}”, id ${w.id}) is still ` +
        'pending: cancel it (cancel_wakeup) if nothing remains to check.',
    )
  if (queued)
    open.push(
      `${queued === 1 ? 'A message' : `${queued} messages`} from a person ${queued === 1 ? 'waits' : 'wait'} ` +
        'for you in this thread: answer first.',
    )
  for (const i of items)
    open.push(
      `The list item “${i.text}” (id ${i.id}, in ${i.path}) is not ticked: tick it once each point ` +
        'of it is done (complete_item), or add what remains of it as a line of its own (add_item ' +
        'with remainsOf).',
    )
  return open
}

/**
 * A person's messages queued for the thread's teammate, neither read nor cancelled since: what
 * a new turn will answer. Among its latest events, which a queued message is.
 */
async function queuedFromPeople(db: ScopedDb, sessionId: string) {
  const events = await db.sessionEvent.findMany({
    where: { sessionId, type: { in: ['message.queued', 'message.user', 'message.cancelled'] } },
    orderBy: { seq: 'desc' },
    take: 100,
    select: { data: true },
  })
  const open = new Set<string>()
  for (const { data } of events.reverse()) {
    const event = data as { type?: string; messageId?: string; memberId?: string | null }
    if (!event.messageId) continue
    if (event.type === 'message.queued' && event.memberId) open.add(event.messageId)
    else open.delete(event.messageId)
  }
  return open.size
}

/**
 * The list items the thread works on that are still open in their file: not ticked, not what
 * remains of another (that is for whoever does it), and with no line of what remains of them
 * (that line carries it). A line gone from its file, or a file deleted, is no longer to tick.
 */
async function untickedItems(db: ScopedDb, sessionId: string) {
  const links = await db.listItemThread.findMany({
    where: { sessionId },
    select: {
      item: {
        select: {
          id: true,
          text: true,
          remainderOfId: true,
          documentId: true,
          document: { select: { path: true, text: true, deletedAt: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })
  const items = links.map((l) => l.item).filter((i) => !i.document.deletedAt)
  if (!items.length) return []
  const lines = new Map<string, Map<string, { done: boolean; text: string }>>()
  for (const i of items)
    if (!lines.has(i.documentId))
      lines.set(
        i.documentId,
        new Map(
          parseList(i.document.text).lines.flatMap((l) =>
            l.id ? [[l.id, { done: l.done, text: l.text }] as const] : [],
          ),
        ),
      )
  const remainders = await db.listItem.findMany({
    where: { remainderOfId: { in: items.map((i) => i.id) } },
    select: { id: true, documentId: true, remainderOfId: true },
  })
  const carried = new Set(
    remainders.flatMap((r) => (lines.get(r.documentId)?.has(r.id) ? [r.remainderOfId!] : [])),
  )
  return items.flatMap((i) => {
    const line = lines.get(i.documentId)!.get(i.id)
    if (!line || line.done || i.remainderOfId || carried.has(i.id)) return []
    return [{ id: i.id, text: plainItemText(line.text), path: i.document.path }]
  })
}

const refusal = (open: string[]) =>
  'Not done yet: something is still open in this thread. Deal with each, or say in your reply ' +
  `what remains:\n${open.map((o) => `- ${o}`).join('\n')}`

/**
 * complete_thread: the teammate declares the work asked in the thread delivered, in a line.
 * Only in a thread a person or a trigger started, at the top: a child reports, a playbook's run
 * ends with its report, a schedule's run with its turn. Refused while anything is open.
 */
export async function completeThread(
  db: ScopedDb,
  scope: Scope,
  session: {
    id: string
    status: string
    origin: string
    parentId: string | null
    playbookRunId: string | null
    updatedAt: Date
  },
  teammate: { id: string },
  op: DoneOperation,
): Promise<object | { error: string }> {
  if (session.parentId || session.origin === 'child')
    return {
      error: 'A child thread is not declared done: call `report` with what you found, once.',
    }
  if (session.playbookRunId)
    return { error: "A playbook's run ends with playbook_report, not complete_thread." }
  if (session.origin === 'schedule')
    return {
      error:
        "A schedule's run is not declared done: it ends with its turn. Finish the work and reply.",
    }
  // Where the thread's events stood before the reads: a message stored after them (a person's,
  // queued or delivered) refuses the write, so it never ends up done behind it.
  const seen = await db.sessionEvent.aggregate({
    where: { sessionId: session.id },
    _max: { seq: true },
  })
  const open = await openWork(db, session.id)
  if (open.length) return { error: refusal(open) }
  const at = new Date()
  const { count } = await db.session.updateMany({
    where: {
      id: session.id,
      ...NOTHING_OPEN,
      events: {
        none: {
          seq: { gt: seen._max.seq ?? 0 },
          type: { in: ['message.queued', 'message.user'] },
        },
      },
    },
    // Its place in the list stays where it was, as when archived.
    data: {
      doneAt: at,
      doneSummary: op.summary,
      doneByType: 'teammate',
      doneById: teammate.id,
      updatedAt: session.updatedAt,
    },
  })
  if (!count) {
    // Something opened between the reads and the write.
    const now = await openWork(db, session.id)
    return {
      error: now.length
        ? refusal(now)
        : 'Something changed in this thread meanwhile: call complete_thread again.',
    }
  }
  await audit({
    ...scope,
    actor: { type: 'teammate', id: teammate.id },
    action: 'thread.done',
    target: { type: 'thread', id: session.id },
    data: { summary: op.summary },
  })
  changed(scope, session)
  return {
    done: { summary: op.summary, at: at.toISOString() },
    next:
      'The thread is done. Say in your reply, in a line, what was delivered. A new message from a ' +
      'person reopens it.',
  }
}

/** A person marks it done (the thread's menu): whatever is open, they decide. Not a child. */
export async function markDone(
  db: ScopedDb,
  scope: WorkspaceScope,
  thread: { id: string; status: string; parentId: string | null; updatedAt: Date },
  summary: string | undefined,
) {
  if (thread.parentId)
    throw new HTTPException(409, {
      message: 'A child thread shows in its parent: mark that one done.',
    })
  await db.session.updateMany({
    where: { id: thread.id },
    data: {
      doneAt: new Date(),
      doneSummary: summary ?? null,
      doneByType: 'member',
      doneById: scope.memberId,
      updatedAt: thread.updatedAt,
    },
  })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'thread.done',
    target: { type: 'thread', id: thread.id },
    ...(summary ? { data: { summary } } : {}),
  })
  changed(scope, thread)
}

/** A person reopens it (the thread's menu). */
export async function markReopened(
  db: ScopedDb,
  scope: WorkspaceScope,
  thread: { id: string; status: string; updatedAt: Date },
) {
  const { count } = await db.session.updateMany({
    where: { id: thread.id, doneAt: { not: null } },
    data: { ...NOT_DONE, updatedAt: thread.updatedAt },
  })
  if (!count) return
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'thread.reopened',
    target: { type: 'thread', id: thread.id },
  })
  changed(scope, thread)
}

/**
 * A person or new work shows up in a thread, or in one of its children: its root is no longer
 * done. A member's message or mail in it, a ticket or a pull request opened in it. Whether it
 * was done.
 */
export async function reopenThread(scope: Scope, sessionId: string) {
  const db = scoped(scope)
  const session = await db.session.findFirst({
    where: { id: sessionId },
    select: { parentId: true },
  })
  if (!session) return false
  const root = await db.session.findFirst({
    where: { id: session.parentId ?? sessionId, doneAt: { not: null } },
    select: { id: true, status: true, updatedAt: true },
  })
  if (!root) return false
  const { count } = await db.session.updateMany({
    where: { id: root.id, doneAt: { not: null } },
    data: { ...NOT_DONE, updatedAt: root.updatedAt },
  })
  if (count) changed(scope, root)
  return count > 0
}

/** What a merge brings to the thread that opened the pull request. */
export const mergedMessage = (pull: { repository: string; number: number }) =>
  `Pull request #${pull.number} in ${pull.repository} was merged. If nothing else remains of what ` +
  'was asked here, declare this thread done with complete_thread (a line on what was delivered); ' +
  'else say in a line what remains.'

/**
 * A pull request was merged: the thread that opened it is woken, to declare it done or say what
 * remains. Only a thread at the top that a person or a trigger started, not a playbook's run;
 * not while its teammate works (it merged it itself, or hears of it in its turn), nor once done
 * or archived, nor while another of its pull requests is open. Once per pull request
 * (sourceId), however many times the merge is heard. The wake-up's id, or null.
 */
export async function wakeOnMerge(
  scope: Scope,
  pull: {
    id: string
    repository: string
    number: number
    sessionId: string | null
    authorTeammateId?: string | null
  },
) {
  if (!pull.sessionId) return null
  const db = scoped(scope)
  const thread = await db.session.findFirst({
    where: { id: pull.sessionId },
    select: {
      id: true,
      parentId: true,
      origin: true,
      playbookRunId: true,
      status: true,
      doneAt: true,
      archivedAt: true,
      teammateId: true,
      teammates: { select: { teammateId: true } },
    },
  })
  if (!thread || thread.parentId || thread.playbookRunId) return null
  if (thread.origin !== 'member' && thread.origin !== 'trigger') return null
  if (thread.doneAt || thread.archivedAt) return null
  // At work, or waiting on a person or a cap: its turn hears of it, or nothing could be declared.
  if (['starting', 'running', 'waiting', 'paused'].includes(thread.status)) return null
  const others = await db.pullRequest.count({
    where: {
      id: { not: pull.id },
      state: 'open',
      OR: [{ sessionId: thread.id }, { session: { parentId: thread.id } }],
    },
  })
  if (others) return null
  // Its author, while in the thread; else the thread's own teammate.
  const author = thread.teammates.some((t) => t.teammateId === pull.authorTeammateId)
  const teammateId = author && pull.authorTeammateId ? pull.authorTeammateId : thread.teammateId
  let id: string
  try {
    id = (
      await db.wakeup.create({
        data: {
          sessionId: thread.id,
          teammateId,
          note: mergedMessage(pull),
          kind: 'wakeup',
          wakeAt: new Date(),
          sourceId: `${MERGE_SOURCE}${pull.repository}#${pull.number}`,
        } as never,
      })
    ).id
  } catch (error) {
    // Heard already (the webhook and Brigade's own merge, or a retry): woken once.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null
    throw error
  }
  // At once, rather than at the next minute's tick; it waits like any wake-up when it cannot go.
  await fireNow(id)
  return id
}
