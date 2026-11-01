// Home under the composer, for one member: their loose ends (nobody is blocked, but
// nothing moves on its own) and what came back since they last looked. Only what
// Brigade knows for sure: a reply ending on buttons nobody clicked, a running thread
// with no event for a while. Pull requests, tickets, failed threads and failing routines that
// wait on a person are Waiting on you, not here (failuresWaitingOn, src/failed.ts). With the
// results, a line per active playbook that ran this week (playbook-metrics.ts).
import {
  bareToolName,
  OFFER_CHOICES_TOOL,
  safeChoices,
  safeReplies,
  SUGGEST_REPLIES_TOOL,
  THREAD_NOTE_SOURCE,
} from '@brigade/contracts'
import type { ScopedDb } from './db.js'
import { failuresWaitingOn } from './failed.js'
import { hubs } from './hub.js'
import { playbookLines } from './playbook-metrics.js'
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
      // Nor those the member put away for later (src/later.ts).
      laters: { none: { memberId } },
      // A playbook's runs stay out of sight until a person takes part, as in the sidebar.
      OR: [{ playbookRunId: null, quiet: false }, { surfacedAt: { not: null } }],
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
      workspaceId: true,
      teammate: { select: { id: true, name: true } },
    },
  })
  const ids = threads.map((t) => t.id)
  const [latest, reads, tickets, pullsWaiting, dismissed, lines] = await Promise.all([
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
    // A line per active playbook that ran this week, shown with the results.
    playbookLines(db, memberId, now),
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
      // A Brigade action (merge, preview) runs from the thread's own button, not from here.
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
  const waitingSince = running.length
    ? await hubs.get(running[0]!.workspaceId).eventsWaitingSince(running.map((t) => t.id))
    : {}
  for (const t of running) {
    const waiting = waitingSince[t.id]
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

  loose.sort((a, b) => b.at.localeCompare(a.at))

  // What came back: threads with a teammate's reply they have not read. Not their own
  // decisions: they made them; what came of one is the reply that follows. Not a failed one
  // either: its last turn did not come back, and once it waits on them it is Waiting on you.
  const looseThreads = new Set(loose.map((l) => l.thread.id))
  const unread = threads.filter((t) => {
    if (looseThreads.has(t.id) || held.has(t.id)) return false
    if (t.status === 'running' || t.status === 'starting' || t.status === 'failed') return false
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

  return { looseEnds: loose, results: results.slice(0, LISTED), playbooks: lines }
}

/** The keys a loose end can have, one prefix per kind built above. */
export const LOOSE_END_KEY = /^(proposal|stalled):[\w:-]{1,200}$/

/**
 * Set a loose end aside: it stays gone until the thing it names changes. Not what waits on the
 * member: a failed thread is put away for later or archived instead.
 */
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

/**
 * Home's Waiting on you beside its tickets and pull requests: the failed threads and failing
 * routines waiting on this member (src/failed.ts), and when to ask again.
 */
export async function homeWaiting(db: ScopedDb, memberId: string, now = new Date()) {
  const { threads, routines, recheckAt } = await failuresWaitingOn(db, memberId, now)
  return {
    threads: threads.map((t) => ({
      id: t.id,
      title: t.title,
      teammate: t.teammate,
      at: t.at.toISOString(),
      error: t.error,
    })),
    routines: routines.map((r) => ({
      scheduleId: r.scheduleId,
      title: r.title,
      runId: r.runId,
      runParentId: r.runParentId,
      couldNotStart: r.couldNotStart,
      at: r.at.toISOString(),
      error: r.error,
    })),
    recheckAt: recheckAt?.toISOString() ?? null,
  }
}
