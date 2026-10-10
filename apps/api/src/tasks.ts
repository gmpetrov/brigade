// Tasks: work to see finished, on the Tasks board. A task has at most one
// thread, which is its comments and progress; its column comes from that
// thread. Members create, start, reassign and close tasks here; teammates
// create and complete them through their task tools.
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
import { scoped, type Scope, type ScopedDb } from './db.js'
import { broadcastTask, dispatch } from './hub.js'
import { usableAccounts } from './routes/accounts.js'
import type { WorkspaceScope } from './scope.js'
import { actingTeammate, currentTeammate, loadThread, requireMayPrompt } from './thread-spec.js'
import { joinThread, promptThread, startThread } from './work.js'

/** What the board shows of a task and its thread. */
const BOARD = {
  teammate: { select: { id: true, name: true, harness: true } },
  createdBy: { select: { id: true, user: { select: { name: true } } } },
  session: {
    select: {
      id: true,
      status: true,
      updatedAt: true,
      computerId: true,
      startedByMemberId: true,
      _count: { select: { tickets: { where: { status: 'open' as const } } } },
    },
  },
}

type BoardRow = Awaited<ReturnType<typeof boardRows>>[number]

const boardRows = (db: ScopedDb, where: { id?: string } = {}) =>
  db.task.findMany({ where, include: BOARD, orderBy: { updatedAt: 'desc' }, take: 500 })

/** No thread: backlog. An open ticket or a waiting thread: needs you. */
export function columnOf(task: {
  completedAt: Date | null
  session: { status: string; _count: { tickets: number } } | null
}): TaskColumn {
  if (task.completedAt) return 'done'
  if (!task.session) return 'backlog'
  if (task.session._count.tickets > 0 || task.session.status === 'waiting') return 'needs_you'
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
      }
    : null,
})

export async function listTasks(db: ScopedDb) {
  return (await boardRows(db)).map(view)
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

/** Who may change a task's thread: whoever may prompt it. Without one: any member. */
async function requireMayAct(db: ScopedDb, scope: WorkspaceScope, task: { id: string }) {
  const thread = await db.session.findFirst({ where: { taskId: task.id } })
  if (thread) requireMayPrompt(scope, { ...thread, controlledByMemberId: null })
  return thread
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
  },
) {
  const thread = input.sessionId ? await loadThread(db, input.sessionId) : null
  if (thread) {
    requireMayPrompt(scope, { ...thread, controlledByMemberId: null })
    if (thread.origin === 'trigger')
      throw new HTTPException(400, { message: 'A thread a trigger started cannot become a task' })
    if (thread.taskId) throw new HTTPException(409, { message: 'This thread is already a task' })
  }
  const teammateId = input.teammateId ?? (thread && currentTeammate(thread).id)
  if (!teammateId) throw new HTTPException(400, { message: 'Who should do it?' })
  await activeTeammate(db, teammateId)
  const task = await db.task.create({
    data: {
      title: input.title,
      description: input.description,
      priority: input.priority,
      teammateId,
      createdByMemberId: scope.memberId,
    } as never,
  })
  if (thread && !(await link(db, thread.id, task.id))) {
    await db.task.deleteMany({ where: { id: task.id } })
    throw new HTTPException(409, { message: 'This thread is already a task' })
  }
  await changed(scope, member(scope), 'task.created', task.id, {
    sessionId: thread?.id ?? null,
  })
  return getTask(db, task.id)
}

export async function updateTask(
  db: ScopedDb,
  scope: WorkspaceScope,
  id: string,
  input: {
    title?: string | undefined
    description?: string | undefined
    priority?: TaskPriority | undefined
  },
) {
  await loadTask(db, id)
  await db.task.updateMany({
    where: { id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    },
  })
  await changed(scope, member(scope), 'task.updated', id)
  return getTask(db, id)
}

/** The first message of a task's thread: its brief. */
const brief = (task: { title: string; description: string }) =>
  [`**${task.title}**`, task.description].filter(Boolean).join('\n\n')

/** A backlog task gets its thread: started on a computer, with the brief as the first message. */
export async function startTask(
  db: ScopedDb,
  scope: WorkspaceScope,
  id: string,
  input: { computerId: string; accountId?: string | undefined },
) {
  const task = await loadTask(db, id)
  if (await db.session.findFirst({ where: { taskId: id } }))
    throw new HTTPException(409, { message: 'This task has already started' })
  const teammate = await activeTeammate(db, task.teammateId)
  const computer = await db.computer.findFirst({ where: { id: input.computerId } })
  if (!computer || (computer.kind === 'member_machine' && computer.memberId !== scope.memberId))
    throw new HTTPException(404, { message: 'Computer not found' })
  const { thread, outcome } = await startThread(db, scope, {
    teammate,
    computer,
    memberId: scope.memberId,
    accountId: input.accountId ?? null,
    title: task.title,
    text: brief(task),
    taskId: task.id,
  })
  if (outcome === 'offline') {
    // The task stays in the backlog; the failed thread is left as a plain one.
    await db.session.updateMany({ where: { id: thread.id }, data: { taskId: null } })
    throw new HTTPException(409, {
      message: 'That computer is offline. Start its runner and try again.',
    })
  }
  if (task.completedAt) await db.task.updateMany({ where: { id }, data: { completedAt: null } })
  await changed(scope, member(scope), 'task.started', id, { sessionId: thread.id })
  return { ...(await getTask(db, id)), paused: outcome === 'paused' }
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
 * Another teammate takes the task. With a thread, it joins it and is told the
 * brief, the reason and the work so far; a running turn stops first and a
 * done task reopens.
 */
export async function reassignTask(
  db: ScopedDb,
  scope: WorkspaceScope,
  id: string,
  input: { teammateId: string; reason: string },
) {
  const task = await loadTask(db, id)
  if (task.teammateId === input.teammateId)
    throw new HTTPException(400, { message: `${task.teammate.name} already has this task` })
  const teammate = await activeTeammate(db, input.teammateId)
  const session = await db.session.findFirst({ where: { taskId: id } })

  if (session) {
    const thread = await loadThread(db, session.id)
    requireMayPrompt(scope, thread)
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
    if (thread.status === 'running' || thread.status === 'starting')
      await dispatch(thread.computer, {
        type: 'thread.interrupt',
        commandId: randomUUID(),
        sessionId: thread.id,
      } satisfies ApiToRunner)
    await joinThread(db, thread.id, [teammate.id])
    const text = await handover(db, task, thread, task.teammate, teammate, input.reason)
    const outcome = await promptThread(db, scope, await loadThread(db, thread.id), {
      text,
      memberId: scope.memberId,
      teammateIds: [teammate.id],
    })
    if (outcome === 'offline')
      throw new HTTPException(409, {
        message: "The thread's computer is offline. Start its runner and try again.",
      })
  }

  await db.task.updateMany({
    where: { id },
    data: { teammateId: teammate.id, completedAt: null },
  })
  await changed(scope, member(scope), 'task.reassigned', id, {
    from: task.teammateId,
    to: teammate.id,
    reason: input.reason || null,
  })
  return getTask(db, id)
}

export async function completeTask(
  db: ScopedDb,
  scope: WorkspaceScope,
  id: string,
  input: { summary?: string | undefined },
) {
  const task = await loadTask(db, id)
  await requireMayAct(db, scope, task)
  await db.task.updateMany({
    where: { id },
    data: { completedAt: new Date(), ...(input.summary ? { summary: input.summary } : {}) },
  })
  await changed(scope, member(scope), 'task.completed', id)
  return getTask(db, id)
}

export async function reopenTask(db: ScopedDb, scope: WorkspaceScope, id: string) {
  const task = await loadTask(db, id)
  await requireMayAct(db, scope, task)
  await db.task.updateMany({ where: { id }, data: { completedAt: null } })
  await changed(scope, member(scope), 'task.reopened', id)
  return getTask(db, id)
}

/** A message to a done task's thread puts it back in Doing. */
export async function reopenOnMessage(
  scope: Scope,
  thread: { task: { id: string; completedAt: Date | null } | null },
) {
  if (!thread.task?.completedAt) return
  await scoped(scope).task.updateMany({
    where: { id: thread.task.id },
    data: { completedAt: null },
  })
  broadcastTask(scope.workspaceId, thread.task.id)
}

/** The task goes; its thread stays, as a plain thread. Also undoes a teammate's create_task. */
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

/** A teammate's create_task or complete_task, from its thread on this runner's computer. */
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
    include: { task: true },
  })
  if (!session) return fail('Unknown thread')
  const teammate = await actingTeammate(db, session, call.teammateId)
  if (!teammate) return fail('That teammate is not in this thread')
  const actor: Actor = { type: 'teammate', id: teammate.id }
  const op = call.operation

  if (op.name === 'create') {
    if (session.origin === 'trigger')
      return fail('A thread a trigger started cannot become a task. Just do the work here.')
    if (session.task)
      return fail(`This thread is already the task "${session.task.title}". Carry on with it.`)
    const task = await db.task.create({
      data: {
        title: op.title,
        description: op.description,
        priority: op.priority,
        teammateId: teammate.id,
        createdByMemberId: session.startedByMemberId,
      } as never,
    })
    if (!(await link(db, session.id, task.id))) {
      await db.task.deleteMany({ where: { id: task.id } })
      return fail('This thread is already a task. Carry on with it.')
    }
    await changed(scope, actor, 'task.created', task.id, { sessionId: session.id })
    return done({
      taskId: task.id,
      title: task.title,
      note: 'This thread is now a task on the Tasks board. Tell the person in one line, then do the work. Call complete_task when it is finished.',
    })
  }

  if (!session.task)
    return fail('This thread is not a task, so there is nothing to complete. Just reply.')
  if (session.task.teammateId !== teammate.id)
    return fail('This task was reassigned to another teammate; only they can complete it.')
  await db.task.updateMany({
    where: { id: session.task.id },
    data: { completedAt: new Date(), summary: op.summary, deliverables: op.deliverables },
  })
  await changed(scope, actor, 'task.completed', session.task.id)
  return done({ ok: true, note: 'The task is marked done. Tell the person what you delivered.' })
}
