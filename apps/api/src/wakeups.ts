// Wake-ups: a teammate asks to be prompted again in its thread at a time
// ("check CI in 10 minutes"). Unlike a schedule's run, which starts a fresh
// thread, a wake-up continues the same one, with the conversation so far. They
// live in the database and the minute tick fires them, so a restart or a deploy
// loses none, and the API runs them the same on a server and on Workers.
import {
  WAKEUPS_IN_A_ROW,
  WAKEUPS_PER_THREAD,
  wakeTime,
  type ScheduleOperation,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit, type Actor } from './audit.js'
import { prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { broadcastThreadStatus } from './hub.js'
import { localTime, memberTimezone } from './schedules.js'
import type { WorkspaceScope } from './scope.js'
import { loadThread } from './thread-spec.js'
import { settleOverdueChildren } from './children.js'
import { settleOverdueDryRuns } from './playbook-dry-runs.js'
import { promptThread } from './work.js'

type WakeupOperation = Extract<
  ScheduleOperation,
  { name: 'wake' | 'list_wakeups' | 'cancel_wakeup' }
>

/** A wake-up whose computer stays offline this long after it was due is given up. */
const MISSED_AFTER_MS = 24 * 60 * 60_000

export const isWakeupOperation = (op: ScheduleOperation): op is WakeupOperation =>
  op.name === 'wake' || op.name === 'list_wakeups' || op.name === 'cancel_wakeup'

type Session = { id: string; origin: string; startedByMemberId: string; status: string }

const changed = (scope: Scope, session: { id: string; status: string }) =>
  broadcastThreadStatus(scope.workspaceId, session.id, session.status)

/**
 * Wake-ups fired in the thread since a person last wrote in it. A wake-up's own
 * prompt has no member, so a teammate checking again and again counts up.
 */
export async function firedInARow(db: ScopedDb, sessionId: string) {
  const messages = await db.sessionEvent.findMany({
    where: { sessionId, type: 'message.user' },
    orderBy: { seq: 'desc' },
    take: 50,
    select: { data: true, at: true },
  })
  const last = messages.find((m) => (m.data as { memberId?: string | null }).memberId)
  return db.wakeup.count({
    where: { sessionId, status: 'fired', firedAt: { gt: last?.at ?? new Date(0) } },
  })
}

/** A teammate's wake-up tools, from a thread a person started. */
export async function handleWakeup(
  db: ScopedDb,
  scope: Scope,
  session: Session,
  teammate: { id: string; name: string },
  op: WakeupOperation,
): Promise<object | { error: string }> {
  if (session.origin !== 'member')
    return {
      error:
        'Wake-ups are set only in a thread a person started. Finish the work now, or open a ticket.',
    }
  const timezone = await memberTimezone(db, session.startedByMemberId)
  const brief = (w: { id: string; note: string; wakeAt: Date }) => ({
    wakeupId: w.id,
    note: w.note,
    wakeAt: w.wakeAt.toISOString(),
    local: `${localTime(w.wakeAt, timezone)} (${timezone})`,
  })
  const pending = await db.wakeup.findMany({
    where: { sessionId: session.id, teammateId: teammate.id, status: 'pending', kind: 'wakeup' },
    orderBy: { wakeAt: 'asc' },
  })

  if (op.name === 'list_wakeups') return { wakeups: pending.map(brief) }

  if (op.name === 'cancel_wakeup') {
    const wakeup = pending.find((w) => w.id === op.wakeupId)
    if (!wakeup)
      return { error: 'No pending wake-up of yours has that id; list_wakeups shows them' }
    await cancel(db, scope, session, wakeup.id, { type: 'teammate', id: teammate.id })
    return { cancelled: brief(wakeup) }
  }

  const when = wakeTime(op)
  if (typeof when === 'string') return { error: when }
  if (pending.length >= WAKEUPS_PER_THREAD)
    return {
      error:
        `You already have ${pending.length} wake-ups pending in this thread, the most it holds. ` +
        'Cancel one (list_wakeups shows them) or wait for it.',
    }
  if ((await firedInARow(db, session.id)) >= WAKEUPS_IN_A_ROW)
    return {
      error:
        `You woke yourself ${WAKEUPS_IN_A_ROW} times in a row in this thread with no word from a person. ` +
        'Stop checking: tell the person where things stand, or open a ticket if you need them.',
    }
  const wakeup = await db.wakeup.create({
    data: { sessionId: session.id, teammateId: teammate.id, note: op.note, wakeAt: when } as never,
  })
  await audit({
    ...scope,
    actor: { type: 'teammate', id: teammate.id },
    action: 'wakeup.created',
    target: { type: 'thread', id: session.id },
    data: { wakeupId: wakeup.id, wakeAt: when.toISOString() },
  })
  changed(scope, session)
  return {
    ...brief(wakeup),
    next:
      'Set. At that time you are prompted again in this thread with your note. End your turn now; ' +
      'do not wait or poll. Tell the person in one line when you will check again.',
  }
}

async function cancel(
  db: ScopedDb,
  scope: Scope,
  session: { id: string; status: string },
  id: string,
  actor: Actor,
) {
  const { count } = await db.wakeup.updateMany({
    where: { id, sessionId: session.id, status: 'pending', kind: 'wakeup' },
    data: { status: 'cancelled' },
  })
  if (!count) return false
  await audit({
    ...scope,
    actor,
    action: 'wakeup.cancelled',
    target: { type: 'thread', id: session.id },
    data: { wakeupId: id },
  })
  changed(scope, session)
  return true
}

/** A member cancels one from the thread's panel: whoever may change the thread. */
export async function cancelWakeup(
  db: ScopedDb,
  scope: WorkspaceScope,
  session: { id: string; status: string },
  id: string,
) {
  if (!(await cancel(db, scope, session, id, { type: 'member', id: scope.memberId })))
    throw new HTTPException(404, { message: 'No pending wake-up with that id in this thread' })
}

/** The prompt a wake-up brings back. */
function prompt(
  wakeup: { note: string; wakeAt: Date; createdAt: Date },
  now: Date,
  timezone: string,
) {
  const late = now.getTime() - wakeup.wakeAt.getTime()
  return (
    `Wake-up you set at ${localTime(wakeup.createdAt, timezone)} (${timezone})` +
    (late > 5 * 60_000
      ? `, ${Math.round(late / 60_000)} minutes late (the computer was offline)`
      : '') +
    `: ${wakeup.note}\n\n` +
    'Check it now and tell the person what you found. Set another wake-up only if it is still not ready.'
  )
}

/** Fire one due wake-up into its thread, or say it waits for the next tick. */
async function fire(wakeup: {
  id: string
  organizationId: string
  workspaceId: string
  sessionId: string
  teammateId: string
  note: string
  kind: 'wakeup' | 'report'
  wakeAt: Date
  createdAt: Date
}) {
  const scope: Scope = { organizationId: wakeup.organizationId, workspaceId: wakeup.workspaceId }
  const db = scoped(scope)
  const now = new Date()
  const thread = await loadThread(db, wakeup.sessionId)
  const settle = async (status: 'fired' | 'missed') => {
    // Moving it off pending is the claim: another tick that read it too does nothing.
    const { count } = await db.wakeup.updateMany({
      where: { id: wakeup.id, status: 'pending' },
      data: { status, firedAt: now },
    })
    return count === 1
  }
  // A person has the computer: it waits until they hand back, as the teammate does.
  if (thread.controlledByMemberId) return
  // The teammate left the thread or was archived: nobody to wake. Children's reports go to whoever is there.
  const seat = thread.teammates.find((t) => t.teammateId === wakeup.teammateId)
  const report = wakeup.kind === 'report'
  if ((!seat || seat.teammate.archivedAt) && !report) {
    await settle('missed')
    return changed(scope, thread)
  }
  if (!(await settle('fired'))) return
  // Archived meanwhile, the thread comes back with the reports, as with a new message.
  if (report && thread.archivedAt)
    await db.session.updateMany({ where: { id: thread.id }, data: { archivedAt: null } })
  const outcome = await promptThread(db, scope, thread, {
    text: report
      ? wakeup.note
      : prompt(wakeup, now, await memberTimezone(db, thread.startedByMemberId)),
    memberId: null,
    ...(seat && !seat.teammate.archivedAt ? { teammateIds: [wakeup.teammateId] } : {}),
  }).catch((error: unknown) => {
    console.error(`wake-up ${wakeup.id}: could not prompt`, error)
    return 'offline' as const
  })
  // A member's machine asleep: pending again, tried each minute, until it is too late.
  if (outcome === 'offline') {
    const missed = now.getTime() - wakeup.wakeAt.getTime() > MISSED_AFTER_MS
    await db.wakeup.updateMany({
      where: { id: wakeup.id },
      data: missed ? { status: 'missed' } : { status: 'pending', firedAt: null },
    })
  }
  // paused: a cap ticket holds the prompt and sends it when allowed.
  changed(scope, thread)
}

/** A children's report, fired as soon as it is made (src/children.ts); it waits like any wake-up when it cannot go. */
export async function fireReport(id: string) {
  const wakeup = await prisma.wakeup.findFirst({ where: { id, status: 'pending' } })
  if (wakeup)
    await fire(wakeup).catch((error: unknown) =>
      console.error(`report ${wakeup.id}: could not fire`, error),
    )
}

let ticking = false

/** Fire every wake-up that is due. */
export async function fireDueWakeups() {
  if (ticking) return
  ticking = true
  try {
    const due = await prisma.wakeup.findMany({
      where: { status: 'pending', wakeAt: { lte: new Date() } },
      orderBy: { wakeAt: 'asc' },
      take: 100,
    })
    for (const wakeup of due)
      await fire(wakeup).catch((error: unknown) =>
        console.error(`wake-up ${wakeup.id}: could not fire`, error),
      )
    // Children whose parent's wait ran out: it hears what is done.
    await settleOverdueChildren()
    // Dry runs' events that took too long: left out, so the report comes.
    await settleOverdueDryRuns()
  } finally {
    ticking = false
  }
}

/** Tick at the start of every minute, as schedules do. */
export function watchWakeups() {
  const later = () =>
    setTimeout(
      () =>
        void fireDueWakeups()
          .catch((error) => console.error('wake-up tick failed', error))
          .finally(later),
      60_000 - (Date.now() % 60_000) + 500,
    )
  later()
}
