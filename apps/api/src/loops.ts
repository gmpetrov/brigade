// Playbooks ("Playbook" in visible text; "loop" in code): a whole job to install. A template
// (loops/<id>/, shipped inside the API as src/generated/loops.ts) says what starts it, its
// recipe (skills), the Apps it needs, its settings and the writes it may make. Installing one
// creates its triggers, schedules and skill pack, all its own: they change only through it,
// and go when it is uninstalled. Each event is a run: a root thread out of the sidebar until a
// person takes part in it, with only the tools of the Apps the playbook declares.
import {
  cronProblem,
  isTriggerEntry,
  LoopManifest,
  nextRun,
  parseSkillMarkdown,
  SkillName,
  type InstallLoop,
  type LoopInstallationView,
  type LoopRunStatus,
  type LoopRunView,
  type LoopTemplate,
  type ScheduleOperation,
  type ThreadLoop,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit, type Actor } from './audit.js'
import { connectors, triggersOf } from './connectors/index.js'
import type { ConnectorKind } from './connectors/types.js'
import type { Scope, ScopedDb } from './db.js'
import { LOOP_TEMPLATES } from './generated/loops.js'
import { isMcp } from './mcp-tools.js'
import { usableProject } from './projects.js'
import { deleteTriggers, resync } from './routes/triggers.js'
import { createSchedule, memberTimezone } from './schedules.js'
import type { WorkspaceScope } from './scope.js'
import { savePack, storeSkillFile } from './skills.js'
import { syncConnection, SubscribeError } from './subscriptions/index.js'

/** Templates shipped with the API are Brigade's own: their id is brigade/<folder>. */
const SOURCE = 'brigade'
const DAY_MS = 24 * 3600_000

export type TemplateSkill = {
  /** Its folder in the template, e.g. skills/support-triage. */
  folder: string
  name: string
  description: string
  instructions: string
  files: { path: string; content: string }[]
}
export type Template = { manifest: LoopManifest; skills: TemplateSkill[] }

const fail = (where: string, message: string): never => {
  throw new Error(`Playbook ${where}: ${message}`)
}

/**
 * A template read and checked: its manifest against the schema, then against what Brigade
 * has (each App, trigger and tool exists, each cron runs), and each skill it names has a
 * SKILL.md. Throws, naming the template and what is wrong.
 */
export function readTemplate(
  folder: string,
  raw: { manifest: unknown; files: Record<string, string> },
): Template {
  const parsed = LoopManifest.safeParse(raw.manifest)
  if (!parsed.success)
    fail(
      folder,
      parsed.error.issues.map((i) => `${i.path.join('.') || 'loop.yaml'}: ${i.message}`).join('; '),
    )
  const manifest = parsed.data!
  if (manifest.id !== `${SOURCE}/${folder}`)
    fail(folder, `its id must be ${SOURCE}/${folder}, not ${manifest.id}`)
  for (const app of manifest.apps)
    if (!connectors[app.kind as ConnectorKind]) fail(folder, `there is no App ${app.kind}`)
  manifest.entries.forEach((entry, i) => {
    if (isTriggerEntry(entry)) {
      const [kind, event] = entry.trigger.split('.') as [ConnectorKind, string]
      const definition = triggersOf(kind)[event!]
      if (!definition) fail(folder, `entries.${i}: ${kind} has no trigger ${event}`)
      for (const name of Object.keys(entry.options))
        if (!definition!.options?.some((o) => o.name === name))
          fail(folder, `entries.${i}: ${entry.trigger} has no option ${name}`)
    } else {
      const problem = cronProblem(entry.schedule, entry.timezone ?? 'UTC')
      if (problem) fail(folder, `entries.${i}: ${problem}`)
    }
  })
  // Each tool of an action is one of its Apps'; an MCP App's tools come from its server.
  for (const action of manifest.actions)
    for (const tool of action.tools) {
      const owner = manifest.apps.find((a) => {
        const kind = a.kind as ConnectorKind
        return isMcp(kind) || connectors[kind]?.operations[tool]
      })
      if (!owner) fail(folder, `action ${action.key}: no App of it has the tool ${tool}`)
    }
  const skills = manifest.skills.map((path): TemplateSkill => {
    const base = path.replace(/\/+$/, '')
    const markdown = raw.files[`${base}/SKILL.md`]
    if (markdown === undefined) fail(folder, `${base} has no SKILL.md`)
    const doc = parseSkillMarkdown(markdown!)
    const name = SkillName.safeParse(doc.name ?? base.split('/').pop())
    if (!name.success) fail(folder, `${base}: ${name.error!.issues[0]?.message}`)
    if (!doc.description) fail(folder, `${base}: its SKILL.md has no description`)
    return {
      folder: base,
      name: name.data!,
      description: doc.description!,
      instructions: doc.instructions,
      files: Object.entries(raw.files)
        .filter(([p]) => p.startsWith(`${base}/`) && p !== `${base}/SKILL.md`)
        .map(([p, content]) => ({ path: p.slice(base.length + 1), content })),
    }
  })
  return { manifest, skills }
}

let catalog: Map<string, Template> | undefined

/** The templates shipped with the API, by id, checked once. */
export function templates(): Map<string, Template> {
  catalog ??= new Map(
    Object.entries(LOOP_TEMPLATES).map(([folder, raw]) => {
      const template = readTemplate(folder, raw)
      return [template.manifest.id, template]
    }),
  )
  return catalog
}

export const templateView = ({ manifest: m, skills }: Template): LoopTemplate => ({
  id: m.id,
  name: m.name,
  version: m.version,
  description: m.description,
  source: SOURCE,
  apps: m.apps,
  settings: m.settings,
  entries: m.entries,
  actions: m.actions,
  skills: skills.map((s) => s.name),
  limits: m.limits,
})

/** {{key}} replaced by its setting; unknown ones are left as they are. */
export const fill = (text: string, settings: Record<string, string | number>) =>
  text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (whole, key: string) =>
    key in settings ? String(settings[key]) : whole,
  )

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/

/**
 * The installation's settings: each answer checked by its kind, defaults for those not
 * given (after the answers, so a default may use them). An account setting is the id of an
 * account of its App in the workspace.
 */
export async function resolveSettings(
  db: ScopedDb,
  manifest: LoopManifest,
  input: Record<string, string | number>,
) {
  const values: Record<string, string | number> = {}
  const bad = (setting: { key: string; ask?: string }, why: string): never => {
    throw new HTTPException(400, { message: `${setting.ask ?? setting.key} ${why}` })
  }
  for (const setting of manifest.settings) {
    const given = input[setting.key]
    if (given === undefined || given === '') continue
    const text = String(given).trim()
    switch (setting.type) {
      case 'text':
        if (!text) bad(setting, 'needs an answer')
        values[setting.key] = text
        break
      case 'url':
        if (!URL.canParse(text) || !/^https?:$/.test(new URL(text).protocol))
          bad(setting, 'needs a web address (https://…)')
        values[setting.key] = text
        break
      case 'email':
        if (!EMAIL.test(text)) bad(setting, 'needs an email address')
        values[setting.key] = text.toLowerCase()
        break
      case 'repository': {
        const repo = text.replace(/^https:\/\/github\.com\//, '').replace(/\.git$|\/$/g, '')
        if (!REPOSITORY.test(repo)) bad(setting, 'needs a repository as owner/name')
        values[setting.key] = repo
        break
      }
      case 'amount': {
        const amount = Number(text)
        if (!Number.isFinite(amount) || amount < 0) bad(setting, 'needs an amount')
        values[setting.key] = amount
        break
      }
      case 'choice':
        if (!setting.options!.includes(text))
          bad(setting, `is one of ${setting.options!.join(', ')}`)
        values[setting.key] = text
        break
      case 'account': {
        const account = await db.connection.findFirst({
          where: { id: text, kind: setting.app as ConnectorKind, status: { not: 'removed' } },
        })
        if (!account) bad(setting, `needs one of the workspace's ${setting.app} accounts`)
        values[setting.key] = account!.id
        break
      }
    }
  }
  for (const setting of manifest.settings) {
    if (setting.key in values) continue
    if (setting.default !== undefined)
      values[setting.key] =
        typeof setting.default === 'string' ? fill(setting.default, values) : setting.default
    else if (!setting.optional) bad(setting, 'needs an answer')
  }
  return values
}

/** Its owner, or an owner or admin: pause, resume, uninstall. */
function requireManager(scope: WorkspaceScope, installation: { ownerMemberId: string }) {
  if (installation.ownerMemberId !== scope.memberId && scope.role === 'member')
    throw new HTTPException(403, {
      message:
        "This playbook runs on another member's accounts; only they or an owner or admin manage it",
    })
}

const admin = (scope: WorkspaceScope) => scope.role === 'owner' || scope.role === 'admin'

/** A skill name not yet taken in the workspace: its own, else with -2, -3… */
async function freeName(db: ScopedDb, name: string) {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name.slice(0, 60)}-${n}`
    if (!(await db.skill.findFirst({ where: { name: candidate }, select: { id: true } })))
      return candidate
  }
}

/**
 * Install a template: its settings checked, then its actions at their starting level, its
 * skill pack, triggers and schedules, all marked as its own. An owner or admin's installation
 * is active at once; a member's waits in setup for one of them to activate it. If any part
 * cannot be made (a vendor refuses the subscription), nothing is kept.
 */
export async function installLoop(db: ScopedDb, scope: WorkspaceScope, input: InstallLoop) {
  const template = templates().get(input.loopKey)
  if (!template) throw new HTTPException(404, { message: `No playbook ${input.loopKey}` })
  const { manifest } = template
  const teammate = await db.teammate.findFirst({
    where: { id: input.teammateId, archivedAt: null },
  })
  if (!teammate) throw new HTTPException(404, { message: 'Teammate not found or archived' })
  const projectId = (await usableProject(db, input.projectId)) ?? null
  const settings = await resolveSettings(db, manifest, input.settings)
  const active = admin(scope)
  const actor: Actor = { type: 'member', id: scope.memberId }

  const installation = await db.loopInstallation.create({
    data: {
      projectId,
      loopKey: manifest.id,
      version: manifest.version,
      source: SOURCE,
      manifest: manifest as never,
      teammateId: teammate.id,
      ownerMemberId: scope.memberId,
      settings,
      status: active ? 'active' : 'setup',
      createdByMemberId: scope.memberId,
      ...(active ? { activatedAt: new Date(), activatedByMemberId: scope.memberId } : {}),
    } as never,
  })
  const connectionIds = new Set<string>()
  try {
    if (manifest.actions.length)
      await db.loopAction.createMany({
        data: manifest.actions.map((a) => ({
          installationId: installation.id,
          key: a.key,
          level: a.start,
        })) as never,
      })

    // Its recipe: a pack of its own, loaded only in its threads (threadSkills).
    if (template.skills.length) {
      const skills = []
      for (const s of template.skills)
        skills.push({
          name: await freeName(db, s.name),
          description: s.description,
          instructions: s.instructions,
          files: await Promise.all(
            s.files.map((f) => storeSkillFile(scope, f.path, new TextEncoder().encode(f.content))),
          ),
          enabled: true,
        })
      const pack = await savePack(db, scope, actor, {
        name: manifest.name,
        source: `loop:${installation.id}`,
        everywhere: true,
        teammateIds: [],
        projectIds: [],
        skills,
      })
      await db.skillPack.updateMany({
        where: { id: pack.id },
        data: { loopInstallationId: installation.id },
      })
    }

    for (const entry of manifest.entries) {
      if (isTriggerEntry(entry)) {
        const [kind, event] = entry.trigger.split('.') as [ConnectorKind, string]
        const connection = await db.connection.findFirst({
          where: { id: fill(entry.account, settings), kind, status: { not: 'removed' } },
        })
        if (!connection)
          throw new HTTPException(400, {
            message: `${entry.trigger} needs one of the workspace's ${kind} accounts`,
          })
        const definition = triggersOf(kind)[event]!
        const options = Object.fromEntries(
          Object.entries(entry.options)
            .map(([k, v]) => [k, fill(v, settings).trim()] as const)
            .filter(([, v]) => v),
        )
        await db.trigger.create({
          data: {
            connectionId: connection.id,
            teammateId: teammate.id,
            label: entry.label ?? `${manifest.name}: ${definition.label}`,
            event,
            options,
            createdByMemberId: scope.memberId,
            projectId,
            loopInstallationId: installation.id,
          } as never,
        })
        connectionIds.add(connection.id)
      } else {
        const schedule = await createSchedule(
          db,
          scope,
          {
            teammateId: teammate.id,
            title: entry.title ?? manifest.name,
            instructions: fill(entry.instructions, settings),
            cron: entry.schedule,
            timezone: entry.timezone ?? (await memberTimezone(db, scope.memberId)),
            projectId,
          },
          { memberId: scope.memberId },
        )
        await db.schedule.updateMany({
          where: { id: schedule.id },
          data: {
            loopInstallationId: installation.id,
            // Waiting for activation, it does not fire.
            ...(active ? {} : { pausedAt: new Date(), nextRunAt: null }),
          },
        })
      }
    }
    // Subscribe the vendors now, so a refusal is the installer's to see.
    for (const id of connectionIds) await syncConnection(scope, id)
  } catch (error) {
    await removeInstallation(db, scope, installation.id)
    if (error instanceof HTTPException) throw error
    if (error instanceof SubscribeError) throw new HTTPException(400, { message: error.message })
    throw error
  }
  await audit({
    ...scope,
    actor,
    action: 'loop.installed',
    target: { type: 'loop', id: installation.id },
    data: { loopKey: manifest.id, version: manifest.version, status: installation.status },
  })
  return getInstallation(db, installation.id)
}

/** Everything it made goes: triggers (and their subscriptions), schedules, its pack, its runs. */
async function removeInstallation(db: ScopedDb, scope: Scope, id: string) {
  const removed = await deleteTriggers(db, { loopInstallationId: id })
  // Its runs no person took part in go out of sight; those a person joined stay their threads.
  await db.session.updateMany({
    where: { loopRun: { installationId: id }, surfacedAt: null, archivedAt: null },
    data: { archivedAt: new Date() },
  })
  await db.loopInstallation.deleteMany({ where: { id } })
  await resync(
    scope,
    removed.map((t) => t.connectionId),
  )
}

async function requireInstallation(db: ScopedDb, id: string) {
  const installation = await db.loopInstallation.findFirst({ where: { id } })
  if (!installation) throw new HTTPException(404, { message: 'Playbook not found' })
  return installation
}

export async function uninstallLoop(db: ScopedDb, scope: WorkspaceScope, id: string) {
  const installation = await requireInstallation(db, id)
  requireManager(scope, installation)
  await removeInstallation(db, scope, id)
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'loop.uninstalled',
    target: { type: 'loop', id },
    data: { loopKey: installation.loopKey },
  })
}

/**
 * Pause or resume. Resuming one that waits in setup activates it, which takes an owner or
 * admin: it then runs on its owner's accounts with no one checking each time.
 */
export async function setLoopPaused(
  db: ScopedDb,
  scope: WorkspaceScope,
  id: string,
  paused: boolean,
) {
  const installation = await requireInstallation(db, id)
  requireManager(scope, installation)
  const activating = !paused && installation.status !== 'active' && !installation.activatedAt
  if (activating && !admin(scope))
    throw new HTTPException(403, { message: 'Only an owner or admin can activate a playbook' })
  const now = new Date()
  await db.loopInstallation.updateMany({
    where: { id },
    data: paused
      ? { status: 'paused', pausedAt: now }
      : {
          status: 'active',
          pausedAt: null,
          ...(activating ? { activatedAt: now, activatedByMemberId: scope.memberId } : {}),
        },
  })
  const schedules = await db.schedule.findMany({ where: { loopInstallationId: id } })
  for (const s of schedules)
    await db.schedule.updateMany({
      where: { id: s.id },
      data: paused
        ? { pausedAt: now, nextRunAt: null }
        : { pausedAt: null, nextRunAt: nextRun(s.cron, s.timezone) ?? null },
    })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: paused ? 'loop.paused' : activating ? 'loop.activated' : 'loop.resumed',
    target: { type: 'loop', id },
  })
  return getInstallation(db, id)
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export type RunStart = { runId: string } | { skipped: string } | { limit: string }

/**
 * Before a trigger or schedule of a playbook starts a thread: the run it is. Nothing while
 * the playbook is not active. Past its runs a day, the event waits (the caller offers it
 * again later) and its owner gets a ticket, one at a time.
 */
export async function beginRun(
  db: ScopedDb,
  installationId: string,
  conversationKey?: string,
): Promise<RunStart> {
  const installation = await db.loopInstallation.findFirst({ where: { id: installationId } })
  if (!installation) return { skipped: 'the playbook is gone' }
  if (installation.status !== 'active') return { skipped: `the playbook is ${installation.status}` }
  const manifest = installation.manifest as LoopManifest
  const perDay = manifest.limits.runsPerDay
  const today = await db.loopRun.count({
    where: { installationId, dryRun: false, startedAt: { gte: new Date(Date.now() - DAY_MS) } },
  })
  if (today >= perDay) {
    const message = `the playbook reached its ${perDay} runs a day`
    const open = await db.ticket.count({
      where: {
        type: 'question',
        status: 'open',
        payload: { path: ['loopInstallationId'], equals: installationId },
      },
    })
    if (!open)
      await db.ticket.create({
        data: {
          type: 'question',
          title: `Playbook "${manifest.name}" reached its ${perDay} runs a day: new events wait until the next ones free up`,
          payload: {
            loopInstallationId: installationId,
            memberId: installation.ownerMemberId,
            limit: 'runsPerDay',
          },
        } as never,
      })
    return { limit: message }
  }
  const run = await db.loopRun.create({
    data: { installationId, conversationKey: conversationKey ?? null } as never,
  })
  return { runId: run.id }
}

/**
 * Its root thread started: tied to the run. Not started (the computer offline, no account):
 * the run never was, so it does not count, and the thread that failed goes out of sight; the
 * event is offered again later.
 */
export async function settleRun(db: ScopedDb, runId: string, threadId: string | null) {
  if (threadId) {
    await db.loopRun.updateMany({ where: { id: runId }, data: { rootSessionId: threadId } })
    return
  }
  await db.session.updateMany({
    where: { loopRunId: runId, surfacedAt: null },
    data: { archivedAt: new Date() },
  })
  await db.loopRun.deleteMany({ where: { id: runId } })
}

/** A later event of the same conversation: the run goes on. */
export async function continueRun(db: ScopedDb, runId: string | null) {
  if (!runId) return
  await db.loopRun.updateMany({
    where: { id: runId },
    data: { status: 'running', endedAt: null },
  })
}

/**
 * A person took part in a run's thread (a message, a takeover, a pin): from now on it is in
 * the sidebar's Threads like any other. A member's message counts as stepping in.
 */
export async function surface(
  db: ScopedDb,
  thread: { id: string; loopRunId: string | null; surfacedAt: Date | null },
  intervention = false,
) {
  if (!thread.loopRunId) return
  if (!thread.surfacedAt)
    await db.session.updateMany({
      where: { id: thread.id, surfacedAt: null },
      data: { surfacedAt: new Date() },
    })
  if (intervention)
    await db.loopRun.updateMany({
      where: { id: thread.loopRunId },
      data: { interventions: { increment: 1 } },
    })
}

/** The playbook a thread is part of, for its spec: its run, name and Apps. */
export async function threadLoop(
  db: ScopedDb,
  loopRunId: string | null,
): Promise<
  | (ThreadLoop & {
      access: Map<string, 'read' | 'read_write'>
      actions: LoopManifest['actions']
    })
  | null
> {
  if (!loopRunId) return null
  const run = await db.loopRun.findFirst({
    where: { id: loopRunId },
    include: { installation: { select: { id: true, manifest: true } } },
  })
  if (!run) return null
  const manifest = run.installation.manifest as LoopManifest
  return {
    installationId: run.installation.id,
    runId: run.id,
    name: manifest.name,
    apps: manifest.apps.map((a) => a.kind),
    access: new Map(manifest.apps.map((a) => [a.kind, a.access])),
    actions: manifest.actions,
  }
}

type LoopReport = Extract<ScheduleOperation, { name: 'loop_report' }>

/** loop_report: the run's case and how it ended. */
export async function reportRun(
  db: ScopedDb,
  scope: Scope,
  session: { id: string; loopRunId: string | null },
  teammate: { id: string },
  op: LoopReport,
): Promise<{ error: string } | { recorded: { case: string; outcome: string }; note: string }> {
  if (!session.loopRunId)
    return { error: 'This thread is not part of a playbook: there is nothing to report.' }
  await db.loopRun.updateMany({
    where: { id: session.loopRunId },
    data: {
      case: op.case,
      outcome: op.outcome,
      status: op.outcome === 'failed' ? 'failed' : 'done',
      endedAt: new Date(),
    },
  })
  await audit({
    ...scope,
    actor: { type: 'teammate', id: teammate.id },
    action: 'loop.reported',
    target: { type: 'loop_run', id: session.loopRunId },
    data: { case: op.case, outcome: op.outcome, ...(op.summary ? { summary: op.summary } : {}) },
  })
  return {
    recorded: { case: op.case, outcome: op.outcome },
    note: 'Recorded on the run. A later event of the same conversation continues it.',
  }
}

// ---------------------------------------------------------------------------
// The dashboard's view
// ---------------------------------------------------------------------------

/** Unreported, a run's state is its root thread's. */
function runStatus(
  run: { status: LoopRunStatus; outcome: string | null },
  thread: { status: string } | null,
): LoopRunStatus {
  if (run.outcome || !thread) return run.status
  switch (thread.status) {
    case 'starting':
    case 'running':
      return 'running'
    case 'waiting':
    case 'paused':
      return 'waiting_person'
    case 'failed':
      return 'failed'
    default:
      return 'done'
  }
}

const INCLUDE = {
  teammate: { select: { id: true, name: true } },
  owner: { select: { id: true, user: { select: { name: true } } } },
  project: { select: { id: true, name: true, icon: true, logo: true } },
  actions: true,
  triggers: {
    include: { connection: { select: { kind: true, label: true, externalAccount: true } } },
  },
  schedules: true,
} as const

type Row = NonNullable<Awaited<ReturnType<typeof findRows>>>[number]

const findRows = (db: ScopedDb, where: { id?: string; projectId?: string | null }) =>
  db.loopInstallation.findMany({ where, include: INCLUDE, orderBy: { createdAt: 'asc' } })

async function toView(db: ScopedDb, row: Row, runsTaken = 10): Promise<LoopInstallationView> {
  const manifest = row.manifest as LoopManifest
  const week = new Date(Date.now() - 7 * DAY_MS)
  const day = new Date(Date.now() - DAY_MS)
  const [recent, weekRuns, calls] = await Promise.all([
    db.loopRun.findMany({
      where: { installationId: row.id, dryRun: false },
      orderBy: { startedAt: 'desc' },
      take: runsTaken,
      include: { rootSession: { select: { id: true, title: true, status: true } } },
    }),
    db.loopRun.findMany({
      where: { installationId: row.id, dryRun: false, startedAt: { gte: week } },
      select: { startedAt: true, endedAt: true, interventions: true },
    }),
    db.connectionCall.findMany({
      where: {
        loopActionKey: { not: null },
        simulated: false,
        session: { loopRun: { installationId: row.id } },
      },
      select: { loopActionKey: true, result: true, ticketId: true },
    }),
  ])
  const ended = weekRuns.filter((r) => r.endedAt)
  // A call a person decided carries its ticket: approved, or denied. One without, done alone.
  const count = (key: string, result: 'ok' | 'denied', decided: boolean) =>
    calls.filter((c) => c.loopActionKey === key && c.result === result && !!c.ticketId === decided)
      .length
  const settings = (row.settings ?? {}) as Record<string, string | number>
  const recentRuns: LoopRunView[] = recent.map((run) => ({
    id: run.id,
    title: run.rootSession?.title ?? 'Run',
    threadId: run.rootSession?.id ?? null,
    case: run.case,
    status: runStatus(run, run.rootSession),
    outcome: (run.outcome as LoopRunView['outcome']) ?? null,
    startedAt: run.startedAt.toISOString(),
    endedAt: run.endedAt?.toISOString() ?? null,
  }))
  return {
    id: row.id,
    loopKey: row.loopKey,
    name: manifest.name,
    description: manifest.description,
    version: row.version,
    source: row.source,
    status: row.status,
    teammate: row.teammate,
    owner: { id: row.owner.id, name: row.owner.user.name },
    project: row.project,
    apps: manifest.apps,
    settings: manifest.settings.map((s) => ({
      key: s.key,
      type: s.type,
      ...(s.ask ? { ask: s.ask } : {}),
      value:
        s.type === 'account'
          ? (row.triggers.find((t) => t.connectionId === settings[s.key])?.connection
              .externalAccount ??
            settings[s.key] ??
            null)
          : (settings[s.key] ?? null),
    })),
    actions: manifest.actions.map((a) => ({
      ...a,
      level: row.actions.find((r) => r.key === a.key)?.level ?? a.start,
      approved: count(a.key, 'ok', true),
      denied: count(a.key, 'denied', true),
      auto: count(a.key, 'ok', false),
    })),
    entries: [
      ...row.triggers.map((t) => ({
        kind: 'trigger' as const,
        id: t.id,
        label: t.label,
        app: t.connection.kind,
        event: t.event,
        account: t.connection.externalAccount ?? t.connection.label,
      })),
      ...row.schedules.map((s) => ({
        kind: 'schedule' as const,
        id: s.id,
        title: s.title,
        cron: s.cron,
        timezone: s.timezone,
        nextRunAt: s.nextRunAt?.toISOString() ?? null,
      })),
    ],
    runsThisWeek: weekRuns.length,
    runsToday: weekRuns.filter((r) => r.startedAt >= day).length,
    runsPerDay: manifest.limits.runsPerDay,
    unattended: ended.length
      ? ended.filter((r) => r.interventions === 0).length / ended.length
      : null,
    recentRuns,
    createdAt: row.createdAt.toISOString(),
    activatedAt: row.activatedAt?.toISOString() ?? null,
    pausedAt: row.pausedAt?.toISOString() ?? null,
  }
}

/** `project`: a project's id, or "none". */
export async function listInstallations(db: ScopedDb, project?: string) {
  const rows = await findRows(db, project ? { projectId: project === 'none' ? null : project } : {})
  return Promise.all(rows.map((row) => toView(db, row, 5)))
}

export async function getInstallation(db: ScopedDb, id: string) {
  const [row] = await findRows(db, { id })
  if (!row) throw new HTTPException(404, { message: 'Playbook not found' })
  return toView(db, row, 30)
}
