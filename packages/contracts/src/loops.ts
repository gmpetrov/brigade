// Playbooks ("loops" in code): a whole job to install. A template is a folder with a
// loop.yaml (LoopManifest), its skills and samples; Brigade ships its own with the API
// (apps/api/loops/<id>/). An installation runs one in a workspace, for one teammate, on
// its owner's accounts. "Playbook" in visible text; "loop" in code, API and database.
import { z } from 'zod'

const Key = z.string().regex(/^[a-z][a-z0-9_]*$/, 'lowercase letters, digits and _')
const Text = z.string().trim().min(1)

/** ask: a person approves each time. auto: the teammate acts alone. deny: never. */
export const LoopLevel = z.enum(['ask', 'auto', 'deny'])
export type LoopLevel = z.infer<typeof LoopLevel>
/** From least to most autonomy: a level is within a ceiling when it is not after it. */
const LEVELS: LoopLevel[] = ['deny', 'ask', 'auto']
export const withinCeiling = (level: LoopLevel, ceiling: LoopLevel) =>
  LEVELS.indexOf(level) <= LEVELS.indexOf(ceiling)

/** The kinds of setting a template asks for; the API checks each answer by its kind. */
export const LoopSettingType = z.enum([
  'text',
  'url',
  'email',
  'repository',
  /** One of the workspace's accounts of an App (`app`): its connection id. */
  'account',
  'amount',
  'choice',
])
export type LoopSettingType = z.infer<typeof LoopSettingType>

export const LoopSetting = z
  .object({
    key: Key,
    type: LoopSettingType,
    /** What the teammate asks at installation. */
    ask: Text.max(300).optional(),
    /** May hold {{other}} settings. */
    default: z.union([z.string(), z.number()]).optional(),
    /** An account setting: the App kind it is an account of. */
    app: z.string().optional(),
    /** A choice setting: its values. */
    options: z.array(Text).min(1).optional(),
    optional: z.boolean().optional(),
  })
  .superRefine((s, ctx) => {
    if (s.type === 'account' && !s.app)
      ctx.addIssue({ code: 'custom', message: 'an account setting names its app', path: ['app'] })
    if (s.type === 'choice' && !s.options)
      ctx.addIssue({ code: 'custom', message: 'a choice lists its options', path: ['options'] })
  })
export type LoopSetting = z.infer<typeof LoopSetting>

/** A trigger it creates: `<app kind>.<event>`, on an account, with the catalog's options. */
const TriggerEntry = z.object({
  trigger: z.string().regex(/^[a-z_]+\.[a-z_]+$/, 'app.event, e.g. gmail.email_received'),
  /** The account, usually "{{inbox}}" (an account setting). */
  account: z.string(),
  options: z.record(z.string(), z.string()).default({}),
  label: Text.max(120).optional(),
})
/** A schedule it creates: a cron and the instructions of each run. */
const ScheduleEntry = z.object({
  schedule: z.string().trim().min(1).max(100),
  instructions: Text.max(20_000),
  title: Text.max(120).optional(),
  /** IANA; unset: the owner's (their latest schedule's), else UTC. */
  timezone: z.string().optional(),
})
export const LoopEntry = z.union([TriggerEntry, ScheduleEntry])
export type LoopEntry = z.infer<typeof LoopEntry>
export const isTriggerEntry = (e: LoopEntry): e is z.infer<typeof TriggerEntry> => 'trigger' in e

export const LoopActionSpec = z
  .object({
    key: Key,
    label: Text.max(120),
    /** The tools that are this action, by name (e.g. gmail_send). */
    tools: z.array(z.string().min(1)).min(1),
    start: LoopLevel,
    /** The most autonomy an installation may give it. */
    ceiling: LoopLevel,
    /** What may limit auto: case (triage cases), checks_passed, or an argument's value. */
    conditions: z.array(z.string().min(1)).default([]),
  })
  .refine((a) => withinCeiling(a.start, a.ceiling), {
    message: 'start is above ceiling',
    path: ['start'],
  })
export type LoopActionSpec = z.infer<typeof LoopActionSpec>

export const LoopApp = z.object({
  /** A built-in App's kind, e.g. gmail. */
  kind: z.string().regex(/^[a-z_]+$/),
  access: z.enum(['read', 'read_write']),
  optional: z.boolean().optional(),
})
export type LoopApp = z.infer<typeof LoopApp>

export const LoopManifest = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/, 'owner/name, e.g. brigade/support-bugs'),
    name: Text.max(80),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'semver, e.g. 1.0.0'),
    description: Text.max(500),
    apps: z.array(LoopApp).default([]),
    settings: z.array(LoopSetting).default([]),
    entries: z.array(LoopEntry).min(1),
    /** Its recipe: folders of the template, each with a SKILL.md. */
    skills: z.array(z.string().min(1)).default([]),
    actions: z.array(LoopActionSpec).default([]),
    limits: z.object({ runsPerDay: z.number().int().positive().max(10_000) }),
    promotion: z
      .object({
        decisions: z.number().int().positive(),
        approvedRate: z.number().gt(0).max(1),
      })
      .default({ decisions: 30, approvedRate: 0.95 }),
    dryRun: z
      .object({
        replay: z.object({ entry: z.number().int().min(0), last: z.number().int().positive() }),
      })
      .optional(),
    metrics: z.array(z.string()).default([]),
  })
  .superRefine((m, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: 'custom', message, path })
    const dupes = (list: string[]) => list.filter((v, i) => list.indexOf(v) !== i)
    for (const key of dupes(m.settings.map((s) => s.key)))
      issue(`two settings are called ${key}`, ['settings'])
    for (const key of dupes(m.actions.map((a) => a.key)))
      issue(`two actions are called ${key}`, ['actions'])
    for (const kind of dupes(m.apps.map((a) => a.kind)))
      issue(`${kind} is declared twice`, ['apps'])
    const keys = new Set(m.settings.map((s) => s.key))
    // Every {{setting}} it uses is one of its settings.
    const refs = (text: string, path: (string | number)[]) => {
      for (const [, key] of text.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi))
        if (!keys.has(key!)) issue(`{{${key}}} is not a setting`, path)
    }
    m.settings.forEach((s, i) => {
      if (typeof s.default === 'string') refs(s.default, ['settings', i, 'default'])
      if (s.type === 'account' && !m.apps.some((a) => a.kind === s.app))
        issue(`${s.app} is not among its apps`, ['settings', i, 'app'])
    })
    m.entries.forEach((e, i) => {
      if (isTriggerEntry(e)) {
        refs(e.account, ['entries', i, 'account'])
        Object.values(e.options).forEach((v) => refs(v, ['entries', i, 'options']))
        const kind = e.trigger.split('.')[0]
        if (!m.apps.some((a) => a.kind === kind))
          issue(`${kind} is not among its apps`, ['entries', i, 'trigger'])
      } else {
        // Its cron is checked where the template loads (schedules.ts imports this file).
        refs(e.instructions, ['entries', i, 'instructions'])
      }
    })
    if (m.dryRun && !m.entries[m.dryRun.replay.entry])
      issue('dryRun replays an entry it does not have', ['dryRun', 'replay', 'entry'])
  })
export type LoopManifest = z.infer<typeof LoopManifest>

/** How a run ended, as the teammate reports it (loop_report). */
export const LoopOutcome = z.enum(['resolved', 'escalated', 'noise', 'failed'])
export type LoopOutcome = z.infer<typeof LoopOutcome>

export const LoopStatus = z.enum(['setup', 'dry_run', 'active', 'paused'])
export type LoopStatus = z.infer<typeof LoopStatus>
export const LoopRunStatus = z.enum([
  'running',
  'waiting_person',
  'waiting_event',
  'done',
  'failed',
])
export type LoopRunStatus = z.infer<typeof LoopRunStatus>

/** Settings answers, by key. */
const SettingValues = z.record(z.string(), z.union([z.string(), z.number()]))

/** A dry run replays at most this many events. */
export const DRY_RUN_MAX = 20

/**
 * The playbook operations of a teammate's schedule tools: loop_report in a playbook's thread;
 * the others to install one from a member's thread (show_playbook, configure_loop,
 * start_dry_run, dry_run_report, activate_loop).
 */
export const LoopOperations = [
  z.object({
    name: z.literal('loop_report'),
    /** The triage case, in the recipe's words (e.g. documented_question, bug). */
    case: z.string().trim().min(1).max(80),
    outcome: LoopOutcome,
    summary: z.string().trim().max(2_000).optional(),
  }),
  /** The catalog, or one playbook as a card in the thread. */
  z.object({ name: z.literal('show_playbook'), loopKey: z.string().trim().min(1).optional() }),
  /** Start installing one (loopKey), or go on with it (installationId): answers, checked by type. */
  z.object({
    name: z.literal('configure_loop'),
    loopKey: z.string().trim().min(1).optional(),
    installationId: z.string().trim().min(1).optional(),
    /** The teammate that runs it, by name or id; unset: the one installing it. */
    teammate: z.string().trim().min(1).optional(),
    settings: SettingValues.default({}),
  }),
  z.object({
    name: z.literal('start_dry_run'),
    installationId: z.string().trim().min(1),
    /** Fewer events than the playbook replays, for a quick try. */
    last: z.number().int().positive().max(DRY_RUN_MAX).optional(),
  }),
  z.object({ name: z.literal('dry_run_report'), installationId: z.string().trim().min(1) }),
  z.object({ name: z.literal('activate_loop'), installationId: z.string().trim().min(1) }),
] as const

/** The tools of the teammate that installs a playbook, by the operation each one is. */
export const LOOP_INSTALL_TOOLS = [
  'show_playbook',
  'configure_loop',
  'start_dry_run',
  'dry_run_report',
  'activate_loop',
] as const
export type LoopInstallTool = (typeof LOOP_INSTALL_TOOLS)[number]

/** A playbook's thread, as its runner sees it (ThreadSpec.loop). */
export const ThreadLoop = z.object({
  installationId: z.string(),
  runId: z.string(),
  name: z.string(),
  /** The Apps it declares: the thread has only theirs. */
  apps: z.array(z.string()).default([]),
  /** A dry run's: every write is simulated, nothing is pushed, nobody is asked. */
  dryRun: z.boolean().default(false),
})
export type ThreadLoop = z.infer<typeof ThreadLoop>

// ---------------------------------------------------------------------------
// The dashboard's view
// ---------------------------------------------------------------------------

/** A template of the catalog, as the dashboard and the installing teammate see it. */
export type LoopTemplate = {
  id: string
  name: string
  version: string
  description: string
  source: string
  apps: LoopApp[]
  settings: LoopSetting[]
  entries: LoopEntry[]
  actions: LoopActionSpec[]
  skills: string[]
  limits: { runsPerDay: number }
}

/** Install one: its answers, the teammate it runs for, where. */
export const InstallLoop = z.object({
  loopKey: z.string().min(1),
  teammateId: z.string().min(1),
  projectId: z.string().nullish(),
  /** By setting key. */
  settings: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
})
export type InstallLoop = z.infer<typeof InstallLoop>

export const UpdateLoop = z.object({
  paused: z.boolean().optional(),
})

/** The Activate button: from the thread it was installed in, where a member's ticket goes. */
export const ActivateLoop = z.object({ threadId: z.string().optional() })

/** What an App of a playbook stands at for its teammate: usable, missing, or read-only where it writes. */
export type LoopAppStatus = LoopApp & {
  status: 'ready' | 'missing' | 'read_only'
  /** The accounts the teammate can use, by what they show (a Gmail address). */
  accounts: string[]
}

/** One event of a dry run: the case found, what would have been done, its thread. */
export type LoopDryRunEvent = {
  runId: string
  title: string
  threadId: string | null
  status: 'waiting' | 'running' | 'done' | 'failed'
  case: string | null
  outcome: LoopOutcome | null
  summary: string | null
  /** When the event happened (the mail's date). */
  at: string | null
  /** Session minutes on the owner's subscription, its children's included. */
  minutes: number
  /** The writes it would have made: recorded, answered with a fake success, never sent. */
  writes: {
    operation: string
    /** The playbook's action it is, e.g. "Reply to the customer". */
    action: string | null
    target: string
    input: unknown
  }[]
  /** Pushes refused, as nothing leaves a dry run. */
  pushes: number
}

export type LoopDryRunView = {
  id: string
  installationId: string
  name: string
  status: 'running' | 'done' | 'failed'
  error: string | null
  events: LoopDryRunEvent[]
  /** Events done (or failed) out of all. */
  finished: number
  minutes: number
  /** At the pace of the replayed events: a week's events and minutes. Null when it cannot tell. */
  week: { events: number; minutes: number } | null
  startedAt: string
  endedAt: string | null
}
export type UpdateLoop = z.infer<typeof UpdateLoop>

export type LoopRunView = {
  id: string
  title: string
  threadId: string | null
  case: string | null
  status: LoopRunStatus
  outcome: LoopOutcome | null
  startedAt: string
  endedAt: string | null
}

export type LoopActionView = LoopActionSpec & {
  level: LoopLevel
  approved: number
  denied: number
  auto: number
}

export type LoopEntryView =
  | {
      kind: 'trigger'
      id: string
      label: string
      /** The App kind, e.g. gmail. */
      app: string
      event: string
      account: string | null
    }
  | {
      kind: 'schedule'
      id: string
      title: string
      cron: string
      timezone: string
      nextRunAt: string | null
    }

export type LoopInstallationView = {
  id: string
  loopKey: string
  name: string
  description: string
  version: string
  source: string
  status: LoopStatus
  teammate: { id: string; name: string }
  owner: { id: string; name: string }
  project: { id: string; name: string; icon: string | null; logo: string | null } | null
  apps: LoopApp[]
  settings: { key: string; type: LoopSettingType; ask?: string; value: string | number | null }[]
  actions: LoopActionView[]
  entries: LoopEntryView[]
  runsThisWeek: number
  runsToday: number
  runsPerDay: number
  /** Share of this week's finished runs with no person stepping in, 0 to 1; null with none. */
  unattended: number | null
  recentRuns: LoopRunView[]
  /** Every setting it needs has an answer, and its triggers, schedules and skills are made. */
  ready: boolean
  /** Its settings still without an answer. */
  missing: string[]
  /** Its latest dry run. */
  dryRun: LoopDryRunView | null
  /** A member asked an owner or admin to activate it: the ticket that waits. */
  activationTicketId: string | null
  createdAt: string
  activatedAt: string | null
  pausedAt: string | null
}
