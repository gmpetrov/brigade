// Updating an installed playbook to its template's newer version (spec "Mises à jour"). An active
// or paused installation keeps its id, its runs, numbers, approvals and dry runs, and moves in
// place: its answers are kept (new required ones are asked first), its triggers and schedules
// change where they stand (a Gmail trigger keeps its id, so its inbox subscription and cursor stay,
// with no mail missed or replayed), and its recipe takes the new skills, except one the workspace
// edited, which stays as it is unless chosen. An update never gives more autonomy: an unchanged
// action keeps its level, conditions, caps and history; one whose tools or conditions change asks
// first again; a new one starts no higher than asking. One not active yet moves as it always did
// (upgradeSetup), its parts made again.
import { createHash } from 'node:crypto'
import {
  isTriggerEntry,
  needsChecks,
  nextRun,
  playbookRoles,
  type PlaybookActionConditions,
  type PlaybookActionSpec,
  type PlaybookEntry,
  type PlaybookLevel,
  type PlaybookManifest,
  type PlaybookRole,
  type PlaybookSetting,
  type PlaybookUpdateQuestion,
  type PlaybookUpdateView,
  type PlaybookUpgradeResult,
  type UpgradePlaybook,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit } from './audit.js'
import { triggersOf } from './connectors/index.js'
import type { ConnectorKind } from './connectors/types.js'
import type { Scope, ScopedDb } from './db.js'
import { lockActions, storedConditions } from './playbook-autonomy.js'
import {
  answerSettings,
  checkSettings,
  entryOptions,
  fill,
  freeName,
  getInstallation,
  requireInstallation,
  requireManager,
  runTeammate,
  templates,
  upgradeSetup,
  withDefaults,
  type Template,
  type TemplateSkill,
} from './playbooks.js'
import { deleteTriggers, resync } from './routes/triggers.js'
import { savePack, storeSkillFile } from './skills.js'

type Answers = Record<string, string | number>
type Who = Scope & { memberId: string; role: string }

const LEVELS: PlaybookLevel[] = ['deny', 'ask', 'auto']
const LEVEL_WORDS: Record<PlaybookLevel, string> = {
  ask: 'Asks first',
  auto: 'On its own',
  deny: 'Never',
}
/** The least autonomy of these. */
const lowest = (...levels: PlaybookLevel[]) =>
  LEVELS[Math.min(...levels.map((l) => LEVELS.indexOf(l)))]!

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** Semver order: negative when a is older than b, 0 when the same, positive when newer. */
export function compareVersions(a: string, b: string) {
  const parts = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** Its template, when it is newer than the version installed. */
export function newerTemplate(installation: { playbookKey: string; version: string }) {
  const template = templates().get(installation.playbookKey)
  return template && compareVersions(template.manifest.version, installation.version) > 0
    ? template
    : null
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

/** One skill of its recipe as installed, and whether the workspace edited it since. */
export type InstalledSkill = {
  id: string
  name: string
  description: string
  instructions: string
  files: { path: string; sha256: string }[]
  edited: boolean
}

type TriggerEntry = Extract<PlaybookEntry, { trigger: string }>
type ScheduleEntry = Exclude<PlaybookEntry, TriggerEntry>

/** Each entry of the new version against the one at its index: changed in place, added, removed. */
export type EntryPlan =
  | { kind: 'same'; index: number; from: PlaybookEntry; to: PlaybookEntry }
  | { kind: 'add'; index: number; to: PlaybookEntry }
  | { kind: 'remove'; index: number; from: PlaybookEntry }

export type ActionPlan = {
  key: string
  spec: PlaybookActionSpec
  /** same: tools, conditions and ceiling unchanged; changed: its tools or conditions. */
  change: 'same' | 'changed' | 'ceiling' | 'added'
  /** Its level now, and after the update. */
  from: PlaybookLevel | null
  to: PlaybookLevel
}

export type SkillPlan = {
  name: string
  template: TemplateSkill | null
  row: InstalledSkill | null
  /** add: new; replace: takes the new version; keep: edited, kept; delete: gone from the recipe. */
  step: 'same' | 'add' | 'replace' | 'keep' | 'delete'
}

export type PlaybookDiff = {
  from: string
  to: string
  entries: EntryPlan[]
  actions: ActionPlan[]
  removedActions: { key: string; label: string }[]
  skills: SkillPlan[]
  apps: {
    added: PlaybookRole[]
    removed: PlaybookRole[]
    changed: { from: PlaybookRole; to: PlaybookRole }[]
  }
  settings: { added: PlaybookSetting[]; removed: PlaybookSetting[] }
}

const sha256 = (text: string) =>
  createHash('sha256').update(new TextEncoder().encode(text)).digest('hex')

const sameList = (a: readonly string[] = [], b: readonly string[] = []) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i])

/** A template skill's content is what the installed one holds: its text and every file. */
const sameSkill = (row: InstalledSkill, skill: TemplateSkill) =>
  row.description === skill.description &&
  row.instructions === skill.instructions &&
  row.files.length === skill.files.length &&
  skill.files.every((f) =>
    row.files.some((r) => r.path === f.path && r.sha256 === sha256(f.content)),
  )

/** The template skill an installed one is: its name, or its name made free with -2, -3… */
function skillOf(row: { name: string }, names: string[]) {
  if (names.includes(row.name)) return row.name
  return names.find((n) => new RegExp(`^${n.slice(0, 60)}-\\d+$`).test(row.name)) ?? null
}

/** Two trigger entries are the same trigger: the same App event on the same account. */
const sameTrigger = (a: TriggerEntry, b: TriggerEntry, before: Answers, after: Answers) =>
  a.trigger === b.trigger && fill(a.account, before) === fill(b.account, after)

/** The new version's entries against the installed ones, by index. */
export function planEntries(
  from: readonly PlaybookEntry[],
  to: readonly PlaybookEntry[],
  before: Answers,
  after: Answers,
): EntryPlan[] {
  const plans: EntryPlan[] = []
  for (let i = 0; i < Math.max(from.length, to.length); i++) {
    const a = from[i]
    const b = to[i]
    const same =
      a &&
      b &&
      (isTriggerEntry(a)
        ? isTriggerEntry(b) && sameTrigger(a, b, before, after)
        : !isTriggerEntry(b))
    if (same) plans.push({ kind: 'same', index: i, from: a, to: b })
    else {
      if (a) plans.push({ kind: 'remove', index: i, from: a })
      if (b) plans.push({ kind: 'add', index: i, to: b })
    }
  }
  return plans
}

/**
 * What moving from the installed manifest to the template changes: entries, actions (with their
 * levels after it), skills (by content, the edited ones kept unless in `replaceSkills`), Apps and
 * roles, settings added and removed. `settings`: its answers before, then after the update.
 */
export function playbookDiff(input: {
  from: PlaybookManifest
  to: Template
  before: Answers
  after: Answers
  levels: Record<string, PlaybookLevel>
  skills: InstalledSkill[]
  replaceSkills?: string[]
}): PlaybookDiff {
  const { from, to } = input
  const next = to.manifest
  // Stored manifests are kept as they were written: an old one may lack a list.
  const oldActions = from.actions ?? []
  const actions: ActionPlan[] = next.actions.map((spec) => {
    const old = oldActions.find((a) => a.key === spec.key)
    const current = input.levels[spec.key] ?? null
    if (!old)
      return { key: spec.key, spec, change: 'added', from: null, to: lowest(spec.start, 'ask') }
    const level = current ?? lowest(old.start, 'ask')
    if (!sameList(old.tools, spec.tools) || !sameList(old.conditions, spec.conditions))
      return {
        key: spec.key,
        spec,
        change: 'changed',
        from: current,
        to: lowest(level, 'ask', spec.ceiling),
      }
    if (old.ceiling !== spec.ceiling)
      return {
        key: spec.key,
        spec,
        change: 'ceiling',
        from: current,
        to: lowest(level, spec.ceiling),
      }
    return { key: spec.key, spec, change: 'same', from: current, to: level }
  })
  const removedActions = oldActions
    .filter((a) => !next.actions.some((n) => n.key === a.key))
    .map((a) => ({ key: a.key, label: a.label }))

  const names = to.skills.map((s) => s.name)
  const replace = new Set(input.replaceSkills ?? [])
  const matched = new Map<string, InstalledSkill>()
  const strays: InstalledSkill[] = []
  for (const row of input.skills) {
    const name = skillOf(row, names)
    if (name && !matched.has(name)) matched.set(name, row)
    else strays.push(row)
  }
  const skills: SkillPlan[] = [
    ...to.skills.map((skill): SkillPlan => {
      const row = matched.get(skill.name) ?? null
      if (!row) return { name: skill.name, template: skill, row, step: 'add' }
      if (sameSkill(row, skill)) return { name: row.name, template: skill, row, step: 'same' }
      if (row.edited && !replace.has(row.name) && !replace.has(skill.name))
        return { name: row.name, template: skill, row, step: 'keep' }
      return { name: row.name, template: skill, row, step: 'replace' }
    }),
    ...strays.map((row): SkillPlan => ({
      name: row.name,
      template: null,
      row,
      step: row.edited && !replace.has(row.name) ? 'keep' : 'delete',
    })),
  ]

  const oldRoles = playbookRoles(from.apps ?? [])
  const newRoles = playbookRoles(next.apps)
  const roleKey = (r: PlaybookRole) =>
    JSON.stringify([[...r.kinds].sort(), r.access, r.optional, r.teammate])
  const oldSettings = from.settings ?? []
  return {
    from: from.version,
    to: next.version,
    entries: planEntries(from.entries ?? [], next.entries, input.before, input.after),
    actions,
    removedActions,
    skills,
    apps: {
      added: newRoles.filter((r) => !oldRoles.some((o) => o.name === r.name)),
      removed: oldRoles.filter((r) => !newRoles.some((n) => n.name === r.name)),
      changed: newRoles.flatMap((r) => {
        const old = oldRoles.find((o) => o.name === r.name)
        return old && roleKey(old) !== roleKey(r) ? [{ from: old, to: r }] : []
      }),
    },
    settings: {
      // A setting whose kind changed is a new question: its old answer may not fit.
      added: next.settings.filter(
        (s) => !oldSettings.some((o) => o.key === s.key && o.type === s.type),
      ),
      removed: oldSettings.filter((o) => !next.settings.some((s) => s.key === o.key)),
    },
  }
}

// ---------------------------------------------------------------------------
// In plain English
// ---------------------------------------------------------------------------

const quote = (text: string) => `“${text.length > 120 ? `${text.slice(0, 117)}…` : text}”`
const lower = (label: string) => label.charAt(0).toLowerCase() + label.slice(1)
const kindWords = (kinds: readonly string[]) =>
  kinds.map((k) => (k === 'mcp' ? 'an MCP server' : k)).join(' or ')
const roleWords = (r: PlaybookRole) =>
  r.plain ? r.name : `the role ${r.name} (${kindWords(r.kinds)})`
const accessWords = (r: PlaybookRole) =>
  `${r.access === 'read_write' ? 'read and write' : 'read only'}${r.optional ? ', optional' : ''}`

/** A trigger entry's name, as its row shows it. */
const triggerName = (entry: TriggerEntry, manifest: { name: string }) => {
  const [kind, event] = entry.trigger.split('.') as [ConnectorKind, string]
  return entry.label ?? `${manifest.name}: ${triggersOf(kind)[event]?.label ?? event}`
}
const scheduleName = (entry: ScheduleEntry, manifest: { name: string }) =>
  entry.title ?? manifest.name

/** What an option is called on its trigger, e.g. "Only emails matching". */
const optionLabel = (entry: TriggerEntry, name: string) => {
  const [kind, event] = entry.trigger.split('.') as [ConnectorKind, string]
  return triggersOf(kind)[event]?.options?.find((o) => o.name === name)?.label ?? name
}

function entryLines(
  diff: PlaybookDiff,
  from: PlaybookManifest,
  to: PlaybookManifest,
  before: Answers,
  after: Answers,
) {
  const lines: string[] = []
  for (const plan of diff.entries) {
    if (plan.kind === 'add')
      lines.push(
        isTriggerEntry(plan.to)
          ? `Adds the trigger ${quote(triggerName(plan.to, to))}`
          : `Adds the schedule ${quote(scheduleName(plan.to, to))}`,
      )
    else if (plan.kind === 'remove')
      lines.push(
        isTriggerEntry(plan.from)
          ? `Removes the trigger ${quote(triggerName(plan.from, from))}`
          : `Removes the schedule ${quote(scheduleName(plan.from, from))}`,
      )
    else if (isTriggerEntry(plan.from) && isTriggerEntry(plan.to)) {
      const name = triggerName(plan.to, to)
      const a = entryOptions(plan.from, before)
      const b = entryOptions(plan.to, after)
      const parts: string[] = []
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (a[key] === b[key]) continue
        const label = optionLabel(plan.to, key)
        parts.push(
          b[key] === undefined
            ? `${lower(label)} no longer set`
            : `${lower(label)} becomes ${quote(b[key]!)}`,
        )
      }
      const oldName = triggerName(plan.from, from)
      if (oldName !== name) parts.push(`renamed from ${quote(oldName)}`)
      if (parts.length)
        lines.push(`${quote(name)}: ${parts.join('; ')} (same trigger, nothing missed)`)
    } else if (!isTriggerEntry(plan.from) && !isTriggerEntry(plan.to)) {
      const name = scheduleName(plan.to, to)
      const parts: string[] = []
      if (plan.from.schedule !== plan.to.schedule) parts.push(`runs at ${quote(plan.to.schedule)}`)
      if (fill(plan.from.instructions, before) !== fill(plan.to.instructions, after))
        parts.push('new instructions')
      if (plan.to.timezone && plan.from.timezone !== plan.to.timezone)
        parts.push(`in ${plan.to.timezone}`)
      const oldName = scheduleName(plan.from, from)
      if (oldName !== name) parts.push(`renamed from ${quote(oldName)}`)
      if (parts.length) lines.push(`${quote(name)}: ${parts.join('; ')}`)
    }
  }
  return lines
}

/** What the update changes and does to autonomy, in plain English. */
export function describeDiff(
  diff: PlaybookDiff,
  from: PlaybookManifest,
  to: PlaybookManifest,
  before: Answers,
  after: Answers,
) {
  const changes: string[] = []
  const asked = (key: string | null) =>
    key ? (to.settings.find((s) => s.key === key)?.ask ?? key) : null
  for (const s of diff.skills) {
    if (s.step === 'add') changes.push(`Adds the skill ${s.name} to its recipe`)
    else if (s.step === 'replace') changes.push(`Updates the skill ${s.name}`)
    else if (s.step === 'delete') changes.push(`Removes the skill ${s.name}`)
    else if (s.step === 'keep')
      changes.push(
        s.template
          ? `Keeps your edited ${s.name}; the new version differs`
          : `Keeps your edited ${s.name}, which the new version no longer has`,
      )
  }
  changes.push(...entryLines(diff, from, to, before, after))
  for (const a of diff.actions)
    if (a.change === 'added') changes.push(`New action: ${a.spec.label}`)
    else if (a.change === 'changed') changes.push(`${a.spec.label}: its tools or conditions change`)
  for (const a of diff.removedActions) changes.push(`Removes the action ${lower(a.label)}`)
  for (const r of diff.apps.added) changes.push(`Adds ${roleWords(r)} (${accessWords(r)})`)
  for (const r of diff.apps.removed) changes.push(`No longer uses ${roleWords(r)}`)
  for (const { from: a, to: b } of diff.apps.changed) {
    const parts: string[] = []
    if (!sameList(a.kinds, b.kinds)) parts.push(`now ${kindWords(b.kinds)}`)
    if (a.access !== b.access || a.optional !== b.optional) parts.push(accessWords(b))
    if (a.teammate !== b.teammate)
      parts.push(
        b.teammate
          ? `held by the teammate who answers ${quote(asked(b.teammate)!)}`
          : 'held by the teammate its runs start with',
      )
    changes.push(`${roleWords(b)}: ${parts.join(', ')}`)
  }
  for (const s of diff.settings.added)
    changes.push(
      `${s.optional || s.default !== undefined ? 'New optional setting' : 'New setting'}: ${s.ask ?? s.key}`,
    )
  for (const s of diff.settings.removed) changes.push(`Drops the setting ${quote(s.ask ?? s.key)}`)

  const autonomy: string[] = []
  for (const a of diff.actions) {
    if (a.change === 'added') autonomy.push(`${a.spec.label} starts at ${LEVEL_WORDS[a.to]}`)
    else if (a.change === 'changed')
      autonomy.push(
        a.from === 'auto'
          ? `${a.spec.label} goes back to ${LEVEL_WORDS[a.to]}, as its tools or conditions change; its history is kept`
          : `${a.spec.label} stays at ${LEVEL_WORDS[a.to]}; trust counts again from now`,
      )
    else if (a.change === 'ceiling' && a.from && a.to !== a.from)
      autonomy.push(`${a.spec.label} can go no further than ${LEVEL_WORDS[a.to]} now`)
  }
  const kept = diff.actions.filter(
    (a) => a.change === 'same' || (a.change === 'ceiling' && a.to === a.from),
  )
  if (kept.length)
    autonomy.push(
      `${kept.length === diff.actions.length ? 'Every action keeps' : 'The other actions keep'} their level, limits and history`,
    )
  return { changes, autonomy }
}

// ---------------------------------------------------------------------------
// Reading an installation
// ---------------------------------------------------------------------------

/** Brigade writes a playbook's skills as this: an edit by anyone else is the workspace's. */
const writer = (installationId: string) => ({
  type: 'system' as const,
  id: `playbook:${installationId}`,
})

/**
 * Its recipe's skills as installed, each marked edited when the workspace changed it since
 * Brigade last wrote it: an edit (a person's, or a teammate's approved proposal) is a
 * skill.updated in the audit log, and Brigade's own writes are signed as the playbook.
 */
export async function installedSkills(
  db: ScopedDb,
  installationId: string,
): Promise<InstalledSkill[]> {
  const rows = await db.skill.findMany({
    where: { pack: { playbookInstallationId: installationId } },
    orderBy: { createdAt: 'asc' },
  })
  if (!rows.length) return []
  const me = writer(installationId)
  const edits = await db.auditEntry.findMany({
    where: {
      action: 'skill.updated',
      targetType: 'skill',
      targetId: { in: rows.map((r) => r.id) },
    },
    select: { targetId: true },
  })
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    instructions: r.instructions,
    files: (Array.isArray(r.files) ? r.files : []).flatMap((f) => {
      const ref = f as { path?: unknown; sha256?: unknown; content?: unknown }
      if (typeof ref.path !== 'string') return []
      if (typeof ref.sha256 === 'string') return [{ path: ref.path, sha256: ref.sha256 }]
      // Kept inline before packs.
      return typeof ref.content === 'string'
        ? [{ path: ref.path, sha256: sha256(ref.content) }]
        : []
    }),
    edited:
      !(r.updatedByType === me.type && r.updatedById === me.id) &&
      edits.some((e) => e.targetId === r.id),
  }))
}

type Installation = {
  id: string
  playbookKey: string
  version: string
  status: string
  manifest: unknown
  settings: unknown
  teammateId: string
  ownerMemberId: string
}

/**
 * Its answers on the new version: those it keeps, the setting its runs start with defaulting to
 * its teammate, the answers given, then defaults; and the required ones still without one.
 */
async function nextAnswers(
  db: ScopedDb,
  installation: Installation,
  template: Template,
  given: Answers,
) {
  const manifest = template.manifest
  const before = (installation.settings ?? {}) as Answers
  const old = (installation.manifest as PlaybookManifest).settings ?? []
  const kept: Answers = Object.fromEntries(
    Object.entries(before).filter(([key]) => {
      const s = manifest.settings.find((n) => n.key === key)
      return s && old.some((o) => o.key === key && o.type === s.type)
    }),
  )
  if (manifest.teammate && !(manifest.teammate in kept))
    kept[manifest.teammate] = installation.teammateId
  const answers = { ...kept, ...(await checkSettings(db, manifest, given)) }
  const { values, missing } = withDefaults(manifest, answers)
  return { before, values, missing }
}

const question = (s: PlaybookSetting): PlaybookUpdateQuestion => ({
  key: s.key,
  type: s.type,
  ask: s.ask ?? s.key,
  optional: Boolean(s.optional),
  ...(s.options ? { options: s.options } : {}),
  ...(s.app ? { app: s.app } : {}),
})

const runningDryRun = (db: ScopedDb, id: string) =>
  db.playbookDryRun.count({ where: { installationId: id, status: 'running' } })

/** What moving to the template's newer version does, before it is done. */
async function prepare(
  db: ScopedDb,
  installation: Installation & { actions: { key: string; level: PlaybookLevel }[] },
  template: Template,
  given: Answers = {},
  replaceSkills?: string[],
) {
  const from = installation.manifest as PlaybookManifest
  const { before, values, missing } = await nextAnswers(db, installation, template, given)
  const skills = await installedSkills(db, installation.id)
  const diff = playbookDiff({
    from,
    to: template,
    before,
    after: values,
    levels: Object.fromEntries(installation.actions.map((a) => [a.key, a.level])),
    skills,
    replaceSkills,
  })
  const words = describeDiff(diff, from, template.manifest, before, values)
  const newSettings = template.manifest.settings
    .filter((s) => !(s.key in values) && diff.settings.added.some((a) => a.key === s.key))
    .map(question)
  return { from, before, values, missing, skills, diff, words, newSettings }
}

/** The sheet's line: its template's newer version and what moving to it changes, else null. */
export async function updateView(
  db: ScopedDb,
  installation: Installation & { actions: { key: string; level: PlaybookLevel }[] },
  viewer?: { memberId: string; role: string },
): Promise<PlaybookUpdateView | null> {
  const template = newerTemplate(installation)
  if (!template) return null
  const { diff, words, newSettings } = await prepare(db, installation, template)
  return {
    version: template.manifest.version,
    changes: words.changes,
    autonomy: words.autonomy,
    keptSkills: diff.skills.filter((s) => s.step === 'keep').map((s) => s.name),
    newSettings,
    blocked: (await runningDryRun(db, installation.id))
      ? 'A dry run is under way: update it once that is done'
      : null,
    canUpdate:
      !!viewer &&
      (viewer.memberId === installation.ownerMemberId ||
        viewer.role === 'owner' ||
        viewer.role === 'admin'),
  }
}

// ---------------------------------------------------------------------------
// Applying it
// ---------------------------------------------------------------------------

/** Conditions a changed action keeps: only those its new version still allows. */
function allowedConditions(spec: PlaybookActionSpec, raw: unknown): PlaybookActionConditions {
  const c = storedConditions(raw) ?? {}
  const args = spec.conditions.filter((x) => x !== 'case' && x !== 'checks_passed')
  const max = Object.fromEntries(Object.entries(c.max ?? {}).filter(([k]) => args.includes(k)))
  return {
    ...(c.cases && spec.conditions.includes('case') ? { cases: c.cases } : {}),
    ...(c.checksPassed && needsChecks(spec) ? { checksPassed: true as const } : {}),
    ...(Object.keys(max).length ? { max } : {}),
  }
}

/** Where its rows stand for the installed manifest's entries, by index: matched by what they are, then order. */
function matchRows<R extends { id: string }>(
  entries: readonly PlaybookEntry[],
  rows: R[],
  kind: 'trigger' | 'schedule',
  fits: (entry: PlaybookEntry, row: R) => boolean,
) {
  const left = [...rows]
  const found = new Map<number, R>()
  const indexes = entries.flatMap((e, i) => ((kind === 'trigger') === isTriggerEntry(e) ? [i] : []))
  for (const i of indexes) {
    const at = left.findIndex((r) => fits(entries[i]!, r))
    if (at >= 0) found.set(i, left.splice(at, 1)[0]!)
  }
  for (const i of indexes) if (!found.has(i) && left.length) found.set(i, left.shift()!)
  return { found, strays: left }
}

/**
 * POST /playbooks/:id/update: onto its template's latest version. Its owner, an owner or an
 * admin. A new required setting without an answer changes nothing: the questions come back.
 */
export async function upgradePlaybook(
  db: ScopedDb,
  who: Who,
  id: string,
  input: UpgradePlaybook,
  /** Tests only: runs once the update is planned, before it is written. */
  hooks: { beforeApply?: () => Promise<void> } = {},
): Promise<PlaybookUpgradeResult> {
  const viewer = { memberId: who.memberId, role: who.role }
  const installer = {
    organizationId: who.organizationId,
    workspaceId: who.workspaceId,
    memberId: who.memberId,
  }
  const found = await db.playbookInstallation.findFirst({
    where: { id },
    include: {
      actions: true,
      triggers: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      schedules: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
  })
  if (!found) throw new HTTPException(404, { message: 'Playbook not found' })
  requireManager(viewer, found)
  const template = newerTemplate(found)
  if (!template)
    throw new HTTPException(409, {
      message: `It is already on the latest version, ${found.version}`,
    })
  const fromVersion = found.version
  const to = template.manifest

  // Not active yet: it moves as it always did, its parts made again with its answers.
  if (found.status === 'setup' || found.status === 'dry_run') {
    const moved = await upgradeSetup(db, installer, found, template)
    if (moved.version === fromVersion)
      throw new HTTPException(409, {
        message: 'A dry run is under way: update it once that is done',
      })
    const missing = await answerSettings(db, installer, id, input.settings)
    return {
      updated: true,
      from: fromVersion,
      to: to.version,
      keptSkills: [],
      missing: to.settings.filter((s) => missing.includes(s.key)).map(question),
      playbook: await getInstallation(db, id, viewer),
    }
  }
  if (await runningDryRun(db, id))
    throw new HTTPException(409, { message: 'A dry run is under way: update it once that is done' })

  const plan = await prepare(db, found, template, input.settings, input.replaceSkills)
  if (plan.missing.length) {
    return {
      updated: false,
      from: fromVersion,
      to: to.version,
      keptSkills: plan.diff.skills.filter((s) => s.step === 'keep').map((s) => s.name),
      missing: to.settings.filter((s) => plan.missing.includes(s.key)).map(question),
      playbook: await getInstallation(db, id, viewer),
    }
  }
  const { from, before, values: settings, diff } = plan
  const teammateId = runTeammate(to, settings) ?? found.teammateId
  const teammate = await db.teammate.findFirst({ where: { id: teammateId, archivedAt: null } })
  if (!teammate)
    throw new HTTPException(409, {
      message: 'The teammate its runs start with is archived: pick another first',
    })

  // The new skills' files go to the bucket first: nothing to undo there if the update fails.
  const files = new Map<string, { path: string; sha256: string; size: number }[]>()
  for (const s of diff.skills)
    if (s.template && (s.step === 'add' || s.step === 'replace'))
      files.set(
        s.template.name,
        await Promise.all(
          s.template.files.map((f) =>
            storeSkillFile(who, f.path, new TextEncoder().encode(f.content)),
          ),
        ),
      )

  const now = new Date()
  const active = found.status === 'active'
  const me = writer(id)
  const touched = new Set<string>()
  const timezoneFallback = found.schedules[0]?.timezone ?? 'UTC'

  await hooks.beforeApply?.()
  await db.$transaction(async (raw) => {
    const tx = raw as unknown as ScopedDb
    // Serialized with every other change to its actions (a person's level, a call marked as
    // wrong, a proposal): their levels are read again under the lock, after any of those.
    await lockActions(tx, who, id)
    const rows = await tx.playbookAction.findMany({ where: { installationId: id } })
    // One update at a time: a second one finds the version moved and stops.
    const moved = await tx.playbookInstallation.updateMany({
      where: { id, version: fromVersion },
      data: { manifest: to as never, version: to.version, settings, teammateId },
    })
    if (!moved.count) throw new HTTPException(409, { message: 'It was just updated' })

    // Autonomy never grows: each level from the row as it is now, kept or lowered.
    for (const a of diff.actions) {
      const row = rows.find((r) => r.key === a.key)
      if (!row) {
        await tx.playbookAction.create({
          data: {
            installationId: id,
            key: a.key,
            level: lowest(a.spec.start, 'ask', a.spec.ceiling),
          } as never,
        })
        continue
      }
      if (a.change === 'same') continue
      const level =
        a.change === 'changed'
          ? lowest(row.level, 'ask', a.spec.ceiling)
          : lowest(row.level, a.spec.ceiling)
      const lowered = LEVELS.indexOf(level) < LEVELS.indexOf(row.level)
      if (a.change === 'ceiling' && !lowered) continue
      await tx.playbookAction.updateMany({
        where: { id: row.id },
        data: {
          level,
          ...(a.change === 'changed'
            ? { conditions: allowedConditions(a.spec, row.conditions) as never }
            : {}),
          // Its trust counts again from now: what it is has changed.
          ...(a.change === 'changed' || lowered
            ? { levelChangedAt: now, levelChangedByMemberId: null }
            : {}),
          ...(lowered ? { demotedReason: 'update' } : {}),
        },
      })
    }
    for (const a of diff.removedActions)
      await tx.playbookAction.deleteMany({ where: { installationId: id, key: a.key } })
    // A proposal to act on its own made for what it was has no more point.
    for (const key of [
      ...diff.actions
        .filter(
          (a) => a.change === 'changed' || (a.change === 'ceiling' && a.spec.ceiling !== 'auto'),
        )
        .map((a) => a.key),
      ...diff.removedActions.map((a) => a.key),
    ])
      await tx.ticket.updateMany({
        where: {
          type: 'approval',
          status: 'open',
          AND: [
            { payload: { path: ['playbookPromotion', 'installationId'], equals: id } },
            { payload: { path: ['playbookPromotion', 'actionKey'], equals: key } },
          ],
        },
        data: { status: 'resolved', resolvedByMemberId: who.memberId, resolvedAt: now },
      })

    // Triggers and schedules, in place where an entry still corresponds.
    const oldEntries = from.entries ?? []
    const triggers = matchRows(
      oldEntries,
      found.triggers,
      'trigger',
      (e, r) =>
        isTriggerEntry(e) &&
        r.event === e.trigger.split('.')[1] &&
        r.connectionId === fill(e.account, before),
    )
    const schedules = matchRows(
      oldEntries,
      found.schedules,
      'schedule',
      (e, r) => !isTriggerEntry(e) && r.cron === e.schedule && r.title === (e.title ?? from.name),
    )
    const removeRow = async (entry: PlaybookEntry, index: number) => {
      if (isTriggerEntry(entry)) {
        const row = triggers.found.get(index)
        if (!row) return
        await deleteTriggers(tx, { id: row.id })
        touched.add(row.connectionId)
      } else {
        const row = schedules.found.get(index)
        if (row) await tx.schedule.deleteMany({ where: { id: row.id } })
      }
    }
    const addRow = async (entry: PlaybookEntry) => {
      if (isTriggerEntry(entry)) {
        const [kind, event] = entry.trigger.split('.') as [ConnectorKind, string]
        const connection = await tx.connection.findFirst({
          where: { id: fill(entry.account, settings), kind, status: { not: 'removed' } },
        })
        if (!connection)
          throw new HTTPException(400, {
            message: `${entry.trigger} needs one of the workspace's ${kind} accounts`,
          })
        await tx.trigger.create({
          data: {
            connectionId: connection.id,
            teammateId,
            label: triggerName(entry, to),
            event,
            options: entryOptions(entry, settings),
            createdByMemberId: found.ownerMemberId,
            projectId: found.projectId,
            playbookInstallationId: id,
          } as never,
        })
        touched.add(connection.id)
      } else {
        const timezone = entry.timezone ?? timezoneFallback
        await tx.schedule.create({
          data: {
            teammateId,
            title: scheduleName(entry, to),
            instructions: fill(entry.instructions, settings),
            cron: entry.schedule,
            timezone,
            ownerMemberId: found.ownerMemberId,
            projectId: found.projectId,
            playbookInstallationId: id,
            ...(active
              ? { nextRunAt: nextRun(entry.schedule, timezone) ?? null }
              : { pausedAt: now, nextRunAt: null }),
          } as never,
        })
      }
    }
    for (const plan of diff.entries) {
      if (plan.kind === 'remove') await removeRow(plan.from, plan.index)
      else if (plan.kind === 'add') await addRow(plan.to)
      else if (isTriggerEntry(plan.from) && isTriggerEntry(plan.to)) {
        const row = triggers.found.get(plan.index)
        if (!row) {
          await addRow(plan.to)
          continue
        }
        // The same trigger, its id kept: its inbox subscription and cursor stay as they are.
        await tx.trigger.updateMany({
          where: { id: row.id },
          data: {
            label: triggerName(plan.to, to),
            options: entryOptions(plan.to, settings),
            teammateId,
          },
        })
      } else if (!isTriggerEntry(plan.to)) {
        const row = schedules.found.get(plan.index)
        if (!row) {
          await addRow(plan.to)
          continue
        }
        const timezone = plan.to.timezone ?? row.timezone
        const moved = row.cron !== plan.to.schedule || row.timezone !== timezone
        await tx.schedule.updateMany({
          where: { id: row.id },
          data: {
            title: scheduleName(plan.to, to),
            instructions: fill(plan.to.instructions, settings),
            cron: plan.to.schedule,
            timezone,
            teammateId,
            ...(moved && !row.pausedAt
              ? { nextRunAt: nextRun(plan.to.schedule, timezone) ?? null }
              : {}),
          },
        })
      }
    }
    // Rows no entry accounts for (made by hand before playbooks owned them): left as they are.

    // Its recipe.
    const pack = await tx.skillPack.findFirst({ where: { playbookInstallationId: id } })
    if (!pack) {
      if (template.skills.length) {
        const skills = []
        for (const s of template.skills)
          skills.push({
            name: await freeName(tx, s.name),
            description: s.description,
            instructions: s.instructions,
            files: files.get(s.name) ?? [],
            enabled: true,
          })
        const made = await savePack(tx, who, me, {
          name: to.name,
          source: `playbook:${id}`,
          everywhere: true,
          teammateIds: [],
          projectIds: [],
          skills,
        })
        await tx.skillPack.updateMany({
          where: { id: made.id },
          data: { playbookInstallationId: id },
        })
      }
    } else {
      for (const s of diff.skills) {
        if (s.step === 'replace' && s.row && s.template)
          await tx.skill.updateMany({
            where: { id: s.row.id },
            data: {
              description: s.template.description,
              instructions: s.template.instructions,
              files: (files.get(s.template.name) ?? []) as never,
              updatedByType: me.type,
              updatedById: me.id,
            },
          })
        else if (s.step === 'add' && s.template)
          await tx.skill.create({
            data: {
              name: await freeName(tx, s.template.name),
              description: s.template.description,
              instructions: s.template.instructions,
              files: (files.get(s.template.name) ?? []) as never,
              packId: pack.id,
              everywhere: pack.everywhere,
              teammateIds: pack.teammateIds,
              projectIds: pack.projectIds,
              enabled: true,
              createdByType: me.type,
              createdById: me.id,
              updatedByType: me.type,
              updatedById: me.id,
            } as never,
          })
        else if (s.step === 'delete' && s.row)
          await tx.skill.deleteMany({ where: { id: s.row.id } })
      }
      if (pack.name !== to.name)
        await tx.skillPack.updateMany({ where: { id: pack.id }, data: { name: to.name } })
    }
  })

  const keptSkills = diff.skills.filter((s) => s.step === 'keep').map((s) => s.name)
  await audit({
    ...who,
    actor: { type: 'member', id: who.memberId },
    action: 'playbook.upgraded',
    target: { type: 'playbook', id },
    data: {
      from: fromVersion,
      to: to.version,
      ...(keptSkills.length ? { keptSkills } : {}),
      replacedSkills: diff.skills.filter((s) => s.step === 'replace').map((s) => s.name),
    },
  })
  // Only accounts that gained or lost a trigger: an inbox whose trigger changed in place is
  // listened to as it was.
  if (touched.size) await resync(who, touched)
  return {
    updated: true,
    from: fromVersion,
    to: to.version,
    keptSkills,
    missing: [],
    playbook: await getInstallation(db, id, viewer),
  }
}

/** The installation an update in the chat means: by id, else the one of its template the person may update. */
export async function installationToUpdate(
  db: ScopedDb,
  who: { memberId: string; role: string },
  input: { installationId?: string; playbookKey?: string },
) {
  if (input.installationId) {
    const installation = await requireInstallation(db, input.installationId)
    requireManager(who, installation)
    return installation
  }
  const all = await db.playbookInstallation.findMany({
    where: input.playbookKey ? { playbookKey: input.playbookKey } : {},
    orderBy: { createdAt: 'asc' },
  })
  const mine = all.filter(
    (i) => i.ownerMemberId === who.memberId || who.role === 'owner' || who.role === 'admin',
  )
  const outdated = mine.filter((i) => newerTemplate(i))
  const pick = outdated.length ? outdated : mine
  if (pick.length === 1) return pick[0]!
  throw new HTTPException(pick.length ? 409 : 404, {
    message: pick.length
      ? `Several are installed: give the installationId of one of ${pick
          .map((i) => `${(i.manifest as PlaybookManifest).name} ${i.version} (${i.id})`)
          .join(', ')}`
      : 'No playbook installed here that you may update',
  })
}
