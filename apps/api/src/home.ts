// Home under the composer, for one member: their loose ends (nobody is blocked, but
// nothing moves on its own) and what came back since they last looked. Only what
// Brigade knows for sure: a reply ending on buttons nobody clicked, a running thread
// with no event for a while, a routine whose last run failed. Pull requests and
// tickets that wait on a person are Waiting on you, not here.
import { replyCard } from '@brigade/contracts'
import type { ScopedDb } from './db.js'
import { eventsWaitingSince } from './hub.js'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
/** A teammate's proposal is a loose end once nobody answered it for this long. */
const PROPOSAL_AFTER = 30 * MINUTE
/** A running thread with no event for this long has stalled, or works out of sight. */
const STALLED_AFTER = 60 * MINUTE
/** Threads looked at: those active lately. */
const RECENT = 14 * DAY
/** Results listed, newest first. */
const LISTED = 8

export type LooseEnd =
  | {
      kind: 'proposal'
      key: string
      at: string
      thread: { id: string; title: string }
      teammate: { id: string; name: string }
      /** The first button's words: a click sends them. Null for choices, picked in the thread. */
      reply: string | null
      /** What the buttons offer, as the teammate wrote them. */
      offers: string[]
    }
  | {
      kind: 'stalled'
      key: string
      at: string
      thread: { id: string; title: string }
      teammate: { id: string; name: string }
      /** Its last event, or since when its events have not reached Brigade. */
      quietSince: string
      offline: boolean
    }
  | {
      kind: 'routine'
      key: string
      at: string
      schedule: { id: string; title: string }
      /** The failed run, when one started. */
      run: { id: string } | null
      error: string | null
    }

export type HomeResult =
  | {
      kind: 'thread'
      at: string
      thread: { id: string; title: string; status: string }
      teammate: { id: string; name: string }
      /** A pull request it opened since the member last looked. */
      pull: { repository: string; number: number; state: string } | null
    }
  | {
      kind: 'decision'
      at: string
      verdict: 'approved' | 'denied' | 'resolved'
      title: string
      thread: { id: string; title: string } | null
    }
  | {
      kind: 'merged'
      at: string
      pull: { repository: string; number: number; title: string }
      thread: { id: string; title: string } | null
      byYou: boolean
    }

export async function homeFor(db: ScopedDb, memberId: string, now = new Date()) {
  const threads = await db.session.findMany({
    where: {
      startedByMemberId: memberId,
      parentId: null,
      archivedAt: null,
      updatedAt: { gte: new Date(now.getTime() - RECENT) },
    },
    orderBy: { updatedAt: 'desc' },
    take: 60,
    select: {
      id: true,
      title: true,
      status: true,
      lastSeq: true,
      teammate: { select: { id: true, name: true } },
    },
  })
  const ids = threads.map((t) => t.id)
  const [latest, reads, tickets, dismissed, schedules] = await Promise.all([
    ids.length
      ? db.sessionEvent.groupBy({
          by: ['sessionId', 'type'],
          where: {
            sessionId: { in: ids },
            type: { in: ['message.user', 'message.done', 'turn.completed'] },
          },
          _max: { seq: true, at: true },
        })
      : [],
    ids.length
      ? db.threadRead.findMany({
          where: { memberId, sessionId: { in: ids } },
          select: { sessionId: true, seenAt: true },
        })
      : [],
    // A thread held by an open ticket is Waiting on you.
    ids.length
      ? db.ticket.findMany({
          where: { sessionId: { in: ids }, status: 'open' },
          select: { sessionId: true },
        })
      : [],
    db.homeDismissal.findMany({ where: { memberId }, select: { key: true } }),
    db.schedule.findMany({
      where: { ownerMemberId: memberId, pausedAt: null },
      select: {
        id: true,
        title: true,
        lastError: true,
        updatedAt: true,
        sessions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, status: true, updatedAt: true },
        },
      },
    }),
  ])
  const max = (id: string, type: string) =>
    latest.find((l) => l.sessionId === id && l.type === type)?._max
  const held = new Set(tickets.map((t) => t.sessionId))
  const gone = new Set(dismissed.map((d) => d.key))

  // The last reply of each idle thread nobody wrote in since.
  const answered = threads.filter((t) => {
    if (t.status !== 'idle' || held.has(t.id)) return false
    const done = max(t.id, 'message.done')?.seq
    return done != null && (max(t.id, 'message.user')?.seq ?? -1) < done
  })
  const lastReplies = answered.length
    ? await db.sessionEvent.findMany({
        where: {
          OR: answered.map((t) => ({ sessionId: t.id, seq: max(t.id, 'message.done')!.seq! })),
        },
        select: { sessionId: true, seq: true, at: true, data: true },
      })
    : []

  const loose: LooseEnd[] = []
  for (const event of lastReplies) {
    if (now.getTime() - event.at.getTime() < PROPOSAL_AFTER) continue
    const card = replyCard(String((event.data as { text?: unknown }).text ?? ''))
    const offers = card.replies
      ? [...(card.replies.actions ?? []).map((a) => a.label), ...card.replies.replies]
      : (card.choices?.options.map((o) => o.label) ?? [])
    if (!offers.length) continue
    const key = `proposal:${event.sessionId}:${event.seq}`
    if (gone.has(key)) continue
    const thread = threads.find((t) => t.id === event.sessionId)!
    loose.push({
      kind: 'proposal',
      key,
      at: event.at.toISOString(),
      thread: { id: thread.id, title: thread.title },
      teammate: thread.teammate,
      // A Brigade action (merge) runs from the thread's own button, not from here.
      reply: card.replies?.replies[0] ?? null,
      offers,
    })
  }

  // Running threads that went quiet: grouped by thread, their latest event of any kind.
  const running = threads.filter((t) => t.status === 'running' || t.status === 'starting')
  const lastEvents = running.length
    ? await db.sessionEvent.groupBy({
        by: ['sessionId'],
        where: { sessionId: { in: running.map((t) => t.id) } },
        _max: { at: true },
      })
    : []
  for (const t of running) {
    const waiting = eventsWaitingSince(t.id)
    const last = lastEvents.find((e) => e.sessionId === t.id)?._max.at
    const quietSince = waiting ? new Date(waiting) : last
    if (!quietSince || now.getTime() - quietSince.getTime() < STALLED_AFTER) continue
    const key = `stalled:${t.id}:${t.lastSeq}`
    if (gone.has(key)) continue
    loose.push({
      kind: 'stalled',
      key,
      at: quietSince.toISOString(),
      thread: { id: t.id, title: t.title },
      teammate: t.teammate,
      quietSince: quietSince.toISOString(),
      offline: !!waiting,
    })
  }

  // Routines whose last firing could not start, or whose last run failed.
  for (const s of schedules) {
    const run = s.sessions[0]
    const failedRun = run?.status === 'failed' ? run : null
    if (!s.lastError && !failedRun) continue
    const key = s.lastError
      ? `routine:${s.id}:error:${s.updatedAt.getTime()}`
      : `routine:${s.id}:${failedRun!.id}`
    if (gone.has(key)) continue
    loose.push({
      kind: 'routine',
      key,
      at: (s.lastError ? s.updatedAt : failedRun!.updatedAt).toISOString(),
      schedule: { id: s.id, title: s.title },
      run: failedRun ? { id: failedRun.id } : null,
      error: s.lastError,
    })
  }
  loose.sort((a, b) => b.at.localeCompare(a.at))

  // What came back: threads with a reply they have not read, their decisions and merges of the day.
  const looseThreads = new Set(loose.flatMap((l) => ('thread' in l ? [l.thread.id] : [])))
  const unread = threads.filter((t) => {
    if (looseThreads.has(t.id) || held.has(t.id)) return false
    if (t.status === 'running' || t.status === 'starting') return false
    const turn = max(t.id, 'turn.completed')?.at
    const seen = reads.find((r) => r.sessionId === t.id)?.seenAt
    return !!turn && (!seen || turn > seen)
  })
  const since = new Date(now.getTime() - DAY)
  const [opened, decisions, merged] = await Promise.all([
    unread.length
      ? db.pullRequest.findMany({
          where: { sessionId: { in: unread.map((t) => t.id) } },
          orderBy: { createdAt: 'desc' },
          select: { sessionId: true, repository: true, number: true, state: true, createdAt: true },
        })
      : [],
    db.ticket.findMany({
      where: { resolvedByMemberId: memberId, resolvedAt: { gte: since } },
      orderBy: { resolvedAt: 'desc' },
      take: LISTED,
      select: {
        title: true,
        status: true,
        resolvedAt: true,
        session: { select: { id: true, title: true } },
      },
    }),
    db.pullRequest.findMany({
      where: {
        mergedAt: { gte: since },
        OR: [{ requestedByMemberId: memberId }, { session: { startedByMemberId: memberId } }],
      },
      orderBy: { mergedAt: 'desc' },
      take: LISTED,
      select: {
        repository: true,
        number: true,
        title: true,
        mergedAt: true,
        requestedByMemberId: true,
        session: { select: { id: true, title: true } },
      },
    }),
  ])

  const results: HomeResult[] = [
    ...unread.map((t): HomeResult => {
      const seen = reads.find((r) => r.sessionId === t.id)?.seenAt
      // A pull request merged today has its own row, which says who merged it.
      const pull = opened.find(
        (p) =>
          p.sessionId === t.id &&
          (!seen || p.createdAt > seen) &&
          !merged.some((m) => m.repository === p.repository && m.number === p.number),
      )
      return {
        kind: 'thread',
        at: max(t.id, 'turn.completed')!.at!.toISOString(),
        thread: { id: t.id, title: t.title, status: t.status },
        teammate: t.teammate,
        pull: pull ? { repository: pull.repository, number: pull.number, state: pull.state } : null,
      }
    }),
    ...decisions.map((d): HomeResult => ({
      kind: 'decision',
      at: d.resolvedAt!.toISOString(),
      verdict: d.status === 'open' ? 'resolved' : d.status,
      title: d.title,
      thread: d.session,
    })),
    ...merged.map((p): HomeResult => ({
      kind: 'merged',
      at: p.mergedAt!.toISOString(),
      pull: { repository: p.repository, number: p.number, title: p.title },
      thread: p.session,
      byYou: p.requestedByMemberId === memberId,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at))

  return { looseEnds: loose, results: results.slice(0, LISTED) }
}

/** Set a loose end aside: it stays gone until the thing it names changes. */
export async function dismissLooseEnd(
  db: ScopedDb,
  scope: { organizationId: string; workspaceId: string; memberId: string },
  key: string,
) {
  await db.homeDismissal.upsert({
    where: { memberId_key: { memberId: scope.memberId, key } },
    create: {
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      memberId: scope.memberId,
      key,
    },
    update: { dismissedAt: new Date() },
  })
}
