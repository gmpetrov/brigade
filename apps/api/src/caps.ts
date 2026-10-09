// Daily caps per teammate: threads started, computer hours, and write calls
// per connection. Counted from the thread, event and call logs; days are UTC.
import type { Caps } from '@brigade/contracts'
import type { ScopedDb } from './db.js'

export type CapName = keyof Caps
export type CapReached = { cap: CapName; limit: number; used: number }

export const capLabel: Record<CapName, string> = {
  threadsPerDay: 'threads per day',
  computerHoursPerDay: 'computer hours per day',
  writeCallsPerConnectionPerDay: 'write calls per connection per day',
}

export function dayStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

const limitOf = (caps: unknown, cap: CapName) => {
  const value = (caps as Caps | null)?.[cap]
  return typeof value === 'number' ? value : null
}

/** Event types that start or end a stretch of the teammate working. */
const STARTS = new Set(['message.user', 'approval.resolved', 'question.answered'])
const ENDS = new Set([
  'approval.requested',
  'question.asked',
  'turn.completed',
  'error',
  'control.changed',
])

/**
 * Seconds the teammate's threads spent working since `since`: from a prompt or
 * an approval to the end of the turn or the next approval request.
 */
export async function workingSeconds(
  db: ScopedDb,
  teammateId: string,
  since: Date,
  now = new Date(),
) {
  const events = await db.sessionEvent.findMany({
    where: {
      session: { teammateId },
      at: { gte: since },
      type: { in: [...STARTS, ...ENDS, 'account.switched'] },
    },
    select: { sessionId: true, type: true, at: true, data: true },
    orderBy: [{ sessionId: 'asc' }, { seq: 'asc' }],
  })
  let total = 0
  for (const [, list] of Map.groupBy(events, (e) => e.sessionId)) {
    let startedAt: number | null = null
    for (const [i, e] of list.entries()) {
      const pausedBySwitch =
        e.type === 'account.switched' && !(e.data as { toAccountId?: string | null }).toAccountId
      if (STARTS.has(e.type)) startedAt ??= e.at.getTime()
      else if (ENDS.has(e.type) || pausedBySwitch) {
        // A turn that began before `since` counts from `since`.
        const from = startedAt ?? (i === 0 ? since.getTime() : null)
        if (from !== null) total += e.at.getTime() - from
        startedAt = null
      }
    }
    if (startedAt !== null) total += now.getTime() - startedAt
  }
  return total / 1000
}

/** Caps that stop a new turn: threads started (for a new thread) and computer hours. */
export async function turnCapReached(
  db: ScopedDb,
  teammate: { id: string; caps: unknown },
  thread: { id: string; isNew: boolean },
): Promise<CapReached | null> {
  const since = dayStart()
  const threads = limitOf(teammate.caps, 'threadsPerDay')
  if (thread.isNew && threads !== null) {
    const used = await db.session.count({
      where: { teammateId: teammate.id, createdAt: { gte: since }, id: { not: thread.id } },
    })
    if (used >= threads) return { cap: 'threadsPerDay', limit: threads, used }
  }
  const hours = limitOf(teammate.caps, 'computerHoursPerDay')
  if (hours !== null) {
    const used = (await workingSeconds(db, teammate.id, since)) / 3600
    if (used >= hours)
      return { cap: 'computerHoursPerDay', limit: hours, used: Math.round(used * 100) / 100 }
  }
  return null
}

/** The write-call cap for one connection: calls actually made today (ok or failed). */
export async function writeCapReached(
  db: ScopedDb,
  teammate: { id: string; caps: unknown },
  connectionId: string,
): Promise<CapReached | null> {
  const limit = limitOf(teammate.caps, 'writeCallsPerConnectionPerDay')
  if (limit === null) return null
  const used = await db.connectionCall.count({
    where: {
      teammateId: teammate.id,
      connectionId,
      write: true,
      result: { in: ['ok', 'error'] },
      createdAt: { gte: dayStart() },
    },
  })
  return used >= limit ? { cap: 'writeCallsPerConnectionPerDay', limit, used } : null
}

/** Today's use against each cap, for the teammate page. */
export async function usageToday(db: ScopedDb, teammate: { id: string; caps: unknown }) {
  const since = dayStart()
  const [threads, seconds, writes] = await Promise.all([
    db.session.count({ where: { teammateId: teammate.id, createdAt: { gte: since } } }),
    workingSeconds(db, teammate.id, since),
    db.connectionCall.groupBy({
      by: ['connectionId'],
      where: {
        teammateId: teammate.id,
        write: true,
        result: { in: ['ok', 'error'] },
        createdAt: { gte: since },
      },
      _count: { _all: true },
    }),
  ])
  return {
    since: since.toISOString(),
    caps: teammate.caps as Caps,
    threads,
    computerHours: Math.round((seconds / 3600) * 100) / 100,
    writeCalls: Object.fromEntries(writes.map((w) => [w.connectionId, w._count._all])),
  }
}
