// The latest event of a type in each of several threads. Prisma's `distinct` does this
// in memory: the database sends every matching event, data and all, and all but one per
// thread are dropped (a thread list sent about 340 a call, for one preview each). Here
// the database finds each thread's latest seq, then sends those rows only.
import type { ScopedDb } from './db.js'

export async function latestEvents(db: ScopedDb, sessionIds: string[], type: string) {
  if (!sessionIds.length) return []
  const latest = await db.sessionEvent.groupBy({
    by: ['sessionId'],
    where: { sessionId: { in: sessionIds }, type },
    _max: { seq: true },
  })
  if (!latest.length) return []
  return db.sessionEvent.findMany({
    where: { OR: latest.map((l) => ({ sessionId: l.sessionId, seq: l._max.seq! })) },
    select: { sessionId: true, at: true, data: true },
  })
}
