// Autonomy per action, in a playbook's live runs (spec "L'autonomie, action par action"). Each
// write a playbook may make is one of its manifest's actions, at the level its installation sets:
// ask (a person approves each time), auto (on its own) or deny. On its own holds only while its
// conditions do (the run's case, an argument's value, a merge's checks) and under its caps over
// 24 hours; otherwise the call asks, and the stored level stays. A write no action lists asks.
// People's decisions on an action's approvals measure trust: when enough of the latest are
// approvals, its owner is offered, in one ticket, to let it act on its own. Nothing raises a level
// without a person, and a call on its own marked as wrong sends its action back to asking.
import {
  needsChecks,
  PlaybookActionConditions,
  PlaybookActionLimits,
  withinCeiling,
  type PlaybookActionSpec,
  type PlaybookActionView,
  type PlaybookAutoCallView,
  type PlaybookLevel,
  type PlaybookManifest,
  type PlaybookPromotionPayload,
  type ScheduleOperation,
  type UpdatePlaybookAction,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit } from './audit.js'
import { GITHUB_API, githubHeaders, installationToken } from './connectors/github-app.js'
import { prisma, type Prisma, type Scope, type ScopedDb } from './db.js'
import { workspaceGitHub } from './git.js'
import type { WorkspaceScope } from './scope.js'

const DAY_MS = 24 * 3600_000
const isAdmin = (role: string) => role === 'owner' || role === 'admin'
const LEVEL_WORDS: Record<PlaybookLevel, string> = {
  ask: 'Asks first',
  auto: 'On its own',
  deny: 'Never',
}
/** "Reply to the customer" as it reads inside a sentence. */
const inSentence = (label: string) => label.charAt(0).toLowerCase() + label.slice(1)

/**
 * Every change to an installation's actions (a person's level, a call marked as wrong, a
 * proposal and its decision, an update to a newer version) takes this lock in its transaction
 * and reads the rows after it: none writes a level from a stale read, so a restriction one makes
 * is never undone by another.
 */
export async function lockActions(
  tx: { $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number> },
  scope: Scope,
  installationId: string,
) {
  const key = `playbook-actions:${scope.workspaceId}:${installationId}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
}

/** A scoped transaction holding the installation's action lock. */
export function withActionsLock<T>(
  db: ScopedDb,
  scope: Scope,
  installationId: string,
  work: (tx: ScopedDb) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (raw) => {
    const tx = raw as unknown as ScopedDb
    await lockActions(tx, scope, installationId)
    return work(tx)
  })
}

/** Stored conditions or caps as their schema reads them; null when they do not parse. */
export const storedConditions = (raw: unknown) => {
  const parsed = PlaybookActionConditions.safeParse(raw ?? {})
  return parsed.success ? parsed.data : null
}
export const storedLimits = (raw: unknown) => {
  const parsed = PlaybookActionLimits.safeParse(raw ?? {})
  return parsed.success ? parsed.data : null
}

/** An argument of a call, by name or dotted path (refund.amount). */
export function argumentOf(input: unknown, path: string): unknown {
  let value = input
  for (const part of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

/**
 * A call's numbers by dotted path, kept with each call on its own (ConnectionCall.input) so
 * an amount cap can sum them later; the rest of what it sent is not kept.
 */
export function numbersOf(input: unknown, prefix = '', depth = 0): Record<string, number> {
  const found: Record<string, number> = {}
  if (!input || typeof input !== 'object' || Array.isArray(input) || depth > 3) return found
  for (const [key, value] of Object.entries(input)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'number' && Number.isFinite(value)) found[path] = value
    else Object.assign(found, numbersOf(value, path, depth + 1))
  }
  return found
}

// ---------------------------------------------------------------------------
// A write in a playbook's live run
// ---------------------------------------------------------------------------

/**
 * What a write does: on its own, after a person approves it (why, when it is not plain), or never.
 * On its own after a merge's checks: the head commit they passed on, the only one it may merge.
 */
export type Verdict =
  | { level: 'auto'; checkedSha?: string }
  | { level: 'ask'; reason?: string }
  | { level: 'deny'; reason: string }

/** An action's calls on its own over the last 24 hours: how many, and their numbers summed. */
export type Usage = { count: number; sums: Record<string, number> }

/** Whether a pull request's checks allow a merge on its own (on which head commit), and why not. */
export type Checks = { passed: true; why: string; sha: string } | { passed: false; why: string }

/**
 * What a write at its action's level does, in place of the teammate's allow or ask (a deny of
 * the teammate's is checked before, in connector-calls.ts, and always stands). Judged on the
 * real call (its arguments), the run's case and what Brigade stored, never on what the teammate
 * says. Usage and checks are read only when a cap or a merge needs them.
 */
export async function verdict(input: {
  playbook: string
  /** The manifest's action the call is; none: a write the playbook does not list. */
  action: PlaybookActionSpec | undefined
  /** Its installation's row; none (an action newer than the installation): it asks. */
  stored: { level: PlaybookLevel; conditions: unknown; limits: unknown } | null
  args: unknown
  runCase: string | null
  usage: () => Promise<Usage>
  checks: () => Promise<Checks>
}): Promise<Verdict> {
  const { action } = input
  // An unknown or renamed tool is no action either.
  if (!action)
    return {
      level: 'ask',
      reason: `This is not one of the writes the playbook ${input.playbook} lists, so a person approves it.`,
    }
  const stored = input.stored?.level ?? (action.start === 'deny' ? 'deny' : 'ask')
  // Never above the template's ceiling, should a template have lowered it since.
  const level = withinCeiling(stored, action.ceiling) ? stored : action.ceiling
  const label = action.label
  if (level === 'deny')
    return {
      level: 'deny',
      reason: `The playbook ${input.playbook} never does this: ${inSentence(label)}.`,
    }
  if (level === 'ask' || !input.stored) return { level: 'ask' }
  const ask = (reason: string): Verdict => ({ level: 'ask', reason })
  const conditions = storedConditions(input.stored.conditions)
  const limits = storedLimits(input.stored.limits)
  if (!conditions || !limits)
    return ask(`${label}: what limits it on its own could not be read, so a person approves it.`)

  // The case comes from the teammate (playbook_triage): a run could claim the case that acts
  // alone. That is why only the actions its template allows can be limited by case (an
  // installation cannot go past its ceiling), and why a merge also needs its checks.
  if (conditions.cases?.length) {
    const cases = conditions.cases.join(', ')
    const runCase = input.runCase?.trim().toLowerCase()
    if (!runCase)
      return ask(
        `${label} is done on its own only for ${cases}, and this run has not said its case yet.`,
      )
    if (!conditions.cases.some((c) => c.trim().toLowerCase() === runCase))
      return ask(`${label} is done on its own only for ${cases}; this run is ${input.runCase}.`)
  }
  for (const [argument, max] of Object.entries(conditions.max ?? {})) {
    const value = argumentOf(input.args, argument)
    if (typeof value !== 'number' || !Number.isFinite(value))
      return ask(
        `${label} is done on its own only when ${argument} is at most ${max}, and this call has no ${argument}.`,
      )
    if (value > max)
      return ask(
        `${label} is done on its own only up to ${max} (${argument}); this one is ${value}.`,
      )
  }
  // A first look at the caps; the call takes its share of them only once it is let through
  // (reserveAllowance), where they are read again under a lock.
  if (capped(limits)) {
    const problem = capProblem(label, limits, await input.usage(), input.args)
    if (problem) return ask(problem)
  }
  // A merge never goes on its own without its checks, whatever its stored conditions say, and
  // then merges only the commit they passed on.
  if (conditions.checksPassed || needsChecks(action)) {
    const checks = await input.checks()
    if (!checks.passed)
      return ask(
        `${label} is done on its own only when every required check passed: ${checks.why}.`,
      )
    return { level: 'auto', checkedSha: checks.sha }
  }
  return { level: 'auto' }
}

type Limits = NonNullable<ReturnType<typeof storedLimits>>
const capped = (limits: Limits) => limits.count !== undefined || !!limits.amount

/** Why a call on its own would go past its action's caps over 24 hours, or null. */
function capProblem(label: string, limits: Limits, usage: Usage, args: unknown): string | null {
  if (limits.count !== undefined && usage.count >= limits.count)
    return `${label} is done on its own at most ${limits.count} times in 24 hours, and that many were done already.`
  if (limits.amount) {
    const { argument, max } = limits.amount
    const value = argumentOf(args, argument)
    if (typeof value !== 'number' || !Number.isFinite(value))
      return `${label} is capped at ${max} ${argument} a day on its own, and this call has no ${argument}.`
    const used = usage.sums[argument] ?? 0
    if (used + value > max)
      return `${label} is done on its own up to ${max} ${argument} in 24 hours: ${used} so far, and this one is ${value}.`
  }
  return null
}

/** Calls an installation's runs made on their own: real writes of an action no person decided. */
const autoWhere = (installationId: string) => ({
  playbookActionKey: { not: null },
  write: true,
  simulated: false,
  ticketId: null,
  result: 'ok',
  session: { playbookRun: { installationId } },
})

// An action's caps are a ledger in the audit log: every call let through on its own first
// reserves its share (one call, its numbers) under a lock per installation and action, so
// concurrent runs cannot spend the same allowance, and a cap set later counts what was done. A
// share is never given back, even when its call fails: the provider may have made the write
// before its answer was lost. The call log is append-only and lists calls once done, which is too
// late to count one in flight. Caps fail closed.
const RESERVED = 'playbook.allowance_reserved'
const allowanceTarget = (installationId: string, key: string) => ({
  targetType: 'playbook_action',
  targetId: `${installationId}:${key}`,
})

/** A call's share of its action's caps: kept, whatever the call's result. */
export type Reservation = { id: string; installationId: string; key: string }

/** An action's calls on its own over the last 24 hours, as reserved. */
async function usageToday(
  client: Pick<Prisma.TransactionClient, 'auditEntry'>,
  scope: Scope,
  installationId: string,
  key: string,
): Promise<Usage> {
  const reserved = await client.auditEntry.findMany({
    where: {
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      ...allowanceTarget(installationId, key),
      action: RESERVED,
      at: { gte: new Date(Date.now() - DAY_MS) },
    },
    select: { data: true },
  })
  const sums: Record<string, number> = {}
  for (const entry of reserved) {
    const numbers = (entry.data as { numbers?: unknown } | null)?.numbers
    for (const [path, value] of Object.entries(numbersOf(numbers)))
      sums[path] = (sums[path] ?? 0) + value
  }
  return { count: reserved.length, sums }
}

/**
 * A call let through on its own takes its share of its action's caps, atomically: under a lock per
 * installation and action, the caps are read again and counted with the calls still in flight.
 * Every call takes one, capped or not, so a cap set later counts it. `reason`: past one, it asks.
 */
export async function reserveAllowance(
  scope: Scope,
  input: {
    installationId: string
    action: PlaybookActionSpec
    args: unknown
    teammateId: string
    sessionId: string
  },
): Promise<{ held: Reservation } | { reason: string }> {
  const { installationId, action } = input
  return prisma.$transaction(async (tx) => {
    const lock = `playbook-allowance:${scope.workspaceId}:${installationId}:${action.key}`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`
    const row = await tx.playbookAction.findFirst({
      where: { ...scope, installationId, key: action.key },
      select: { limits: true },
    })
    const limits = storedLimits(row?.limits)
    if (!limits)
      return {
        reason: `${action.label}: what limits it on its own could not be read, so a person approves it.`,
      }
    // Every call on its own is in the ledger, capped or not, so a cap set later in the day
    // counts what was already done.
    if (capped(limits)) {
      const usage = await usageToday(tx, scope, installationId, action.key)
      const problem = capProblem(action.label, limits, usage, input.args)
      if (problem) return { reason: problem }
    }
    const entry = await tx.auditEntry.create({
      data: {
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        actorType: 'teammate',
        actorId: input.teammateId,
        action: RESERVED,
        ...allowanceTarget(installationId, action.key),
        data: {
          installationId,
          action: action.key,
          sessionId: input.sessionId,
          numbers: numbersOf(input.args),
        },
      },
      select: { id: true },
    })
    return { held: { id: String(entry.id), installationId, key: action.key } }
  })
}

/** The verdict on a write in a playbook's live run, from what its installation and run store. */
export async function playbookVerdict(
  db: ScopedDb,
  scope: Scope,
  input: {
    playbook: { installationId: string; runId: string; name: string; actions: PlaybookActionSpec[] }
    actionKey: string | null
    args: unknown
    /** The GitHub connection the call goes through, for a merge's checks. */
    github: () => Promise<GitHubFetch>
  },
): Promise<Verdict> {
  const { playbook } = input
  const action = input.actionKey
    ? playbook.actions.find((a) => a.key === input.actionKey)
    : undefined
  const [stored, run] = action
    ? await Promise.all([
        db.playbookAction.findFirst({
          where: { installationId: playbook.installationId, key: action.key },
          select: { level: true, conditions: true, limits: true },
        }),
        db.playbookRun.findFirst({ where: { id: playbook.runId }, select: { case: true } }),
      ])
    : [null, null]
  return verdict({
    playbook: playbook.name,
    action,
    stored,
    args: input.args,
    runCase: run?.case ?? null,
    usage: () => usageToday(prisma, scope, playbook.installationId, action!.key),
    checks: async () => {
      const repository = argumentOf(input.args, 'repository')
      const number = argumentOf(input.args, 'number')
      if (typeof repository !== 'string' || typeof number !== 'number')
        return { passed: false, why: 'the call names no pull request' }
      try {
        return await pullChecks(await input.github(), repository, number)
      } catch (error) {
        return {
          passed: false,
          why: `its checks could not be read (${error instanceof Error ? error.message : String(error)})`,
        }
      }
    },
  })
}

/**
 * playbook_triage: the run's case, once the teammate sorted the event and before its first
 * write, so a case's actions on their own apply. playbook_report may still change it.
 */
export async function triageRun(
  db: ScopedDb,
  scope: Scope,
  session: { id: string; playbookRunId: string | null },
  teammate: { id: string },
  op: Extract<ScheduleOperation, { name: 'playbook_triage' }>,
): Promise<{ error: string } | { recorded: { case: string }; note: string }> {
  if (!session.playbookRunId)
    return { error: 'This thread is not part of a playbook: there is no event to sort.' }
  await db.playbookRun.updateMany({
    where: { id: session.playbookRunId },
    data: { case: op.case },
  })
  await audit({
    ...scope,
    actor: { type: 'teammate', id: teammate.id },
    action: 'playbook.triaged',
    target: { type: 'playbook_run', id: session.playbookRunId },
    data: { case: op.case },
  })
  return {
    recorded: { case: op.case },
    note:
      'Recorded on the run: from now on its writes are judged by this case. Go on with the recipe; ' +
      'playbook_report may still change the case at the end.',
  }
}

// ---------------------------------------------------------------------------
// GitHub's checks, for a merge on its own
// ---------------------------------------------------------------------------

/** A fetch on GitHub's API with a connection's credential, taking full URLs (ConnectorContext's). */
export type GitHubFetch = (url: string, init?: RequestInit) => Promise<Response>

const repoPath = (repo: string) => `/repos/${repo.split('/').map(encodeURIComponent).join('/')}`

async function read<T>(fetch: GitHubFetch, path: string): Promise<T> {
  const response = await fetch(`${GITHUB_API}${path}`)
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}`)
  return (await response.json()) as T
}

/**
 * The checks a branch requires before a merge: its protection's and its rulesets'. Throws when
 * GitHub answers neither.
 */
export async function requiredChecks(fetch: GitHubFetch, repo: string, branch: string) {
  const name = encodeURIComponent(branch)
  const [protection, rules] = await Promise.allSettled([
    read<{
      protection?: {
        required_status_checks?: {
          enforcement_level?: string
          contexts?: string[]
          checks?: { context: string }[]
        }
      }
    }>(fetch, `${repoPath(repo)}/branches/${name}`),
    read<{ type: string; parameters?: { required_status_checks?: { context: string }[] } }[]>(
      fetch,
      `${repoPath(repo)}/rules/branches/${name}`,
    ),
  ])
  if (protection.status === 'rejected' && rules.status === 'rejected')
    throw protection.reason instanceof Error
      ? protection.reason
      : new Error(String(protection.reason))
  const required = new Set<string>()
  const checks =
    protection.status === 'fulfilled'
      ? protection.value.protection?.required_status_checks
      : undefined
  if (checks && checks.enforcement_level !== 'off')
    for (const context of [
      ...(checks.contexts ?? []),
      ...(checks.checks ?? []).map((c) => c.context),
    ])
      required.add(context)
  if (rules.status === 'fulfilled')
    for (const rule of rules.value)
      if (rule.type === 'required_status_checks')
        for (const check of rule.parameters?.required_status_checks ?? [])
          required.add(check.context)
  return [...required]
}

/** The checks a repository's default branch requires. Throws when they cannot be read. */
export async function defaultBranchChecks(fetch: GitHubFetch, repo: string) {
  const { default_branch: branch } = await read<{ default_branch: string }>(fetch, repoPath(repo))
  return { branch, required: await requiredChecks(fetch, repo, branch) }
}

const PASSED = new Set(['success', 'neutral', 'skipped'])

/**
 * Whether a pull request may merge on its own: its base branch requires checks, each of them
 * passed on its head, and no other check there is pending or failing. GitHub's own state must
 * not block it either. Without the GitHub App's Checks or Commit statuses permission, required
 * checks it cannot see count as passed only when GitHub calls the pull request clean, which it
 * does once every required check passed and none failed.
 */
export async function pullChecks(
  fetch: GitHubFetch,
  repo: string,
  number: number,
): Promise<Checks> {
  const pull = await read<{
    state: string
    head: { sha: string }
    base: { ref: string }
    mergeable_state?: string
  }>(fetch, `${repoPath(repo)}/pulls/${number}`)
  if (pull.state !== 'open') return { passed: false, why: `#${number} is not open` }
  const required = await requiredChecks(fetch, repo, pull.base.ref)
  if (!required.length)
    return {
      passed: false,
      why: `${pull.base.ref} requires no checks, so there is nothing to pass`,
    }
  const sha = pull.head.sha
  const [runs, statuses] = await Promise.all([
    read<{ check_runs: { name: string; status: string; conclusion: string | null }[] }>(
      fetch,
      `${repoPath(repo)}/commits/${sha}/check-runs?per_page=100`,
    ).catch(() => null),
    read<{ statuses: { context: string; state: string }[] }>(
      fetch,
      `${repoPath(repo)}/commits/${sha}/status`,
    ).catch(() => null),
  ])
  const checks = [
    ...(runs?.check_runs ?? []).map((r) => ({
      name: r.name,
      state:
        r.status !== 'completed'
          ? 'pending'
          : PASSED.has(r.conclusion ?? '')
            ? 'success'
            : 'failure',
    })),
    ...(statuses?.statuses ?? []).map((s) => ({
      name: s.context,
      state: s.state === 'success' ? 'success' : s.state === 'pending' ? 'pending' : 'failure',
    })),
  ]
  const names = (list: { name: string }[]) => list.map((c) => c.name).join(', ')
  const failing = checks.filter((c) => c.state === 'failure')
  if (failing.length) return { passed: false, why: `${names(failing)} failed` }
  const pending = checks.filter((c) => c.state === 'pending')
  if (pending.length) return { passed: false, why: `${names(pending)} still running` }
  const state = pull.mergeable_state ?? 'unknown'
  if (['blocked', 'dirty', 'behind', 'draft'].includes(state))
    return { passed: false, why: `GitHub says it is ${state}` }
  const missing = required.filter((name) => !checks.some((c) => c.name === name))
  const clean = state === 'clean' || state === 'has_hooks'
  if (missing.length && !(clean && (!runs || !statuses)))
    return { passed: false, why: `${missing.join(', ')} not reported yet` }
  return {
    passed: true,
    why: missing.length ? 'GitHub says every check passed' : `${required.join(', ')} passed`,
    sha,
  }
}

/** The workspace's GitHub, for a repository one of its connections reaches; null when none does. */
async function workspaceFetch(
  db: ScopedDb,
  scope: Scope,
  repo: string,
): Promise<GitHubFetch | null> {
  const found = await workspaceGitHub(db, scope, repo)
  if (!found) return null
  return async (url, init = {}) =>
    fetch(url, {
      ...init,
      headers: {
        ...githubHeaders,
        ...(init.headers as Record<string, string>),
        authorization: `Bearer ${await installationToken(found.installationId)}`,
      },
    })
}

/**
 * Why a merge may not be set to act on its own, or null: "checks pass" means something only on
 * a repository whose default branch requires checks. Refused too when they cannot be read.
 */
export async function mergeRefusal(fetch: GitHubFetch | null, repo: string | null) {
  if (!repo) return 'Its repository setting has no answer yet'
  if (!fetch)
    return `No GitHub connection of this workspace reaches ${repo}, so Brigade cannot read which checks it requires`
  try {
    const { branch, required } = await defaultBranchChecks(fetch, repo)
    return required.length
      ? null
      : `${repo} requires no status checks on ${branch}, so "checks pass" would mean nothing. Require at least one in its branch protection or rulesets on GitHub first`
  } catch (error) {
    return `Brigade could not read which checks ${repo} requires (${error instanceof Error ? error.message : String(error)}), so it cannot let it merge on its own`
  }
}

// ---------------------------------------------------------------------------
// Changing a level, and marking a call on its own as wrong
// ---------------------------------------------------------------------------

/** The arguments a template lets an installation cap on its own (its conditions other than these two). */
const argumentConditions = (action: PlaybookActionSpec) =>
  action.conditions.filter((c) => c !== 'case' && c !== 'checks_passed')

/**
 * Why a person may not set an action so, or null: the playbook's owner, an owner or an admin
 * changes a level, never above the template's ceiling, with only the conditions the template
 * allows; a merge on its own is an owner's or admin's call. Teammates have no way to.
 */
export function levelProblem(input: {
  action: PlaybookActionSpec
  update: UpdatePlaybookAction
  role: string
  /** The person owns the installation: it runs on their accounts. */
  owns: boolean
}): { status: 400 | 403; message: string } | null {
  const { action, update } = input
  const admin = isAdmin(input.role)
  if (!input.owns && !admin)
    return {
      status: 403,
      message:
        "This playbook runs on another member's accounts; only they or an owner or admin change what it does on its own",
    }
  if (!withinCeiling(update.level, action.ceiling))
    return {
      status: 400,
      message: `${action.label} goes no further than ${LEVEL_WORDS[action.ceiling]} in this playbook`,
    }
  if (needsChecks(action) && update.level === 'auto' && !admin)
    return { status: 403, message: 'Only an owner or admin can let it merge on its own' }
  const conditions = update.conditions
  if (conditions?.cases && !action.conditions.includes('case'))
    return { status: 400, message: `${action.label} cannot be limited to triage cases` }
  if (conditions?.checksPassed && !needsChecks(action))
    return { status: 400, message: `${action.label} has no checks to wait for` }
  const allowed = argumentConditions(action)
  const other = Object.keys(conditions?.max ?? {}).find((a) => !allowed.includes(a))
  if (other)
    return {
      status: 400,
      message: allowed.length
        ? `${action.label} can be limited by ${allowed.join(', ')}, not ${other}`
        : `${action.label} cannot be limited by ${other}`,
    }
  return null
}

/** The setting naming the repository it works in: `repo`, else its first repository setting. */
const repositoryOf = (manifest: PlaybookManifest, settings: Record<string, string | number>) => {
  const setting =
    manifest.settings.find((s) => s.key === 'repo' && s.type === 'repository') ??
    manifest.settings.find((s) => s.type === 'repository')
  const value = setting ? settings[setting.key] : undefined
  return typeof value === 'string' && value ? value : null
}

/** The open ticket proposing an action act on its own. */
const openPromotion = (db: ScopedDb, installationId: string, key: string) =>
  db.ticket.findFirst({
    where: {
      type: 'approval',
      status: 'open',
      AND: [
        { payload: { path: ['playbookPromotion', 'installationId'], equals: installationId } },
        { payload: { path: ['playbookPromotion', 'actionKey'], equals: key } },
      ],
    },
    select: { id: true },
  })

/** Off asking (on its own, or never), an open proposal to act on its own has no more point. */
async function closePromotion(db: ScopedDb, memberId: string, installationId: string, key: string) {
  const open = await openPromotion(db, installationId, key)
  if (open)
    await db.ticket.updateMany({
      where: { id: open.id, status: 'open' },
      data: { status: 'resolved', resolvedByMemberId: memberId, resolvedAt: new Date() },
    })
}

/**
 * PATCH /playbooks/:id/actions/:key: its level, and what limits it on its own. A merge on its own
 * always waits for its checks, and only on a repository that requires some.
 */
export async function changeAction(
  db: ScopedDb,
  scope: WorkspaceScope,
  id: string,
  key: string,
  update: UpdatePlaybookAction,
  github: (repo: string) => Promise<GitHubFetch | null> = (repo) => workspaceFetch(db, scope, repo),
) {
  const installation = await db.playbookInstallation.findFirst({
    where: { id },
    include: { actions: { where: { key } } },
  })
  if (!installation) throw new HTTPException(404, { message: 'Playbook not found' })
  const manifest = installation.manifest as PlaybookManifest
  const action = manifest.actions.find((a) => a.key === key)
  if (!action) throw new HTTPException(404, { message: `${manifest.name} has no action ${key}` })
  const row = installation.actions[0]
  if (!row)
    throw new HTTPException(409, {
      message: 'Its actions are made once every setting has an answer',
    })
  const problem = levelProblem({
    action,
    update,
    role: scope.role,
    owns: installation.ownerMemberId === scope.memberId,
  })
  if (problem) throw new HTTPException(problem.status, { message: problem.message })
  let conditions = update.conditions ?? storedConditions(row.conditions) ?? {}
  if (needsChecks(action) && update.level === 'auto') {
    conditions = { ...conditions, checksPassed: true }
    const repo = repositoryOf(manifest, installation.settings as Record<string, string | number>)
    const refusal = await mergeRefusal(repo ? await github(repo) : null, repo)
    if (refusal) throw new HTTPException(409, { message: refusal })
  }
  // Written under the actions' lock, from the rows as they are then: an update to a newer
  // version that landed since the checks above made them on another action than this one.
  const from = await withActionsLock(db, scope, id, async (tx) => {
    const fresh = await tx.playbookInstallation.findFirst({
      where: { id },
      include: { actions: { where: { key } } },
    })
    const now = fresh && (fresh.manifest as PlaybookManifest).actions.find((a) => a.key === key)
    const current = fresh?.actions[0]
    if (!now || !current || JSON.stringify(now) !== JSON.stringify(action))
      throw new HTTPException(409, {
        message: `${manifest.name} was just updated: look at ${action.label} again`,
      })
    conditions = update.conditions ?? storedConditions(current.conditions) ?? {}
    if (needsChecks(action) && update.level === 'auto')
      conditions = { ...conditions, checksPassed: true }
    const changed = current.level !== update.level
    await tx.playbookAction.updateMany({
      where: { id: current.id },
      data: {
        level: update.level,
        conditions: conditions as never,
        ...(update.limits ? { limits: update.limits as never } : {}),
        ...(changed
          ? {
              levelChangedAt: new Date(),
              levelChangedByMemberId: scope.memberId,
              demotedReason: null,
            }
          : {}),
      },
    })
    if (update.level !== 'ask') await closePromotion(tx, scope.memberId, id, key)
    return current.level
  })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'playbook.action_changed',
    target: { type: 'playbook', id },
    data: {
      action: key,
      from,
      to: update.level,
      conditions: conditions as never,
      ...(update.limits ? { limits: update.limits as never } : {}),
    },
  })
}

/**
 * The calls on their own a person marked as wrong, among these. Each mark is an audit entry: the
 * call log is append-only (spec hard constraint 6), so the call itself cannot carry the mark.
 */
async function flaggedCalls(db: ScopedDb, callIds: string[]) {
  if (!callIds.length) return new Set<string>()
  const marks = await db.auditEntry.findMany({
    where: {
      action: 'playbook.call_flagged',
      targetType: 'connection_call',
      targetId: { in: callIds },
    },
    select: { targetId: true },
  })
  return new Set(marks.map((m) => m.targetId))
}

/**
 * POST /playbooks/:id/calls/:callId/flag: a person marks a call it made on its own as wrong. Its
 * action goes back to asking (one set to never stays there), until a person lets it again.
 */
export async function flagCall(db: ScopedDb, scope: WorkspaceScope, id: string, callId: string) {
  const installation = await db.playbookInstallation.findFirst({ where: { id } })
  if (!installation) throw new HTTPException(404, { message: 'Playbook not found' })
  if (installation.ownerMemberId !== scope.memberId && !isAdmin(scope.role))
    throw new HTTPException(403, {
      message:
        "This playbook runs on another member's accounts; only they or an owner or admin mark what it did",
    })
  const call = await db.connectionCall.findFirst({
    where: { id: callId, ...autoWhere(id) },
    select: { id: true, playbookActionKey: true },
  })
  if (!call)
    throw new HTTPException(404, { message: 'This playbook made no call on its own with that id' })
  if ((await flaggedCalls(db, [call.id])).size) return
  const now = new Date()
  const demoted = await withActionsLock(db, scope, id, (tx) =>
    tx.playbookAction.updateMany({
      where: { installationId: id, key: call.playbookActionKey!, level: 'auto' },
      data: {
        level: 'ask',
        demotedReason: 'flagged',
        levelChangedAt: now,
        levelChangedByMemberId: scope.memberId,
      },
    }),
  )
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'playbook.call_flagged',
    target: { type: 'connection_call', id: call.id },
    data: { installationId: id, action: call.playbookActionKey!, demoted: demoted.count > 0 },
  })
}

// ---------------------------------------------------------------------------
// Measured trust, and proposing to act on its own
// ---------------------------------------------------------------------------

/** A decision a person made on one of an action's approvals. */
export type Decision = { approved: boolean; at: Date; bulk: boolean }

/** Those that count toward trust: approving several at once may be done without reading. */
export const counted = (decisions: Decision[]) => decisions.filter((d) => !d.bulk)

/**
 * The latest `n` counted decisions people made on an action's approvals, newest first; after
 * `since` only, when given. Read a batch at a time, as decisions in bulk do not count.
 */
export async function latestDecisions(
  db: ScopedDb,
  installationId: string,
  key: string,
  n: number,
  since?: Date | null,
) {
  const found: Decision[] = []
  const batch = Math.max(n * 2, 50)
  for (let skip = 0; found.length < n; skip += batch) {
    const rows = await db.ticket.findMany({
      where: {
        type: 'approval',
        status: { in: ['approved', 'denied'] },
        ...(since ? { resolvedAt: { gt: since } } : {}),
        AND: [
          { payload: { path: ['playbookInstallationId'], equals: installationId } },
          { payload: { path: ['playbookActionKey'], equals: key } },
        ],
      },
      orderBy: [{ resolvedAt: 'desc' }, { id: 'desc' }],
      skip,
      take: batch,
      select: { status: true, resolvedAt: true, createdAt: true, payload: true },
    })
    found.push(
      ...counted(
        rows.map((r) => ({
          approved: r.status === 'approved',
          at: r.resolvedAt ?? r.createdAt,
          bulk: (r.payload as { decidedInBulk?: unknown } | null)?.decidedInBulk === true,
        })),
      ),
    )
    if (rows.length < batch) break
  }
  return found.slice(0, n)
}

/**
 * Whether to propose an action act on its own, with the numbers: it asks today, its ceiling
 * allows on its own, it is not a merge (Brigade never proposes that), no proposal is open, and
 * the latest window of counted decisions since `since` (a refusal, or a person lowering it)
 * reaches the template's rate.
 */
export function promotionDue(input: {
  action: PlaybookActionSpec
  level: PlaybookLevel
  promotion: { decisions: number; approvedRate: number }
  /** Newest first. */
  decisions: Decision[]
  since: Date | null
  open: boolean
}): { approved: number; decided: number } | null {
  const { action, promotion } = input
  if (input.open || input.level !== 'ask') return null
  if (!withinCeiling('auto', action.ceiling) || needsChecks(action)) return null
  const window = counted(input.decisions)
    .filter((d) => !input.since || d.at > input.since)
    .slice(0, promotion.decisions)
  if (window.length < promotion.decisions) return null
  const approved = window.filter((d) => d.approved).length
  return approved / window.length >= promotion.approvedRate - 1e-9
    ? { approved, decided: window.length }
    : null
}

/**
 * Since when an action's decisions count toward a proposal: after a person refused the last
 * one, or lowered its level (a call marked as wrong, a level set back), a whole new window.
 */
async function promotionSince(
  db: ScopedDb,
  installationId: string,
  key: string,
  levelChangedAt: Date | null,
) {
  const refused = await db.ticket.findFirst({
    where: {
      type: 'approval',
      status: 'denied',
      AND: [
        { payload: { path: ['playbookPromotion', 'installationId'], equals: installationId } },
        { payload: { path: ['playbookPromotion', 'actionKey'], equals: key } },
      ],
    },
    orderBy: { resolvedAt: 'desc' },
    select: { resolvedAt: true },
  })
  const times = [refused?.resolvedAt, levelChangedAt].filter((t): t is Date => !!t)
  return times.length ? new Date(Math.max(...times.map((t) => t.getTime()))) : null
}

/**
 * After a person decided one of a playbook's approvals: when its action's latest decisions earn
 * it, one ticket proposes to its owner (an owner or admin may decide too) to let it act on its
 * own. In the thread of the decision, whose starter is the playbook's owner. Returns its id.
 */
export async function proposePromotion(
  db: ScopedDb,
  scope: Scope,
  input: { installationId: string; actionKey: string; sessionId: string | null },
) {
  // Under the actions' lock: never a proposal for what an update just changed.
  const made = await withActionsLock(db, scope, input.installationId, (tx) =>
    promotionTicket(tx, input),
  )
  if (!made) return null
  await audit({
    ...scope,
    actor: { type: 'system', id: 'brigade' },
    action: 'playbook.promotion_proposed',
    target: { type: 'playbook', id: input.installationId },
    data: {
      action: input.actionKey,
      approved: made.approved,
      decided: made.decided,
      ticketId: made.ticketId,
    },
  })
  return made.ticketId
}

async function promotionTicket(
  db: ScopedDb,
  input: { installationId: string; actionKey: string; sessionId: string | null },
) {
  const installation = await db.playbookInstallation.findFirst({
    where: { id: input.installationId },
    include: {
      actions: { where: { key: input.actionKey } },
      teammate: { select: { name: true } },
    },
  })
  const row = installation?.actions[0]
  if (!installation || !row || row.level !== 'ask') return null
  const manifest = installation.manifest as PlaybookManifest
  const action = manifest.actions.find((a) => a.key === input.actionKey)
  if (!action || !withinCeiling('auto', action.ceiling) || needsChecks(action)) return null
  if (await openPromotion(db, installation.id, action.key)) return null
  const since = await promotionSince(db, installation.id, action.key, row.levelChangedAt)
  const due = promotionDue({
    action,
    level: row.level,
    promotion: manifest.promotion,
    decisions: await latestDecisions(
      db,
      installation.id,
      action.key,
      manifest.promotion.decisions,
      since,
    ),
    since,
    open: false,
  })
  if (!due) return null
  const promotion: PlaybookPromotionPayload = {
    installationId: installation.id,
    actionKey: action.key,
    approved: due.approved,
    decided: due.decided,
    label: action.label,
    playbook: manifest.name,
    ownerMemberId: installation.ownerMemberId,
  }
  const ticket = await db.ticket.create({
    data: {
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      type: 'approval',
      title: `${manifest.name}: let ${installation.teammate.name} ${inSentence(action.label)} on its own?`,
      payload: {
        playbookPromotion: promotion,
        reason:
          `People approved ${due.approved} of its last ${due.decided} requests to ${inSentence(action.label)}. ` +
          'On its own, it no longer asks first, and what it does shows on the playbook’s page, where marking ' +
          'one as wrong sends it back to asking.',
      },
    } as never,
  })
  return { ticketId: ticket.id, approved: due.approved, decided: due.decided }
}

/**
 * After a ticket was decided: a person's decision on a playbook run's approval may earn its
 * action a proposal to act on its own. Never throws: the decision stands either way.
 */
export async function afterPlaybookDecision(
  db: ScopedDb,
  scope: Scope,
  ticket: { type: string; sessionId: string | null; payload: unknown },
) {
  const payload = (ticket.payload ?? {}) as {
    playbookInstallationId?: unknown
    playbookActionKey?: unknown
  }
  if (
    ticket.type !== 'approval' ||
    typeof payload.playbookInstallationId !== 'string' ||
    typeof payload.playbookActionKey !== 'string'
  )
    return
  await proposePromotion(db, scope, {
    installationId: payload.playbookInstallationId,
    actionKey: payload.playbookActionKey,
    sessionId: ticket.sessionId,
  }).catch((error) => console.warn(`playbook promotion check failed: ${String(error)}`))
}

/**
 * The owner's (or an owner's or admin's) answer to a proposal: approving lets the action act on
 * its own from the next call. A refusal waits a whole new window before the next proposal.
 */
export async function decidePromotion(
  db: ScopedDb,
  scope: WorkspaceScope,
  ticket: { id: string; payload: unknown },
  approved: boolean,
) {
  const { playbookPromotion: promotion } = ticket.payload as {
    playbookPromotion: PlaybookPromotionPayload
  }
  const close = (status: 'approved' | 'denied' | 'resolved', client: ScopedDb = db) =>
    client.ticket.updateMany({
      where: { id: ticket.id, status: 'open' },
      data: { status, resolvedByMemberId: scope.memberId, resolvedAt: new Date() },
    })
  const installation = await db.playbookInstallation.findFirst({
    where: { id: promotion.installationId },
    include: { actions: { where: { key: promotion.actionKey } } },
  })
  if (!installation) {
    await close('resolved')
    throw new HTTPException(404, { message: 'This playbook was uninstalled' })
  }
  if (installation.ownerMemberId !== scope.memberId && !isAdmin(scope.role))
    throw new HTTPException(403, {
      message: "Only the playbook's owner, or an owner or admin, decides what it does on its own",
    })
  // Under the actions' lock, from the rows as they are then: an update that changed the action
  // since closed this proposal, and a closed one decides nothing.
  const outcome = await withActionsLock(db, scope, installation.id, async (tx) => {
    const fresh = await tx.playbookInstallation.findFirst({
      where: { id: installation.id },
      include: { actions: { where: { key: promotion.actionKey } } },
    })
    const action = (fresh?.manifest as PlaybookManifest | undefined)?.actions.find(
      (a) => a.key === promotion.actionKey,
    )
    const current = fresh?.actions[0]
    if (
      approved &&
      (!action || !current || !withinCeiling('auto', action.ceiling) || needsChecks(action))
    ) {
      await close('resolved', tx)
      return { stale: true as const, from: current?.level ?? null }
    }
    const claimed = await close(approved ? 'approved' : 'denied', tx)
    if (!claimed.count) return { closed: true as const, from: current?.level ?? null }
    if (approved)
      await tx.playbookAction.updateMany({
        where: { id: current!.id },
        data: {
          level: 'auto',
          demotedReason: null,
          levelChangedAt: new Date(),
          levelChangedByMemberId: scope.memberId,
        },
      })
    return { from: current?.level ?? null }
  })
  if ('stale' in outcome)
    throw new HTTPException(409, {
      message: `${promotion.label} can no longer act on its own in this playbook`,
    })
  if ('closed' in outcome)
    throw new HTTPException(409, { message: 'This proposal was already closed' })
  const row = { level: outcome.from }
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: approved ? 'playbook.promotion_approved' : 'playbook.promotion_denied',
    target: { type: 'playbook', id: installation.id },
    data: { action: promotion.actionKey, ticketId: ticket.id, from: row.level },
  })
}

// ---------------------------------------------------------------------------
// The sheet's view
// ---------------------------------------------------------------------------

/**
 * Its actions as the sheet shows them: level, limits, people's decisions over the promotion
 * window (bulk left out), calls on their own, and whether the viewer may change them.
 */
export async function actionViews(
  db: ScopedDb,
  installation: {
    id: string
    ownerMemberId: string
    manifest: unknown
    actions: {
      key: string
      level: PlaybookLevel
      conditions: unknown
      limits: unknown
      demotedReason: string | null
    }[]
  },
  viewer?: { memberId: string; role: string },
): Promise<PlaybookActionView[]> {
  const manifest = installation.manifest as PlaybookManifest
  const window = manifest.promotion.decisions
  const day = new Date(Date.now() - DAY_MS)
  const countAuto = (since?: Date) =>
    db.connectionCall.groupBy({
      by: ['playbookActionKey'],
      where: { ...autoWhere(installation.id), ...(since ? { createdAt: { gte: since } } : {}) },
      _count: { _all: true },
    })
  const [all, today, promotions, decisions] = await Promise.all([
    countAuto(),
    countAuto(day),
    db.ticket.findMany({
      where: {
        type: 'approval',
        status: 'open',
        payload: { path: ['playbookPromotion', 'installationId'], equals: installation.id },
      },
      select: { id: true, payload: true },
    }),
    Promise.all(manifest.actions.map((a) => latestDecisions(db, installation.id, a.key, window))),
  ])
  const autoOf = (rows: typeof all, key: string) =>
    rows.find((r) => r.playbookActionKey === key)?._count._all ?? 0
  const canChange =
    !!viewer && (viewer.memberId === installation.ownerMemberId || isAdmin(viewer.role))
  return manifest.actions.map(({ conditions: templateConditions, ...a }, i) => {
    const row = installation.actions.find((r) => r.key === a.key)
    const mine = decisions[i]!
    return {
      ...a,
      templateConditions,
      level: row?.level ?? a.start,
      conditions: storedConditions(row?.conditions) ?? {},
      limits: storedLimits(row?.limits) ?? {},
      approved: mine.filter((d) => d.approved).length,
      denied: mine.filter((d) => !d.approved).length,
      window,
      auto: autoOf(all, a.key),
      autoToday: autoOf(today, a.key),
      demotedReason: row?.demotedReason ?? null,
      promotionTicketId:
        promotions.find(
          (t) =>
            (t.payload as { playbookPromotion?: { actionKey?: string } }).playbookPromotion
              ?.actionKey === a.key,
        )?.id ?? null,
      needsChecks: needsChecks({ conditions: templateConditions }),
      canChange,
    }
  })
}

/** Its latest calls on its own, newest first, for the sheet to mark one as wrong. */
export async function recentAutoCalls(
  db: ScopedDb,
  installationId: string,
  manifest: PlaybookManifest,
  take = 10,
): Promise<PlaybookAutoCallView[]> {
  const calls = await db.connectionCall.findMany({
    where: autoWhere(installationId),
    orderBy: { createdAt: 'desc' },
    take,
    select: { id: true, playbookActionKey: true, target: true, createdAt: true, sessionId: true },
  })
  const flagged = await flaggedCalls(
    db,
    calls.map((c) => c.id),
  )
  return calls.map((c) => ({
    id: c.id,
    actionKey: c.playbookActionKey!,
    action:
      manifest.actions.find((a) => a.key === c.playbookActionKey)?.label ?? c.playbookActionKey!,
    target: c.target,
    at: c.createdAt.toISOString(),
    threadId: c.sessionId,
    flagged: flagged.has(c.id),
  }))
}
