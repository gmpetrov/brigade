// The Board (docs/board.md): what moves across a workspace's lists, threads and routines, in
// three columns (Needs you, In progress, Done this week), with its routines above and the
// threads that stopped without being done below. Computed from them on each read: it keeps
// nothing of its own, so it can't fall behind them.
//
// A card is a list's line with work on it, a thread on no list, or a routine that failed. A
// routine's run threads never are cards: the routine's row says what they did, and a line they
// work on is its card. What waits on a person is the same as everywhere else: an open ticket or
// question, a teammate waiting on an answer, a pull request ready to merge, a failed thread or
// routine (src/failed.ts).
import {
  type Board,
  type BoardCard,
  type BoardReason,
  type BoardRoutine,
  type BoardStopped,
  type BoardThread,
  DONE_DAYS,
  type ListItemView,
  plainItemText,
  type RunOutcome,
  STOPPED_DAYS,
} from '@brigade/contracts'
import { mayWrite } from './account-sharing.js'
import { reportOf } from './children.js'
import type { Prisma, ScopedDb } from './db.js'
import { failedWaitingAmong, failingRoutines } from './failed.js'
import { actorNames } from './library-history.js'
import { workspaceLists } from './lists.js'
import { REVIEW_THREAD, pullWaitsOnPerson } from './review-state.js'
import type { WorkspaceScope } from './scope.js'

const DAY = 24 * 60 * 60_000
/** Threads looked at: those active lately, or done this week. */
const LOOKED_AT_DAYS = STOPPED_DAYS * 2
const ACTIVE = ['starting', 'running']
const SUMMARY_CHARS = 200

const isAdmin = (scope: WorkspaceScope) => scope.role === 'owner' || scope.role === 'admin'

const oneLine = (text: string | null | undefined, max = SUMMARY_CHARS) => {
  const line = (text ?? '').replace(/\s+/g, ' ').trim()
  return line ? (line.length > max ? line.slice(0, max) : line) : null
}

/** The calendar day of a moment in a time zone, as YYYY-MM-DD. */
export function dayIn(timezone: string, at: Date) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(at)
  } catch {
    return at.toISOString().slice(0, 10)
  }
}

/** How a run ended: its report when it reports to a thread, else its status. */
export function outcomeOf(run: { status: string; report: unknown }): RunOutcome {
  if (ACTIVE.includes(run.status)) return 'running'
  const report = reportOf(run.report)
  if (report) return report.status
  if (run.status === 'failed') return 'failed'
  return 'ended'
}

/**
 * A routine's health from its runs of the last week, newest first: paused; failed when it
 * could not start or its last finished run failed; degraded when a run failed this week but
 * the last one did not; new before its first run.
 */
export function healthOf(
  schedule: { pausedAt: Date | null; lastError: string | null },
  week: RunOutcome[],
  everRan: boolean,
): BoardRoutine['health'] {
  if (schedule.pausedAt) return 'paused'
  if (schedule.lastError) return 'failed'
  const finished = week.filter((o) => o !== 'running')
  if (finished[0] === 'failed') return 'failed'
  if (finished.includes('failed')) return 'degraded'
  return everRan ? 'ok' : 'new'
}

const THREAD_SELECT = {
  id: true,
  title: true,
  status: true,
  updatedAt: true,
  archivedAt: true,
  projectId: true,
  startedByMemberId: true,
  othersMayPrompt: true,
  computer: { select: { kind: true } },
  teammate: { select: { id: true, name: true } },
  doneAt: true,
  doneSummary: true,
  doneByType: true,
  doneById: true,
  task: { select: { completedAt: true, summary: true } },
  _count: { select: { tickets: { where: { status: 'open' } } } },
  pullRequests: {
    select: {
      repository: true,
      number: true,
      state: true,
      mergeStatus: true,
      reviewSession: { select: REVIEW_THREAD },
    },
    orderBy: { number: 'asc' },
  },
} as const

/** Quiet threads read at most, for Stopped and closed: the latest first. */
const QUIET_LISTED = 500

/**
 * The threads that may be cards: top-level, not a routine's run (never a card), not a playbook's
 * run nobody joined (as in the sidebar). Every one with something under way or waiting on a
 * person, or done this week, however many; then the quiet ones of the last weeks, for Stopped and
 * closed, the latest first.
 */
async function threadRows(db: ScopedDb, now: Date) {
  const cards = {
    parentId: null,
    scheduleId: null,
    OR: [{ playbookRunId: null, quiet: false }, { surfacedAt: { not: null } }],
  } satisfies Prisma.SessionWhereInput
  const [moving, quiet] = await Promise.all([
    db.session.findMany({
      where: {
        AND: [
          cards,
          {
            OR: [
              { status: { in: ['starting', 'running', 'waiting', 'paused', 'failed'] } },
              { tickets: { some: { status: 'open' } } },
              { children: { some: { tickets: { some: { status: 'open' } } } } },
              { pullRequests: { some: { state: 'open' } } },
              { wakeups: { some: { status: 'pending', kind: 'wakeup' } } },
              { doneAt: { gte: new Date(now.getTime() - DONE_DAYS * DAY) } },
              { task: { completedAt: { gte: new Date(now.getTime() - DONE_DAYS * DAY) } } },
            ],
          },
        ],
      },
      select: THREAD_SELECT,
    }),
    db.session.findMany({
      where: {
        ...cards,
        archivedAt: null,
        updatedAt: { gte: new Date(now.getTime() - LOOKED_AT_DAYS * DAY) },
      },
      select: THREAD_SELECT,
      orderBy: { updatedAt: 'desc' },
      take: QUIET_LISTED,
    }),
  ])
  const seen = new Set(moving.map((t) => t.id))
  return [...moving, ...quiet.filter((t) => !seen.has(t.id))]
}

const pullUrl = (p: { repository: string; number: number }) =>
  `https://github.com/${p.repository}/pull/${p.number}`

const boardThread = (t: {
  id: string
  title: string
  status: string
  teammate: { id: string; name: string }
  schedule?: { id: string; title: string } | null
}): BoardThread => ({
  id: t.id,
  title: t.title,
  status: t.status,
  teammate: t.teammate,
  routine: t.schedule ? { id: t.schedule.id, title: t.schedule.title } : null,
})

/** Where a list's line stands on the Board, from its state (lists.ts stateOf) and its threads. */
function itemPlace(
  item: ListItemView,
  threads: Map<string, { status: string; updatedAt: Date; archivedAt: Date | null }>,
  failed: Map<string, { at: Date; error: string | null }>,
  now: Date,
): { column: BoardCard['column']; reason: BoardReason | null; at: Date } | 'stopped' | null {
  const live = item.threads.filter((t) => !threads.get(t.id)?.archivedAt)
  const latest = new Date(
    Math.max(0, ...live.map((t) => threads.get(t.id)?.updatedAt.getTime() ?? 0)),
  )
  if (item.done) {
    const at = item.doneBy ? new Date(item.doneBy.at) : null
    return at && now.getTime() - at.getTime() < DONE_DAYS * DAY
      ? { column: 'done', reason: null, at }
      : null
  }
  if (item.state === 'needs_you') {
    const reason: BoardReason = live.some((t) => failed.has(t.id))
      ? 'failed'
      : live.some((t) => t.status === 'waiting' || t.status === 'paused')
        ? 'waiting'
        : 'pull'
    return { column: 'needs_you', reason, at: latest }
  }
  if (item.state === 'in_progress')
    return {
      column: 'in_progress',
      reason: live.some((t) => ACTIVE.includes(t.status)) ? 'working' : 'review',
      at: latest,
    }
  // Its threads stopped with it open, and nothing else carries it: stopped while recent.
  if (item.stalled && now.getTime() - latest.getTime() < STOPPED_DAYS * DAY) return 'stopped'
  return null
}

/** The Board for a member: every card, routine and stopped thread of the workspace. */
export async function board(db: ScopedDb, scope: WorkspaceScope, now = new Date()): Promise<Board> {
  const [lists, rows, schedules] = await Promise.all([
    workspaceLists(db, scope),
    threadRows(db, now),
    db.schedule.findMany({
      where: { playbookInstallationId: null },
      select: {
        id: true,
        title: true,
        cron: true,
        timezone: true,
        pausedAt: true,
        nextRunAt: true,
        lastError: true,
        projectId: true,
        teammate: { select: { id: true, name: true } },
        sessions: { select: { id: true }, take: 1 },
      },
      orderBy: { createdAt: 'asc' },
    }),
  ])

  // The threads on lines: their routine (a run), when they last moved, who may close them.
  const itemThreadIds = [
    ...new Set(lists.flatMap((l) => l.items.flatMap((i) => i.threads.map((t) => t.id)))),
  ]
  const itemThreads = new Map(
    (itemThreadIds.length
      ? await db.session.findMany({
          where: { id: { in: itemThreadIds } },
          select: {
            id: true,
            status: true,
            updatedAt: true,
            createdAt: true,
            archivedAt: true,
            doneAt: true,
            scheduleId: true,
            schedule: { select: { id: true, title: true } },
            startedByMemberId: true,
            othersMayPrompt: true,
            computer: { select: { kind: true } },
            teammate: { select: { id: true, name: true } },
          },
        })
      : []
    ).map((t) => [t.id, t]),
  )

  const failedOnLines = await failedWaitingAmong(db, itemThreadIds, now)
  const mayClose = (t: {
    startedByMemberId: string | null
    othersMayPrompt: boolean
    computer: { kind: string }
  }) => mayWrite(t, scope) || isAdmin(scope)

  const cards: BoardCard[] = []
  const stopped: BoardStopped[] = []
  const closed: Board['closed'] = []

  // ---- Lines of lists ----
  const shownLists = new Set<string>()
  /** Threads a line's card or stopped row shows: not cards of their own. */
  const represented = new Set<string>()
  for (const l of lists) {
    for (const item of l.items) {
      if (item.missing || (!item.threads.length && !item.pulls.length)) continue
      const place = itemPlace(item, itemThreads, failedOnLines, now)
      if (!place) continue
      const threads = item.threads.flatMap((t) => {
        const row = itemThreads.get(t.id)
        return row ? [boardThread({ ...t, schedule: row.schedule })] : []
      })
      const title = plainItemText(item.text)
      const list = { documentId: l.file.id, title: l.title, section: item.section }
      if (place === 'stopped') {
        const last = [...item.threads]
          .map((t) => itemThreads.get(t.id))
          .filter((t) => t && !t.archivedAt)
          .sort((a, b) => b!.updatedAt.getTime() - a!.updatedAt.getTime())[0]
        // Its last thread was marked done, the line left open: the list holds it now.
        if (!last || last.doneAt) continue
        for (const t of item.threads) represented.add(t.id)
        shownLists.add(l.file.id)
        stopped.push({
          key: `item:${item.id}`,
          title,
          href: `/app/threads/${last.id}`,
          teammate: last.teammate,
          projectId: l.projectId,
          list: { documentId: l.file.id, title: l.title },
          threadId: last.id,
          canClose: mayClose(last),
          idleSince: last.updatedAt.toISOString(),
          closesAt: new Date(last.updatedAt.getTime() + STOPPED_DAYS * DAY).toISOString(),
        })
        continue
      }
      shownLists.add(l.file.id)
      // A line that waits or moves shows its threads; one done this week does not hold them.
      if (place.column !== 'done') for (const t of item.threads) represented.add(t.id)
      const error = item.threads.map((t) => failedOnLines.get(t.id)?.error).find(Boolean) ?? null
      const firstThread = threads.find((t) => !itemThreads.get(t.id)?.archivedAt) ?? threads[0]
      cards.push({
        key: `item:${item.id}`,
        kind: 'item',
        column: place.column,
        title,
        href: firstThread ? `/app/threads/${firstThread.id}` : `/app/lists/${l.file.id}`,
        list,
        projectId: l.projectId,
        threads,
        pulls: item.pulls.map((p) => ({
          repository: p.repository,
          number: p.number,
          state: p.state,
          url: p.url,
        })),
        reason: place.reason,
        note: place.reason === 'failed' ? error : null,
        at: place.at.toISOString(),
        done:
          place.column === 'done' && item.doneBy
            ? { at: item.doneBy.at, by: item.doneBy.name }
            : null,
      })
    }
  }

  // Threads a line on the Board shows are not cards of their own; any other is, even one whose
  // line left its list.
  const offList = rows.filter((t) => !represented.has(t.id))
  const ids = offList.map((t) => t.id)
  const [failed, childTickets, childrenWorking, wakeups, routinesFailing, names] =
    await Promise.all([
      failedWaitingAmong(db, ids, now),
      ids.length
        ? db.ticket.findMany({
            where: { status: 'open', session: { parentId: { in: ids } } },
            select: { session: { select: { parentId: true } } },
          })
        : [],
      ids.length
        ? db.session.groupBy({
            by: ['parentId'],
            where: {
              parentId: { in: ids },
              awaited: true,
              status: { in: ['starting', 'running'] },
            },
            _count: { _all: true },
          })
        : [],
      ids.length
        ? db.wakeup.findMany({
            where: { sessionId: { in: ids }, status: 'pending', kind: 'wakeup' },
            select: { sessionId: true },
          })
        : [],
      failingRoutines(db, {}, now),
      actorNames(
        db,
        offList.flatMap((t) =>
          t.doneAt && t.doneByType && t.doneById ? [{ type: t.doneByType, id: t.doneById }] : [],
        ),
      ),
    ])
  const ticketsOfChildren = new Set(childTickets.map((t) => t.session?.parentId))
  const working = new Set(childrenWorking.map((c) => c.parentId))
  const waking = new Set(wakeups.map((w) => w.sessionId))
  // ---- Threads on no list ----
  for (const t of offList) {
    const doneAt = t.doneAt ?? t.task?.completedAt ?? null
    const doneRecently = doneAt && now.getTime() - doneAt.getTime() < DONE_DAYS * DAY
    const base = {
      key: `thread:${t.id}`,
      kind: 'thread' as const,
      title: t.title,
      href: `/app/threads/${t.id}`,
      list: null,
      projectId: t.projectId,
      threads: [boardThread(t)],
      pulls: t.pullRequests.map((p) => ({
        repository: p.repository,
        number: p.number,
        state: p.state,
        url: pullUrl(p),
      })),
    }
    if (t.doneAt || t.task?.completedAt) {
      if (doneRecently)
        cards.push({
          ...base,
          column: 'done',
          reason: null,
          note: oneLine(t.doneAt ? t.doneSummary : t.task?.summary),
          at: doneAt!.toISOString(),
          done: {
            at: doneAt!.toISOString(),
            by: t.doneAt ? (names(t.doneByType, t.doneById)?.name ?? null) : null,
          },
        })
      continue
    }
    if (t.archivedAt) continue
    const fail = failed.get(t.id)
    const needs: BoardReason | null =
      t._count.tickets > 0 || ticketsOfChildren.has(t.id)
        ? 'ticket'
        : t.status === 'waiting' || t.status === 'paused'
          ? 'waiting'
          : fail
            ? 'failed'
            : !ACTIVE.includes(t.status) &&
                t.status !== 'failed' &&
                t.pullRequests.some(pullWaitsOnPerson)
              ? 'pull'
              : null
    if (needs) {
      cards.push({
        ...base,
        column: 'needs_you',
        reason: needs,
        note: needs === 'failed' ? (fail?.error ?? null) : null,
        at: (needs === 'failed' ? fail!.at : t.updatedAt).toISOString(),
        done: null,
      })
      continue
    }
    const moving: BoardReason | null =
      ACTIVE.includes(t.status) || working.has(t.id) || t.status === 'failed'
        ? 'working'
        : waking.has(t.id)
          ? 'wakeup'
          : t.pullRequests.some((p) => p.state === 'open')
            ? 'review'
            : null
    if (moving) {
      cards.push({
        ...base,
        column: 'in_progress',
        reason: moving,
        note: null,
        at: t.updatedAt.toISOString(),
        done: null,
      })
      continue
    }
    // Idle, not done, nothing pending: stopped while recent, then closed with no activity.
    const quietFor = now.getTime() - t.updatedAt.getTime()
    if (quietFor < STOPPED_DAYS * DAY)
      stopped.push({
        key: `thread:${t.id}`,
        title: t.title,
        href: `/app/threads/${t.id}`,
        teammate: t.teammate,
        projectId: t.projectId,
        list: null,
        threadId: t.id,
        canClose: mayClose(t),
        idleSince: t.updatedAt.toISOString(),
        closesAt: new Date(t.updatedAt.getTime() + STOPPED_DAYS * DAY).toISOString(),
      })
    else
      closed.push({
        id: t.id,
        title: t.title,
        projectId: t.projectId,
        closedAt: new Date(t.updatedAt.getTime() + STOPPED_DAYS * DAY).toISOString(),
      })
  }

  // ---- Routines ----
  const scheduleIds = schedules.map((s) => s.id)
  const weekAgo = new Date(now.getTime() - 7 * DAY)
  const runs = scheduleIds.length
    ? await db.session.findMany({
        where: { scheduleId: { in: scheduleIds }, createdAt: { gte: weekAgo } },
        select: {
          id: true,
          scheduleId: true,
          status: true,
          report: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'desc' },
      })
    : []
  const runPulls = runs.length
    ? await db.pullRequest.findMany({
        where: {
          sessionId: { in: runs.map((r) => r.id) },
          createdAt: { gte: new Date(now.getTime() - DAY) },
        },
        select: { sessionId: true, repository: true, number: true, createdAt: true },
      })
    : []
  // The lists each routine's runs worked on this week.
  const listsOfRoutine = new Map<string, Set<string>>()
  for (const l of lists)
    for (const item of l.items)
      for (const t of item.threads) {
        const row = itemThreads.get(t.id)
        if (!row?.scheduleId || row.createdAt < weekAgo) continue
        const set = listsOfRoutine.get(row.scheduleId) ?? new Set<string>()
        set.add(l.file.id)
        listsOfRoutine.set(row.scheduleId, set)
      }
  const failing = new Map(routinesFailing.map((r) => [r.scheduleId, r]))
  const routines: BoardRoutine[] = schedules.map((s) => {
    const mine = runs.filter((r) => r.scheduleId === s.id)
    const outcomes = mine.map(outcomeOf)
    const today = dayIn(s.timezone, now)
    const ofToday = mine.filter((r) => dayIn(s.timezone, r.createdAt) === today)
    const running = mine.find((r) => ACTIVE.includes(r.status))
    const last = mine.find((r) => !ACTIVE.includes(r.status))
    const todayIds = new Set(ofToday.map((r) => r.id))
    return {
      id: s.id,
      title: s.title,
      cron: s.cron,
      timezone: s.timezone,
      teammate: s.teammate,
      projectId: s.projectId,
      health: healthOf(s, outcomes, s.sessions.length > 0),
      week: { runs: mine.length, failed: outcomes.filter((o) => o === 'failed').length },
      today: {
        runs: ofToday.length,
        nothing: ofToday.filter((r) => outcomeOf(r) === 'nothing').length,
        pulls: runPulls
          .filter((p) => p.sessionId && todayIds.has(p.sessionId))
          .map((p) => ({ number: p.number, url: pullUrl(p) })),
      },
      running: running ? { id: running.id, since: running.createdAt.toISOString() } : null,
      last: last
        ? {
            id: last.id,
            at: last.updatedAt.toISOString(),
            outcome: outcomeOf(last),
            summary: oneLine(reportOf(last.report)?.summary),
          }
        : null,
      error: s.lastError,
      nextRunAt: s.nextRunAt?.toISOString() ?? null,
      listIds: [...(listsOfRoutine.get(s.id) ?? [])],
    }
  })
  // A routine that waits on a person: its card in Needs you, the routine and not its run.
  for (const r of routines) {
    // One that could not start counts here even while its question ticket is open: that
    // ticket has no thread, so no other card shows it.
    const f =
      failing.get(r.id) ??
      (r.error && r.health !== 'paused' ? { runId: null, error: r.error, at: now } : undefined)
    if (!f) continue
    cards.push({
      key: `routine:${r.id}`,
      kind: 'routine',
      column: 'needs_you',
      title: r.title,
      href: f.runId ? `/app/threads/${f.runId}` : '/app/routines',
      list: null,
      projectId: r.projectId,
      threads: [],
      pulls: [],
      reason: 'routine_failed',
      note: oneLine(f.error),
      at: f.at.toISOString(),
      done: null,
    })
  }

  cards.sort((a, b) => b.at.localeCompare(a.at))
  stopped.sort((a, b) => b.idleSince.localeCompare(a.idleSince))
  closed.sort((a, b) => b.closedAt.localeCompare(a.closedAt))
  return {
    cards,
    stopped,
    closed,
    routines,
    lists: lists
      .filter((l) => shownLists.has(l.file.id))
      .map((l) => ({
        documentId: l.file.id,
        title: l.title,
        path: l.file.path,
        projectId: l.projectId,
      })),
  }
}
