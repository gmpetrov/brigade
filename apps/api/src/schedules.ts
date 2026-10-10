// Schedules: a teammate prompted with the same instructions on a cron schedule.
// Every minute the API starts a fresh thread for each schedule that is due, on
// its owner's accounts. Members manage schedules from the dashboard; teammates
// set them up from a member's thread with their schedule tools.
import {
  cronProblem,
  nextRun,
  nextRuns,
  type ApiToRunner,
  type RunnerToApi,
  type ScheduleOperation,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit, type Actor } from './audit.js'
import { prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { broadcastSchedule } from './hub.js'
import type { WorkspaceScope } from './scope.js'
import { actingTeammate } from './thread-spec.js'
import { startThread } from './work.js'

/** A thread still `starting` after this is taken as lost (e.g. its queued prompt went with a restart). */
const STARTING_STALE_MS = 15 * 60_000

type Runner = { organizationId: string; workspaceId: string; computerId: string }
type Schedule = NonNullable<Awaited<ReturnType<typeof findSchedule>>>
type Changes = {
  teammateId?: string
  title?: string
  instructions?: string
  cron?: string
  timezone?: string
  paused?: boolean
}

const findSchedule = (db: ScopedDb, id: string) =>
  db.schedule.findFirst({ where: { id }, include: { teammate: true } })

const LIST = {
  teammate: { select: { id: true, name: true, harness: true, archivedAt: true } },
  owner: { select: { id: true, user: { select: { name: true } } } },
  createdByTeammate: { select: { id: true, name: true } },
  sessions: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: { id: true, status: true, createdAt: true },
  },
}

const view = ({ sessions, ...schedule }: Awaited<ReturnType<typeof listRows>>[number]) => ({
  ...schedule,
  lastRun: sessions[0] ?? null,
})

const listRows = (db: ScopedDb, where: { id?: string } = {}) =>
  db.schedule.findMany({ where, include: LIST, orderBy: { createdAt: 'desc' }, take: 500 })

/** The next firing after now, or null when the expression never fires again. */
const upcoming = (cron: string, timezone: string) => nextRun(cron, timezone) ?? null

/** When it says so in its own timezone, e.g. "12 Oct 2026, 07:00". */
const localTime = (date: Date, timezone: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)

export async function listSchedules(db: ScopedDb) {
  return (await listRows(db)).map(view)
}

async function getSchedule(db: ScopedDb, id: string) {
  const [row] = await listRows(db, { id })
  if (!row) throw new HTTPException(404, { message: 'Schedule not found' })
  return view(row)
}

async function requireSchedule(db: ScopedDb, id: string) {
  const schedule = await findSchedule(db, id)
  if (!schedule) throw new HTTPException(404, { message: 'Schedule not found' })
  return schedule
}

async function requireTeammate(db: ScopedDb, id: string) {
  const teammate = await db.teammate.findFirst({ where: { id, archivedAt: null } })
  if (!teammate) throw new HTTPException(404, { message: 'Teammate not found or archived' })
  return teammate
}

/** Its owner, or an owner or admin of the workspace: pause, resume, run now, delete. */
function requireManager(scope: WorkspaceScope, schedule: { ownerMemberId: string }) {
  if (schedule.ownerMemberId !== scope.memberId && scope.role === 'member')
    throw new HTTPException(403, {
      message: "This schedule runs on another member's accounts; only they or an admin manage it",
    })
}

function checked(cron: string, timezone: string) {
  const problem = cronProblem(cron, timezone)
  if (problem) throw new HTTPException(400, { message: problem })
}

async function changed(scope: Scope, actor: Actor, action: string, id: string, data?: object) {
  await audit({
    ...scope,
    actor,
    action,
    target: { type: 'schedule', id },
    ...(data ? { data: data as never } : {}),
  })
  broadcastSchedule(scope.workspaceId, id)
}

/** A new schedule, active at once, owned by the member whose accounts it runs on. */
export async function createSchedule(
  db: ScopedDb,
  scope: Scope,
  input: {
    teammateId: string
    title: string
    instructions: string
    cron: string
    timezone: string
  },
  by: { memberId: string; teammateId?: string },
) {
  await requireTeammate(db, input.teammateId)
  checked(input.cron, input.timezone)
  const schedule = await db.schedule.create({
    data: {
      teammateId: input.teammateId,
      title: input.title,
      instructions: input.instructions,
      cron: input.cron,
      timezone: input.timezone,
      ownerMemberId: by.memberId,
      createdByTeammateId: by.teammateId ?? null,
      nextRunAt: upcoming(input.cron, input.timezone),
    } as never,
  })
  await changed(
    scope,
    by.teammateId ? { type: 'teammate', id: by.teammateId } : { type: 'member', id: by.memberId },
    'schedule.created',
    schedule.id,
  )
  return getSchedule(db, schedule.id)
}

/** Edits and pausing, from the dashboard or a teammate's tool; the caller checked who may. */
async function applyChanges(
  db: ScopedDb,
  scope: Scope,
  schedule: Schedule,
  changes: Changes,
  actor: Actor,
) {
  if (changes.teammateId && changes.teammateId !== schedule.teammateId)
    await requireTeammate(db, changes.teammateId)
  const cron = changes.cron ?? schedule.cron
  const timezone = changes.timezone ?? schedule.timezone
  const timing = cron !== schedule.cron || timezone !== schedule.timezone
  if (timing) checked(cron, timezone)
  const paused = changes.paused ?? schedule.pausedAt !== null
  const resuming = schedule.pausedAt !== null && !paused
  await db.schedule.updateMany({
    where: { id: schedule.id },
    data: {
      ...(changes.teammateId ? { teammateId: changes.teammateId } : {}),
      ...(changes.title ? { title: changes.title } : {}),
      ...(changes.instructions ? { instructions: changes.instructions } : {}),
      cron,
      timezone,
      ...(paused
        ? { pausedAt: schedule.pausedAt ?? new Date(), nextRunAt: null }
        : timing || resuming
          ? { pausedAt: null, nextRunAt: upcoming(cron, timezone) }
          : {}),
    },
  })
  const action =
    changes.paused === true && !schedule.pausedAt
      ? 'schedule.paused'
      : resuming
        ? 'schedule.resumed'
        : 'schedule.updated'
  await changed(scope, actor, action, schedule.id)
  return getSchedule(db, schedule.id)
}

/** Only the owner edits: the instructions run on their accounts. */
export async function updateSchedule(
  db: ScopedDb,
  scope: WorkspaceScope,
  id: string,
  changes: Omit<Changes, 'paused'>,
) {
  const schedule = await requireSchedule(db, id)
  if (schedule.ownerMemberId !== scope.memberId)
    throw new HTTPException(403, {
      message: "This schedule runs on another member's accounts; only they can edit it",
    })
  return applyChanges(db, scope, schedule, changes, { type: 'member', id: scope.memberId })
}

export async function setPaused(db: ScopedDb, scope: WorkspaceScope, id: string, paused: boolean) {
  const schedule = await requireSchedule(db, id)
  requireManager(scope, schedule)
  return applyChanges(db, scope, schedule, { paused }, { type: 'member', id: scope.memberId })
}

/** Run now: a run outside the schedule; the next firing stays where it was. */
export async function runNow(db: ScopedDb, scope: WorkspaceScope, id: string) {
  const schedule = await requireSchedule(db, id)
  requireManager(scope, schedule)
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'schedule.run_now',
    target: { type: 'schedule', id },
  })
  const result = await fire(schedule, new Date())
  if ('skipped' in result) throw new HTTPException(409, { message: result.skipped })
  if ('error' in result) throw new HTTPException(409, { message: result.error })
  return result
}

/** The schedule goes; its threads stay as plain threads. */
export async function deleteSchedule(db: ScopedDb, scope: WorkspaceScope, id: string) {
  const schedule = await requireSchedule(db, id)
  requireManager(scope, schedule)
  await db.schedule.deleteMany({ where: { id } })
  await changed(scope, { type: 'member', id: scope.memberId }, 'schedule.deleted', id, {
    title: schedule.title,
  })
}

export type Firing = { threadId: string } | { skipped: string } | { error: string }

/**
 * Start one run: a fresh thread with the instructions, on the owner's accounts,
 * unless the previous run is still going. When it cannot start, the owner gets
 * a ticket (one open per schedule) and the error stays on the schedule.
 */
export async function fire(schedule: Schedule, dueAt: Date): Promise<Firing> {
  const scope: Scope = {
    organizationId: schedule.organizationId,
    workspaceId: schedule.workspaceId,
  }
  const db = scoped(scope)
  if (schedule.teammate.archivedAt) return { skipped: `${schedule.teammate.name} is archived` }

  const previous = await db.session.findFirst({
    where: { scheduleId: schedule.id },
    orderBy: { createdAt: 'desc' },
  })
  if (
    previous &&
    (previous.status === 'running' ||
      (previous.status === 'starting' &&
        Date.now() - previous.updatedAt.getTime() < STARTING_STALE_MS))
  )
    return { skipped: 'The previous run is still going' }

  const failed = async (message: string): Promise<Firing> => {
    await db.schedule.updateMany({ where: { id: schedule.id }, data: { lastError: message } })
    // Never silent: a ticket for the member whose accounts it runs on.
    const open = await db.ticket.count({
      where: {
        type: 'question',
        status: 'open',
        payload: { path: ['scheduleId'], equals: schedule.id },
      },
    })
    if (!open)
      await db.ticket.create({
        data: {
          type: 'question',
          title: `Schedule "${schedule.title}" could not start a run: ${message}`,
          payload: { scheduleId: schedule.id, memberId: schedule.ownerMemberId },
        } as never,
      })
    broadcastSchedule(scope.workspaceId, schedule.id)
    return { error: message }
  }

  // The workspace computer, or else the owner's own machine.
  const computer =
    (await db.computer.findFirst({ where: { kind: 'cloud', status: { not: 'destroyed' } } })) ??
    (await db.computer.findFirst({
      where: { kind: 'member_machine', memberId: schedule.ownerMemberId },
      orderBy: { updatedAt: 'desc' },
    }))
  if (!computer) return failed('the workspace has no computer')

  const text = [
    `Scheduled run of "${schedule.title}", due ${localTime(dueAt, schedule.timezone)} (${schedule.timezone}). ` +
      'Nobody is watching this thread live: do the work below, and open a ticket if you need a person.',
    '',
    schedule.instructions,
  ].join('\n')
  try {
    const { thread, outcome } = await startThread(db, scope, {
      teammate: schedule.teammate,
      computer,
      memberId: schedule.ownerMemberId,
      title: `${schedule.title} · ${localTime(dueAt, schedule.timezone)}`,
      text,
      origin: { kind: 'schedule', scheduleId: schedule.id },
    })
    if (outcome === 'offline') return failed('the computer is offline')
    if (schedule.lastError)
      await db.schedule.updateMany({ where: { id: schedule.id }, data: { lastError: null } })
    broadcastSchedule(scope.workspaceId, schedule.id)
    return { threadId: thread.id }
  } catch (error) {
    if (error instanceof HTTPException) return failed(error.message)
    throw error
  }
}

let ticking = false

/**
 * Fire every schedule that is due. Moving nextRunAt is the claim: only the tick
 * that moves it off the due value fires, so a firing never starts twice. The
 * next firing is counted from now, so missed ones (downtime) collapse into one.
 */
async function tick() {
  if (ticking) return
  ticking = true
  try {
    const now = new Date()
    const due = await prisma.schedule.findMany({
      where: { pausedAt: null, nextRunAt: { lte: now } },
      orderBy: { nextRunAt: 'asc' },
      take: 100,
      include: { teammate: true },
    })
    for (const schedule of due) {
      let next: Date | null = null
      try {
        next = upcoming(schedule.cron, schedule.timezone)
      } catch (error) {
        console.error(`schedule ${schedule.id}: bad cron, it stops`, error)
      }
      const { count } = await prisma.schedule.updateMany({
        where: { id: schedule.id, nextRunAt: schedule.nextRunAt },
        data: { nextRunAt: next },
      })
      if (!count) continue
      const result = await fire(schedule, schedule.nextRunAt!).catch((error: unknown) => {
        console.error(`schedule ${schedule.id}: could not fire`, error)
        return null
      })
      if (result && 'skipped' in result)
        console.log(`schedule ${schedule.id}: skipped, ${result.skipped}`)
    }
  } finally {
    ticking = false
  }
}

/** Tick at the start of every minute, so a 07:00 run starts at 07:00. */
export function watchSchedules() {
  const later = () =>
    setTimeout(
      () =>
        void tick()
          .catch((error) => console.error('schedule tick failed', error))
          .finally(later),
      60_000 - (Date.now() % 60_000) + 250,
    ).unref()
  later()
}

/** What a teammate is told about a schedule. */
const brief = (s: {
  id: string
  title: string
  cron: string
  timezone: string
  pausedAt: Date | null
}) => ({
  scheduleId: s.id,
  title: s.title,
  cron: s.cron,
  timezone: s.timezone,
  paused: s.pausedAt !== null,
  nextRuns: s.pausedAt ? [] : nextRuns(s.cron, s.timezone, 3).map((d) => localTime(d, s.timezone)),
})

/**
 * A teammate's schedule tools, from a thread a member started on this runner's
 * computer. Its schedules run on that member's accounts, so only they are touched.
 */
export async function handleScheduleCall(
  runner: Runner,
  call: Extract<RunnerToApi, { type: 'schedule.call' }>,
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
  })
  if (!session) return fail('Unknown thread')
  const teammate = await actingTeammate(db, session, call.teammateId)
  if (!teammate) return fail('That teammate is not in this thread')
  if (session.origin !== 'member')
    return fail('Schedules are set up only from a thread a person started. Just do the work here.')
  const op: ScheduleOperation = call.operation
  const actor: Actor = { type: 'teammate', id: teammate.id }

  try {
    if (op.name === 'create') {
      // Unset: the zone of the person's latest schedule, else UTC.
      const timezone =
        op.timezone ??
        (
          await db.schedule.findFirst({
            where: { ownerMemberId: session.startedByMemberId },
            orderBy: { createdAt: 'desc' },
            select: { timezone: true },
          })
        )?.timezone ??
        'UTC'
      const problem = cronProblem(op.cron, timezone)
      if (problem) return fail(problem)
      const schedule = await createSchedule(
        db,
        scope,
        {
          teammateId: teammate.id,
          title: op.title,
          instructions: op.instructions,
          cron: op.cron,
          timezone,
        },
        { memberId: session.startedByMemberId, teammateId: teammate.id },
      )
      return done({
        ...brief(schedule),
        note:
          'The schedule is active. Each run starts a fresh thread with the instructions as its first message. ' +
          'Tell the person in one line when it runs (in words, with the timezone) and the next run.' +
          (op.timezone ? '' : ` No timezone was given, so it uses ${timezone}; say so.`),
      })
    }

    const mine = await db.schedule.findMany({
      where: { teammateId: teammate.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    if (op.name === 'list') return done({ schedules: mine.map(brief) })

    const schedule = mine.find((s) => s.id === op.scheduleId)
    if (!schedule) return fail('No schedule of yours has that id; list_schedules shows them')
    if (schedule.ownerMemberId !== session.startedByMemberId)
      return fail(
        "That schedule runs on another member's accounts; only they can change it, on the Automations page",
      )
    const { scheduleId: _, name: __, ...changes } = op
    const updated = await applyChanges(db, scope, { ...schedule, teammate }, changes, actor)
    return done(brief(updated))
  } catch (error) {
    if (error instanceof HTTPException) return fail(error.message)
    throw error
  }
}
