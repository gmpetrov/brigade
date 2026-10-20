// A playbook's dry run: it replays past events (for Gmail, the latest mails its search
// matches), each one a run as it would be once active, with every write simulated
// (connector-calls.ts records it and answers a fake success) and no push (git.ts). Its runs
// start a few at a time on the installer's subscription; once they are all done, the thread
// it was started from is woken to show the report: per event, the case found, what would
// have been done, and the session minutes it took, with a week's extrapolation.
import {
  DRY_RUN_HEAD,
  DRY_RUN_MAX,
  isTriggerEntry,
  nextRuns,
  type PlaybookDryRunEvent,
  type PlaybookDryRunView,
  type PlaybookManifest,
  type PlaybookOutcome,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { ingestExternal } from './attachments.js'
import { audit } from './audit.js'
import { authorisedFetch } from './connector-calls.js'
import { triggersOf } from './connectors/index.js'
import type { ConnectorKind } from './connectors/types.js'
import { prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { hasParts, requireInstallation } from './playbooks.js'
import { eventMessage } from './triggers.js'
import { fireNow } from './wakeups.js'
import { startThread } from './work.js'

/** Runs at once: a dry run should not take the whole computer. */
const AT_ONCE = 3
/** A run still going after this is cut short: its turn is likely stuck on something. */
const RUN_MS_MAX = 30 * 60_000
const WEEK_MS = 7 * 24 * 3600_000

/** A dry run's event, waiting its turn (PlaybookRun.replay). */
type Replay = {
  title: string
  text: string
  attachmentIds: string[]
  /** When the event happened. */
  at: string | null
  origin: { kind: 'trigger'; triggerId: string } | { kind: 'schedule'; scheduleId: string }
}

/** The thread a dry run is started from, as the schedule calls see it. */
type Thread = {
  id: string
  startedByMemberId: string
  computerId: string
  accountId: string | null
}

/**
 * start_dry_run: the playbook's past events, replayed. Only its owner's thread may start one
 * (it runs on their subscription), once its settings are all answered, one at a time.
 */
export async function startDryRun(
  db: ScopedDb,
  scope: Scope,
  thread: Thread,
  teammate: { id: string },
  installationId: string,
  last?: number,
) {
  const installation = await requireInstallation(db, installationId)
  const manifest = installation.manifest as PlaybookManifest
  if (installation.ownerMemberId !== thread.startedByMemberId)
    throw new HTTPException(403, {
      message:
        "This playbook runs on another member's accounts: its dry run starts from one of their threads",
    })
  if (!(await hasParts(db, installationId)))
    throw new HTTPException(409, {
      message: 'Its settings are not all answered yet: configure_playbook says which are missing',
    })
  const running = await db.playbookDryRun.findFirst({
    where: { installationId, status: 'running' },
    select: { id: true },
  })
  if (running)
    throw new HTTPException(409, {
      message: 'A dry run of it is already going: wait for its report (dry_run_report)',
    })

  const replay = manifest.dryRun?.replay ?? { entry: 0, last: 5 }
  const count = Math.min(last ?? replay.last, replay.last, DRY_RUN_MAX)
  const entry = manifest.entries[replay.entry]!
  const events: Replay[] = []
  if (isTriggerEntry(entry)) {
    const [kind, event] = entry.trigger.split('.') as [ConnectorKind, string]
    const trigger = await db.trigger.findFirst({
      where: { playbookInstallationId: installationId, event, connection: { kind } },
      include: { connection: true },
    })
    const definition = triggersOf(kind)[event]
    if (!trigger || !definition)
      throw new HTTPException(409, { message: `Its ${entry.trigger} trigger is not made yet` })
    if (!definition.replay)
      throw new HTTPException(409, { message: `${entry.trigger} cannot replay past events yet` })
    const fetch = await authorisedFetch(db, scope, trigger.connection)
    const past = await definition.replay(
      (trigger.options ?? {}) as Record<string, string>,
      { fetch },
      count,
    )
    for (const e of past) {
      const files = definition.attachments?.(e) ?? []
      // Its files as the trigger would give them; a file that cannot be taken stays out.
      const attachmentIds = files.length
        ? await ingestExternal(db, scope, trigger.connectionId, files, { fetch }).catch(
            (error: unknown) => {
              console.warn(`dry run ${installationId}: files of ${e.id} left out`, error)
              return []
            },
          )
        : []
      const message = eventMessage(trigger, definition, trigger.connection, e, e.at ?? undefined)
      events.push({
        ...message,
        attachmentIds,
        at: e.at,
        origin: { kind: 'trigger', triggerId: trigger.id },
      })
    }
  } else {
    // A schedule's past is its next firing: one run of its instructions.
    const schedule = await db.schedule.findFirst({
      where: { playbookInstallationId: installationId },
    })
    if (!schedule) throw new HTTPException(409, { message: 'Its schedule is not made yet' })
    events.push({
      title: schedule.title,
      text: schedule.instructions,
      attachmentIds: [],
      at: null,
      origin: { kind: 'schedule', scheduleId: schedule.id },
    })
  }
  if (!events.length)
    throw new HTTPException(409, {
      message: `There is nothing to replay: no past event matches ${manifest.name}'s ${isTriggerEntry(entry) ? entry.trigger : 'schedule'} yet`,
    })

  // Oldest first, the order they came in.
  events.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))
  const times = events.flatMap((e) => (e.at ? [Date.parse(e.at)] : []))
  const dryRun = await db.playbookDryRun.create({
    data: {
      installationId,
      sessionId: thread.id,
      teammateId: teammate.id,
      startedByMemberId: thread.startedByMemberId,
      ...(times.length
        ? {
            firstEventAt: new Date(Math.min(...times)),
            lastEventAt: new Date(Math.max(...times)),
          }
        : {}),
    } as never,
  })
  for (const [i, e] of events.entries())
    await db.playbookRun.create({
      data: {
        installationId,
        dryRun: true,
        dryRunId: dryRun.id,
        status: 'waiting_event',
        replay: e as never,
        // Kept in their order, as they start a few at a time.
        startedAt: new Date(Date.now() + i),
      } as never,
    })
  if (installation.status === 'setup')
    await db.playbookInstallation.updateMany({
      where: { id: installationId },
      data: { status: 'dry_run' },
    })
  await audit({
    ...scope,
    actor: { type: 'teammate', id: teammate.id },
    action: 'playbook.dry_run_started',
    target: { type: 'playbook', id: installationId },
    data: { dryRunId: dryRun.id, events: events.length },
  })
  await advanceDryRun(scope, dryRun.id)
  return dryRunView(db, dryRun.id)
}

const advancing = new Map<string, Promise<void>>()

/** Start what waits while fewer than AT_ONCE run; once none is left, the report. One at a time per dry run. */
export function advanceDryRun(scope: Scope, dryRunId: string): Promise<void> {
  const next = (advancing.get(dryRunId) ?? Promise.resolve())
    .then(() => advance(scope, dryRunId))
    .catch((error: unknown) => console.error(`dry run ${dryRunId}: could not go on`, error))
  advancing.set(dryRunId, next)
  void next.finally(() => {
    if (advancing.get(dryRunId) === next) advancing.delete(dryRunId)
  })
  return next
}

async function advance(scope: Scope, dryRunId: string) {
  const db = scoped(scope)
  const dryRun = await db.playbookDryRun.findFirst({ where: { id: dryRunId, status: 'running' } })
  if (!dryRun) return
  const runs = await db.playbookRun.findMany({
    where: { dryRunId },
    orderBy: { startedAt: 'asc' },
  })
  let going = runs.filter((r) => r.status === 'running').length
  for (const run of runs.filter((r) => r.status === 'waiting_event')) {
    if (going >= AT_ONCE) break
    await startEvent(db, scope, dryRun, run)
    going++
  }
  const left = await db.playbookRun.count({
    where: { dryRunId, status: { in: ['running', 'waiting_event', 'waiting_person'] } },
  })
  if (left) return
  const { count } = await db.playbookDryRun.updateMany({
    where: { id: dryRunId, status: 'running' },
    data: { status: 'done', endedAt: new Date() },
  })
  if (count) await reportDone(db, scope, dryRunId)
}

/** One event's run: its root thread, as the trigger or schedule would start it. */
async function startEvent(
  db: ScopedDb,
  scope: Scope,
  dryRun: {
    id: string
    installationId: string
    sessionId: string | null
    startedByMemberId: string
  },
  run: { id: string; replay: unknown },
) {
  const replay = run.replay as Replay
  const failed = (summary: string) =>
    db.playbookRun.updateMany({
      where: { id: run.id },
      data: { status: 'failed', outcome: 'failed', summary, endedAt: new Date() },
    })
  const installation = await db.playbookInstallation.findFirst({
    where: { id: dryRun.installationId },
    include: { teammate: true },
  })
  // It runs where the installation's chat runs, on the same subscription.
  const from = dryRun.sessionId
    ? await db.session.findFirst({
        where: { id: dryRun.sessionId },
        select: { computerId: true, accountId: true, teammate: { select: { harness: true } } },
      })
    : null
  if (!installation || !from) return failed('The thread it was started from is gone')
  await db.playbookRun.updateMany({
    where: { id: run.id },
    data: { status: 'running', startedAt: new Date() },
  })
  try {
    const { thread, outcome } = await startThread(db, scope, {
      teammate: installation.teammate,
      computer: { id: from.computerId },
      memberId: dryRun.startedByMemberId,
      accountId: from.teammate.harness === installation.teammate.harness ? from.accountId : null,
      title: `Dry run · ${replay.title}`,
      text: replay.text,
      // No conversation: a real event of the same one later starts its own run.
      origin: replay.origin,
      attachmentIds: replay.attachmentIds,
      projectId: installation.projectId,
      playbookRunId: run.id,
    })
    await db.playbookRun.updateMany({ where: { id: run.id }, data: { rootSessionId: thread.id } })
    if (outcome === 'offline') await failed('The computer is offline')
  } catch (error) {
    await failed(error instanceof Error ? error.message : String(error))
  }
}

/**
 * A run's thread ended its turn (src/hub.ts): in a dry run, its run is done, reported or not,
 * and the next event starts. A run that ended without playbook_report takes its thread's word.
 */
export async function noteDryRunEvents(
  session: {
    id: string
    organizationId: string
    workspaceId: string
    playbookRunId: string | null
  },
  events: { event: { type: string; message?: string } }[],
) {
  if (!session.playbookRunId) return
  const ended = events.find((e) => e.event.type === 'turn.completed' || e.event.type === 'error')
  if (!ended) return
  const scope: Scope = { organizationId: session.organizationId, workspaceId: session.workspaceId }
  const db = scoped(scope)
  const run = await db.playbookRun.findFirst({
    where: { id: session.playbookRunId, dryRun: true, rootSessionId: session.id },
    select: { id: true, dryRunId: true, status: true },
  })
  if (!run?.dryRunId) return
  if (run.status === 'running' || run.status === 'waiting_person') {
    const error = ended.event.type === 'error'
    await db.playbookRun.updateMany({
      where: { id: run.id, outcome: null },
      data: {
        status: error ? 'failed' : 'done',
        ...(error
          ? { outcome: 'failed', summary: ended.event.message ?? 'It stopped on an error' }
          : {}),
        endedAt: new Date(),
      },
    })
    // Reported earlier in the turn: its outcome stays, and it is done.
    await db.playbookRun.updateMany({
      where: { id: run.id, status: { in: ['running', 'waiting_person'] } },
      data: { status: 'done', endedAt: new Date() },
    })
  }
  await advanceDryRun(scope, run.dryRunId)
}

/** Runs of a dry run still going past RUN_MS_MAX: cut short, so the report comes. Each minute (src/wakeups.ts). */
export async function settleOverdueDryRuns() {
  const overdue = await prisma.playbookRun.findMany({
    where: {
      dryRun: true,
      status: { in: ['running', 'waiting_person'] },
      startedAt: { lte: new Date(Date.now() - RUN_MS_MAX) },
    },
    select: { id: true, dryRunId: true, organizationId: true, workspaceId: true },
    take: 100,
  })
  for (const run of overdue) {
    const scope = { organizationId: run.organizationId, workspaceId: run.workspaceId }
    await scoped(scope).playbookRun.updateMany({
      where: { id: run.id, status: { in: ['running', 'waiting_person'] } },
      data: {
        status: 'failed',
        outcome: 'failed',
        summary: `It took longer than ${RUN_MS_MAX / 60_000} minutes and was left out`,
        endedAt: new Date(),
      },
    })
    if (run.dryRunId) await advanceDryRun(scope, run.dryRunId)
  }
}

/** The thread it was started from is woken, to show the report and say what it found. */
async function reportDone(db: ScopedDb, scope: Scope, dryRunId: string) {
  const view = await dryRunView(db, dryRunId)
  const dryRun = await db.playbookDryRun.findFirst({ where: { id: dryRunId } })
  await audit({
    ...scope,
    actor: { type: 'system', id: 'brigade' },
    action: 'playbook.dry_run_done',
    target: { type: 'playbook', id: view.installationId },
    data: { dryRunId, events: view.events.length, minutes: view.minutes },
  })
  if (!dryRun?.sessionId) return
  const thread = await db.session.findFirst({
    where: { id: dryRun.sessionId },
    select: { id: true, teammateId: true, teammates: { select: { teammateId: true } } },
  })
  if (!thread) return
  const seated = thread.teammates.some((t) => t.teammateId === dryRun.teammateId)
  const failed = view.events.filter((e) => e.status === 'failed').length
  const note =
    `${DRY_RUN_HEAD}${view.name} is done: ${view.events.length} event${view.events.length === 1 ? '' : 's'}` +
    (failed ? ` (${failed} failed)` : '') +
    `, ${minutesText(view.minutes)} of session on the owner's subscription` +
    (view.week
      ? `, about ${minutesText(view.week.minutes)} a week at the pace of these events (${view.week.events} a week).`
      : '.') +
    ' Nothing was sent: every write was simulated and no push left. ' +
    `Call dry_run_report with installationId ${view.installationId} to show its report in this thread, ` +
    'one card per event, and read what each run found and would have done. Then tell the person in a few ' +
    'lines what stands out and what you would change in its recipe (propose_skill), and offer to activate ' +
    'it (activate_playbook) when it looks right.'
  const wakeup = await db.wakeup.create({
    data: {
      sessionId: thread.id,
      teammateId: seated ? dryRun.teammateId : thread.teammateId,
      note,
      kind: 'report',
      wakeAt: new Date(),
    } as never,
  })
  await fireNow(wakeup.id)
}

const minutesText = (minutes: number) =>
  minutes < 1
    ? 'under a minute'
    : `${Math.round(minutes)} minute${Math.round(minutes) === 1 ? '' : 's'}`

/** Session minutes of each thread: its turns, from start to end. The playbook's numbers count them too. */
export async function sessionMinutes(db: ScopedDb, sessionIds: string[]) {
  const minutes = new Map<string, number>()
  if (!sessionIds.length) return minutes
  const events = await db.sessionEvent.findMany({
    where: {
      sessionId: { in: sessionIds },
      type: { in: ['turn.started', 'turn.completed', 'error'] },
    },
    orderBy: [{ sessionId: 'asc' }, { seq: 'asc' }],
    select: { sessionId: true, type: true, at: true },
  })
  // A turn stays open while it waits on a person's decision (an approval, a cap): that time
  // uses no subscription, so it is taken out.
  const tickets = await db.ticket.findMany({
    where: { sessionId: { in: sessionIds }, type: { in: ['approval', 'cap'] } },
    select: { sessionId: true, createdAt: true, resolvedAt: true },
  })
  const waits = new Map<string, { from: number; to: number }[]>()
  for (const t of tickets) {
    if (!t.sessionId) continue
    const list = waits.get(t.sessionId) ?? []
    list.push({ from: t.createdAt.getTime(), to: (t.resolvedAt ?? new Date()).getTime() })
    waits.set(t.sessionId, list)
  }
  // The union of the waits inside a turn: two approvals waiting at once count once.
  const waited = (sessionId: string, from: number, to: number) => {
    const spans = (waits.get(sessionId) ?? [])
      .map((w) => ({ from: Math.max(from, w.from), to: Math.min(to, w.to) }))
      .filter((w) => w.to > w.from)
      .sort((a, b) => a.from - b.from)
    let sum = 0
    let end = -Infinity
    for (const w of spans) {
      const start = Math.max(w.from, end)
      if (w.to > start) sum += w.to - start
      end = Math.max(end, w.to)
    }
    return sum
  }
  let open: { sessionId: string; at: Date } | null = null
  for (const e of events) {
    if (open && open.sessionId !== e.sessionId) open = null
    if (e.type === 'turn.started') open ??= { sessionId: e.sessionId, at: e.at }
    else if (open) {
      const from = open.at.getTime()
      const to = e.at.getTime()
      const ms = Math.max(0, to - from - waited(e.sessionId, from, to))
      minutes.set(e.sessionId, (minutes.get(e.sessionId) ?? 0) + ms / 60_000)
      open = null
    }
  }
  return minutes
}

const STATUS: Record<string, PlaybookDryRunEvent['status']> = {
  waiting_event: 'waiting',
  running: 'running',
  waiting_person: 'running',
  done: 'done',
  failed: 'failed',
}

/** A dry run as its report card and the teammate read it. */
export async function dryRunView(db: ScopedDb, id: string): Promise<PlaybookDryRunView> {
  const dryRun = await db.playbookDryRun.findFirst({
    where: { id },
    include: {
      installation: { select: { manifest: true } },
      runs: {
        orderBy: { startedAt: 'asc' },
        include: { rootSession: { select: { id: true, title: true } } },
      },
    },
  })
  if (!dryRun) throw new HTTPException(404, { message: 'Dry run not found' })
  const manifest = dryRun.installation.manifest as PlaybookManifest
  const runIds = dryRun.runs.map((r) => r.id)
  const threads = runIds.length
    ? await db.session.findMany({
        where: { playbookRunId: { in: runIds } },
        select: { id: true, playbookRunId: true },
      })
    : []
  const threadIds = threads.map((t) => t.id)
  const [minutes, calls] = await Promise.all([
    sessionMinutes(db, threadIds),
    threadIds.length
      ? db.connectionCall.findMany({
          where: {
            sessionId: { in: threadIds },
            OR: [{ simulated: true }, { operation: 'git_push', result: 'denied' }],
          },
          orderBy: { createdAt: 'asc' },
          select: {
            sessionId: true,
            operation: true,
            target: true,
            input: true,
            playbookActionKey: true,
            simulated: true,
          },
        })
      : [],
  ])
  const runOf = new Map(threads.map((t) => [t.id, t.playbookRunId]))
  const events: PlaybookDryRunEvent[] = dryRun.runs.map((run) => {
    const replay = run.replay as Replay | null
    const mine = calls.filter((c) => runOf.get(c.sessionId) === run.id)
    return {
      runId: run.id,
      title: replay?.title ?? run.rootSession?.title ?? 'Event',
      threadId: run.rootSession?.id ?? null,
      status: STATUS[run.status] ?? 'running',
      case: run.case,
      outcome: (run.outcome as PlaybookOutcome | null) ?? null,
      summary: run.summary,
      at: replay?.at ?? null,
      minutes: threads
        .filter((t) => t.playbookRunId === run.id)
        .reduce((sum, t) => sum + (minutes.get(t.id) ?? 0), 0),
      writes: mine
        .filter((c) => c.simulated)
        .map((c) => ({
          operation: c.operation,
          action: manifest.actions.find((a) => a.key === c.playbookActionKey)?.label ?? null,
          target: c.target,
          input: c.input ?? null,
        })),
      pushes: mine.filter((c) => !c.simulated).length,
    }
  })
  const total = events.reduce((sum, e) => sum + e.minutes, 0)
  const finished = events.filter((e) => e.status === 'done' || e.status === 'failed')
  return {
    id: dryRun.id,
    installationId: dryRun.installationId,
    name: manifest.name,
    status: dryRun.status as PlaybookDryRunView['status'],
    error: dryRun.error,
    events,
    finished: finished.length,
    minutes: round(total),
    week: weekOf(manifest, dryRun, finished.length, total),
    startedAt: dryRun.startedAt.toISOString(),
    endedAt: dryRun.endedAt?.toISOString() ?? null,
  }
}

const round = (n: number) => Math.round(n * 10) / 10

/**
 * A week at the pace of the replayed events: as many as came in a week, within its runs a
 * day, each at the average minutes of those done. A schedule's: its firings in a week.
 */
function weekOf(
  manifest: PlaybookManifest,
  dryRun: { firstEventAt: Date | null; lastEventAt: Date | null },
  finished: number,
  minutes: number,
): PlaybookDryRunView['week'] {
  if (!finished) return null
  const replay = manifest.dryRun?.replay ?? { entry: 0, last: 5 }
  const entry = manifest.entries[replay.entry]
  let perWeek: number | null = null
  if (entry && !isTriggerEntry(entry)) {
    perWeek = nextRuns(entry.schedule, entry.timezone ?? 'UTC', 50).filter(
      (d) => d.getTime() < Date.now() + WEEK_MS,
    ).length
  } else if (dryRun.firstEventAt && dryRun.lastEventAt && finished > 1) {
    // n events span n - 1 gaps; at least an hour, so a burst does not read as thousands.
    const span = Math.max(dryRun.lastEventAt.getTime() - dryRun.firstEventAt.getTime(), 3600_000)
    perWeek = ((finished - 1) / span) * WEEK_MS
  }
  if (perWeek === null) return null
  perWeek = Math.min(perWeek, manifest.limits.runsPerDay * 7)
  return { events: Math.round(perWeek), minutes: Math.round((minutes / finished) * perWeek) }
}

/** dry_run_report and the dashboard: the latest dry run of an installation. */
export async function latestDryRun(db: ScopedDb, installationId: string) {
  const latest = await db.playbookDryRun.findFirst({
    where: { installationId },
    orderBy: { startedAt: 'desc' },
    select: { id: true },
  })
  if (!latest)
    throw new HTTPException(404, { message: 'It has had no dry run yet: start_dry_run starts one' })
  return dryRunView(db, latest.id)
}
