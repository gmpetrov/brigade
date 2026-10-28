// Playbooks ("Playbook" in visible text; "playbook" in code): a whole job to install. A template
// (playbooks/<id>/, shipped inside the API as src/generated/playbooks.ts) says what starts it, its
// recipe (skills), the Apps it needs, its settings and the writes it may make. Installing one
// creates its triggers, schedules and skill pack, all its own: they change only through it,
// and go when it is uninstalled. Each event is a run: a root thread out of the sidebar until a
// person takes part in it, with only the tools of the Apps the playbook declares.
import {
  cronProblem,
  isTriggerEntry,
  MCP_KIND,
  PlaybookManifest,
  playbookRoles,
  roleOfTeammate,
  nextRun,
  parseSkillMarkdown,
  SkillName,
  type InstallPlaybook,
  type PlaybookAppStatus,
  type PlaybookEntry,
  type PlaybookInstallationView,
  type PlaybookRole,
  type PlaybookRunStatus,
  type PlaybookRunView,
  type PlaybookTemplate,
  type ScheduleOperation,
  type ThreadPlaybook,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit, type Actor } from './audit.js'
import { connectors, triggersOf } from './connectors/index.js'
import type { ConnectorKind } from './connectors/types.js'
import { Prisma, type Scope, type ScopedDb } from './db.js'
import { PLAYBOOK_TEMPLATES } from './generated/playbooks.js'
import { usableIn } from './apps.js'
import { isMcp } from './mcp-tools.js'
import { usableProject } from './projects.js'
import { deleteTriggers, resync } from './routes/triggers.js'
import { actionViews, recentAutoCalls } from './playbook-autonomy.js'
import { dryRunView } from './playbook-dry-runs.js'
import { playbookMetrics } from './playbook-metrics.js'
import { updateView } from './playbook-updates.js'
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
export type Template = { manifest: PlaybookManifest; skills: TemplateSkill[] }

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
  const parsed = PlaybookManifest.safeParse(raw.manifest)
  if (!parsed.success)
    fail(
      folder,
      parsed.error.issues
        .map((i) => `${i.path.join('.') || 'playbook.yaml'}: ${i.message}`)
        .join('; '),
    )
  const manifest = parsed.data!
  if (manifest.id !== `${SOURCE}/${folder}`)
    fail(folder, `its id must be ${SOURCE}/${folder}, not ${manifest.id}`)
  // Each App a role accepts is built in, or a server added by its URL (mcp).
  const roles = playbookRoles(manifest.apps)
  for (const kind of roles.flatMap((r) => r.kinds))
    if (kind !== MCP_KIND && !connectors[kind as ConnectorKind])
      fail(folder, `there is no App ${kind}`)
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
      const owner = roles
        .flatMap((r) => r.kinds as ConnectorKind[])
        .find((kind) => isMcp(kind) || connectors[kind]?.operations[tool])
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
    Object.entries(PLAYBOOK_TEMPLATES).map(([folder, raw]) => {
      const template = readTemplate(folder, raw)
      return [template.manifest.id, template]
    }),
  )
  return catalog
}

export const templateView = ({ manifest: m, skills }: Template): PlaybookTemplate => ({
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

/** The App kinds an account setting takes an account of: its role's, or its one App's. */
const settingKinds = (manifest: PlaybookManifest, setting: { app?: string }) =>
  (playbookRoles(manifest.apps).find((r) => r.name === setting.app)?.kinds ?? [
    setting.app!,
  ]) as ConnectorKind[]

/** An App's name as its accounts are told apart: Mixpanel, MCP. */
const providerName = (kind: string) =>
  kind === MCP_KIND ? 'MCP' : (connectors[kind as ConnectorKind]?.label ?? kind)

/** One account an account setting may take: its id, its App and what its row shows. */
export type AccountChoice = { id: string; kind: string; app: string; name: string; label: string }

/** "Mixpanel · Acme (id c123)": an account told apart from others of the same name. */
const choiceWords = (a: AccountChoice) => `${a.app} · ${a.name} (id ${a.id})`

/** The workspace's accounts an account setting may take, of any App its role accepts. */
export async function accountChoices(
  db: ScopedDb,
  manifest: PlaybookManifest,
  setting: { app?: string },
): Promise<AccountChoice[]> {
  const rows = await db.connection.findMany({
    where: { kind: { in: settingKinds(manifest, setting) }, status: { not: 'removed' } },
    select: { id: true, kind: true, externalAccount: true, label: true },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    app: providerName(r.kind),
    name: r.externalAccount ?? r.label,
    label: r.label,
  }))
}

/** The teammates a teammate setting may take: the workspace's, the chief left out (it routes work). */
export async function teammateChoices(db: ScopedDb) {
  return db.teammate.findMany({
    where: { archivedAt: null, kind: { not: 'chief' } },
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  })
}

/** "mixpanel or MCP server": the Apps a role accepts, as a sentence says them. */
const kindsWords = (kinds: readonly string[]) =>
  kinds.map((k) => (k === MCP_KIND ? 'MCP server' : k)).join(' or ')

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/

/**
 * The answers given, each checked by its setting's kind. An account setting takes one of the
 * workspace's accounts of its App, by id or by what its row shows, and keeps its id.
 */
export async function checkSettings(
  db: ScopedDb,
  manifest: PlaybookManifest,
  input: Record<string, string | number>,
) {
  const values: Record<string, string | number> = {}
  const bad = (setting: { key: string; ask?: string }, why: string): never => {
    throw new HTTPException(400, { message: `${setting.ask ?? setting.key} ${why}` })
  }
  for (const [key, given] of Object.entries(input)) {
    const setting = manifest.settings.find((s) => s.key === key)
    if (!setting)
      throw new HTTPException(400, {
        message: `${manifest.name} has no setting ${key}; its settings are ${manifest.settings.map((s) => s.key).join(', ')}`,
      })
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
        // Its id, or what its row shows (the Gmail address), as a person would say it: an
        // account of one of the Apps its role accepts. A name two accounts share (a Mixpanel
        // organization and an MCP server both called Acme) picks neither: it takes the id.
        const kinds = settingKinds(manifest, setting)
        const accounts = await accountChoices(db, manifest, setting)
        const lower = text.toLowerCase()
        const byId = accounts.find((a) => a.id === text)
        const named = accounts.filter(
          (a) => a.name.toLowerCase() === lower || a.label.toLowerCase() === lower,
        )
        if (!byId && named.length > 1)
          bad(
            setting,
            `matches ${named.length} accounts; answer with one of their ids: ${named.map(choiceWords).join(', ')}`,
          )
        const account = byId ?? named[0]
        if (!account)
          bad(
            setting,
            accounts.length
              ? `needs one of the workspace's ${kindsWords(kinds)} accounts: ${accounts.map(choiceWords).join(', ')}`
              : `needs a ${kindsWords(kinds)} account, and the workspace has none yet`,
          )
        values[setting.key] = account!.id
        break
      }
      case 'teammate': {
        // By id or name, as a person would say it; the chief only when named.
        const teammate =
          (await db.teammate.findFirst({ where: { id: text, archivedAt: null } })) ??
          (await db.teammate.findFirst({
            where: { name: { equals: text, mode: 'insensitive' }, archivedAt: null },
          }))
        if (!teammate)
          bad(
            setting,
            `needs one of the workspace's teammates: ${(await teammateChoices(db)).map((t) => t.name).join(', ')}`,
          )
        values[setting.key] = teammate!.id
        break
      }
    }
  }
  return values
}

/** Its answers with defaults for those not given (after the answers, so a default may use them), and what still lacks one. */
export function withDefaults(manifest: PlaybookManifest, answers: Record<string, string | number>) {
  const values = { ...answers }
  const missing: string[] = []
  for (const setting of manifest.settings) {
    if (setting.key in values) continue
    if (setting.default !== undefined)
      values[setting.key] =
        typeof setting.default === 'string' ? fill(setting.default, values) : setting.default
    else if (!setting.optional) missing.push(setting.key)
  }
  return { values, missing }
}

/** Every answer checked by its kind, with defaults; throws on the first one missing. */
export async function resolveSettings(
  db: ScopedDb,
  manifest: PlaybookManifest,
  input: Record<string, string | number>,
) {
  const { values, missing } = withDefaults(manifest, await checkSettings(db, manifest, input))
  const first = manifest.settings.find((s) => s.key === missing[0])
  if (first) throw new HTTPException(400, { message: `${first.ask ?? first.key} needs an answer` })
  return values
}

/** Its owner, or an owner or admin: pause, resume, uninstall. */
export function requireManager(
  scope: { memberId: string; role: string },
  installation: { ownerMemberId: string },
) {
  if (installation.ownerMemberId !== scope.memberId && scope.role === 'member')
    throw new HTTPException(403, {
      message:
        "This playbook runs on another member's accounts; only they or an owner or admin manage it",
    })
}

export const isAdminRole = (role: string) => role === 'owner' || role === 'admin'

/** A skill name not yet taken in the workspace: its own, else with -2, -3… */
export async function freeName(db: ScopedDb, name: string) {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name.slice(0, 60)}-${n}`
    if (!(await db.skill.findFirst({ where: { name: candidate }, select: { id: true } })))
      return candidate
  }
}

/** Who installs: the member whose accounts it runs on. */
export type Installer = Scope & { memberId: string }

/**
 * A template installed in setup, its settings so far: nothing runs until it is activated.
 * Its parts come once every setting has an answer (buildParts).
 */
export async function createInstallation(
  db: ScopedDb,
  scope: Installer,
  input: {
    template: Template
    teammateId: string
    projectId?: string | null
    settings: Record<string, string | number>
  },
) {
  const { manifest } = input.template
  const teammate = await db.teammate.findFirst({
    where: { id: input.teammateId, archivedAt: null },
  })
  if (!teammate) throw new HTTPException(404, { message: 'Teammate not found or archived' })
  const projectId = (await usableProject(db, input.projectId)) ?? null
  const settings = await checkSettings(db, manifest, input.settings)
  const installation = await db.playbookInstallation.create({
    data: {
      projectId,
      playbookKey: manifest.id,
      version: manifest.version,
      source: SOURCE,
      manifest: manifest as never,
      // The teammate its runs start with, once its setting has an answer; until then, the one
      // installing it holds the place (nothing runs before every setting has an answer).
      teammateId: runTeammate(manifest, settings) ?? teammate.id,
      ownerMemberId: scope.memberId,
      settings,
      status: 'setup',
      createdByMemberId: scope.memberId,
    } as never,
  })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'playbook.installed',
    target: { type: 'playbook', id: installation.id },
    data: { playbookKey: manifest.id, version: manifest.version, status: installation.status },
  })
  return installation
}

/** What it made from its settings: its actions, skill pack, triggers and schedules. */
async function removeParts(db: ScopedDb, scope: Scope, id: string) {
  const removed = await deleteTriggers(db, { playbookInstallationId: id })
  await db.schedule.deleteMany({ where: { playbookInstallationId: id } })
  await db.skillPack.deleteMany({ where: { playbookInstallationId: id } })
  await db.playbookAction.deleteMany({ where: { installationId: id } })
  return removed.map((t) => t.connectionId)
}

/**
 * Make its parts from its settings, all marked as its own: its actions at their starting
 * level, its skill pack (loaded only in its threads), its triggers and its schedules
 * (paused until it is active). Made again when its settings change before it is active.
 * If a part cannot be made (a vendor refuses the subscription), none is kept.
 */
export async function buildParts(db: ScopedDb, scope: Installer, id: string) {
  const installation = await requireInstallation(db, id)
  const manifest = installation.manifest as PlaybookManifest
  const template = templates().get(installation.playbookKey)
  const settings = installation.settings as Record<string, string | number>
  const teammate = await db.teammate.findFirst({ where: { id: installation.teammateId } })
  if (!teammate) throw new HTTPException(404, { message: 'Teammate not found' })
  const active = installation.status === 'active'
  const actor: Actor = { type: 'member', id: scope.memberId }
  const before = await removeParts(db, scope, id)
  const connectionIds = new Set<string>()
  try {
    if (manifest.actions.length)
      await db.playbookAction.createMany({
        data: manifest.actions.map((a) => ({
          installationId: id,
          key: a.key,
          level: a.start,
        })) as never,
      })

    // Its recipe: a pack of its own, loaded only in its threads (threadSkills).
    if (template?.skills.length) {
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
        source: `playbook:${id}`,
        everywhere: true,
        teammateIds: [],
        projectIds: [],
        skills,
      })
      await db.skillPack.updateMany({
        where: { id: pack.id },
        data: { playbookInstallationId: id },
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
        await db.trigger.create({
          data: {
            connectionId: connection.id,
            teammateId: teammate.id,
            label: entry.label ?? `${manifest.name}: ${definition.label}`,
            event,
            options: entryOptions(entry, settings),
            createdByMemberId: installation.ownerMemberId,
            projectId: installation.projectId,
            playbookInstallationId: id,
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
            timezone: entry.timezone ?? (await memberTimezone(db, installation.ownerMemberId)),
            projectId: installation.projectId,
          },
          { memberId: installation.ownerMemberId },
        )
        await db.schedule.updateMany({
          where: { id: schedule.id },
          data: {
            playbookInstallationId: id,
            // Waiting for activation, it does not fire.
            ...(active ? {} : { pausedAt: new Date(), nextRunAt: null }),
          },
        })
      }
    }
    // Subscribe the vendors now, so a refusal is the installer's to see.
    for (const connectionId of connectionIds) await syncConnection(scope, connectionId)
  } catch (error) {
    await resync(scope, [...before, ...(await removeParts(db, scope, id))])
    if (error instanceof HTTPException) throw error
    if (error instanceof SubscribeError) throw new HTTPException(400, { message: error.message })
    throw error
  }
  // An account the old settings used and these do not: its subscription goes.
  await resync(
    scope,
    before.filter((c) => !connectionIds.has(c)),
  )
}

/** A trigger entry's options, its settings put in; empty ones left out. */
export const entryOptions = (
  entry: Extract<PlaybookEntry, { trigger: string }>,
  settings: Record<string, string | number>,
) =>
  Object.fromEntries(
    Object.entries(entry.options)
      .map(([k, v]) => [k, fill(v, settings).trim()] as const)
      .filter(([, v]) => v),
  )

/** Whether its parts are made: every setting answered, and its first entry exists. */
export async function hasParts(db: ScopedDb, id: string) {
  const [triggers, schedules] = await Promise.all([
    db.trigger.count({ where: { playbookInstallationId: id } }),
    db.schedule.count({ where: { playbookInstallationId: id } }),
  ])
  return triggers + schedules > 0
}

/** Its teammate settings whose teammate is archived or gone, by key. */
async function archivedTeammates(
  db: ScopedDb,
  manifest: PlaybookManifest,
  answers: Record<string, unknown>,
) {
  const keys = (manifest.settings ?? [])
    .filter((s) => s.type === 'teammate' && typeof answers[s.key] === 'string')
    .map((s) => s.key)
  if (!keys.length) return []
  const live = new Set(
    (
      await db.teammate.findMany({
        where: { id: { in: keys.map((k) => answers[k] as string) }, archivedAt: null },
        select: { id: true },
      })
    ).map((t) => t.id),
  )
  return keys.filter((k) => !live.has(answers[k] as string))
}

/**
 * New answers for an installation not yet active: checked by kind, kept with the earlier ones.
 * Once every setting has one, its parts are made (again, when they were). Returns what still
 * lacks an answer.
 */
export async function answerSettings(
  db: ScopedDb,
  scope: Installer,
  id: string,
  input: Record<string, string | number>,
) {
  const installation = await requireInstallation(db, id)
  if (installation.status === 'active' || installation.status === 'paused')
    throw new HTTPException(409, {
      message: 'This playbook is already active: its settings change from its sheet, on Routines',
    })
  const manifest = installation.manifest as PlaybookManifest
  const given = await checkSettings(db, manifest, input)
  const answers = { ...(installation.settings as Record<string, string | number>), ...given }
  // A teammate archived since it was picked is no answer: its question comes again.
  const gone = await archivedTeammates(db, manifest, answers)
  for (const key of gone) delete answers[key]
  const { values, missing } = withDefaults(manifest, answers)
  const changed = Object.keys(given).length > 0 || gone.length > 0
  if (changed)
    await db.playbookInstallation.updateMany({
      where: { id },
      data: {
        settings: answers,
        // Its runs start with the teammate its setting names.
        ...(runTeammate(manifest, answers) ? { teammateId: runTeammate(manifest, answers)! } : {}),
      },
    })
  if (!missing.length) {
    // Defaults filled in are answers from now on.
    await db.playbookInstallation.updateMany({ where: { id }, data: { settings: values } })
    if (changed || !(await hasParts(db, id))) await buildParts(db, scope, id)
  }
  return missing
}

/**
 * One not active yet, on its template's latest version: a new version's manifest replaces its
 * own, the answers it still asks for are kept, and its parts are made again once every setting
 * has an answer. It goes back to setup, as an earlier dry run tried the old one.
 */
export async function upgradeSetup<T extends { id: string; version: string; status: string }>(
  db: ScopedDb,
  scope: Installer,
  installation: T,
  template: Template,
): Promise<T> {
  const { manifest } = template
  if (installation.version === manifest.version) return installation
  if (installation.status !== 'setup' && installation.status !== 'dry_run') return installation
  // A dry run under way replays its events on the parts it has: it moves once that one is done.
  if (
    await db.playbookDryRun.count({
      where: { installationId: installation.id, status: 'running' },
    })
  )
    return installation
  const current = await requireInstallation(db, installation.id)
  const kept = Object.fromEntries(
    Object.entries((current.settings ?? {}) as Record<string, string | number>).filter(([key]) =>
      manifest.settings.some((s) => s.key === key),
    ),
  )
  await resync(scope, await removeParts(db, scope, installation.id))
  await db.playbookInstallation.updateMany({
    where: { id: installation.id },
    data: {
      manifest: manifest as never,
      version: manifest.version,
      settings: kept,
      status: 'setup',
      ...(runTeammate(manifest, kept) ? { teammateId: runTeammate(manifest, kept)! } : {}),
    },
  })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'playbook.upgraded',
    target: { type: 'playbook', id: installation.id },
    data: { from: installation.version, to: manifest.version },
  })
  return (await requireInstallation(db, installation.id)) as unknown as T
}

/**
 * Install a template with all its answers at once (the API's POST /playbooks): in setup, its
 * parts made. Activating it is a step of its own (activatePlaybook).
 */
export async function installPlaybook(db: ScopedDb, scope: WorkspaceScope, input: InstallPlaybook) {
  const template = templates().get(input.playbookKey)
  if (!template) throw new HTTPException(404, { message: `No playbook ${input.playbookKey}` })
  // The teammate it is installed for answers the setting its runs start with.
  const first = template.manifest.teammate
  const settings =
    first && !(first in input.settings)
      ? { ...input.settings, [first]: input.teammateId }
      : input.settings
  await resolveSettings(db, template.manifest, settings)
  const installation = await createInstallation(db, scope, {
    template,
    teammateId: input.teammateId,
    projectId: input.projectId,
    settings,
  })
  try {
    await answerSettings(db, scope, installation.id, {})
  } catch (error) {
    await removeInstallation(db, scope, installation.id)
    throw error
  }
  return getInstallation(db, installation.id)
}

/** Everything it made goes: triggers (and their subscriptions), schedules, its pack, its runs. */
export async function removeInstallation(db: ScopedDb, scope: Scope, id: string) {
  const removed = await deleteTriggers(db, { playbookInstallationId: id })
  // Its runs no person took part in go out of sight; those a person joined stay their threads.
  await db.session.updateMany({
    where: { playbookRun: { installationId: id }, surfacedAt: null, archivedAt: null },
    data: { archivedAt: new Date() },
  })
  await db.playbookInstallation.deleteMany({ where: { id } })
  await resync(
    scope,
    removed.map((t) => t.connectionId),
  )
}

export async function requireInstallation(db: ScopedDb, id: string) {
  const installation = await db.playbookInstallation.findFirst({ where: { id } })
  if (!installation) throw new HTTPException(404, { message: 'Playbook not found' })
  return installation
}

export async function uninstallPlaybook(db: ScopedDb, scope: WorkspaceScope, id: string) {
  const installation = await requireInstallation(db, id)
  requireManager(scope, installation)
  await removeInstallation(db, scope, id)
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'playbook.uninstalled',
    target: { type: 'playbook', id },
    data: { playbookKey: installation.playbookKey },
  })
}

/** The open ticket asking an owner or admin to activate it, if any. */
const activationTicket = (db: ScopedDb, id: string) =>
  db.ticket.findFirst({
    where: {
      type: 'approval',
      status: 'open',
      AND: [
        { payload: { path: ['playbookInstallationId'], equals: id } },
        { payload: { path: ['playbookActivation'], equals: true } },
      ],
    },
    select: { id: true },
  })

/**
 * Activate it: from now on it runs on its owner's accounts, every action at its level (all
 * Ask first to begin with). It takes an owner or admin, like importing a skill pack; a
 * member asks one (requestActivation). Its parts must be made first.
 */
export async function activatePlaybook(db: ScopedDb, scope: WorkspaceScope, id: string) {
  const installation = await requireInstallation(db, id)
  if (installation.status === 'active') return getInstallation(db, id)
  if (!isAdminRole(scope.role))
    throw new HTTPException(403, { message: 'Only an owner or admin can activate a playbook' })
  if (!(await hasParts(db, id))) {
    const { missing } = withDefaults(
      installation.manifest as PlaybookManifest,
      installation.settings as Record<string, string | number>,
    )
    throw new HTTPException(409, {
      message: missing.length
        ? `Its settings are not all answered yet: ${missing.join(', ')}`
        : 'Its triggers and schedules are not made yet: answer its settings again',
    })
  }
  return setPlaybookPaused(db, scope, id, false)
}

/**
 * A member who is not an owner or admin asks one to activate it: one ticket in Needs you,
 * which an owner or admin approves (resolveTicket). Asking again keeps the one ticket.
 */
export async function requestActivation(
  db: ScopedDb,
  scope: WorkspaceScope,
  id: string,
  sessionId: string | null,
) {
  const installation = await requireInstallation(db, id)
  requireManager(scope, installation)
  if (installation.status === 'active') return { ticketId: null, active: true }
  if (!(await hasParts(db, id)))
    throw new HTTPException(409, { message: 'Its settings are not all answered yet' })
  const open = await activationTicket(db, id)
  if (open) return { ticketId: open.id, active: false }
  const manifest = installation.manifest as PlaybookManifest
  const owner = await db.member.findFirst({
    where: { id: installation.ownerMemberId },
    select: { user: { select: { name: true } } },
  })
  const ticket = await db.ticket.create({
    data: {
      ...(sessionId ? { sessionId } : {}),
      type: 'approval',
      title: `Activate the playbook ${manifest.name}`,
      payload: {
        playbookInstallationId: id,
        playbookActivation: true,
        reason: `${owner?.user.name ?? 'A member'} installed it and asks an owner or admin to activate it. It runs on their accounts, and every action asks first to begin with.`,
      },
    } as never,
  })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'playbook.activation_requested',
    target: { type: 'playbook', id },
    data: { ticketId: ticket.id },
  })
  return { ticketId: ticket.id, active: false }
}

/** An owner or admin's answer to a member's request: approving activates it. */
export async function decideActivation(
  db: ScopedDb,
  scope: WorkspaceScope,
  ticket: { id: string; payload: unknown },
  approved: boolean,
) {
  const { playbookInstallationId } = ticket.payload as { playbookInstallationId: string }
  if (approved) await activatePlaybook(db, scope, playbookInstallationId)
  await db.ticket.updateMany({
    where: { id: ticket.id, status: 'open' },
    data: {
      status: approved ? 'approved' : 'denied',
      resolvedByMemberId: scope.memberId,
      resolvedAt: new Date(),
    },
  })
  if (!approved)
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'playbook.activation_denied',
      target: { type: 'playbook', id: playbookInstallationId },
    })
}

/**
 * Pause or resume. Resuming one that waits in setup activates it, which takes an owner or
 * admin: it then runs on its owner's accounts with no one checking each time.
 */
export async function setPlaybookPaused(
  db: ScopedDb,
  scope: WorkspaceScope,
  id: string,
  paused: boolean,
) {
  const installation = await requireInstallation(db, id)
  requireManager(scope, installation)
  const activating = !paused && installation.status !== 'active' && !installation.activatedAt
  if (activating && !isAdminRole(scope.role))
    throw new HTTPException(403, { message: 'Only an owner or admin can activate a playbook' })
  if (activating && !(await hasParts(db, id)))
    throw new HTTPException(409, { message: 'Its settings are not all answered yet' })
  const now = new Date()
  await db.playbookInstallation.updateMany({
    where: { id },
    data: paused
      ? { status: 'paused', pausedAt: now }
      : {
          status: 'active',
          pausedAt: null,
          ...(activating ? { activatedAt: now, activatedByMemberId: scope.memberId } : {}),
        },
  })
  const schedules = await db.schedule.findMany({ where: { playbookInstallationId: id } })
  for (const s of schedules)
    await db.schedule.updateMany({
      where: { id: s.id },
      data: paused
        ? { pausedAt: now, nextRunAt: null }
        : { pausedAt: null, nextRunAt: nextRun(s.cron, s.timezone) ?? null },
    })
  // Activated: a member's request waiting for it is answered.
  if (activating)
    await db.ticket.updateMany({
      where: {
        type: 'approval',
        status: 'open',
        AND: [
          { payload: { path: ['playbookInstallationId'], equals: id } },
          { payload: { path: ['playbookActivation'], equals: true } },
        ],
      },
      data: { status: 'approved', resolvedByMemberId: scope.memberId, resolvedAt: now },
    })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: paused ? 'playbook.paused' : activating ? 'playbook.activated' : 'playbook.resumed',
    target: { type: 'playbook', id },
    track: { playbook: installation.playbookKey },
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
  /**
   * The run's id, chosen beforehand (a trigger delivery's, from its thread's): begun again after
   * a restart cut it off, the run begun then is the one, counted once.
   */
  id?: string,
): Promise<RunStart> {
  if (id && (await db.playbookRun.count({ where: { id, installationId } }))) return { runId: id }
  const installation = await db.playbookInstallation.findFirst({ where: { id: installationId } })
  if (!installation) return { skipped: 'the playbook is gone' }
  if (installation.status !== 'active') return { skipped: `the playbook is ${installation.status}` }
  const manifest = installation.manifest as PlaybookManifest
  const perDay = manifest.limits.runsPerDay
  const today = await db.playbookRun.count({
    where: { installationId, dryRun: false, startedAt: { gte: new Date(Date.now() - DAY_MS) } },
  })
  if (today >= perDay) {
    const message = `the playbook reached its ${perDay} runs a day`
    const open = await db.ticket.count({
      where: {
        type: 'question',
        status: 'open',
        payload: { path: ['playbookInstallationId'], equals: installationId },
      },
    })
    if (!open)
      await db.ticket.create({
        data: {
          type: 'question',
          title: `Playbook "${manifest.name}" reached its ${perDay} runs a day: new events wait until the next ones free up`,
          payload: {
            playbookInstallationId: installationId,
            memberId: installation.ownerMemberId,
            limit: 'runsPerDay',
          },
        } as never,
      })
    return { limit: message }
  }
  const run = await db.playbookRun.create({
    data: {
      ...(id ? { id } : {}),
      installationId,
      conversationKey: conversationKey ?? null,
    } as never,
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
    await db.playbookRun.updateMany({ where: { id: runId }, data: { rootSessionId: threadId } })
    return
  }
  await db.session.updateMany({
    where: { playbookRunId: runId, surfacedAt: null },
    data: { archivedAt: new Date() },
  })
  await db.playbookRun.deleteMany({ where: { id: runId } })
}

/** A later event of the same conversation: the run goes on. */
export async function continueRun(db: ScopedDb, runId: string | null) {
  if (!runId) return
  await db.playbookRun.updateMany({
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
  thread: { id: string; playbookRunId: string | null; surfacedAt: Date | null; quiet?: boolean },
  intervention = false,
) {
  // A mailbox rule's quiet thread surfaces the same way, without a run to count it in.
  if (!thread.playbookRunId) {
    if (thread.quiet && !thread.surfacedAt)
      await db.session.updateMany({
        where: { id: thread.id, surfacedAt: null },
        data: { surfacedAt: new Date() },
      })
    return
  }
  if (!thread.surfacedAt)
    await db.session.updateMany({
      where: { id: thread.id, surfacedAt: null },
      data: { surfacedAt: new Date() },
    })
  if (intervention)
    await db.playbookRun.updateMany({
      where: { id: thread.playbookRunId },
      data: { interventions: { increment: 1 } },
    })
}

/**
 * A role of a playbook as its runs may use it: the Apps it accepts, at its access, and the
 * accounts its account settings picked. `accounts` null: it has no account setting, so any
 * account of its kinds granted to the teammate (never a server added by its URL). A set, empty
 * while unanswered (an optional one): those accounts alone.
 */
export type RunRole = PlaybookRole & { accounts: Set<string> | null }

/** The teammate its runs start with, by its setting's answer; null without one. */
export function runTeammate(manifest: PlaybookManifest, settings: Record<string, unknown>) {
  const value = manifest.teammate ? settings[manifest.teammate] : undefined
  return typeof value === 'string' && value ? value : null
}

/**
 * Its roles, each with the accounts its settings picked (their connection ids). With `thread`,
 * a thread's teammate setting (null: the one its runs start with): only the roles of its Apps.
 */
export function runRoles(
  manifest: PlaybookManifest,
  settings: Record<string, unknown>,
  thread?: { teammate: string | null },
): RunRole[] {
  return playbookRoles(manifest.apps)
    .filter((role) => !thread || roleOfTeammate(role, manifest, thread.teammate))
    .map((role) => {
      const picks = manifest.settings.filter((s) => s.type === 'account' && s.app === role.name)
      if (!picks.length) return { ...role, accounts: null }
      const ids = new Set<string>()
      for (const setting of picks) {
        const value = settings[setting.key]
        // Unanswered (an optional one): no account rather than every one.
        if (typeof value === 'string' && value) ids.add(value)
      }
      return { ...role, accounts: ids }
    })
}

/**
 * The access a playbook's thread has to this account, or null when it may not use it: an App one
 * of its roles accepts, and where that role's account setting picked one (its inbox), that very
 * account, not the other inboxes its teammate has. Within a role, a server added by its URL
 * counts only as the account a setting picked. Old manifests (Apps by kind alone) read the same:
 * a kind is a role, and a plain `{ kind: mcp }` still reaches every server granted.
 */
export function playbookAccount(
  playbook: { roles: RunRole[] },
  connection: { id: string; kind: string },
): 'read' | 'read_write' | null {
  let access: 'read' | 'read_write' | null = null
  for (const role of playbook.roles) {
    if (!role.kinds.includes(connection.kind)) continue
    const allowed = role.accounts
      ? role.accounts.has(connection.id)
      : role.plain || connection.kind !== MCP_KIND
    if (allowed && access !== 'read_write') access = role.access
  }
  return access
}

/** Whether one of its roles accepts this kind of App at all (to tell a wrong account from a wrong App). */
export const playbookAccepts = (playbook: { roles: RunRole[] }, kind: string) =>
  playbook.roles.find((r) => r.kinds.includes(kind)) ?? null

/**
 * The action of its manifest a call is, by the tool's name as teammates call it (gmail_send,
 * mixpanel_run_query, posthog_create_annotation), else null: an unlisted write, which asks. A
 * server added by its URL names its tools after itself; one whose names fall in a built-in App's
 * (a server called "GitHub merge" calling a tool github_merge_pull_request) is never taken for
 * that App's action.
 */
export function playbookActionOf(
  actions: PlaybookManifest['actions'],
  kind: string,
  tool: string,
): string | null {
  if (
    kind === MCP_KIND &&
    Object.entries(connectors).some(
      ([builtIn, definition]) => tool.startsWith(`${builtIn}_`) || definition?.operations[tool],
    )
  )
    return null
  return actions.find((a) => a.tools.includes(tool))?.key ?? null
}

/**
 * The playbook a thread is part of, for its spec: its run, name and Apps. `teammate`: the
 * thread's teammate setting (null: the one its runs start with), whose Apps alone it has.
 */
export async function threadPlaybook(
  db: ScopedDb,
  playbookRunId: string | null,
  teammate: string | null = null,
): Promise<
  | (Omit<ThreadPlaybook, 'roles'> & {
      roles: RunRole[]
      actions: PlaybookManifest['actions']
      /** The action that is its first response to an event, if it times one. */
      firstResponse: string | null
      dryRunId: string | null
    })
  | null
> {
  if (!playbookRunId) return null
  const run = await db.playbookRun.findFirst({
    where: { id: playbookRunId },
    include: { installation: { select: { id: true, manifest: true, settings: true } } },
  })
  if (!run) return null
  const manifest = run.installation.manifest as PlaybookManifest
  const settings = (run.installation.settings ?? {}) as Record<string, unknown>
  const roles = runRoles(manifest, settings, { teammate })
  const teammates = await playbookTeammates(db, manifest, settings, teammate)
  return {
    installationId: run.installation.id,
    runId: run.id,
    name: manifest.name,
    apps: roles.map((r) => r.name),
    ...(teammates.length > 1 ? { teammates } : {}),
    dryRun: run.dryRun,
    dryRunId: run.dryRunId,
    roles,
    actions: manifest.actions,
    firstResponse: manifest.firstResponse ?? null,
  }
}

/**
 * Its teammate settings, the one its runs start with first: each with its teammate's name and
 * its Apps, and `here` for the thread's (`teammate`, null: the first). Empty without any.
 */
export async function playbookTeammates(
  db: ScopedDb,
  manifest: PlaybookManifest,
  settings: Record<string, unknown>,
  teammate: string | null,
) {
  // Stored manifests are kept as they were written: an old one may lack its settings.
  const keys = (manifest.settings ?? [])
    .filter((s) => s.type === 'teammate')
    .map((s) => s.key)
    .sort((a, b) => Number(b === manifest.teammate) - Number(a === manifest.teammate))
  if (!keys.length) return []
  const ids = keys.map((k) => settings[k]).filter((v): v is string => typeof v === 'string')
  const rows = await db.teammate.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  })
  const here = teammate ?? manifest.teammate
  return keys.map((key) => ({
    key,
    name: rows.find((r) => r.id === settings[key])?.name ?? 'not picked yet',
    apps: playbookRoles(manifest.apps)
      .filter((r) => roleOfTeammate(r, manifest, key))
      .map((r) => r.name),
    here: key === here,
  }))
}

/**
 * The playbook's Apps and roles as its teammate stands with each, on its owner's accounts: the
 * accounts it may use for each (only the one picked, where a setting picks one), and whether
 * that is enough for the access the role declares.
 */
export async function roleStatuses(
  db: ScopedDb,
  manifest: PlaybookManifest,
  settings: Record<string, unknown>,
  teammateId: string,
  ownerMemberId: string,
): Promise<PlaybookAppStatus[]> {
  const roles = runRoles(manifest, settings)
  const kinds = [...new Set(roles.flatMap((r) => r.kinds))]
  const picked = [...new Set(roles.flatMap((r) => [...(r.accounts ?? [])]))]
  // Each role's teammate: the one its setting names, else the one its runs start with. A
  // teammate setting not answered yet holds none, and its Apps wait for it.
  const holderOf = (role: { teammate: string | null }) => {
    if (!role.teammate) return manifest.teammate ? runTeammate(manifest, settings) : teammateId
    const value = settings[role.teammate]
    return typeof value === 'string' && value ? value : null
  }
  const holders = [...new Set(roles.map(holderOf).filter((id): id is string => !!id))]
  const [grants, chosen, teammates] = await Promise.all([
    db.grant.findMany({
      where: {
        teammateId: { in: holders },
        connection: { kind: { in: kinds as never }, status: 'active' },
      },
      include: { connection: true },
    }),
    picked.length
      ? db.connection.findMany({
          where: { id: { in: picked }, status: { not: 'removed' } },
          select: { id: true, kind: true, label: true, externalAccount: true },
        })
      : [],
    // An archived teammate holds nothing: its Apps are missing until another is picked.
    db.teammate.findMany({
      where: { id: { in: holders }, archivedAt: null },
      select: { id: true, name: true },
    }),
  ])
  return roles.map(({ accounts, ...role }) => {
    const holder = teammates.find((t) => t.id === holderOf(role)) ?? null
    // The accounts it could use, those its setting may pick among; within a role, a server added
    // by its URL only where a setting picks the account.
    const candidates = grants.filter(
      (g) =>
        g.teammateId === holder?.id &&
        role.kinds.includes(g.connection.kind) &&
        (accounts || role.plain || g.connection.kind !== MCP_KIND) &&
        usableIn(g.connection, { startedByMemberId: ownerMemberId }),
    )
    // What its runs reach, as playbookAccount decides: where a setting picks its account, that
    // one alone, and none while it is unanswered.
    const usable = accounts ? candidates.filter((g) => accounts.has(g.connection.id)) : candidates
    const writable = usable.filter((g) => g.scope === 'read_write')
    const pick = chosen.find((c) => accounts?.has(c.id))
    return {
      ...role,
      status: !usable.length
        ? 'missing'
        : role.access === 'read_write' && !writable.length
          ? 'read_only'
          : 'ready',
      accounts: candidates.map((g) => g.connection.externalAccount ?? g.connection.label),
      picks: accounts !== null,
      chosen: pick ? { name: pick.externalAccount ?? pick.label, kind: pick.kind } : null,
      holder,
    }
  })
}

type PlaybookReport = Extract<ScheduleOperation, { name: 'playbook_report' }>

/** playbook_report: the run's case and how it ended. */
export async function reportRun(
  db: ScopedDb,
  scope: Scope,
  session: { id: string; playbookRunId: string | null },
  teammate: { id: string },
  op: PlaybookReport,
): Promise<{ error: string } | { recorded: { case: string; outcome: string }; note: string }> {
  if (!session.playbookRunId)
    return { error: 'This thread is not part of a playbook: there is nothing to report.' }
  await db.playbookRun.updateMany({
    where: { id: session.playbookRunId },
    data: {
      case: op.case,
      outcome: op.outcome,
      summary: op.summary ?? null,
      status: op.outcome === 'failed' ? 'failed' : 'done',
      endedAt: new Date(),
    },
  })
  await audit({
    ...scope,
    actor: { type: 'teammate', id: teammate.id },
    action: 'playbook.reported',
    target: { type: 'playbook_run', id: session.playbookRunId },
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
  run: { status: PlaybookRunStatus; outcome: string | null },
  thread: { status: string; children?: unknown[]; following?: unknown[] } | null,
): PlaybookRunStatus {
  if (run.outcome || !thread) return run.status
  // Its own thread is quiet, but a fix it started or follows has not reported yet.
  const waitsOnFix = Boolean(thread.children?.length || thread.following?.length)
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
      return waitsOnFix ? 'waiting_event' : 'done'
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
  db.playbookInstallation.findMany({ where, include: INCLUDE, orderBy: { createdAt: 'asc' } })

/** Who looks at it: whether they may change its actions' levels. Unset (a teammate): no one. */
type Viewer = { memberId: string; role: string }

async function toView(
  db: ScopedDb,
  row: Row,
  runsTaken = 10,
  viewer?: Viewer,
): Promise<PlaybookInstallationView> {
  const manifest = row.manifest as PlaybookManifest
  const day = new Date(Date.now() - DAY_MS)
  const [recent, runsToday, metrics, actions, autoCalls, dryRun, ticket, update] =
    await Promise.all([
      db.playbookRun.findMany({
        where: { installationId: row.id, dryRun: false },
        orderBy: { startedAt: 'desc' },
        take: runsTaken,
        include: {
          rootSession: {
            select: {
              id: true,
              title: true,
              status: true,
              // A fix it started or follows that has not reported: the run waits on it.
              children: {
                where: { report: { equals: Prisma.DbNull } },
                select: { id: true },
                take: 1,
              },
              following: { where: { deliveredAt: null }, select: { id: true }, take: 1 },
            },
          },
        },
      }),
      db.playbookRun.count({
        where: { installationId: row.id, dryRun: false, startedAt: { gte: day } },
      }),
      playbookMetrics(db, row),
      actionViews(db, row, viewer),
      recentAutoCalls(db, row.id, manifest),
      db.playbookDryRun.findFirst({
        where: { installationId: row.id },
        orderBy: { startedAt: 'desc' },
        select: { id: true },
      }),
      activationTicket(db, row.id),
      updateView(db, row, viewer),
    ])
  const settings = (row.settings ?? {}) as Record<string, string | number>
  const { missing } = withDefaults(manifest, settings)
  // Account settings show the account as its row does (the Gmail address), not its id.
  const picked = manifest.settings
    .filter((s) => s.type === 'account' && typeof settings[s.key] === 'string')
    .map((s) => settings[s.key] as string)
  // And teammate settings the teammate's name.
  const named = manifest.settings
    .filter((s) => s.type === 'teammate' && typeof settings[s.key] === 'string')
    .map((s) => settings[s.key] as string)
  const [apps, accounts, teammates] = await Promise.all([
    roleStatuses(db, manifest, settings, row.teammate.id, row.owner.id),
    picked.length
      ? db.connection.findMany({
          where: { id: { in: picked } },
          select: { id: true, label: true, externalAccount: true },
        })
      : [],
    named.length
      ? db.teammate.findMany({ where: { id: { in: named } }, select: { id: true, name: true } })
      : [],
  ])
  const recentRuns: PlaybookRunView[] = recent.map((run) => ({
    id: run.id,
    title: run.rootSession?.title ?? 'Run',
    threadId: run.rootSession?.id ?? null,
    case: run.case,
    status: runStatus(run, run.rootSession),
    outcome: (run.outcome as PlaybookRunView['outcome']) ?? null,
    startedAt: run.startedAt.toISOString(),
    endedAt: run.endedAt?.toISOString() ?? null,
  }))
  return {
    id: row.id,
    playbookKey: row.playbookKey,
    name: manifest.name,
    description: manifest.description,
    version: row.version,
    source: row.source,
    status: row.status,
    teammate: row.teammate,
    owner: { id: row.owner.id, name: row.owner.user.name },
    project: row.project,
    apps,
    settings: manifest.settings.map((s) => {
      const account =
        s.type === 'account' ? accounts.find((a) => a.id === settings[s.key]) : undefined
      const teammate =
        s.type === 'teammate' ? teammates.find((t) => t.id === settings[s.key]) : undefined
      return {
        key: s.key,
        type: s.type,
        ...(s.ask ? { ask: s.ask } : {}),
        value: account
          ? (account.externalAccount ?? account.label)
          : (teammate?.name ?? settings[s.key] ?? null),
      }
    }),
    actions,
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
    runsThisWeek: metrics.week.runs,
    runsToday,
    runsPerDay: manifest.limits.runsPerDay,
    // The same count as its numbers: a person's message, takeover or decision is stepping in.
    unattended: metrics.week.unattended,
    metrics,
    recentRuns,
    autoCalls,
    ready: !missing.length && row.triggers.length + row.schedules.length > 0,
    missing,
    dryRun: dryRun ? await dryRunView(db, dryRun.id) : null,
    activationTicketId: ticket?.id ?? null,
    update,
    createdAt: row.createdAt.toISOString(),
    activatedAt: row.activatedAt?.toISOString() ?? null,
    pausedAt: row.pausedAt?.toISOString() ?? null,
  }
}

/** `project`: a project's id, or "none". */
export async function listInstallations(db: ScopedDb, project?: string, viewer?: Viewer) {
  const rows = await findRows(db, project ? { projectId: project === 'none' ? null : project } : {})
  return Promise.all(rows.map((row) => toView(db, row, 5, viewer)))
}

export async function getInstallation(db: ScopedDb, id: string, viewer?: Viewer) {
  const [row] = await findRows(db, { id })
  if (!row) throw new HTTPException(404, { message: 'Playbook not found' })
  return toView(db, row, 30, viewer)
}
