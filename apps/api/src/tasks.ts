// Tasks: work to see finished, on the Tasks board. A task has at most one
// thread, which is its comments and progress; its column comes from that
// thread. Assigning a teammate starts the thread: until then the task waits in
// Backlog with nobody on it. Members act here; teammates through their task
// tools, which never assign a person nor move a task to Needs you (a ticket does).
import { randomUUID } from 'node:crypto'
import {
  formatMention,
  type ApiToRunner,
  type RunnerToApi,
  type TaskColumn,
  type TaskDeliverable,
  type TaskPriority,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit, type Actor } from './audit.js'
import { scoped, type Prisma, type Scope, type ScopedDb } from './db.js'
import { broadcastTask, dispatch, isOnline } from './hub.js'
import { projectWhere, usableProject } from './projects.js'
import { usableAccounts } from './routes/accounts.js'
import type { WorkspaceScope } from './scope.js'
import { actingTeammate, currentTeammate, loadThread, requireMayPrompt } from './thread-spec.js'
import { joinThread, promptThread, startThread } from './work.js'

/** What the board shows of a task and its thread. */
const BOARD = {
  teammate: { select: { id: true, name: true, harness: true } },
  project: { select: { id: true, name: true, icon: true } },
  createdBy: { select: { id: true, user: { select: { name: true } } } },
  session: {
    select: {
      id: true,
      status: true,
      updatedAt: true,
      computerId: true,
      startedByMemberId: true,
      _count: { select: { tickets: { where: { status: 'open' as const } } } },
      pullRequests: {
        select: { repository: true, number: true, state: true },
        orderBy: { createdAt: 'asc' as const },
      },
    },
  },
}

type BoardRow = Awaited<ReturnType<typeof boardRows>>[number]

const boardRows = (
  db: ScopedDb,
  where: Prisma.TaskWhereInput = {},
  orderBy: Prisma.TaskOrderByWithRelationInput[] = [{ updatedAt: 'desc' }],
  take = 500,
) => db.task.findMany({ where, include: BOARD, orderBy, take })

/** A thread status while its teammate is at work. */
const ACTIVE = ['starting', 'running']

/**
 * No thread: backlog. An open ticket, a waiting thread, or an open pull request the
 * teammate opened and stopped at (for review and merge): needs you. Its merge
 * marks the task done (see settleOnMerge).
 */
export function columnOf(task: {
  completedAt: Date | null
  session: {
    status: string
    _count: { tickets: number }
    pullRequests: { state: string }[]
  } | null
}): TaskColumn {
  if (task.completedAt) return 'done'
  if (!task.session) return 'backlog'
  if (task.session._count.tickets > 0 || task.session.status === 'waiting') return 'needs_you'
  // Only an open one waits on a person: once merged or closed, a reopened task is Doing.
  if (
    task.session.pullRequests.some((p) => p.state === 'open') &&
    !ACTIVE.includes(task.session.status)
  )
    return 'needs_you'
  return 'doing'
}

const view = ({ session, ...task }: BoardRow) => ({
  ...task,
  column: columnOf({ completedAt: task.completedAt, session }),
  thread: session
    ? {
        id: session.id,
        status: session.status,
        updatedAt: session.updatedAt,
        computerId: session.computerId,
        startedByMemberId: session.startedByMemberId,
        openTickets: session._count.tickets,
        openPullRequests: session.pullRequests
          .filter((p) => p.state === 'open')
          .map(({ repository, number }) => ({ repository, number })),
      }
    : null,
})

/**
 * The board: every task not archived nor in the Trash, most recently touched
 * first. `project`: a project's id, or "none".
 */
export async function listTasks(db: ScopedDb, project?: string) {
  return (await boardRows(db, { archivedAt: null, trashedAt: null, ...projectWhere(project) })).map(
    view,
  )
}

/** The Trash, most recently trashed first. */
export async function listTrashedTasks(db: ScopedDb) {
  return (
    await boardRows(db, { trashedAt: { not: null } }, [{ trashedAt: 'desc' }, { id: 'desc' }])
  ).map(view)
}

/** Archived tasks shown at a time. */
const ARCHIVE_PAGE = 100

/**
 * The done tasks put away, most recently archived first, a page at a time:
 * next is the cursor for the page after this one, null on the last.
 */
export async function listArchivedTasks(db: ScopedDb, before?: string) {
  const after = before ? parseCursor(before) : null
  const rows = await boardRows(
    db,
    {
      archivedAt: { not: null },
      trashedAt: null,
      ...(after && {
        OR: [
          { archivedAt: { lt: after.archivedAt } },
          { archivedAt: after.archivedAt, id: { lt: after.id } },
        ],
      }),
    },
    [{ archivedAt: 'desc' }, { id: 'desc' }],
    ARCHIVE_PAGE + 1,
  )
  const page = rows.slice(0, ARCHIVE_PAGE)
  const last = page.at(-1)
  return {
    tasks: page.map(view),
    next:
      rows.length > ARCHIVE_PAGE && last ? `${last.archivedAt!.toISOString()}_${last.id}` : null,
  }
}

function parseCursor(cursor: string) {
  const at = cursor.indexOf('_')
  const archivedAt = new Date(cursor.slice(0, at))
  const id = cursor.slice(at + 1)
  if (at < 0 || !id || Number.isNaN(archivedAt.getTime()))
    throw new HTTPException(400, { message: 'Invalid cursor' })
  return { archivedAt, id }
}

/** One task, with the pull requests its thread opened. */
export async function getTask(db: ScopedDb, id: string) {
  const [row] = await boardRows(db, { id })
  if (!row) throw new HTTPException(404, { message: 'Task not found' })
  const pullRequests = row.session
    ? await db.pullRequest.findMany({
        where: { sessionId: row.session.id },
        select: {
          id: true,
          repository: true,
          number: true,
          title: true,
          state: true,
          headRef: true,
        },
        orderBy: { createdAt: 'asc' },
      })
    : []
  return { ...view(row), pullRequests }
}

async function loadTask(db: ScopedDb, id: string) {
  const task = await db.task.findFirst({ where: { id }, include: { teammate: true } })
  if (!task) throw new HTTPException(404, { message: 'Task not found' })
  return task
}

async function activeTeammate(db: ScopedDb, id: string) {
  const teammate = await db.teammate.findFirst({ where: { id, archivedAt: null } })
  if (!teammate) throw new HTTPException(404, { message: 'Teammate not found or archived' })
  return teammate
}

async function changed(
  scope: Scope,
  actor: Actor,
  action: string,
  taskId: string,
  data?: Record<string, string | null>,
) {
  await audit({
    ...scope,
    actor,
    action,
    target: { type: 'task', id: taskId },
    ...(data ? { data } : {}),
  })
  broadcastTask(scope.workspaceId, taskId)
}

const member = (scope: WorkspaceScope): Actor => ({ type: 'member', id: scope.memberId })

/**
 * Who acts on a task: a member, or a teammate on behalf of its thread's
 * starter, whose accounts any thread it starts runs on.
 */
export type By = { scope: Scope; memberId: string; actor: Actor }

export const byMember = (scope: WorkspaceScope): By => ({
  scope,
  memberId: scope.memberId,
  actor: member(scope),
})

/** What a message to a thread is from: the member, or nobody typing (a teammate's). */
const typedBy = (by: By) => (by.actor.type === 'member' ? by.memberId : null)

/** Who may change a task's thread: whoever may prompt it. Without one: anyone. */
async function requireMayAct(db: ScopedDb, by: By, taskId: string) {
  const thread = await db.session.findFirst({ where: { taskId } })
  if (thread && thread.startedByMemberId !== by.memberId && !thread.othersMayPrompt)
    throw new HTTPException(403, {
      message: "This task's thread runs on another member's subscription.",
    })
  return thread
}

/** A task in the Trash only comes back by being restored. */
function requireNotTrashed(task: { trashedAt: Date | null }) {
  if (task.trashedAt) throw new HTTPException(409, { message: 'Restore it from the Trash first' })
}

/**
 * A thread becomes a task's thread, unless a trigger started it or it already
 * is one. Returns false when another request linked it first.
 */
async function link(db: ScopedDb, sessionId: string, taskId: string) {
  const { count } = await db.session.updateMany({
    where: { id: sessionId, taskId: null, origin: 'member' },
    data: { taskId },
  })
  return count === 1
}

export async function createTask(
  db: ScopedDb,
  scope: WorkspaceScope,
  input: {
    title: string
    description: string
    priority: TaskPriority
    teammateId?: string | undefined
    sessionId?: string | undefined
    projectId?: string | null | undefined
  },
) {
  const by = byMember(scope)
  const projectId = await usableProject(db, input.projectId)
  if (!input.sessionId) {
    const task = await db.task.create({
      data: {
        title: input.title,
        description: input.description,
        priority: input.priority,
        createdByMemberId: scope.memberId,
        projectId: projectId ?? null,
      } as never,
    })
    await changed(scope, by.actor, 'task.created', task.id, { sessionId: null })
    if (!input.teammateId) return getTask(db, task.id)
    // Its thread starts now; if it cannot, the task stays in Backlog and says why.
    try {
      return await assignTask(db, by, task.id, { teammateId: input.teammateId, reason: '' })
    } catch (error) {
      if (!(error instanceof HTTPException)) throw error
      return { ...(await getTask(db, task.id)), startError: error.message }
    }
  }

  const thread = await loadThread(db, input.sessionId)
  requireMayPrompt(scope, { ...thread, controlledByMemberId: null })
  if (thread.origin === 'trigger')
    throw new HTTPException(400, { message: 'A thread a trigger started cannot become a task' })
  if (thread.taskId) throw new HTTPException(409, { message: 'This thread is already a task' })
  const teammateId = input.teammateId ?? currentTeammate(thread).id
  await activeTeammate(db, teammateId)
  // The thread's project unless another is given; the thread then moves with it.
  const inProject = projectId === undefined ? thread.projectId : projectId
  const task = await db.task.create({
    data: {
      title: input.title,
      description: input.description,
      priority: input.priority,
      teammateId,
      createdByMemberId: scope.memberId,
      projectId: inProject,
    } as never,
  })
  if (!(await link(db, thread.id, task.id))) {
    await db.task.deleteMany({ where: { id: task.id } })
    throw new HTTPException(409, { message: 'This thread is already a task' })
  }
  if (inProject !== thread.projectId)
    await db.session.updateMany({ where: { id: thread.id }, data: { projectId: inProject } })
  await changed(scope, by.actor, 'task.created', task.id, { sessionId: thread.id })
  return getTask(db, task.id)
}

export async function updateTask(
  db: ScopedDb,
  by: By,
  id: string,
  input: {
    title?: string | undefined
    description?: string | undefined
    priority?: TaskPriority | undefined
    projectId?: string | null | undefined
  },
) {
  await loadTask(db, id)
  const projectId = await usableProject(db, input.projectId)
  await db.task.updateMany({
    where: { id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
    },
  })
  // Its thread follows, so its next turn has the project's context.
  if (projectId !== undefined) {
    const thread = await db.session.findFirst({
      where: { taskId: id },
      select: { id: true, updatedAt: true },
    })
    if (thread)
      await db.session.updateMany({
        where: { id: thread.id },
        data: { projectId, updatedAt: thread.updatedAt },
      })
  }
  await changed(by.scope, by.actor, 'task.updated', id)
  return getTask(db, id)
}

/** The first message of a task's thread: its brief. */
const brief = (task: { title: string; description: string }) =>
  [`**${task.title}**`, task.description].filter(Boolean).join('\n\n')

/**
 * Where a member's task runs: the workspace computer, else one of their own
 * machines that is online; the first where they have an account with usage
 * left for the teammate's harness.
 */
async function computerFor(db: ScopedDb, memberId: string, harness: 'claude_code' | 'codex') {
  const candidates = [
    ...(await db.computer.findMany({
      where: { kind: 'cloud', status: { in: ['running', 'stopped', 'starting'] } },
    })),
    ...(
      await db.computer.findMany({
        where: { kind: 'member_machine', memberId },
        orderBy: { updatedAt: 'desc' },
      })
    ).filter((c) => isOnline(c.id)),
  ]
  // One with usage left first; else one whose accounts are out of usage, which a
  // new turn tries again (the plan may have been upgraded since).
  let fallback: (typeof candidates)[number] | undefined
  for (const computer of candidates) {
    const accounts = await usableAccounts(db, {
      memberId,
      computerId: computer.id,
      provider: harness,
    })
    if (accounts.some((a) => !a.exhaustedUntil || a.exhaustedUntil <= new Date())) return computer
    if (accounts.length) fallback ??= computer
  }
  if (fallback) return fallback
  const name = harness === 'codex' ? 'Codex' : 'Claude'
  throw new HTTPException(409, {
    message: candidates.length
      ? `No ${name} account of yours is ready on the computers it could run on. Add or sign in to one under Accounts.`
      : 'No computer is online to run it. Start your runner, or set up the cloud computer.',
  })
}

/**
 * A backlog task gets its teammate and its thread, with the brief as the
 * first message. Taking the teammate is the claim: two assigns never start
 * two threads. If the thread cannot start, the task goes back to Backlog.
 */
async function startTask(
  db: ScopedDb,
  by: By,
  task: { id: string; title: string; description: string; projectId: string | null },
  teammate: { id: string; name: string; harness: 'claude_code' | 'codex' },
  computer?: { id: string; kind: string },
) {
  const { count } = await db.task.updateMany({
    where: { id: task.id, session: { is: null } },
    data: { teammateId: teammate.id, completedAt: null, archivedAt: null },
  })
  if (!count) throw new HTTPException(409, { message: 'This task has already started' })
  try {
    const { thread, outcome } = await startThread(db, by.scope, {
      teammate,
      computer: computer ?? (await computerFor(db, by.memberId, teammate.harness)),
      memberId: by.memberId,
      title: task.title,
      text: brief(task),
      taskId: task.id,
      projectId: task.projectId,
    })
    if (outcome === 'offline') {
      // The failed thread is left as a plain one.
      await db.session.updateMany({ where: { id: thread.id }, data: { taskId: null } })
      throw new HTTPException(409, {
        message: 'That computer is offline. Start its runner and try again.',
      })
    }
    return { threadId: thread.id, outcome }
  } catch (error) {
    await db.task.updateMany({
      where: { id: task.id, teammateId: teammate.id, session: { is: null } },
      data: { teammateId: null },
    })
    throw error
  }
}

/**
 * What the new teammate is told: the brief, why, and where the work so far
 * is. Teammates do not share working folders, so only what was pushed,
 * attached or saved carries over.
 */
async function handover(
  db: ScopedDb,
  task: { title: string; description: string; summary: string | null; deliverables: unknown },
  thread: { id: string },
  from: { name: string },
  to: { id: string; name: string },
  reason: string,
) {
  const pulls = await db.pullRequest.findMany({
    where: { sessionId: thread.id },
    select: { repository: true, number: true, title: true, headRef: true, state: true },
    orderBy: { createdAt: 'asc' },
  })
  const delivered = (task.deliverables as TaskDeliverable[]) ?? []
  const work = [
    ...pulls.map(
      (p) =>
        `- Pull request ${p.repository}#${p.number} (${p.state}): ${p.title}, branch \`${p.headRef}\`, https://github.com/${p.repository}/pull/${p.number}`,
    ),
    ...delivered.map((d) => `- ${d.label}: ${d.url}`),
    ...(task.summary ? [`- ${from.name}'s summary: ${task.summary}`] : []),
  ]
  return [
    `${formatMention({ kind: 'teammate', id: to.id, label: to.name })} this task is yours now, taking over from ${from.name}.`,
    `**Task:** ${task.title}${task.description ? `\n\n${task.description}` : ''}`,
    `**Why it was reassigned:** ${reason || 'No reason given.'}`,
    `**Work so far:**\n${work.length ? work.join('\n') : '- Nothing pushed or attached yet; see the conversation above.'}`,
    `${from.name}'s working folder is not yours: build on what is pushed, attached or in the library. ` +
      'Review what was done, then carry on. Call complete_task when it is finished.',
  ].join('\n\n')
}

/**
 * A teammate takes the task. In Backlog, its thread starts (on `computer`, or
 * where computerFor says). With a thread, the teammate joins it and is told
 * the brief, the reason and the work so far; a running turn stops first and a
 * done task reopens.
 */
export async function assignTask(
  db: ScopedDb,
  by: By,
  id: string,
  input: { teammateId: string; reason: string },
  computer?: { id: string; kind: string },
) {
  const task = await loadTask(db, id)
  requireNotTrashed(task)
  if (task.teammateId === input.teammateId)
    throw new HTTPException(400, { message: `${task.teammate?.name} already has this task` })
  const teammate = await activeTeammate(db, input.teammateId)
  const session = await db.session.findFirst({ where: { taskId: id } })

  if (!session) {
    const { threadId, outcome } = await startTask(db, by, task, teammate, computer)
    await changed(by.scope, by.actor, 'task.assigned', id, {
      to: teammate.id,
      sessionId: threadId,
    })
    return { ...(await getTask(db, id)), paused: outcome === 'paused' }
  }

  const thread = await loadThread(db, session.id)
  await requireMayAct(db, by, id)
  if (thread.controlledByMemberId)
    throw new HTTPException(409, {
      message: 'A person has control of this thread. It continues when they hand it back.',
    })
  if (thread.status === 'waiting')
    throw new HTTPException(409, { message: 'Answer the open ticket on its thread first' })
  const [account] = await usableAccounts(db, {
    memberId: thread.startedByMemberId,
    computerId: thread.computerId,
    provider: teammate.harness,
  })
  if (!account)
    throw new HTTPException(409, {
      message: `${teammate.name} runs on ${teammate.harness === 'codex' ? 'Codex' : 'Claude'}, and the thread's starter has no account for it with usage left on its computer.`,
    })
  if (thread.status === 'running' || thread.status === 'starting') await interrupt(thread)
  await joinThread(db, thread.id, [teammate.id])
  const from = task.teammate ?? { name: 'the previous teammate' }
  const text = await handover(db, task, thread, from, teammate, input.reason)
  const outcome = await promptThread(db, by.scope, await loadThread(db, thread.id), {
    text,
    memberId: typedBy(by),
    teammateIds: [teammate.id],
  })
  if (outcome === 'offline')
    throw new HTTPException(409, {
      message: "The thread's computer is offline. Start its runner and try again.",
    })

  await db.task.updateMany({
    where: { id },
    data: { teammateId: teammate.id, completedAt: null, archivedAt: null },
  })
  await changed(by.scope, by.actor, 'task.reassigned', id, {
    from: task.teammateId,
    to: teammate.id,
    reason: input.reason || null,
  })
  return getTask(db, id)
}

/** Stop a thread's running turn. */
const interrupt = (thread: { id: string; computer: { id: string; kind: string } }) =>
  dispatch(thread.computer, {
    type: 'thread.interrupt',
    commandId: randomUUID(),
    sessionId: thread.id,
  } satisfies ApiToRunner)

export async function completeTask(
  db: ScopedDb,
  by: By,
  id: string,
  input: { summary?: string | undefined; deliverables?: TaskDeliverable[] },
) {
  const task = await loadTask(db, id)
  requireNotTrashed(task)
  await requireMayAct(db, by, id)
  await db.task.updateMany({
    where: { id },
    data: {
      completedAt: new Date(),
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.deliverables ? { deliverables: input.deliverables } : {}),
    },
  })
  await changed(by.scope, by.actor, 'task.completed', id)
  return getTask(db, id)
}

/** A done task back on the board: Doing, or Backlog without a thread. */
export async function reopenTask(db: ScopedDb, by: By, id: string) {
  const task = await loadTask(db, id)
  requireNotTrashed(task)
  await requireMayAct(db, by, id)
  await db.task.updateMany({ where: { id }, data: { completedAt: null, archivedAt: null } })
  await changed(by.scope, by.actor, 'task.reopened', id)
  return getTask(db, id)
}

/** A message to a done task's thread puts it back in Doing, archived or not. */
export async function reopenOnMessage(
  scope: Scope,
  thread: { task: { id: string; completedAt: Date | null } | null },
) {
  if (!thread.task?.completedAt) return
  await scoped(scope).task.updateMany({
    where: { id: thread.task.id },
    data: { completedAt: null, archivedAt: null },
  })
  broadcastTask(scope.workspaceId, thread.task.id)
}

/**
 * A done task goes off the board. Its thread stays as it is. The write checks
 * the task is still done: a reopen racing it wins and the task stays put.
 */
export async function archiveTask(db: ScopedDb, by: By, id: string) {
  const task = await loadTask(db, id)
  requireNotTrashed(task)
  if (!task.completedAt)
    throw new HTTPException(409, { message: 'Only a done task can be archived' })
  const { count } = await db.task.updateMany({
    where: { id, completedAt: { not: null }, archivedAt: null },
    data: { archivedAt: new Date() },
  })
  if (count) await changed(by.scope, by.actor, 'task.archived', id)
  return getTask(db, id)
}

/** An archived task back in Done. */
export async function unarchiveTask(db: ScopedDb, by: By, id: string) {
  await loadTask(db, id)
  const { count } = await db.task.updateMany({
    where: { id, archivedAt: { not: null } },
    data: { archivedAt: null },
  })
  if (count) await changed(by.scope, by.actor, 'task.unarchived', id)
  return getTask(db, id)
}

/**
 * Into the Trash, from any column: off the board, its running turn stopped.
 * Its thread stays. Restoring puts it back where its thread says.
 */
export async function trashTask(db: ScopedDb, by: By, id: string) {
  await loadTask(db, id)
  const session = await requireMayAct(db, by, id)
  const { count } = await db.task.updateMany({
    where: { id, trashedAt: null },
    data: { trashedAt: new Date() },
  })
  if (!count) return getTask(db, id)
  if (session && (session.status === 'running' || session.status === 'starting')) {
    const computer = await db.computer.findFirst({ where: { id: session.computerId } })
    if (computer) await interrupt({ id: session.id, computer })
  }
  await changed(by.scope, by.actor, 'task.trashed', id)
  return getTask(db, id)
}

export async function restoreTask(db: ScopedDb, by: By, id: string) {
  await loadTask(db, id)
  const { count } = await db.task.updateMany({
    where: { id, trashedAt: { not: null } },
    data: { trashedAt: null },
  })
  if (count) await changed(by.scope, by.actor, 'task.restored', id)
  return getTask(db, id)
}

/** Clear the Done column: every done task goes off the board at once. */
export async function archiveDoneTasks(db: ScopedDb, scope: WorkspaceScope) {
  const done = await db.task.findMany({
    where: { completedAt: { not: null }, archivedAt: null, trashedAt: null },
    select: { id: true },
  })
  if (!done.length) return { archived: 0 }
  const ids = done.map((t) => t.id)
  const { count } = await db.task.updateMany({
    where: { id: { in: ids }, completedAt: { not: null }, archivedAt: null },
    data: { archivedAt: new Date() },
  })
  await audit({
    ...scope,
    actor: member(scope),
    action: 'task.archived',
    target: { type: 'workspace', id: scope.workspaceId },
    data: { taskIds: ids },
  })
  broadcastTask(scope.workspaceId, ids[0]!)
  return { archived: count }
}

/**
 * A pull request of a task's thread merged or closed. Once none is open and
 * one merged, the work has landed: the task is done.
 */
export async function settleOnMerge(scope: Scope, sessionId: string) {
  const db = scoped(scope)
  const thread = await db.session.findFirst({
    where: { id: sessionId },
    select: { task: true, pullRequests: { select: { state: true } } },
  })
  const task = thread?.task
  if (!task || task.completedAt) return
  const states = thread.pullRequests.map((p) => p.state)
  if (states.includes('open') || !states.includes('merged')) return
  const { count } = await db.task.updateMany({
    where: { id: task.id, completedAt: null },
    data: { completedAt: new Date() },
  })
  if (count) await changed(scope, { type: 'system', id: 'brigade' }, 'task.completed', task.id)
}

/**
 * The task goes for good; its thread stays, as a plain thread. Also undoes a
 * teammate's create_task ("Not a task").
 */
export async function deleteTask(db: ScopedDb, scope: WorkspaceScope, id: string) {
  const task = await loadTask(db, id)
  const thread = await db.session.findFirst({ where: { taskId: id } })
  const isAdmin = scope.role === 'owner' || scope.role === 'admin'
  if (
    !isAdmin &&
    task.createdByMemberId !== scope.memberId &&
    thread?.startedByMemberId !== scope.memberId
  )
    throw new HTTPException(403, { message: 'Only whoever asked for it or an admin can delete it' })
  await db.task.deleteMany({ where: { id } })
  await changed(scope, member(scope), 'task.deleted', id, { title: task.title })
}

type Runner = { computerId: string; organizationId: string; workspaceId: string }

/** A task's line for a teammate's list_tasks. */
const listed = (task: ReturnType<typeof view>) => ({
  id: task.id,
  title: task.title,
  column: task.column,
  priority: task.priority,
  teammate: task.teammate && { id: task.teammate.id, name: task.teammate.name },
  description:
    task.description.length > 300 ? `${task.description.slice(0, 300)}…` : task.description,
})

/** A teammate's task tool call, from its thread on this runner's computer. */
export async function handleTaskCall(
  runner: Runner,
  call: Extract<RunnerToApi, { type: 'task.call' }>,
  reply: (message: ApiToRunner) => void,
) {
  const scope: Scope = { organizationId: runner.organizationId, workspaceId: runner.workspaceId }
  const db = scoped(scope)
  const done = (output: unknown) =>
    reply({ type: 'connector.result', callId: call.callId, ok: true, output })
  const fail = (error: string) =>
    reply({ type: 'connector.result', callId: call.callId, ok: false, error })

  const session = await db.session.findFirst({
    where: { id: call.sessionId, computerId: runner.computerId },
    include: { task: true, computer: true },
  })
  if (!session) return fail('Unknown thread')
  const teammate = await actingTeammate(db, session, call.teammateId)
  if (!teammate) return fail('That teammate is not in this thread')
  // It acts for whoever started its thread: any thread it starts runs on their accounts.
  const by: By = {
    scope,
    memberId: session.startedByMemberId,
    actor: { type: 'teammate', id: teammate.id },
  }
  const op = call.operation

  /** A teammate by id or name, so "Ada" works as well as its id. */
  const findTeammate = async (ref: string) =>
    (await db.teammate.findFirst({ where: { id: ref, archivedAt: null } })) ??
    (await db.teammate.findFirst({
      where: { name: { equals: ref.trim(), mode: 'insensitive' }, archivedAt: null },
    }))

  try {
    if (op.name === 'list') {
      const [tasks, teammates] = await Promise.all([
        listTasks(db),
        db.teammate.findMany({
          where: { archivedAt: null },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
      ])
      return done({
        thisThreadTask: session.task?.id ?? null,
        tasks: tasks.map(listed),
        teammates: teammates.map((t) => ({ ...t, you: t.id === teammate.id })),
      })
    }

    if (op.name === 'create') {
      if (op.assignee === 'self') {
        if (session.origin === 'trigger')
          return fail('A thread a trigger started cannot become a task. Just do the work here.')
        if (session.task)
          return fail(
            `This thread is already the task "${session.task.title}". Carry on with it, or create a separate task with assignee "none" or another teammate.`,
          )
        const task = await db.task.create({
          data: {
            title: op.title,
            description: op.description,
            priority: op.priority,
            teammateId: teammate.id,
            createdByMemberId: session.startedByMemberId,
            projectId: session.projectId,
          } as never,
        })
        if (!(await link(db, session.id, task.id))) {
          await db.task.deleteMany({ where: { id: task.id } })
          return fail('This thread is already a task. Carry on with it.')
        }
        await changed(scope, by.actor, 'task.created', task.id, { sessionId: session.id })
        return done({
          taskId: task.id,
          title: task.title,
          note: 'This thread is now a task on the Tasks board. Tell the person in one line, then do the work. Call complete_task when it is finished.',
        })
      }

      const assignee = op.assignee === 'none' ? null : await findTeammate(op.assignee)
      if (op.assignee !== 'none' && !assignee)
        return fail('No teammate has that id or name; list_tasks shows them')
      const task = await db.task.create({
        data: {
          title: op.title,
          description: op.description,
          priority: op.priority,
          createdByMemberId: session.startedByMemberId,
          projectId: session.projectId,
        } as never,
      })
      await changed(scope, by.actor, 'task.created', task.id, { sessionId: null })
      if (!assignee)
        return done({ taskId: task.id, column: 'backlog', note: 'In Backlog, assigned to nobody.' })
      try {
        await assignTask(db, by, task.id, { teammateId: assignee.id, reason: '' }, session.computer)
        return done({
          taskId: task.id,
          column: 'doing',
          note: `${assignee.name} started on it in its own thread.`,
        })
      } catch (error) {
        if (!(error instanceof HTTPException)) throw error
        return done({
          taskId: task.id,
          column: 'backlog',
          note: `Created, but ${assignee.name} could not start, so it waits in Backlog: ${error.message}`,
        })
      }
    }

    if (op.name === 'complete' && !op.taskId) {
      if (!session.task)
        return fail(
          'This thread is not a task. Pass the taskId of the task to complete, or just reply.',
        )
      if (session.task.teammateId !== teammate.id)
        return fail('This task was reassigned to another teammate; only they can complete it.')
    }
    const taskId = (op.name === 'complete' ? op.taskId : op.taskId) ?? session.task!.id
    const task = await db.task.findFirst({ where: { id: taskId } })
    if (!task) return fail('No task has that id; list_tasks shows them')

    switch (op.name) {
      case 'complete':
        await completeTask(db, by, taskId, {
          summary: op.summary,
          deliverables: op.deliverables,
        })
        return done({
          ok: true,
          note: 'The task is marked done. Tell the person what you delivered.',
        })

      case 'update': {
        const { name: _, taskId: __, ...changes } = op
        await updateTask(db, by, taskId, changes)
        return done({ ok: true })
      }

      case 'assign': {
        const to = await findTeammate(op.teammateId)
        if (!to) return fail('No teammate has that id or name; list_tasks shows them')
        await assignTask(db, by, taskId, { teammateId: to.id, reason: op.reason }, session.computer)
        return done({ ok: true, note: `${to.name} has the task now and is working on it.` })
      }

      case 'move':
        if (op.to === 'trash') await trashTask(db, by, taskId)
        else if (op.to === 'archived') await archiveTask(db, by, taskId)
        else {
          if (task.trashedAt) await restoreTask(db, by, taskId)
          if (task.completedAt) await reopenTask(db, by, taskId)
          else if (task.archivedAt) await unarchiveTask(db, by, taskId)
          const moved = await getTask(db, taskId)
          if (moved.column === 'backlog')
            return fail('It is in Backlog: assign it to a teammate with assign_task to start it.')
          return done({ ok: true, column: moved.column })
        }
        return done({ ok: true })

      case 'comment': {
        if (task.trashedAt) return fail('That task is in the Trash')
        const thread = await db.session.findFirst({ where: { taskId } })
        if (!thread)
          return fail(
            'That task is in Backlog with no thread yet. Assign it, or update its description.',
          )
        if (thread.id === session.id) return fail('That is this thread: just reply here.')
        const target = await loadThread(db, thread.id)
        await requireMayAct(db, by, taskId)
        if (target.controlledByMemberId)
          return fail('A person has control of that thread right now. Try again later.')
        const outcome = await promptThread(db, scope, target, {
          text: `**${teammate.name}** commented from the thread “${session.title}”:\n\n${op.text}`,
          memberId: null,
          ...(task.teammateId && target.teammates.some((t) => t.teammateId === task.teammateId)
            ? { teammateIds: [task.teammateId] }
            : {}),
        })
        if (outcome === 'offline') return fail("That task's computer is offline.")
        await reopenOnMessage(scope, { task })
        await changed(scope, by.actor, 'task.commented', taskId)
        return done({ ok: true, note: 'Posted to its thread; its teammate will read it.' })
      }
    }
  } catch (error) {
    if (error instanceof HTTPException) return fail(error.message)
    throw error
  }
}
