// Home under the composer, for one member: their loose ends (nobody is blocked, but
// nothing moves on its own) and what came back since they last looked. Only what
// Brigade knows for sure: a reply ending on buttons nobody clicked, a running thread
// with no event for a while, a thread that failed, a routine whose last run failed. Pull requests and
// tickets that wait on a person are Waiting on you, not here.
import {
  bareToolName,
  OFFER_CHOICES_TOOL,
  safeChoices,
  safeReplies,
  SUGGEST_REPLIES_TOOL,
  THREAD_NOTE_SOURCE,
} from '@brigade/contracts'
import type { ScopedDb } from './db.js'
import { eventsWaitingSince } from './hub.js'
import { waitingOnPerson } from './pull-requests.js'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
/** A teammate's proposal is a loose end once nobody answered it for this long… */
const PROPOSAL_AFTER = 30 * MINUTE
/** …and until it is this old: past that, the member moved on. */
const PROPOSAL_UNTIL = DAY
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
      kind: 'failed'
      key: string
      at: string
      thread: { id: string; title: string }
      teammate: { id: string; name: string }
      /** What the teammate's last error said, when it said something. */
      error: string | null
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

/** A thread with a teammate's reply the member has not read. */
export type HomeResult = {
  kind: 'thread'
  at: string
  thread: { id: string; title: string; status: string }
  teammate: { id: string; name: string }
  /** A pull request it opened or merged since the member last looked. */
  pull: { repository: string; number: number; state: string } | null
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
      updatedAt: true,
      scheduleId: true,
      teammate: { select: { id: true, name: true } },
    },
  })
  const ids = threads.map((t) => t.id)
  const [latest, reads, tickets, pullsWaiting, dismissed, schedules] = await Promise.all([
    ids.length
      ? db.sessionEvent.groupBy({
          by: ['sessionId', 'type'],
          where: {
            sessionId: { in: ids },
            type: { in: ['message.user', 'turn.completed'] },
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
    // A thread held by an open ticket is Waiting on you, not here.
    ids.length
      ? db.ticket.findMany({
          where: { sessionId: { in: ids }, status: 'open' },
          select: { sessionId: true },
        })
      : [],
    // So is one whose pull request waits on a person.
    ids.length
      ? db.pullRequest.findMany({
          where: { ...waitingOnPerson, sessionId: { in: ids } },
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
  const held = new Set([...tickets, ...pullsWaiting].map((t) => t.sessionId))
  const gone = new Set(dismissed.map((d) => d.key))

  // The buttons or choices each idle thread ended on. The runner takes them out of the
  // reply's text and records them as a card tool's call (apps/runner/src/harness/events.ts),
  // as the thread reads them. They stand until someone writes in the thread or a note
  // settles them (a pull request merged from its card), as the thread shows them.
  const idle = threads.filter((t) => t.status === 'idle' && !held.has(t.id))
  const [cards, notes, closedPulls] = idle.length
    ? await Promise.all([
        db.sessionEvent.findMany({
          where: {
            sessionId: { in: idle.map((t) => t.id) },
            type: 'tool.started',
            OR: [
              { data: { path: ['toolName'], string_ends_with: SUGGEST_REPLIES_TOOL } },
              { data: { path: ['toolName'], string_ends_with: OFFER_CHOICES_TOOL } },
            ],
          },
          orderBy: { seq: 'desc' },
          select: { sessionId: true, seq: true, at: true, data: true },
        }),
        db.sessionEvent.groupBy({
          by: ['sessionId'],
          where: {
            sessionId: { in: idle.map((t) => t.id) },
            type: 'raw',
            data: { path: ['source'], equals: THREAD_NOTE_SOURCE },
          },
          _max: { seq: true },
        }),
        // A pull request merged or closed since settles what was asked about it, from
        // wherever it was merged (GitHub, Home, the card).
        db.pullRequest.findMany({
          where: { sessionId: { in: idle.map((t) => t.id) }, state: { in: ['merged', 'closed'] } },
          select: { sessionId: true, updatedAt: true, mergedAt: true },
        }),
      ])
    : [[], [], []]

  const loose: LooseEnd[] = []
  for (const thread of idle) {
    const event = cards.find((c) => c.sessionId === thread.id)
    const age = event ? now.getTime() - event.at.getTime() : 0
    if (!event || age < PROPOSAL_AFTER || age > PROPOSAL_UNTIL) continue
    if (
      closedPulls.some((p) => p.sessionId === thread.id && (p.mergedAt ?? p.updatedAt) > event.at)
    )
      continue
    const settled = Math.max(
      max(thread.id, 'message.user')?.seq ?? -1,
      notes.find((n) => n.sessionId === thread.id)?._max.seq ?? -1,
    )
    if (settled > event.seq) continue
    const { toolName, input } = event.data as { toolName?: string; input?: unknown }
    const name = bareToolName(String(toolName ?? ''))
    const replies = name === SUGGEST_REPLIES_TOOL ? safeReplies(input) : null
    const choices = name === OFFER_CHOICES_TOOL ? safeChoices(input) : null
    const offers = replies
      ? [...(replies.actions ?? []).map((a) => a.label), ...replies.replies]
      : (choices?.options.map((o) => o.label) ?? [])
    if (!offers.length) continue
    const key = `proposal:${thread.id}:${event.seq}`
    if (gone.has(key)) continue
    loose.push({
      kind: 'proposal',
      key,
      at: event.at.toISOString(),
      thread: { id: thread.id, title: thread.title },
      teammate: thread.teammate,
      // A Brigade action (merge) runs from the thread's own button, not from here.
      reply: replies?.replies[0] ?? null,
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

  // Threads that failed: until someone writes in them again, nothing moves. A routine's
  // run is its routine's loose end, below.
  const failed = threads.filter((t) => t.status === 'failed' && !t.scheduleId && !held.has(t.id))
  const errors = failed.length
    ? await db.sessionEvent.findMany({
        where: { sessionId: { in: failed.map((t) => t.id) }, type: 'error' },
        orderBy: { seq: 'desc' },
        distinct: ['sessionId'],
        select: { sessionId: true, at: true, data: true },
      })
    : []
  loose.push(...failedLooseEnds(failed, errors, gone))

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

  // What came back: threads with a teammate's reply they have not read. Not their own
  // decisions: they made them; what came of one is the reply that follows.
  const looseThreads = new Set(loose.flatMap((l) => ('thread' in l ? [l.thread.id] : [])))
  const unread = threads.filter((t) => {
    if (looseThreads.has(t.id) || held.has(t.id)) return false
    if (t.status === 'running' || t.status === 'starting') return false
    const turn = max(t.id, 'turn.completed')?.at
    const seen = reads.find((r) => r.sessionId === t.id)?.seenAt
    return !!turn && (!seen || turn > seen)
  })
  const pulls = unread.length
    ? await db.pullRequest.findMany({
        where: { sessionId: { in: unread.map((t) => t.id) } },
        orderBy: { createdAt: 'desc' },
        select: {
          sessionId: true,
          repository: true,
          number: true,
          state: true,
          createdAt: true,
          mergedAt: true,
        },
      })
    : []

  const results: HomeResult[] = unread
    .map((t): HomeResult => {
      const seen = reads.find((r) => r.sessionId === t.id)?.seenAt
      // A pull request it opened or merged since they looked: what the reply is about.
      const pull = pulls.find(
        (p) =>
          p.sessionId === t.id &&
          (!seen || p.createdAt > seen || (p.mergedAt != null && p.mergedAt > seen)),
      )
      return {
        kind: 'thread',
        at: max(t.id, 'turn.completed')!.at!.toISOString(),
        thread: { id: t.id, title: t.title, status: t.status },
        teammate: t.teammate,
        pull: pull ? { repository: pull.repository, number: pull.number, state: pull.state } : null,
      }
    })
    .sort((a, b) => b.at.localeCompare(a.at))

  return { looseEnds: loose, results: results.slice(0, LISTED) }
}

/**
 * Failed threads as loose ends: reading one does not mend it, so it stays until the thread
 * runs again (it is no longer failed) or the member sets it aside. Its last error says
 * when and why; a thread that never ran (its computer offline) has no error event.
 */
export function failedLooseEnds(
  failed: {
    id: string
    title: string
    lastSeq: number
    updatedAt: Date
    teammate: { id: string; name: string }
  }[],
  errors: { sessionId: string; at: Date; data: unknown }[],
  gone: Set<string>,
): LooseEnd[] {
  return failed.flatMap((t): LooseEnd[] => {
    // The thread's events so far: a new failure after another message is a new loose end.
    const key = `failed:${t.id}:${t.lastSeq}`
    if (gone.has(key)) return []
    const error = errors.find((e) => e.sessionId === t.id)
    const message = (error?.data as { message?: unknown } | undefined)?.message
    return [
      {
        kind: 'failed',
        key,
        at: (error?.at ?? t.updatedAt).toISOString(),
        thread: { id: t.id, title: t.title },
        teammate: t.teammate,
        error: typeof message === 'string' && message.trim() ? message.trim() : null,
      },
    ]
  })
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
