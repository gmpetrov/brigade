// Tasks: work to see finished, on the Tasks board. A task has at most one
// thread, which is its comments and progress; its column comes from that
// thread. Assigning a teammate starts the thread: until then the task waits in
// Backlog with nobody on it. Members act here; teammates through their task
// tools, which never assign a person nor move a task to Needs you (a ticket does).
import { randomUUID } from 'node:crypto'
import {
  formatMention,
  taskBrief,
  taskComment,
  type ApiToRunner,
  type RunnerToApi,
  type TaskColumn,
  type TaskDeliverable,
  type TaskOperation,
  type TaskPriority,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit, type Actor } from './audit.js'
import { messageChild } from './children.js'
import { prisma, scoped, type Prisma, type Scope, type ScopedDb } from './db.js'
import { broadcastTask, dispatch, isOnline } from './hub.js'
import { projectWhere, usableProject } from './projects.js'
import { projectRefusal } from './task-project.js'
import { usableAccounts } from './routes/accounts.js'
import type { WorkspaceScope } from './scope.js'
import { pullWaitsOnPerson, REVIEW_THREAD } from './review-state.js'
import { actingTeammate, currentTeammate, loadThread, requireMayPrompt } from './thread-spec.js'
import { joinThread, promptThread, startThread } from './work.js'

/** What the board shows of a task and its thread. */
const BOARD = {
  teammate: { select: { id: true, name: true, harness: true } },
  project: { select: { id: true, name: true, icon: true, logo: true } },
  createdBy: { select: { id: true, user: { select: { name: true, image: true } } } },
  createdByTeammate: { select: { id: true, name: true } },
  parent: { select: { id: true, title: true } },
  session: {
    select: {
      id: true,
      status: true,
      updatedAt: true,
      computerId: true,
      startedByMemberId: true,
      _count: { select: { tickets: { where: { status: 'open' as const } } } },
      pullRequests: {
        select: {
          repository: true,
          number: true,
          state: true,
          mergeStatus: true,
          reviewSession: { select: REVIEW_THREAD },
        },
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
 * teammate opened and stopped at, once its review is done (for the person to merge):
 * needs you, as Home and the sidebar say (pullWaitsOnPerson). Its merge marks the task
 * done (see settleOnMerge).
 */
export function columnOf(task: {
  completedAt: Date | null
  session: {
    status: string
    _count: { tickets: number }
    pullRequests: Parameters<typeof pullWaitsOnPerson>[0][]
  } | null
}): TaskColumn {
  if (task.completedAt) return 'done'
  if (!task.session) return 'backlog'
  if (task.session._count.tickets > 0 || task.session.status === 'waiting') return 'needs_you'
  // Only an open one waits on a person: once merged or closed, a reopened task is Doing.
  if (task.session.pullRequests.some(pullWaitsOnPerson) && !ACTIVE.includes(task.session.status))
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
  // A mission's sub-tasks, in the order they were made; in the Trash ones left out.
  const children = (
    await boardRows(db, { parentId: id, trashedAt: null }, [{ createdAt: 'asc' }, { id: 'asc' }])
  ).map(view)
  return { ...view(row), pullRequests, children }
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
export type By = {
  scope: Scope
  memberId: string
  actor: Actor
  /** A teammate's call: its name and its thread's title, which the threads it starts name. */
  from?: { name: string; threadTitle: string }
}

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
 * The mission a task goes in: a task on the board that is not itself a
 * sub-task, and never the task itself or one with sub-tasks of its own (one level).
 */
async function requireMission(db: ScopedDb, parentId: string, taskId?: string) {
  const mission = await db.task.findFirst({ where: { id: parentId } })
  if (!mission) throw new HTTPException(404, { message: 'Mission not found' })
  if (mission.id === taskId)
    throw new HTTPException(400, { message: 'A task cannot be its own mission' })
  if (mission.parentId)
    throw new HTTPException(400, {
      message: 'That task is in a mission itself: a mission cannot go in another.',
    })
  if (mission.trashedAt) throw new HTTPException(409, { message: 'That mission is in the Trash' })
  if (mission.archivedAt) throw new HTTPException(409, { message: 'That mission is archived' })
  if (taskId && (await db.task.count({ where: { id: taskId, children: { some: {} } } })))
    throw new HTTPException(400, {
      message: 'This task is a mission with tasks of its own: it cannot go in another.',
    })
  return mission
}

const system: Actor = { type: 'system', id: 'brigade' }

/**
 * A mission is done once every sub-task is, and back on the board, with them,
 * when one is not. Called after anything that changes a sub-task.
 */
async function settleMission(scope: Scope, missionId: string | null | undefined) {
  if (!missionId) return
  const db = scoped(scope)
  const mission = await db.task.findFirst({
    where: { id: missionId, trashedAt: null },
    select: { id: true, completedAt: true },
  })
  if (!mission) return
  // One archived unfinished, with its thread, no longer holds the mission back.
  const children = (
    await db.task.findMany({
      where: { parentId: missionId, trashedAt: null },
      select: { completedAt: true, archivedAt: true },
    })
  ).filter((c) => c.completedAt || !c.archivedAt)
  if (!children.length) return
  const allDone = children.every((c) => c.completedAt)
  if (allDone && !mission.completedAt) {
    const { count } = await db.task.updateMany({
      where: { id: missionId, completedAt: null },
      data: { completedAt: new Date() },
    })
    if (count) await changed(scope, system, 'task.completed', missionId)
  } else if (!allDone && mission.completedAt) {
    await db.task.updateMany({
      where: { id: missionId },
      data: { completedAt: null, archivedAt: null },
    })
    await db.task.updateMany({
      where: { parentId: missionId, archivedAt: { not: null }, completedAt: { not: null } },
      data: { archivedAt: null },
    })
    await changed(scope, system, 'task.reopened', missionId)
  }
}

/** The mission a task is in, to settle after changing it. */
const missionOf = async (db: ScopedDb, id: string) =>
  (await db.task.findFirst({ where: { id }, select: { parentId: true } }))?.parentId

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
    parentId?: string | undefined
  },
) {
  const by = byMember(scope)
  // In a mission, it is in the mission's project.
  const mission = input.parentId ? await requireMission(db, input.parentId) : null
  const projectId = mission ? mission.projectId : await usableProject(db, input.projectId)
  if (!input.sessionId) {
    const task = await db.task.create({
      data: {
        title: input.title,
        description: input.description,
        priority: input.priority,
        createdByMemberId: scope.memberId,
        projectId: projectId ?? null,
        parentId: mission?.id ?? null,
      } as never,
    })
    await changed(scope, by.actor, 'task.created', task.id, { sessionId: null })
    await settleMission(scope, mission?.id)
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
  // The thread's project unless another (or a mission's) is given; the thread then moves with it.
  const inProject = mission
    ? mission.projectId
    : projectId === undefined
      ? thread.projectId
      : projectId
  const task = await db.task.create({
    data: {
      title: input.title,
      description: input.description,
      priority: input.priority,
      teammateId,
      createdByMemberId: scope.memberId,
      projectId: inProject,
      parentId: mission?.id ?? null,
    } as never,
  })
  if (!(await link(db, thread.id, task.id))) {
    await db.task.deleteMany({ where: { id: task.id } })
    throw new HTTPException(409, { message: 'This thread is already a task' })
  }
  if (inProject !== thread.projectId)
    await db.session.updateMany({ where: { id: thread.id }, data: { projectId: inProject } })
  await changed(scope, by.actor, 'task.created', task.id, { sessionId: thread.id })
  await settleMission(scope, mission?.id)
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
    parentId?: string | null | undefined
  },
) {
  const task = await loadTask(db, id)
  const mission =
    input.parentId && input.parentId !== task.parentId
      ? await requireMission(db, input.parentId, id)
      : null
  const parentId = input.parentId === undefined ? task.parentId : input.parentId
  // A sub-task is in its mission's project: moving it in brings it there.
  let projectId = mission ? mission.projectId : await usableProject(db, input.projectId)
  if (!mission && parentId && projectId !== undefined) {
    const current = await db.task.findFirst({
      where: { id: parentId },
      select: { projectId: true },
    })
    if (current && current.projectId !== projectId)
      throw new HTTPException(400, {
        message:
          "A task in a mission is in the mission's project. Take it out of the mission first.",
      })
    projectId = undefined
  }
  await db.task.updateMany({
    where: { id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
    },
  })
  if (projectId !== undefined) {
    // A mission's tasks follow it.
    const children = await db.task.findMany({ where: { parentId: id }, select: { id: true } })
    await db.task.updateMany({ where: { parentId: id }, data: { projectId } })
    // Each thread follows, so its next turn has the project's context.
    const threads = await db.session.findMany({
      where: { taskId: { in: [id, ...children.map((c) => c.id)] } },
      select: { id: true, updatedAt: true },
    })
    for (const thread of threads)
      await db.session.updateMany({
        where: { id: thread.id },
        data: { projectId, updatedAt: thread.updatedAt },
      })
  }
  await changed(by.scope, by.actor, 'task.updated', id)
  if (input.parentId !== undefined && input.parentId !== task.parentId) {
    await settleMission(by.scope, task.parentId)
    await settleMission(by.scope, input.parentId)
    if (task.parentId) broadcastTask(by.scope.workspaceId, task.parentId)
  }
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
      // A teammate's task is not the member's word: its brief says who wrote it.
      text: by.from
        ? taskBrief({ ...task, from: by.from.name, threadTitle: by.from.threadTitle })
        : brief(task),
      ...(by.actor.type === 'teammate' ? { byTeammateId: by.actor.id } : {}),
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
    await settleMission(by.scope, task.parentId)
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
  await settleMission(by.scope, task.parentId)
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
  await settleMission(by.scope, task.parentId)
  return getTask(db, id)
}

/** A done task back on the board: Doing, or Backlog without a thread. */
export async function reopenTask(db: ScopedDb, by: By, id: string) {
  const task = await loadTask(db, id)
  requireNotTrashed(task)
  await requireMayAct(db, by, id)
  await db.task.updateMany({ where: { id }, data: { completedAt: null, archivedAt: null } })
  // A mission comes back with its tasks, those put away done with it.
  await db.task.updateMany({
    where: { parentId: id, archivedAt: { not: null }, completedAt: { not: null } },
    data: { archivedAt: null },
  })
  await changed(by.scope, by.actor, 'task.reopened', id)
  await settleMission(by.scope, task.parentId)
  return getTask(db, id)
}

/** A message to a done task's thread puts it back in Doing, archived or not. */
export async function reopenOnMessage(
  scope: Scope,
  thread: { task: { id: string; completedAt: Date | null; parentId?: string | null } | null },
) {
  if (!thread.task?.completedAt) return
  const db = scoped(scope)
  await db.task.updateMany({
    where: { id: thread.task.id },
    data: { completedAt: null, archivedAt: null },
  })
  await db.task.updateMany({
    where: { parentId: thread.task.id, archivedAt: { not: null }, completedAt: { not: null } },
    data: { archivedAt: null },
  })
  broadcastTask(scope.workspaceId, thread.task.id)
  await settleMission(scope, thread.task.parentId ?? (await missionOf(db, thread.task.id)))
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
  if (task.parentId)
    throw new HTTPException(409, {
      message: 'It goes with its mission: archive the mission once it is done.',
    })
  const now = new Date()
  const { count } = await db.task.updateMany({
    where: { id, completedAt: { not: null }, archivedAt: null },
    data: { archivedAt: now },
  })
  if (count) {
    // A mission's tasks go with it.
    await db.task.updateMany({
      where: { parentId: id, archivedAt: null, trashedAt: null },
      data: { archivedAt: now },
    })
    await changed(by.scope, by.actor, 'task.archived', id)
  }
  return getTask(db, id)
}

/**
 * An archived task back on the board: in Done, or, one archived with its thread, where
 * its thread says, with the thread back in the sidebar.
 */
export async function unarchiveTask(db: ScopedDb, by: By, id: string): Promise<TaskDetail> {
  const task = await loadTask(db, id)
  // A mission's task comes back with its mission.
  if (task.parentId) {
    const mission = await db.task.findFirst({
      where: { id: task.parentId, archivedAt: { not: null } },
    })
    // One archived unfinished, with its thread, still has to come back itself.
    if (mission) await unarchiveTask(db, by, mission.id)
  }
  const { count } = await db.task.updateMany({
    where: { id, archivedAt: { not: null } },
    data: { archivedAt: null },
  })
  if (count) {
    await db.task.updateMany({
      where: { parentId: id, archivedAt: { not: null }, completedAt: { not: null } },
      data: { archivedAt: null },
    })
    if (!task.completedAt) {
      const thread = await db.session.findFirst({ where: { taskId: id }, select: { id: true } })
      if (thread)
        await db.session.updateMany({
          where: { OR: [{ id: thread.id }, { parentId: thread.id }], archivedAt: { not: null } },
          data: { archivedAt: null },
        })
    }
    await changed(by.scope, by.actor, 'task.unarchived', id)
    await settleMission(by.scope, task.parentId)
  }
  return getTask(db, id)
}

/**
 * Its thread archived: an unfinished task goes off the board with it, so nothing there
 * waits on a person any more; Archived lists it. A mission's tasks stay, as tasks of
 * their own: each has its own thread. A done one stays in Done, waiting on nobody.
 */
export async function archiveWithThread(scope: Scope, taskId: string, at: Date) {
  const db = scoped(scope)
  const { count } = await db.task.updateMany({
    where: { id: taskId, completedAt: null, archivedAt: null, trashedAt: null },
    data: { archivedAt: at },
  })
  if (!count) return
  broadcastTask(scope.workspaceId, taskId)
  await settleMission(scope, await missionOf(db, taskId))
}

/** Its thread back: an unfinished task archived with it comes back where the thread says. */
export async function unarchiveWithThread(scope: Scope, taskId: string) {
  const db = scoped(scope)
  const { count } = await db.task.updateMany({
    where: { id: taskId, completedAt: null, archivedAt: { not: null } },
    data: { archivedAt: null },
  })
  if (!count) return
  broadcastTask(scope.workspaceId, taskId)
  await settleMission(scope, await missionOf(db, taskId))
}

type TaskDetail = Awaited<ReturnType<typeof getTask>>

/**
 * Into the Trash, from any column: off the board, its running turn stopped.
 * Its thread stays. Restoring puts it back where its thread says.
 */
export async function trashTask(db: ScopedDb, by: By, id: string) {
  const task = await loadTask(db, id)
  const session = await requireMayAct(db, by, id)
  const now = new Date()
  const { count } = await db.task.updateMany({
    where: { id, trashedAt: null },
    data: { trashedAt: now },
  })
  if (!count) return getTask(db, id)
  await stopTurn(db, session)
  // A mission takes its unfinished tasks with it, at the same time, so restoring brings them back.
  // One on another member's subscription that this one may not act on stays.
  const children = await db.task.findMany({
    where: { parentId: id, trashedAt: null, completedAt: null },
    select: { id: true },
  })
  for (const child of children) {
    const thread = await requireMayAct(db, by, child.id).catch(() => false as const)
    if (thread === false) continue
    await db.task.updateMany({ where: { id: child.id, trashedAt: null }, data: { trashedAt: now } })
    await stopTurn(db, thread)
  }
  await changed(by.scope, by.actor, 'task.trashed', id)
  await settleMission(by.scope, task.parentId)
  return getTask(db, id)
}

/** Stop a task thread's running turn, if it has one. */
async function stopTurn(
  db: ScopedDb,
  session: { id: string; status: string; computerId: string } | null,
) {
  if (!session || (session.status !== 'running' && session.status !== 'starting')) return
  const computer = await db.computer.findFirst({ where: { id: session.computerId } })
  if (computer) await interrupt({ id: session.id, computer })
}

export async function restoreTask(db: ScopedDb, by: By, id: string) {
  const task = await loadTask(db, id)
  const { count } = await db.task.updateMany({
    where: { id, trashedAt: { not: null } },
    data: { trashedAt: null },
  })
  if (count) {
    // The tasks that went to the Trash with it.
    if (task.trashedAt)
      await db.task.updateMany({
        where: { parentId: id, trashedAt: task.trashedAt },
        data: { trashedAt: null },
      })
    await changed(by.scope, by.actor, 'task.restored', id)
    await settleMission(by.scope, task.parentId)
  }
  return getTask(db, id)
}

/** Clear the Done column: every done task goes off the board at once. */
export async function archiveDoneTasks(db: ScopedDb, scope: WorkspaceScope) {
  return archiveDone(scope, member(scope), {})
}

/**
 * Done tasks off the board, `where` they match; a mission's tasks go with it,
 * and stay while it is not done.
 */
async function archiveDone(scope: Scope, actor: Actor, where: Prisma.TaskWhereInput) {
  const db = scoped(scope)
  const done = await db.task.findMany({
    where: {
      completedAt: { not: null },
      archivedAt: null,
      trashedAt: null,
      parentId: null,
      ...where,
    },
    select: { id: true },
  })
  if (!done.length) return { archived: 0 }
  const ids = done.map((t) => t.id)
  const now = new Date()
  const { count } = await db.task.updateMany({
    where: { id: { in: ids }, completedAt: { not: null }, archivedAt: null },
    data: { archivedAt: now },
  })
  await db.task.updateMany({
    where: { parentId: { in: ids }, archivedAt: null, trashedAt: null },
    data: { archivedAt: now },
  })
  await audit({
    ...scope,
    actor,
    action: 'task.archived',
    target: { type: 'workspace', id: scope.workspaceId },
    data: { taskIds: ids },
  })
  broadcastTask(scope.workspaceId, ids[0]!)
  return { archived: count }
}

/** How long a done task stays in Done before it is archived by itself. */
const DONE_DAYS = 3

/** Done tasks finished DONE_DAYS ago go off the board, in every workspace. */
export async function sweepDoneTasks() {
  const before = new Date(Date.now() - DONE_DAYS * 24 * 60 * 60_000)
  const workspaces = await prisma.task.groupBy({
    by: ['organizationId', 'workspaceId'],
    where: {
      completedAt: { lt: before },
      archivedAt: null,
      trashedAt: null,
      parentId: null,
    },
  })
  for (const w of workspaces) {
    const scope = { organizationId: w.organizationId, workspaceId: w.workspaceId }
    await archiveDone(scope, system, { completedAt: { lt: before } }).catch((error) =>
      console.warn(`tasks: done tasks of ${w.workspaceId} not archived: ${String(error)}`),
    )
  }
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
  if (count) {
    await changed(scope, system, 'task.completed', task.id)
    await settleMission(scope, task.parentId)
  }
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
  // Its mission may be done now; a mission's own tasks stay, as tasks of their own.
  await settleMission(scope, task.parentId)
}

type Runner = { computerId: string; organizationId: string; workspaceId: string }

/** A task's line for a teammate's list_tasks; a mission's says how many of its tasks are done. */
const listed = (task: ReturnType<typeof view>, all: ReturnType<typeof view>[]) => {
  const children = all.filter((t) => t.parentId === task.id)
  return {
    id: task.id,
    title: task.title,
    column: task.column,
    priority: task.priority,
    teammate: task.teammate && { id: task.teammate.id, name: task.teammate.name },
    ...(task.parentId ? { missionId: task.parentId } : {}),
    ...(task.projectId ? { projectId: task.projectId } : {}),
    ...(children.length
      ? { mission: { done: children.filter((c) => c.completedAt).length, total: children.length } }
      : {}),
    description:
      task.description.length > 300 ? `${task.description.slice(0, 300)}…` : task.description,
  }
}

/**
 * A playbook's run, whatever its runner offers: no call that starts or prompts a thread outside
 * the run, which would have none of its limits (its Apps, approvals, a dry run's simulation),
 * on the word of an untrusted event. It may read the board and write to its own children; a live
 * run may also file a task in Backlog, assigned to nobody, and add to one there, which start
 * nothing until a person assigns them. A dry run changes nothing on the board.
 */
async function playbookRefusal(
  db: ScopedDb,
  runId: string,
  op: TaskOperation,
): Promise<string | null> {
  if (op.name === 'list' || (op.name === 'comment' && op.threadId)) return null
  const run = await db.playbookRun.findFirst({ where: { id: runId }, select: { dryRun: true } })
  if (!run || run.dryRun)
    return "A dry run changes nothing on the Tasks board: say in playbook_report's summary what you would have filed."
  if (op.name === 'create')
    return op.assignee !== 'none'
      ? 'A playbook\'s run hands no work to a teammate: create the task with assignee "none" (Backlog), or start a child thread.'
      : op.mission
        ? "A playbook's run files tasks in Backlog only, outside any mission."
        : null
  if (op.name === 'update') {
    if (op.mission !== undefined)
      return "A playbook's run does not move tasks into or out of a mission."
    const task = await db.task.findFirst({
      where: { id: op.taskId },
      select: { teammateId: true, completedAt: true, trashedAt: true, archivedAt: true },
    })
    const started = await db.session.count({ where: { taskId: op.taskId } })
    if (
      !task ||
      task.teammateId ||
      task.completedAt ||
      task.trashedAt ||
      task.archivedAt ||
      started > 0
    )
      return "A playbook's run changes only tasks in Backlog that nobody has started."
    return null
  }
  return "A playbook's run does not assign, move, complete or write in tasks outside it: a person does, or start a child thread."
}

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
    from: { name: teammate.name, threadTitle: session.title },
  }
  const op = call.operation
  if (session.playbookRunId) {
    const refused = await playbookRefusal(db, session.playbookRunId, op)
    if (refused) return fail(refused)
  }

  /** A teammate by id or name, so "Ada" works as well as its id. */
  const findTeammate = async (ref: string) =>
    (await db.teammate.findFirst({ where: { id: ref, archivedAt: null } })) ??
    (await db.teammate.findFirst({
      where: { name: { equals: ref.trim(), mode: 'insensitive' }, archivedAt: null },
    }))
  /** A project by id or name, or null for none; undefined when the call names none. */
  const findProject = async (ref: string | null | undefined) => {
    if (ref === undefined || ref === null) return ref
    const project =
      (await db.project.findFirst({ where: { id: ref }, select: { id: true } })) ??
      (await db.project.findFirst({
        where: { name: { equals: ref.trim(), mode: 'insensitive' } },
        select: { id: true },
      }))
    if (!project)
      throw new HTTPException(404, {
        message: 'No project has that id or name; your instructions list the projects',
      })
    return usableProject(db, project.id)
  }

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
        tasks: tasks.map((t) => listed(t, tasks)),
        teammates: teammates.map((t) => ({ ...t, you: t.id === teammate.id })),
      })
    }

    if (op.name === 'create') {
      // In a mission, it is in the mission's project; else the one asked, or this thread's.
      const refusal = projectRefusal(op.project, op.mission ?? null)
      if (refusal) return fail(refusal)
      const mission = op.mission ? await requireMission(db, op.mission) : null
      const asked = await findProject(op.project)
      const projectId = mission
        ? mission.projectId
        : asked === undefined
          ? session.projectId
          : asked
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
            createdByTeammateId: teammate.id,
            projectId,
            parentId: mission?.id ?? null,
          } as never,
        })
        if (!(await link(db, session.id, task.id))) {
          await db.task.deleteMany({ where: { id: task.id } })
          return fail('This thread is already a task. Carry on with it.')
        }
        if (projectId !== session.projectId)
          await db.session.updateMany({ where: { id: session.id }, data: { projectId } })
        await changed(scope, by.actor, 'task.created', task.id, { sessionId: session.id })
        await settleMission(scope, mission?.id)
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
          createdByTeammateId: teammate.id,
          projectId,
          parentId: mission?.id ?? null,
        } as never,
      })
      await changed(scope, by.actor, 'task.created', task.id, { sessionId: null })
      await settleMission(scope, mission?.id)
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

    // message_thread to a child of this thread: it carries on, and this thread waits for its report.
    if (op.name === 'comment' && op.threadId) {
      const output = await messageChild(db, scope, session, teammate, op.threadId, op.text)
      return 'error' in output ? fail(output.error) : done(output)
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
        const { name: _, taskId: __, mission, project, ...changes } = op
        // Like the Project select in the task panel: a task of its own, not one in a mission.
        const refusal = projectRefusal(project, mission === undefined ? task.parentId : mission)
        if (refusal) return fail(refusal)
        const projectId = await findProject(project)
        await updateTask(db, by, taskId, {
          ...changes,
          ...(mission !== undefined ? { parentId: mission } : {}),
          ...(projectId !== undefined ? { projectId } : {}),
        })
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
          text: taskComment({ from: teammate.name, threadTitle: session.title, text: op.text }),
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
