// Goals (docs/goals.md): a teammate works until Brigade's measurement says the goal is reached.
// The teammate proposes a contract (propose_goal), a person approves it in one click, and from
// then on the loop is Brigade's, whatever the harness:
// - each turn's end (noteGoalTurnEnded) is measured by the contract's recipe, never by the
//   teammate: a command on the computer (goal.measure, answered later with goal.measured), a read
//   of a connected App, a list's ticked lines, or the person's judgment;
// - the measurement confirms the goal: it is achieved, and the teammate writes its summary;
// - else past its deadline, its duration, its budget or too many turns without progress: it ends,
//   with a summary too;
// - else while anything is open in the thread (a ticket, a sub-thread, a review, a wake-up, a pull
//   request), it sleeps as any thread does; with nothing open, Brigade prompts the teammate again
//   with the latest measurement (a goal note, kept in order with the person's word by
//   src/chief-order.ts: their message withdraws a relaunch that has not gone).
// Recipes measured every so often (an App's, a list's) are measured between turns too
// (measureDueGoals): a measurement that moves away from the target wakes a teammate that waits.
// Writes the contract allows in advance go without asking, up to their caps (goalCovers).
import {
  better,
  END_WORDS,
  EXIT_TARGET,
  GOAL_DRIFT_GAP_MS,
  GOAL_MEASURE_GRACE_MS,
  GOAL_PROTOCOL,
  GOAL_QUOTA_RESERVE,
  GOAL_SERIES_MAX,
  GoalContract,
  goalDriftMessage,
  goalEndMessage,
  goalRelaunchMessage,
  GoalReport,
  goalStartMessage,
  measureLine,
  meets,
  type ApiToRunner,
  type GoalContractInput,
  type GoalEndReason,
  type GoalMeasurementView,
  type GoalPermission,
  type GoalStatus,
  type GoalTarget,
  type GoalView,
  type RunnerToApi,
  type ScheduleOperation,
  type SequencedEvent,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { usableIn } from './apps.js'
import { audit, type Actor } from './audit.js'
import { connectors } from './connectors/index.js'
import type { Operation } from './connectors/types.js'
import { prisma, Prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { hubs, threadUpdated } from './hub.js'
import { listTally } from './lists.js'
import { isMcp, mcpOperation } from './mcp-tools.js'
import { argumentOf, pullChecks, type GitHubFetch } from './playbook-autonomy.js'
import { openWork } from './thread-done.js'

type GoalOperation = Extract<
  ScheduleOperation,
  { name: 'propose_goal' | 'goal_status' | 'goal_report' }
>
export const isGoalOperation = (op: ScheduleOperation): op is GoalOperation =>
  op.name === 'propose_goal' || op.name === 'goal_status' || op.name === 'goal_report'

/** A goal's notes come back as wake-ups with this sourceId: `goal:<goal>:<kind>:<key>`. */
export const GOAL_SOURCE = 'goal:'
/** The notes a person's word withdraws while they have not gone: the loop's own prompts. */
export const WITHDRAWN_KINDS = ['relaunch', 'drift'] as const
const sourceOf = (goalId: string, kind: string, key: string) =>
  `${GOAL_SOURCE}${goalId}:${kind}:${key}`

/** Proposed, active or paused: one at a time in a thread (Goal_one_open_per_thread). */
const OPEN: GoalStatus[] = ['proposed', 'active', 'paused']
const DAY_MS = 24 * 60 * 60_000

type GoalRow = NonNullable<Awaited<ReturnType<ScopedDb['goal']['findFirst']>>>
type Session = {
  id: string
  organizationId: string
  workspaceId: string
  computerId: string
  origin: string
  parentId: string | null
  playbookRunId: string | null
  chiefPassId?: string | null
  startedByMemberId: string
  status: string
}

const contractOf = (goal: { contract: unknown }) => GoalContract.parse(goal.contract)
const revokedOf = (goal: { revoked: unknown }) =>
  Array.isArray(goal.revoked)
    ? (goal.revoked as unknown[]).filter((r) => typeof r === 'string')
    : []
/** The target the measurement is read against: the contract's, or a command's exit code. */
export const targetOf = (contract: GoalContract): GoalTarget | undefined =>
  contract.target ??
  (contract.recipe.kind === 'command' && contract.recipe.read === 'exit_code'
    ? EXIT_TARGET
    : undefined)

const changed = (scope: Scope, sessionId: string) =>
  void prisma.session
    .findFirst({ where: { id: sessionId }, select: { status: true } })
    .then(
      (row) => row && hubs.get(scope.workspaceId).broadcast(threadUpdated(sessionId, row.status)),
    )
    .catch(() => undefined)

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/** An App's operation by name, as connector-calls finds it; undefined when it has none. */
async function operationOf(
  db: ScopedDb,
  scope: Scope,
  connection: Parameters<typeof mcpOperation>[2] & { kind: string },
  name: string,
): Promise<Operation | undefined> {
  if (isMcp(connection.kind as never))
    return mcpOperation(db, scope, connection, name).catch(() => undefined)
  return connectors[connection.kind as keyof typeof connectors]?.operations[name] as
    Operation | undefined
}

/** The protocol of the thread's computer: its runner's now, else the last it said. */
async function protocolOf(scope: Scope, computerId: string) {
  const live = await hubs
    .get(scope.workspaceId)
    .runnerProtocol(computerId)
    .catch(() => undefined)
  if (live !== undefined) return live
  const row = await prisma.runner.findFirst({
    where: { computerId },
    select: { protocolVersion: true },
  })
  return row?.protocolVersion ?? 0
}

/** Why `/goal` cannot be used on this computer, or null (GOAL_PROTOCOL). */
export async function goalCommandRefusal(scope: Scope, computerId: string) {
  return (await protocolOf(scope, computerId)) < GOAL_PROTOCOL
    ? "This computer's runner is too old for /goal. It updates by itself after a quiet while; try again then."
    : null
}

/** Why a proposed contract cannot be kept, or null. */
async function contractProblem(
  db: ScopedDb,
  scope: Scope,
  session: Session,
  teammateId: string,
  contract: GoalContractInput,
): Promise<string | null> {
  const now = Date.now()
  if (contract.deadline && new Date(contract.deadline).getTime() <= now + 60_000)
    return 'The deadline is already past: give one ahead, or none.'
  const { recipe } = contract
  if (recipe.kind === 'command' && (await protocolOf(scope, session.computerId)) < GOAL_PROTOCOL)
    return "This computer's runner is too old to measure by a command. Measure another way, or wait for it to update."
  if (recipe.kind === 'list') {
    const found = await listTally(db, scope, recipe.path).catch(() => null)
    if (!found) return `No Markdown list of the library is at ${recipe.path}.`
    if (!found.total) return `${recipe.path} has no checklist lines to count.`
  }
  const grants = await db.grant.findMany({
    where: { teammateId },
    select: { connectionId: true, scope: true },
  })
  const connection = async (id: string) => {
    const row = await db.connection.findFirst({
      where: { id, status: { not: 'removed' } },
      include: { app: { select: { disabledTools: true } } },
    })
    return row && usableIn(row, session) ? row : null
  }
  if (recipe.kind === 'app') {
    const row = await connection(recipe.connectionId)
    if (!row || !grants.some((g) => g.connectionId === row.id))
      return `You have no access to the App account ${recipe.connectionId}: measure with an account you were granted (list_apps).`
    const op = await operationOf(db, scope, row, recipe.operation)
    if (!op) return `${row.label} has no operation ${recipe.operation}.`
    if (op.write)
      return `${recipe.operation} changes something: a measurement only reads. Pick a read operation.`
    if (!op.input.safeParse(recipe.input).success)
      return `The input given to ${recipe.operation} is not one it takes.`
  }
  for (const p of contract.permissions) {
    const row = await connection(p.connectionId)
    const grant = row && grants.find((g) => g.connectionId === row.id)
    if (!row || !grant)
      return `You have no access to the App account ${p.connectionId} for “${p.label}”.`
    if (grant.scope !== 'read_write')
      return `Your access to ${row.label} is read-only: “${p.label}” cannot be allowed.`
    const op = await operationOf(db, scope, row, p.operation)
    if (!op) return `${row.label} has no operation ${p.operation} (“${p.label}”).`
    if (!op.write) return `${p.operation} only reads: it needs no permission (“${p.label}”).`
    if (row.app.disabledTools.includes(p.operation))
      return `${p.operation} is turned off for ${row.label}.`
    if (p.afterChecks && !/merge/.test(p.operation))
      return `“After checks pass” applies to a merge only, not to ${p.operation}.`
  }
  return null
}

/** The contract in words, for the teammate's start message. */
function contractText(contract: GoalContract) {
  const target = targetOf(contract)
  const r = contract.recipe
  const how =
    r.kind === 'command'
      ? `the command \`${r.command}\` run in your working folder (${r.read === 'exit_code' ? 'reached when it exits 0' : 'its last number printed'})`
      : r.kind === 'app'
        ? `${r.operation} on the App account ${r.connectionId}, every ${r.everyMinutes} minutes and after each turn`
        : r.kind === 'list'
          ? `the ticked lines of the list ${r.path}`
          : 'the person, at the deadline or before'
  return [
    `- Result: ${contract.outcome}`,
    ...(contract.deadline ? [`- Deadline: ${contract.deadline}`] : []),
    ...(target
      ? [
          `- Target: ${target.comparison === 'at_least' ? 'at least' : 'at most'} ${target.value}${target.unit ? ` ${target.unit}` : ''}`,
        ]
      : []),
    `- Measured by Brigade: ${how}`,
    `- Budget: ${contract.budget.tokens.toLocaleString('en')} tokens, ${contract.budget.hours} hours at most`,
    `- Stops after ${contract.stallTurns} turns in a row without progress`,
    ...(contract.permissions.length
      ? [
          '- Allowed without asking:',
          ...contract.permissions.map(
            (p) =>
              `  - ${p.label} (${p.operation} on ${p.connectionId}, ${p.perDay} a day${p.onlyWhen?.length ? `, only when ${p.onlyWhen.map((w) => `${w.argument} is ${w.oneOf.join(' or ')}`).join(' and ')}` : ''}${p.afterChecks ? ', once every required check passed' : ''})`,
          ),
        ]
      : ['- No write is allowed in advance: every write asks as usual.']),
  ].join('\n')
}

/** The goal a thread works toward: its own, or its parent's for a sub-thread. */
async function goalOfThread(db: ScopedDb, session: Session, statuses: GoalStatus[]) {
  const ids = [session.id, ...(session.parentId ? [session.parentId] : [])]
  const goals = await db.goal.findMany({
    where: { sessionId: { in: ids }, status: { in: statuses } },
    orderBy: { createdAt: 'desc' },
  })
  return goals.find((g) => g.sessionId === session.id) ?? goals[0] ?? null
}

/** propose_goal, goal_status and goal_report: a teammate's goal tools. */
export async function handleGoalCall(
  db: ScopedDb,
  scope: Scope,
  session: Session,
  teammate: { id: string; name: string },
  op: GoalOperation,
): Promise<object | { error: string }> {
  if (op.name === 'goal_status') {
    const goal = await goalOfThread(db, session, [
      'proposed',
      'active',
      'paused',
      'achieved',
      'ended',
    ])
    if (!goal) return { error: 'No goal in this thread.' }
    return teammateView(db, scope, goal)
  }

  if (op.name === 'goal_report') {
    const goal = await db.goal.findFirst({
      where: { sessionId: session.id, status: { in: ['achieved', 'ended'] } },
      orderBy: { createdAt: 'desc' },
    })
    if (!goal)
      return {
        error:
          'No goal of this thread is over. Brigade asks for the summary once the measurement confirms it or it stops.',
      }
    if (goal.report) return { error: 'Its summary is written already.' }
    const report = GoalReport.parse({
      summary: op.summary,
      worked: op.worked,
      didNotWork: op.didNotWork,
    })
    const { count } = await db.goal.updateMany({
      where: { id: goal.id, report: { equals: Prisma.DbNull } },
      data: { report },
    })
    if (!count) return { error: 'Its summary is written already.' }
    changed(scope, session.id)
    return {
      kept: true,
      next: 'Tell the person the summary in a few lines. Declare the thread done if nothing else is open.',
    }
  }

  // propose_goal: in a thread a person started, at the top, never a playbook's or Chief's.
  if (
    session.parentId ||
    session.origin !== 'member' ||
    session.playbookRunId ||
    session.chiefPassId
  )
    return { error: 'A goal is set only in a thread a person started, at the top.' }
  const problem = await contractProblem(db, scope, session, teammate.id, op.contract)
  if (problem) return { error: problem }
  const contract: GoalContract = {
    ...op.contract,
    permissions: op.contract.permissions.map((p, i) => ({ ...p, id: `p${i + 1}` })),
  }
  const goal = await prisma
    .$transaction(async (tx) => {
      const open = await tx.goal.findFirst({
        where: { sessionId: session.id, status: { in: OPEN } },
        select: { id: true, status: true },
      })
      if (open && open.status !== 'proposed')
        throw new HTTPException(409, {
          message:
            'A goal is already under way in this thread. The person can stop it from its banner; then propose another.',
        })
      // A new proposal replaces the one nobody decided yet.
      if (open)
        await tx.goal.updateMany({
          where: { id: open.id, status: 'proposed' },
          data: { status: 'superseded' },
        })
      return tx.goal.create({
        data: {
          organizationId: scope.organizationId,
          workspaceId: scope.workspaceId,
          sessionId: session.id,
          teammateId: teammate.id,
          contract: contract as unknown as Prisma.InputJsonValue,
        },
      })
    })
    .catch((error: unknown) => {
      if (error instanceof HTTPException) return { error: error.message }
      // Two proposals at once: the index keeps one.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        return { error: 'Another proposal was just made in this thread: look at it first.' }
      throw error
    })
  if ('error' in goal) return goal
  await audit({
    ...scope,
    actor: { type: 'teammate', id: teammate.id },
    action: 'goal.proposed',
    target: { type: 'thread', id: session.id },
    data: { goalId: goal.id },
  })
  changed(scope, session.id)
  return {
    goalId: goal.id,
    next:
      'Proposed. The person approves it, or corrects it, in the card shown in the thread. End your turn now with ' +
      'a few lines on what you propose and why. Do no work toward the goal before it is approved: Brigade tells ' +
      'you when it is.',
  }
}

// ---------------------------------------------------------------------------
// People's actions (routes/threads.ts)
// ---------------------------------------------------------------------------

type ThreadRef = { id: string; organizationId: string; workspaceId: string }

async function goalIn(db: ScopedDb, thread: ThreadRef, goalId: string) {
  const goal = await db.goal.findFirst({ where: { id: goalId, sessionId: thread.id } })
  if (!goal) throw new HTTPException(404, { message: 'No such goal in this thread' })
  return goal
}

/** A goal's note, as a wake-up fired at once (src/wakeups.ts): it goes in order with the person. */
async function note(
  scope: Scope,
  goal: { id: string; sessionId: string; teammateId: string },
  kind: 'start' | 'relaunch' | 'drift' | 'end',
  key: string,
  text: string,
  wakeAt = new Date(),
) {
  let id: string
  try {
    id = (
      await prisma.wakeup.create({
        data: {
          organizationId: scope.organizationId,
          workspaceId: scope.workspaceId,
          sessionId: goal.sessionId,
          teammateId: goal.teammateId,
          kind: 'wakeup',
          note: text,
          wakeAt,
          sourceId: sourceOf(goal.id, kind, key),
        },
      })
    ).id
  } catch (error) {
    // Made already: a retry of the same step.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null
    throw error
  }
  if (wakeAt.getTime() <= Date.now()) {
    const { fireNow } = await import('./wakeups.js')
    await fireNow(id)
  }
  return id
}

/** Cancel the loop's notes not sent yet: its relaunches and drift wake-ups. */
async function cancelNotes(
  client: { wakeup: { updateMany: (args: Prisma.WakeupUpdateManyArgs) => Promise<unknown> } },
  goalId: string,
) {
  await client.wakeup.updateMany({
    where: {
      status: 'pending',
      OR: WITHDRAWN_KINDS.map((k) => ({
        sourceId: { startsWith: `${GOAL_SOURCE}${goalId}:${k}:` },
      })),
    },
    data: { status: 'cancelled' },
  })
}

/** A person approves the proposed contract: the goal starts, measured first as it stands. */
export async function approveGoal(
  db: ScopedDb,
  scope: Scope & { memberId: string },
  thread: ThreadRef,
  goalId: string,
) {
  const goal = await goalIn(db, thread, goalId)
  const contract = contractOf(goal)
  const now = new Date()
  const every = 'everyMinutes' in contract.recipe ? contract.recipe.everyMinutes : undefined
  const { count } = await db.goal.updateMany({
    where: { id: goal.id, status: 'proposed' },
    data: {
      status: 'active',
      approvedAt: now,
      approvedByMemberId: scope.memberId,
      ...(every ? { nextMeasureAt: new Date(now.getTime() + every * 60_000) } : {}),
    },
  })
  if (!count)
    throw new HTTPException(409, { message: 'This goal is no longer waiting for approval' })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'goal.approved',
    target: { type: 'thread', id: thread.id },
    data: { goalId: goal.id, permissions: contract.permissions.map((p) => p.label) },
  })
  // Where it starts from: a first measurement, which may find it reached already.
  if (contract.recipe.kind !== 'person') await measure(scope, goal.id, 'start')
  await note(
    scope,
    goal,
    'start',
    'once',
    goalStartMessage({
      goalId: goal.id,
      outcome: contract.outcome,
      contract: contractText(contract),
    }),
  )
  changed(scope, thread.id)
}

export async function declineGoal(
  db: ScopedDb,
  scope: Scope & { memberId: string },
  thread: ThreadRef,
  goalId: string,
) {
  const goal = await goalIn(db, thread, goalId)
  const { count } = await db.goal.updateMany({
    where: { id: goal.id, status: 'proposed' },
    data: { status: 'declined', decidedByMemberId: scope.memberId },
  })
  if (!count)
    throw new HTTPException(409, { message: 'This goal is no longer waiting for approval' })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'goal.declined',
    target: { type: 'thread', id: thread.id },
    data: { goalId },
  })
  changed(scope, thread.id)
}

/** Pause: no relaunch, no measurement wakes it, its permissions stop covering writes. */
export async function pauseGoal(
  db: ScopedDb,
  scope: Scope & { memberId: string },
  thread: ThreadRef,
  goalId: string,
) {
  const goal = await goalIn(db, thread, goalId)
  const paused = await prisma.$transaction(async (tx) => {
    const { count } = await tx.goal.updateMany({
      where: { id: goal.id, status: 'active' },
      data: { status: 'paused', decidedByMemberId: scope.memberId },
    })
    if (count) await cancelNotes(tx, goal.id)
    return count > 0
  })
  if (!paused) throw new HTTPException(409, { message: 'This goal is not under way' })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'goal.paused',
    target: { type: 'thread', id: thread.id },
    data: { goalId },
  })
  changed(scope, thread.id)
}

/** Resume: the loop goes on, from a measurement now when the thread is idle. */
export async function resumeGoal(
  db: ScopedDb,
  scope: Scope & { memberId: string },
  thread: ThreadRef,
  goalId: string,
) {
  const goal = await goalIn(db, thread, goalId)
  const { count } = await db.goal.updateMany({
    where: { id: goal.id, status: 'paused' },
    data: { status: 'active', decidedByMemberId: scope.memberId, stalledTurns: 0 },
  })
  if (!count) throw new HTTPException(409, { message: 'This goal is not paused' })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'goal.resumed',
    target: { type: 'thread', id: thread.id },
    data: { goalId },
  })
  await measure(scope, goal.id, 'resume')
  changed(scope, thread.id)
}

/** Stop: over for good, with its measurement as it stands; the teammate takes no more turn for it. */
export async function stopGoal(
  db: ScopedDb,
  scope: Scope & { memberId: string },
  thread: ThreadRef,
  goalId: string,
) {
  const goal = await goalIn(db, thread, goalId)
  if (!(await end(scope, goal.id, 'stopped', { type: 'member', id: scope.memberId })))
    throw new HTTPException(409, { message: 'This goal is not under way' })
  changed(scope, thread.id)
}

/** Withdraw one of its permissions: its writes ask again, at once. */
export async function revokePermission(
  db: ScopedDb,
  scope: Scope & { memberId: string },
  thread: ThreadRef,
  goalId: string,
  permissionId: string,
) {
  const goal = await goalIn(db, thread, goalId)
  if (!contractOf(goal).permissions.some((p) => p.id === permissionId))
    throw new HTTPException(404, { message: 'No such permission in this goal' })
  // Appended in one statement, so two withdrawals at once both stay.
  await prisma.$executeRaw`
    UPDATE "Goal" SET revoked = revoked || ${JSON.stringify([permissionId])}::jsonb, "updatedAt" = now()
    WHERE id = ${goal.id} AND "workspaceId" = ${scope.workspaceId} AND NOT revoked ? ${permissionId}`
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'goal.permission_revoked',
    target: { type: 'thread', id: thread.id },
    data: { goalId, permissionId },
  })
  changed(scope, thread.id)
}

/** The person judges a goal measured by their judgment (or any goal): reached, or not. */
export async function judgeGoal(
  db: ScopedDb,
  scope: Scope & { memberId: string },
  thread: ThreadRef,
  goalId: string,
  met: boolean,
) {
  const goal = await goalIn(db, thread, goalId)
  if (goal.status !== 'active' && goal.status !== 'paused')
    throw new HTTPException(409, { message: 'This goal is not under way' })
  if (contractOf(goal).recipe.kind !== 'person')
    throw new HTTPException(409, {
      message: 'Brigade measures this goal by its recipe; stop it instead.',
    })
  await db.goalMeasurement.create({
    data: {
      goalId: goal.id,
      reason: 'person',
      status: 'ok',
      value: met ? 1 : 0,
      met,
      measuredAt: new Date(),
      detail: 'Judged by a person',
    } as never,
  })
  const actor: Actor = { type: 'member', id: scope.memberId }
  const done = met
    ? await achieve(scope, goal.id, actor)
    : await end(scope, goal.id, 'not_met', actor)
  if (!done) throw new HTTPException(409, { message: 'This goal is not under way' })
  changed(scope, thread.id)
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

type Reason = 'start' | 'turn' | 'periodic' | 'resume' | 'deadline'

/** Reads a dotted path (with indexes) out of an answer, parsing JSON text met on the way. */
export function readPath(value: unknown, path: string): unknown {
  const open = (v: unknown) => {
    if (typeof v !== 'string') return v
    const t = v.trim()
    if (!t.startsWith('{') && !t.startsWith('[')) return v
    try {
      return JSON.parse(t) as unknown
    } catch {
      return v
    }
  }
  let current = open(value)
  // An MCP tool's answer: its text content.
  const content = (current as { content?: unknown })?.content
  if (
    Array.isArray(content) &&
    content.length === 1 &&
    (content[0] as { type?: string })?.type === 'text' &&
    !path.startsWith('content')
  )
    current = open((content[0] as { text?: unknown }).text)
  for (const part of path.split('.').filter(Boolean)) {
    if (current === null || current === undefined) return undefined
    current = open((current as Record<string, unknown>)[part])
  }
  return current
}

/** The number a recipe's read takes out of an App's answer, or why there is none. */
export function readNumber(
  output: unknown,
  read: { path: string; op: 'value' | 'count' | 'sum'; field?: string | undefined },
): number | string {
  const at = readPath(output, read.path)
  if (read.op === 'count') {
    if (!Array.isArray(at)) return `nothing to count at "${read.path}"`
    return at.length
  }
  if (read.op === 'sum') {
    if (!Array.isArray(at)) return `nothing to add up at "${read.path}"`
    let sum = 0
    for (const item of at) {
      const v = read.field ? readPath(item, read.field) : item
      const n = typeof v === 'string' ? Number(v) : v
      if (typeof n === 'number' && Number.isFinite(n)) sum += n
    }
    return sum
  }
  const n = typeof at === 'string' ? Number(at.trim()) : at
  return typeof n === 'number' && Number.isFinite(n) ? n : `no number at "${read.path}"`
}

/** The last number in a command's output, or null. */
export function lastNumber(output: string) {
  const all = output.match(/-?\d+(?:[.,]\d+)?/g)
  if (!all?.length) return null
  const n = Number(all.at(-1)!.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

/** Run an App's read for a goal, through the same checks as a teammate's call. */
async function readApp(
  goal: GoalRow,
  recipe: Extract<GoalContract['recipe'], { kind: 'app' }>,
): Promise<{ value: number } | { error: string }> {
  const scope = { organizationId: goal.organizationId, workspaceId: goal.workspaceId }
  const db = scoped(scope)
  const session = await db.session.findFirst({
    where: { id: goal.sessionId },
    select: { computerId: true },
  })
  if (!session) return { error: 'The thread is gone' }
  const connection = await db.connection.findFirst({
    where: { id: recipe.connectionId, status: { not: 'removed' } },
  })
  if (!connection) return { error: 'The App account is no longer connected' }
  const op = await operationOf(db, scope, connection, recipe.operation)
  if (!op || op.write) return { error: `${recipe.operation} is not a read of ${connection.label}` }
  const { handleConnectorCall } = await import('./connector-calls.js')
  const answer = await new Promise<Extract<ApiToRunner, { type: 'connector.result' }>>(
    (resolve, reject) => {
      handleConnectorCall(
        { computerId: session.computerId, ...scope },
        {
          type: 'connector.call',
          callId: `goal-measure-${goal.id}-${Date.now()}`,
          sessionId: goal.sessionId,
          teammateId: goal.teammateId,
          connectionId: recipe.connectionId,
          operation: recipe.operation,
          input: recipe.input,
        } as Extract<RunnerToApi, { type: 'connector.call' }>,
        (message) => {
          if (message.type === 'connector.result') resolve(message)
        },
      ).catch(reject)
    },
  )
  if (!answer.ok) return { error: answer.error ?? 'the App refused the read' }
  const value = readNumber(answer.output, recipe.read)
  return typeof value === 'string' ? { error: value } : { value }
}

/**
 * Measure a goal by its recipe now. A command's measurement is pending until its computer answers
 * (noteMeasured); the others are done here. The measurement's id, or null for a person's judgment.
 */
export async function measure(
  scope: Scope,
  goalId: string,
  reason: Reason,
  turnSeq?: number,
): Promise<string | null> {
  const db = scoped(scope)
  const goal = await db.goal.findFirst({ where: { id: goalId } })
  if (!goal) return null
  const contract = contractOf(goal)
  const recipe = contract.recipe
  if (recipe.kind === 'person') return null
  const row = await db.goalMeasurement.create({
    data: { goalId, reason, ...(turnSeq !== undefined ? { turnSeq } : {}) } as never,
  })
  if (recipe.kind === 'command') {
    const session = await db.session.findFirst({
      where: { id: goal.sessionId },
      select: { computerId: true },
    })
    const protocol = session ? await protocolOf(scope, session.computerId) : 0
    const sent =
      !!session &&
      protocol >= GOAL_PROTOCOL &&
      (await hubs
        .get(scope.workspaceId)
        .sendToRunner(
          session.computerId,
          {
            type: 'goal.measure',
            measureId: row.id,
            sessionId: goal.sessionId,
            teammateId: goal.teammateId,
            command: recipe.command,
            timeoutSeconds: recipe.timeoutMinutes * 60,
          },
          // A measurement between turns does not keep a cloud computer up.
          { touch: reason !== 'periodic' },
        )
        .catch(() => false))
    if (!sent)
      await finish(scope, row.id, {
        error:
          protocol && protocol < GOAL_PROTOCOL
            ? "The computer's runner is too old to measure by a command"
            : 'The computer is offline',
      })
    return row.id
  }
  let result: { value: number } | { error: string }
  try {
    if (recipe.kind === 'app') result = await readApp(goal, recipe)
    else {
      const { ticked } = await listTally(db, scope, recipe.path)
      result = { value: ticked }
    }
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) }
  }
  await finish(scope, row.id, result)
  return row.id
}

/** A command's measurement came back from the computer (goal.measured). */
export async function noteMeasured(
  runner: { computerId: string; organizationId: string; workspaceId: string },
  message: Extract<RunnerToApi, { type: 'goal.measured' }>,
) {
  const scope = { organizationId: runner.organizationId, workspaceId: runner.workspaceId }
  const db = scoped(scope)
  // Only a measurement of a thread on this runner's own computer.
  const row = await db.goalMeasurement.findFirst({
    where: { id: message.measureId, status: 'pending' },
    select: { goal: { select: { sessionId: true, contract: true } } },
  })
  if (!row || row.goal.sessionId !== message.sessionId) return
  const own = await db.session.count({
    where: { id: message.sessionId, computerId: runner.computerId },
  })
  if (!own) return
  const recipe = contractOf(row.goal).recipe
  if (recipe.kind !== 'command') return
  const output = message.output.slice(-2_000)
  if (message.exitCode === null)
    return finish(scope, message.measureId, {
      error: message.error ?? 'The command could not run',
      detail: output,
    })
  if (recipe.read === 'exit_code')
    return finish(scope, message.measureId, {
      value: message.exitCode === 0 ? 1 : 0,
      detail: `exit ${message.exitCode}\n${output}`,
    })
  const n = lastNumber(message.output)
  return finish(
    scope,
    message.measureId,
    n === null
      ? { error: 'The command printed no number', detail: output }
      : { value: n, detail: `exit ${message.exitCode}\n${output}` },
  )
}

/** Keep a measurement's result once, then move the loop on (afterMeasure). */
async function finish(
  scope: Scope,
  measurementId: string,
  result: { value: number; detail?: string } | { error: string; detail?: string },
) {
  const db = scoped(scope)
  const row = await db.goalMeasurement.findFirst({
    where: { id: measurementId },
    select: { goal: { select: { contract: true } } },
  })
  if (!row) return
  const target = targetOf(contractOf(row.goal))
  const value = 'value' in result ? result.value : null
  const { count } = await db.goalMeasurement.updateMany({
    where: { id: measurementId, status: 'pending' },
    data: {
      status: value === null ? 'failed' : 'ok',
      value,
      met: value === null || !target ? null : meets(target, value),
      detail: ('error' in result ? result.error : (result.detail ?? '')).slice(0, 2_000),
      measuredAt: new Date(),
    },
  })
  if (count) await afterMeasure(scope, measurementId)
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/** Tokens the goal spent: its thread's and its sub-threads', since it was approved, as Usage counts. */
export async function tokensSpent(goal: {
  sessionId: string
  workspaceId: string
  approvedAt: Date | null
}) {
  if (!goal.approvedAt) return 0
  const [row] = await prisma.$queryRaw<[{ used: bigint | null }]>`
    SELECT sum("inputTokens"::bigint + "outputTokens") AS used FROM "TokenUsage"
    WHERE "workspaceId" = ${goal.workspaceId} AND NOT replaced AND at >= ${goal.approvedAt}
      AND "sessionId" IN (
        SELECT id FROM "Session" WHERE id = ${goal.sessionId}
        UNION SELECT id FROM "Session" WHERE "parentId" = ${goal.sessionId}
        UNION SELECT s.id FROM "Session" s JOIN "Session" p ON s."parentId" = p.id
          WHERE p."parentId" = ${goal.sessionId})`
  return Number(row?.used ?? 0)
}

/** Why a goal under way is over without being reached, or null. */
async function overBecause(goal: GoalRow, contract: GoalContract, now = Date.now()) {
  if (!goal.approvedAt) return null
  if (goal.stalledTurns >= contract.stallTurns) return 'stalled' as const
  if (now >= goal.approvedAt.getTime() + contract.budget.hours * 60 * 60_000)
    return 'duration' as const
  // A person's judgment waits for them past the deadline: the banner asks.
  if (
    contract.deadline &&
    now >= new Date(contract.deadline).getTime() &&
    contract.recipe.kind !== 'person'
  )
    return 'deadline' as const
  if ((await tokensSpent(goal)) >= contract.budget.tokens) return 'budget' as const
  return null
}

/** The account's usage window nearly spent: until when the goal waits, and why. */
async function quotaHold(sessionId: string) {
  const thread = await prisma.session.findFirst({
    where: { id: sessionId },
    select: { account: { select: { lastUsage: true, lastUsageAt: true, provider: true } } },
  })
  const account = thread?.account
  if (!account?.lastUsage || !account.lastUsageAt) return null
  // Read in the last 6 hours, or it says nothing of now.
  if (Date.now() - account.lastUsageAt.getTime() > 6 * 60 * 60_000) return null
  const windows = Array.isArray(account.lastUsage)
    ? (account.lastUsage as { window?: string; utilization?: number; resetsAt?: string | null }[])
    : []
  let hold: { until: Date; reason: string } | null = null
  for (const w of windows) {
    if (typeof w.utilization !== 'number' || w.utilization < GOAL_QUOTA_RESERVE) continue
    const until = w.resetsAt ? new Date(w.resetsAt) : new Date(Date.now() + 60 * 60_000)
    if (until.getTime() <= Date.now()) continue
    if (!hold || until > hold.until)
      hold = {
        until,
        reason:
          `Your ${account.provider === 'codex' ? 'Codex' : 'Claude'} usage is at ${Math.round(w.utilization * 100)}% of its ${w.window ?? ''} window: the goal waits for it to reset, so your other threads keep theirs.`.replace(
            'its  window',
            'its window',
          ),
      }
  }
  return hold
}

/** The latest measurements of a goal, oldest first. */
async function series(db: ScopedDb, goalId: string, take = GOAL_SERIES_MAX) {
  const rows = await db.goalMeasurement.findMany({
    where: { goalId },
    orderBy: { at: 'desc' },
    take,
  })
  return rows.reverse()
}

/** Where the goal stands, in lines for the teammate: budget, time, progress, the pace's projection. */
async function standing(db: ScopedDb, goal: GoalRow, contract: GoalContract) {
  const lines: string[] = []
  const used = await tokensSpent(goal)
  lines.push(
    `Budget: ${Math.round((used / contract.budget.tokens) * 100)}% of ${contract.budget.tokens.toLocaleString('en')} tokens spent.`,
  )
  if (contract.deadline) {
    const left = new Date(contract.deadline).getTime() - Date.now()
    lines.push(
      left > 0
        ? `Deadline: ${contract.deadline}, in ${Math.round(left / 3_600_000)} hours.`
        : `Deadline: ${contract.deadline}, passed.`,
    )
  }
  lines.push(
    `Turns without progress: ${goal.stalledTurns} of ${contract.stallTurns} before it stops.`,
  )
  const target = targetOf(contract)
  const points = (await series(db, goal.id)).filter((m) => m.status === 'ok' && m.value !== null)
  if (target && contract.deadline && points.length >= 2 && goal.approvedAt) {
    const first = points[0]!
    const last = points.at(-1)!
    const span = last.at.getTime() - first.at.getTime()
    if (span > 0) {
      const rate = (last.value! - first.value!) / span
      const projected =
        last.value! + rate * (new Date(contract.deadline).getTime() - last.at.getTime())
      const rounded = Math.round(projected * 10) / 10
      lines.push(
        meets(target, projected)
          ? `At this pace it reaches about ${rounded} by the deadline: on track.`
          : `At this pace it reaches about ${rounded} by the deadline, short of ${target.value}: say so to the person now and propose where to put the effort.`,
      )
    }
  }
  return lines
}

/** The latest measurement in words. */
async function latestLine(db: ScopedDb, goal: GoalRow, contract: GoalContract) {
  const last = await db.goalMeasurement.findFirst({
    where: { goalId: goal.id, status: { not: 'pending' } },
    orderBy: { at: 'desc' },
  })
  return measureLine(
    targetOf(contract),
    last
      ? {
          value: last.value,
          at: (last.measuredAt ?? last.at).toISOString(),
          error: last.detail,
        }
      : null,
  )
}

/** The goal is reached: over, and the teammate writes its summary. Whether this call ended it. */
async function achieve(scope: Scope, goalId: string, actor?: Actor) {
  const db = scoped(scope)
  const ended = await prisma.$transaction(async (tx) => {
    const { count } = await tx.goal.updateMany({
      where: { id: goalId, workspaceId: scope.workspaceId, status: { in: ['active', 'paused'] } },
      data: {
        status: 'achieved',
        endedAt: new Date(),
        heldUntil: null,
        holdReason: null,
        ...(actor?.type === 'member' ? { decidedByMemberId: actor.id } : {}),
      },
    })
    if (count) await cancelNotes(tx, goalId)
    return count > 0
  })
  if (!ended) return false
  const goal = (await db.goal.findFirst({ where: { id: goalId } }))!
  const contract = contractOf(goal)
  await audit({
    ...scope,
    actor: actor ?? { type: 'system', id: 'brigade' },
    action: 'goal.achieved',
    target: { type: 'thread', id: goal.sessionId },
    data: { goalId },
  })
  await note(
    scope,
    goal,
    'end',
    'once',
    goalEndMessage({
      goalId,
      outcome: contract.outcome,
      how: END_WORDS.achieved,
      measure: await latestLine(db, goal, contract),
    }),
  )
  changed(scope, goal.sessionId)
  return true
}

/** The goal is over without being reached. Whether this call ended it. */
async function end(scope: Scope, goalId: string, reason: GoalEndReason, actor?: Actor) {
  const db = scoped(scope)
  const ended = await prisma.$transaction(async (tx) => {
    const { count } = await tx.goal.updateMany({
      where: { id: goalId, workspaceId: scope.workspaceId, status: { in: ['active', 'paused'] } },
      data: {
        status: 'ended',
        endReason: reason,
        endedAt: new Date(),
        heldUntil: null,
        holdReason: null,
        ...(actor?.type === 'member' ? { decidedByMemberId: actor.id } : {}),
      },
    })
    if (count) await cancelNotes(tx, goalId)
    return count > 0
  })
  if (!ended) return false
  const goal = (await db.goal.findFirst({ where: { id: goalId } }))!
  const contract = contractOf(goal)
  await audit({
    ...scope,
    actor: actor ?? { type: 'system', id: 'brigade' },
    action: 'goal.ended',
    target: { type: 'thread', id: goal.sessionId },
    data: { goalId, reason },
  })
  // Stopped by a person: no more turn for it. Otherwise one last, for its summary.
  if (reason !== 'stopped')
    await note(
      scope,
      goal,
      'end',
      'once',
      goalEndMessage({
        goalId,
        outcome: contract.outcome,
        how: END_WORDS[reason],
        measure: await latestLine(db, goal, contract),
      }),
    )
  changed(scope, goal.sessionId)
  return true
}

/**
 * A measurement is kept: the goal is reached, over, prompted again, or left to sleep. Progress
 * counts per turn (a turn's or a resume's measurement); between turns, a measurement moving away
 * from the target wakes a waiting teammate (drift).
 */
async function afterMeasure(scope: Scope, measurementId: string) {
  const db = scoped(scope)
  const m = await db.goalMeasurement.findFirst({ where: { id: measurementId } })
  if (!m) return
  const goal = await db.goal.findFirst({ where: { id: m.goalId } })
  if (!goal || goal.status !== 'active') return
  const contract = contractOf(goal)
  const target = targetOf(contract)
  if (m.met) return void (await achieve(scope, goal.id))
  if (m.reason === 'turn' && target) {
    const progressed =
      m.value !== null && (goal.best === null || better(target, m.value, goal.best))
    await db.goal.updateMany({
      where: { id: goal.id, status: 'active' },
      data: progressed ? { best: m.value, stalledTurns: 0 } : { stalledTurns: { increment: 1 } },
    })
  } else if (
    m.value !== null &&
    target &&
    (goal.best === null || better(target, m.value, goal.best))
  )
    await db.goal.updateMany({ where: { id: goal.id }, data: { best: m.value } })
  if (m.reason === 'turn' || m.reason === 'resume' || m.reason === 'deadline')
    return afterTurn(scope, goal.id)
  if (m.reason === 'periodic') {
    const fresh = (await db.goal.findFirst({ where: { id: goal.id } }))!
    const over = await overBecause(fresh, contract)
    if (over) return void (await end(scope, goal.id, over))
    await maybeDrift(scope, fresh, contract, m)
  }
}

/**
 * Where the loop goes once a turn's measurement says the goal is not reached (or a person's
 * judgment is still to come): over, asleep while something is open, held for the account's usage,
 * or prompted again.
 */
async function afterTurn(scope: Scope, goalId: string) {
  const db = scoped(scope)
  const goal = await db.goal.findFirst({ where: { id: goalId } })
  if (!goal || goal.status !== 'active') return
  const contract = contractOf(goal)
  const over = await overBecause(goal, contract)
  if (over) return void (await end(scope, goal.id, over))
  // Past its deadline, a person's judgment is theirs to give: nothing more to do meanwhile.
  if (
    contract.recipe.kind === 'person' &&
    contract.deadline &&
    Date.now() >= new Date(contract.deadline).getTime()
  )
    return
  const thread = await db.session.findFirst({
    where: { id: goal.sessionId },
    select: { status: true, controlledByMemberId: true },
  })
  // At work, waiting on a person or a cap, failed, or in a person's hands: it sleeps.
  if (!thread || thread.status !== 'idle' || thread.controlledByMemberId) return
  if ((await openWork(db, goal.sessionId)).length) return
  const hold = await quotaHold(goal.sessionId)
  if (hold)
    await db.goal.updateMany({
      where: { id: goal.id, status: 'active' },
      data: { heldUntil: hold.until, holdReason: hold.reason },
    })
  else if (goal.heldUntil)
    await db.goal.updateMany({
      where: { id: goal.id },
      data: { heldUntil: null, holdReason: null },
    })
  await note(
    scope,
    goal,
    'relaunch',
    String(goal.turnSeq),
    goalRelaunchMessage({
      goalId: goal.id,
      outcome: contract.outcome,
      measure: await latestLine(db, goal, contract),
      standing: await standing(db, goal, contract),
    }),
    hold?.until,
  )
  if (hold) changed(scope, goal.sessionId)
}

/** A measurement between turns moved away from the target: wake a teammate that waits. */
async function maybeDrift(
  scope: Scope,
  goal: GoalRow,
  contract: GoalContract,
  m: { id: string; value: number | null; at: Date },
) {
  const target = targetOf(contract)
  if (!target || m.value === null) return
  if (goal.driftWokeAt && Date.now() - goal.driftWokeAt.getTime() < GOAL_DRIFT_GAP_MS) return
  const db = scoped(scope)
  const before = await db.goalMeasurement.findFirst({
    where: { goalId: goal.id, status: 'ok', id: { not: m.id }, at: { lt: m.at } },
    orderBy: { at: 'desc' },
  })
  if (before?.value === null || before?.value === undefined) return
  if (!better(target, before.value, m.value)) return
  const thread = await db.session.findFirst({
    where: { id: goal.sessionId },
    select: { status: true, controlledByMemberId: true },
  })
  // Only a teammate that sleeps: one at work hears of it at its turn's end.
  if (!thread || thread.controlledByMemberId || !['idle', 'waiting'].includes(thread.status)) return
  const { count } = await db.goal.updateMany({
    where: {
      id: goal.id,
      status: 'active',
      OR: [
        { driftWokeAt: null },
        { driftWokeAt: { lt: new Date(Date.now() - GOAL_DRIFT_GAP_MS) } },
      ],
    },
    data: { driftWokeAt: new Date() },
  })
  if (!count) return
  const unit = target.unit ? ` ${target.unit}` : ''
  await note(
    scope,
    goal,
    'drift',
    m.id,
    goalDriftMessage({
      goalId: goal.id,
      outcome: contract.outcome,
      measure: await latestLine(db, goal, contract),
      why: `from ${before.value}${unit} to ${m.value}${unit}`,
    }),
  )
}

/**
 * A thread's events are kept (src/hub/runner-messages.ts): a turn that ended in a thread with a
 * goal under way is measured, once per turn's end, and the loop moves on from it.
 */
export async function noteGoalTurnEnded(
  session: { id: string; organizationId: string; workspaceId: string },
  events: SequencedEvent[],
) {
  const ended = events.filter((e) => e.event.type === 'turn.completed').at(-1)
  if (!ended) return
  const scope = { organizationId: session.organizationId, workspaceId: session.workspaceId }
  const db = scoped(scope)
  const goal = await db.goal.findFirst({
    where: { sessionId: session.id, status: 'active' },
    select: { id: true, contract: true },
  })
  if (!goal) return
  // Each turn's end once, however often its events are noted.
  const { count } = await db.goal.updateMany({
    where: { id: goal.id, status: 'active', turnSeq: { lt: ended.seq } },
    data: { turnSeq: ended.seq, turns: { increment: 1 } },
  })
  if (!count) return
  if (contractOf(goal).recipe.kind === 'person') {
    // No figure: progress is the person's to judge, so only the limits and the relaunch apply.
    return afterTurn(scope, goal.id)
  }
  await measure(scope, goal.id, 'turn', ended.seq)
}

/** Whether a thread has a goal under way: the person's word then goes in order with its notes. */
export async function goalOpenIn(sessionId: string) {
  return (
    (await prisma.goal.count({ where: { sessionId, status: { in: ['active', 'paused'] } } })) > 0
  )
}

// ---------------------------------------------------------------------------
// Between turns (src/jobs.ts)
// ---------------------------------------------------------------------------

/** Workspaces with a goal under way: measured, ended or given up on each minute as due. */
export async function dueGoals() {
  const rows = await prisma.goal.findMany({
    where: { status: 'active' },
    distinct: ['workspaceId'],
    select: { workspaceId: true },
  })
  return rows.map((r) => r.workspaceId)
}

/**
 * Each minute: measurements due between turns, a command's that never came back, and goals whose
 * deadline, duration or budget ran out while the thread slept.
 */
export async function measureDueGoals(workspaceId?: string) {
  const now = new Date()
  const where = workspaceId ? { workspaceId } : {}
  // A command's measurement the computer never answered: failed, and the loop goes on.
  const stale = await prisma.goalMeasurement.findMany({
    where: {
      ...where,
      status: 'pending',
      at: { lt: new Date(now.getTime() - 30 * 60_000 - GOAL_MEASURE_GRACE_MS) },
    },
    select: { id: true, organizationId: true, workspaceId: true },
    take: 100,
  })
  for (const m of stale)
    await finish({ organizationId: m.organizationId, workspaceId: m.workspaceId }, m.id, {
      error: 'The computer never answered the measurement',
    }).catch((error: unknown) => console.error(`goal measurement ${m.id}: ${String(error)}`))
  const goals = await prisma.goal.findMany({ where: { ...where, status: 'active' }, take: 200 })
  for (const goal of goals) {
    const scope = { organizationId: goal.organizationId, workspaceId: goal.workspaceId }
    try {
      const contract = contractOf(goal)
      const pending = await prisma.goalMeasurement.count({
        where: {
          goalId: goal.id,
          status: 'pending',
          at: {
            gt: new Date(
              now.getTime() -
                (('timeoutMinutes' in contract.recipe ? contract.recipe.timeoutMinutes : 1) *
                  60_000 +
                  GOAL_MEASURE_GRACE_MS),
            ),
          },
        },
      })
      if (pending) continue
      // Past its deadline: one last measurement decides, reached or not.
      if (
        contract.deadline &&
        now.getTime() >= new Date(contract.deadline).getTime() &&
        contract.recipe.kind !== 'person'
      ) {
        await measure(scope, goal.id, 'deadline')
        continue
      }
      const over = await overBecause(goal, contract, now.getTime())
      if (over) {
        await end(scope, goal.id, over)
        continue
      }
      const every = 'everyMinutes' in contract.recipe ? contract.recipe.everyMinutes : undefined
      if (!every || (goal.nextMeasureAt && goal.nextMeasureAt > now)) continue
      // Claimed before measuring: two ticks at once measure once.
      const { count } = await prisma.goal.updateMany({
        where: {
          id: goal.id,
          status: 'active',
          OR: [{ nextMeasureAt: null }, { nextMeasureAt: goal.nextMeasureAt }],
        },
        data: { nextMeasureAt: new Date(now.getTime() + every * 60_000) },
      })
      if (count) await measure(scope, goal.id, 'periodic')
    } catch (error) {
      console.error(`goal ${goal.id}: ${String(error)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Writes allowed in advance (src/connector-calls.ts)
// ---------------------------------------------------------------------------

const ALLOWANCE = 'goal.allowance_reserved'
const allowanceTarget = (goalId: string, permissionId: string) => ({
  targetType: 'goal_permission',
  targetId: `${goalId}:${permissionId}`,
})

/** Calls each permission of a goal made on its own in the last 24 hours. */
async function usedToday(
  client: Pick<Prisma.TransactionClient, 'auditEntry'>,
  scope: Scope,
  goalId: string,
  permissionIds: string[],
) {
  const out: Record<string, number> = {}
  for (const id of permissionIds)
    out[id] = await client.auditEntry.count({
      where: {
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        action: ALLOWANCE,
        ...allowanceTarget(goalId, id),
        at: { gte: new Date(Date.now() - DAY_MS) },
      },
    })
  return out
}

const same = (a: unknown, b: string) =>
  typeof a === 'string' &&
  a.trim().toLowerCase().replace(/^r\//, '') === b.trim().toLowerCase().replace(/^r\//, '')

/** Why a call is not within a permission's conditions, or null. */
export function outsideConditions(permission: GoalPermission, args: unknown): string | null {
  for (const w of permission.onlyWhen ?? []) {
    const value = argumentOf(args, w.argument)
    const values = Array.isArray(value) ? value : [value]
    if (!values.length || !values.every((v) => w.oneOf.some((allowed) => same(v, allowed))))
      return `“${permission.label}” covers only ${w.argument} ${w.oneOf.join(', ')}.`
  }
  return null
}

/**
 * A write that would ask a person: whether the active goal of its thread (or of its parent, for a
 * sub-thread working on a lever) allows it in advance. Covered: its share of the permission's cap
 * is taken atomically, under a lock per permission, and kept whatever the call's result (the
 * provider may have made the write before its answer was lost). Not covered: why, when a
 * permission matched but its cap or conditions did not; null when none matched.
 */
export async function goalCovers(
  scope: Scope,
  session: { id: string; parentId: string | null },
  call: { connectionId: string; operation: string; args: unknown; teammateId: string },
  github: () => Promise<GitHubFetch>,
): Promise<
  { covered: true; label: string; checkedSha?: string } | { covered: false; reason: string } | null
> {
  const db = scoped(scope)
  const ids = [session.id, ...(session.parentId ? [session.parentId] : [])]
  const goal = await db.goal.findFirst({
    where: { sessionId: { in: ids }, status: 'active' },
    orderBy: { createdAt: 'desc' },
  })
  if (!goal) return null
  const revoked = revokedOf(goal)
  const permission = contractOf(goal).permissions.find(
    (p) =>
      p.connectionId === call.connectionId &&
      p.operation === call.operation &&
      !revoked.includes(p.id),
  )
  if (!permission) return null
  const outside = outsideConditions(permission, call.args)
  if (outside) return { covered: false, reason: outside }
  let checkedSha: string | undefined
  if (permission.afterChecks) {
    const repository = argumentOf(call.args, 'repository')
    const number = argumentOf(call.args, 'number')
    if (typeof repository !== 'string' || typeof number !== 'number')
      return { covered: false, reason: `“${permission.label}” needs a pull request to check.` }
    const checks = await pullChecks(await github(), repository, number).catch((error: unknown) => ({
      passed: false as const,
      why: `its checks could not be read (${error instanceof Error ? error.message : String(error)})`,
    }))
    if (!checks.passed)
      return {
        covered: false,
        reason: `“${permission.label}” waits for every check to pass: ${checks.why}.`,
      }
    checkedSha = checks.sha
  }
  return prisma.$transaction(async (tx) => {
    const lock = `goal-permission:${goal.id}:${permission.id}`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`
    // Read again under the lock: paused, ended or withdrawn meanwhile, it no longer covers.
    const [now] = await tx.$queryRaw<{ status: string; revoked: unknown }[]>`
      SELECT status::text AS status, revoked FROM "Goal" WHERE id = ${goal.id} FOR SHARE`
    if (now?.status !== 'active' || revokedOf({ revoked: now.revoked }).includes(permission.id))
      return null
    const used = (await usedToday(tx, scope, goal.id, [permission.id]))[permission.id] ?? 0
    if (used >= permission.perDay)
      return {
        covered: false as const,
        reason: `“${permission.label}” allows ${permission.perDay} in 24 hours, and that many were done: a person approves this one.`,
      }
    await tx.auditEntry.create({
      data: {
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        actorType: 'teammate',
        actorId: call.teammateId,
        action: ALLOWANCE,
        ...allowanceTarget(goal.id, permission.id),
        data: { goalId: goal.id, permissionId: permission.id, sessionId: session.id },
      },
    })
    return {
      covered: true as const,
      label: permission.label,
      ...(checkedSha ? { checkedSha } : {}),
    }
  })
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const viewOf = (m: {
  at: Date
  measuredAt: Date | null
  value: number | null
  met: boolean | null
  status: string
  reason: string
  detail: string | null
}): GoalMeasurementView => ({
  at: (m.measuredAt ?? m.at).toISOString(),
  value: m.value,
  met: m.met,
  status: m.status as GoalMeasurementView['status'],
  reason: m.reason,
  detail: m.detail,
})

/** The thread's latest goal, as its banner shows it; null when it never had one. */
export async function goalView(
  db: ScopedDb,
  scope: Scope,
  sessionId: string,
  may: { act: boolean; approve: boolean },
): Promise<GoalView | null> {
  const goal = await db.goal.findFirst({
    where: { sessionId, status: { notIn: ['superseded'] } },
    orderBy: { createdAt: 'desc' },
  })
  if (!goal) return null
  const contract = contractOf(goal)
  const [measurements, used, today, approver] = await Promise.all([
    series(db, goal.id),
    tokensSpent(goal),
    usedToday(
      prisma,
      scope,
      goal.id,
      contract.permissions.map((p) => p.id),
    ),
    goal.approvedByMemberId
      ? db.member.findFirst({
          where: { id: goal.approvedByMemberId },
          select: { user: { select: { name: true } } },
        })
      : null,
  ])
  const report = goal.report ? GoalReport.safeParse(goal.report) : null
  const named = [
    ...(contract.recipe.kind === 'app' ? [contract.recipe.connectionId] : []),
    ...contract.permissions.map((p) => p.connectionId),
  ]
  const connections = named.length
    ? await db.connection.findMany({
        where: { id: { in: named } },
        select: { id: true, label: true, externalAccount: true },
      })
    : []
  return {
    id: goal.id,
    status: goal.status,
    contract,
    revoked: revokedOf(goal),
    usedToday: today,
    createdAt: goal.createdAt.toISOString(),
    approvedAt: goal.approvedAt?.toISOString() ?? null,
    approvedBy: approver?.user.name ?? null,
    endedAt: goal.endedAt?.toISOString() ?? null,
    endReason: (goal.endReason as GoalEndReason | null) ?? null,
    heldUntil: goal.heldUntil && goal.heldUntil > new Date() ? goal.heldUntil.toISOString() : null,
    holdReason: goal.heldUntil && goal.heldUntil > new Date() ? goal.holdReason : null,
    measurements: measurements.map(viewOf),
    budget: {
      tokens: contract.budget.tokens,
      used,
      hours: contract.budget.hours,
      endsAt: goal.approvedAt
        ? new Date(goal.approvedAt.getTime() + contract.budget.hours * 3_600_000).toISOString()
        : null,
    },
    turns: goal.turns,
    stalledTurns: goal.stalledTurns,
    report: report?.success ? report.data : null,
    accounts: Object.fromEntries(connections.map((c) => [c.id, c.externalAccount ?? c.label])),
    mayAct: may.act,
    mayApprove: may.approve,
  }
}

/** goal_status: where the goal stands, for the teammate. */
async function teammateView(db: ScopedDb, scope: Scope, goal: GoalRow) {
  const contract = contractOf(goal)
  const view = await goalView(db, scope, goal.sessionId, { act: false, approve: false })
  const revoked = revokedOf(goal)
  return {
    goalId: goal.id,
    status: goal.status,
    outcome: contract.outcome,
    deadline: contract.deadline ?? null,
    target: targetOf(contract) ?? null,
    recipe: contract.recipe,
    measurements: (view?.measurements ?? []).slice(-20),
    budget: view?.budget ?? null,
    turnsWithoutProgress: goal.stalledTurns,
    stallTurns: contract.stallTurns,
    permissions: contract.permissions.map((p) => ({
      label: p.label,
      operation: p.operation,
      perDay: p.perDay,
      usedToday: view?.usedToday[p.id] ?? 0,
      withdrawn: revoked.includes(p.id),
    })),
    ...(goal.status === 'active' ? { standing: await standing(db, goal, contract) } : {}),
    ...(goal.heldUntil && goal.heldUntil > new Date()
      ? { heldUntil: goal.heldUntil.toISOString(), holdReason: goal.holdReason }
      : {}),
  }
}
