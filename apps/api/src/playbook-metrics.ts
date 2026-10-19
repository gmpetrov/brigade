// A playbook's numbers (spec "Les chiffres"): for one installation, the last 7 days and the 7
// before, overall and by triage case. Its runs, the share no person stepped in, how often people
// did, the first response, escalations and refusals, bugs fixed, and the session minutes on its
// owner's subscription. Dry runs never count. Home's line for each active playbook reads the
// same runs, so "handled on its own" there is the sheet's "unattended".
import {
  isTriggerEntry,
  playbookRoles,
  type PlaybookHomeLine,
  type PlaybookManifest,
  type PlaybookMetrics,
  type PlaybookNumbers,
} from '@brigade/contracts'
import type { ScopedDb } from './db.js'
import { sessionMinutes } from './playbook-dry-runs.js'

const WEEK_MS = 7 * 24 * 3600_000
/** Runs read for one installation at most: at 100 runs a day, its two weeks are 1,400. */
const MAX_RUNS = 2_000
/** Tickets that are a write a person allowed or refused. */
const WRITES = new Set(['approval', 'cap'])

/** A run as its numbers read it. */
type MeasuredRun = {
  id: string
  case: string | null
  outcome: string | null
  /** A member's messages and takeovers in its threads. */
  interventions: number
  firstResponseAt: Date | null
  startedAt: Date
  endedAt: Date | null
  /** Started by one of its schedules, not by an event. */
  scheduled: boolean
  /** Its root thread and its children. */
  threadIds: string[]
  /** Tickets in its threads a person decided. */
  decisions: { type: string; status: string; memberId: string }[]
}

/**
 * An installation's runs started since `since`, dry runs left out, newest first, with their
 * threads and the tickets a person decided there. A proposal to let an action act on its own
 * waits in a run's thread but is about the playbook, not that run: it is left out.
 */
async function measuredRuns(
  db: ScopedDb,
  installationId: string,
  since: Date,
): Promise<MeasuredRun[]> {
  const runs = await db.playbookRun.findMany({
    where: { installationId, dryRun: false, startedAt: { gte: since } },
    orderBy: { startedAt: 'desc' },
    take: MAX_RUNS,
    select: {
      id: true,
      case: true,
      outcome: true,
      interventions: true,
      firstResponseAt: true,
      startedAt: true,
      endedAt: true,
      rootSession: { select: { origin: true } },
    },
  })
  if (!runs.length) return []
  const threads = await db.session.findMany({
    where: { playbookRunId: { in: runs.map((r) => r.id) } },
    select: { id: true, playbookRunId: true },
  })
  const threadIds = threads.map((t) => t.id)
  const [decided, proposals] = threadIds.length
    ? await Promise.all([
        db.ticket.findMany({
          where: { sessionId: { in: threadIds }, resolvedByMemberId: { not: null } },
          select: { id: true, sessionId: true, type: true, status: true, resolvedByMemberId: true },
        }),
        db.ticket.findMany({
          where: {
            sessionId: { in: threadIds },
            payload: { path: ['playbookPromotion', 'installationId'], equals: installationId },
          },
          select: { id: true },
        }),
      ])
    : [[], []]
  const aside = new Set(proposals.map((t) => t.id))
  const runOf = new Map(threads.map((t) => [t.id, t.playbookRunId!]))
  const threadsOf = group(threads, (t) => t.playbookRunId!)
  const decisionsOf = group(
    decided.filter((t) => !aside.has(t.id)),
    (t) => runOf.get(t.sessionId!)!,
  )
  return runs.map((run) => ({
    id: run.id,
    case: run.case,
    outcome: run.outcome,
    interventions: run.interventions,
    firstResponseAt: run.firstResponseAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    scheduled: run.rootSession?.origin === 'schedule',
    threadIds: (threadsOf.get(run.id) ?? []).map((t) => t.id),
    decisions: (decisionsOf.get(run.id) ?? []).map((t) => ({
      type: t.type,
      status: t.status,
      memberId: t.resolvedByMemberId!,
    })),
  }))
}

function group<T, K>(items: T[], key: (item: T) => K) {
  const groups = new Map<K, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = groups.get(k)
    if (list) list.push(item)
    else groups.set(k, [item])
  }
  return groups
}

/** Times a person stepped in: a member's message or takeover, a ticket a person decided. */
const steps = (run: Pick<MeasuredRun, 'interventions' | 'decisions'>) =>
  run.interventions + run.decisions.length

/**
 * A run that ended with no person stepping in: what the sheet's "unattended" and Home's
 * "handled on its own" count.
 */
export const unattended = (run: Pick<MeasuredRun, 'endedAt' | 'interventions' | 'decisions'>) =>
  !!run.endedAt && steps(run) === 0

const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/** What the runs' threads add up to, by run: session minutes and merged pull requests. */
type ByRun = { minutes: Map<string, number>; merged: Map<string, number> }

function tally(runs: MeasuredRun[], byRun: ByRun): PlaybookNumbers {
  const finished = runs.filter((r) => r.endedAt)
  const responses = runs.flatMap((r) =>
    r.firstResponseAt
      ? [Math.max(0, r.firstResponseAt.getTime() - r.startedAt.getTime()) / 60_000]
      : [],
  )
  const sum = (of: (r: MeasuredRun) => number) => runs.reduce((total, r) => total + of(r), 0)
  return {
    runs: runs.length,
    finished: finished.length,
    unattended: finished.length ? finished.filter(unattended).length / finished.length : null,
    interventionsPerRun: runs.length ? round(sum(steps) / runs.length, 2) : null,
    firstResponseMinutes: responses.length ? round(median(responses)) : null,
    escalations: runs.filter((r) => r.outcome === 'escalated').length,
    denied: sum(
      (r) => r.decisions.filter((d) => WRITES.has(d.type) && d.status === 'denied').length,
    ),
    bugsFixed: sum((r) => byRun.merged.get(r.id) ?? 0),
    minutes: round(sum((r) => byRun.minutes.get(r.id) ?? 0)),
  }
}

/** The sheet's numbers: the last 7 days, the 7 before, and the last 7 days by triage case. */
export async function playbookMetrics(
  db: ScopedDb,
  installation: { id: string; manifest: unknown },
  now = new Date(),
): Promise<PlaybookMetrics> {
  const manifest = installation.manifest as PlaybookManifest
  const weekStart = new Date(now.getTime() - WEEK_MS)
  const runs = await measuredRuns(db, installation.id, new Date(now.getTime() - 2 * WEEK_MS))
  const threadIds = runs.flatMap((r) => r.threadIds)
  const [minutes, merged] = await Promise.all([
    sessionMinutes(db, threadIds),
    threadIds.length
      ? db.pullRequest.findMany({
          where: { sessionId: { in: threadIds }, state: 'merged' },
          select: { sessionId: true },
        })
      : [],
  ])
  const pulls = group(merged, (p) => p.sessionId!)
  // A run's threads added up: its root's and its children's.
  const over = (of: (threadId: string) => number) =>
    new Map(runs.map((r) => [r.id, r.threadIds.reduce((total, id) => total + of(id), 0)]))
  const byRun: ByRun = {
    minutes: over((id) => minutes.get(id) ?? 0),
    merged: over((id) => pulls.get(id)?.length ?? 0),
  }
  const week = runs.filter((r) => r.startedAt >= weekStart)
  const before = runs.filter((r) => r.startedAt < weekStart)
  // Cases matched as autonomy matches them, whatever their capitals.
  const byCase = group(week, (r) => r.case?.trim().toLowerCase() || null)
  return {
    responds: !!manifest.firstResponse,
    fixesBugs: playbookRoles(manifest.apps).some((r) => r.kinds.includes('github')),
    week: tally(week, byRun),
    lastWeek: before.length ? tally(before, byRun) : null,
    cases: [...byCase]
      .map(([key, list]) => ({ case: key, ...tally(list, byRun) }))
      .sort(
        (a, b) =>
          Number(a.case === null) - Number(b.case === null) ||
          b.runs - a.runs ||
          (a.case ?? '').localeCompare(b.case ?? ''),
      ),
  }
}

/**
 * Home's line for each active playbook that ran in the last 7 days, for the member reading:
 * "Support and bugs: 46 mails, 41 handled on its own, 5 approved by you". Every member sees the
 * workspace's playbooks (Routines lists them all), so every member gets their lines.
 */
export async function playbookLines(
  db: ScopedDb,
  memberId: string,
  now = new Date(),
): Promise<PlaybookHomeLine[]> {
  const installations = await db.playbookInstallation.findMany({
    where: { status: 'active' },
    select: { id: true, manifest: true },
    orderBy: { createdAt: 'asc' },
  })
  const since = new Date(now.getTime() - WEEK_MS)
  const lines = await Promise.all(
    installations.map(async (installation): Promise<PlaybookHomeLine | null> => {
      const manifest = installation.manifest as PlaybookManifest
      // A support inbox counts mails: its weekly review is no mail.
      const mails = manifest.entries.some(
        (e) => isTriggerEntry(e) && e.trigger.startsWith('gmail.'),
      )
      const all = await measuredRuns(db, installation.id, since)
      const runs = mails ? all.filter((r) => !r.scheduled) : all
      if (!runs.length) return null
      const approved = new Set(
        runs.filter((r) =>
          r.decisions.some(
            (d) => WRITES.has(d.type) && d.status === 'approved' && d.memberId === memberId,
          ),
        ),
      )
      return {
        id: installation.id,
        name: manifest.name,
        unit: mails ? 'mail' : 'run',
        count: runs.length,
        onItsOwn: runs.filter(unattended).length,
        approvedByYou: approved.size,
        withPerson: runs.filter((r) => steps(r) > 0 && !approved.has(r)).length,
      }
    }),
  )
  return lines
    .filter((line): line is PlaybookHomeLine => line !== null)
    .sort((a, b) => b.count - a.count)
}
