// The checks behind operators' alerts (docs/monitoring.md), run each minute in the API's jobs
// (src/jobs.ts): failures counted as they happen (src/ops/failures.ts), cloud computers as the
// database and the hub see them, Stripe's webhook endpoint, and the Workers' failed
// invocations as Cloudflare counts them.
import { billingEnabled, cloudEntitled, stripeClient } from '../billing.js'
import { env } from '../config.js'
import { prisma } from '../db.js'
import { hubs } from '../hub.js'
import { raise, resolve, settle, type Alert } from './alerts.js'
import { failuresOf, summary, type Failure } from './failures.js'

const MINUTE = 60_000

/**
 * A kind of failure and when it is a problem: `warning` of them (or `critical`) within
 * `windowMs`; over once none came for `quietMs`.
 */
export type Rule = {
  kind: string
  title: string
  windowMs: number
  warning: number
  critical: number
  quietMs: number
  /** Also needs failures in this many workspaces: one workspace's own trouble is not Brigade's. */
  workspaces?: number
  hint?: string
}

export const RULES: Rule[] = [
  {
    kind: 'api',
    title: 'API requests failing (500)',
    windowMs: 5 * MINUTE,
    warning: 10,
    critical: 50,
    quietMs: 15 * MINUTE,
  },
  {
    kind: 'stripe-webhook',
    title: 'Stripe webhook events not reconciled',
    windowMs: 30 * MINUTE,
    warning: 1,
    critical: 5,
    quietMs: 60 * MINUTE,
    hint: 'Stripe sends them again; the plans of the workspaces involved may be out of date until then.',
  },
  {
    kind: 'stripe-signature',
    title: "Stripe webhook signatures don't match",
    windowMs: 60 * MINUTE,
    warning: 3,
    critical: 10,
    quietMs: 2 * 60 * MINUTE,
    hint: "Check that brigade-api's STRIPE_WEBHOOK_SECRET is the endpoint's signing secret.",
  },
  {
    kind: 'resend-webhook',
    title: "Resend webhook events failing (Brigade's email)",
    windowMs: 30 * MINUTE,
    warning: 3,
    critical: 20,
    quietMs: 60 * MINUTE,
  },
  {
    kind: 'trigger-webhook',
    title: "Triggers' webhooks failing (events not starting threads)",
    windowMs: 30 * MINUTE,
    warning: 5,
    critical: 30,
    quietMs: 60 * MINUTE,
  },
  {
    kind: 'turn',
    title: "Teammates' turns failing in several workspaces",
    windowMs: 15 * MINUTE,
    warning: 6,
    critical: 25,
    workspaces: 2,
    quietMs: 30 * MINUTE,
    hint: 'Failing in several workspaces at once points at Brigade or a provider, not one member’s account.',
  },
  {
    kind: 'runner-silent',
    title: "Cloud computers' runners going silent",
    windowMs: 15 * MINUTE,
    warning: 3,
    critical: 10,
    quietMs: 30 * MINUTE,
    hint: 'Runners that stop sending heartbeats without closing their connection: computers crashing, or the network.',
  },
  {
    kind: 'runner-reconnects',
    title: 'Runners reconnecting again and again',
    windowMs: 15 * MINUTE,
    warning: 1,
    critical: 5,
    quietMs: 30 * MINUTE,
    hint: 'A computer opening its connection many times a minute: the API, or its hub, dropping it each time it connects (docs/workspace-hubs-plan.md).',
  },
  {
    kind: 'runner-outbox',
    title: 'Commands refused: too many waiting for a computer',
    windowMs: 30 * MINUTE,
    warning: 1,
    critical: 20,
    quietMs: 60 * MINUTE,
    hint: 'A computer that stays down while messages keep coming for it (src/runner-commands.ts): find out why it does not start.',
  },
  {
    kind: 'api-reset',
    title: 'API restarting without a deploy',
    windowMs: 30 * MINUTE,
    warning: 1,
    critical: 3,
    quietMs: 60 * MINUTE,
    hint: 'The Api object restarted with the same version of the Worker: past its memory, most likely. Every socket dropped with it.',
  },
  {
    kind: 'runner-restart',
    title: "Cloud computers' runners not back after an update's restart",
    windowMs: 60 * MINUTE,
    warning: 1,
    critical: 5,
    quietMs: 2 * 60 * MINUTE,
  },
]

/** Background jobs: each failing again and again is a problem of its own. */
export const JOB_RULE: Omit<Rule, 'kind' | 'title'> = {
  windowMs: 15 * MINUTE,
  warning: 3,
  critical: 10,
  quietMs: 30 * MINUTE,
}

/** The hourly sweeps: failing twice in a row. */
export const SWEEP_RULE: Omit<Rule, 'kind' | 'title'> = {
  windowMs: 3 * 60 * MINUTE,
  warning: 2,
  critical: 3,
  quietMs: 3 * 60 * MINUTE,
}

/** What a rule makes of the failures it sees: an alert, its end, or nothing new. */
export function judge(
  rule: Rule,
  failures: Failure[],
  now: number,
  /** Since when failures have been counted: a restart forgets them, which is not their end. */
  countingSince = 0,
): { alert: Alert } | 'resolve' | 'keep' {
  const recent = failures.filter((f) => now - f.at < rule.windowMs)
  const spread = new Set(recent.map((f) => f.workspaceId).filter(Boolean)).size
  const enough = !rule.workspaces || spread >= rule.workspaces
  if (enough && recent.length >= rule.warning) {
    const minutes = Math.round(rule.windowMs / MINUTE)
    const where = rule.workspaces ? ` in ${spread} workspaces` : ''
    return {
      alert: {
        key: rule.kind,
        severity: recent.length >= rule.critical ? 'critical' : 'warning',
        title: rule.title,
        detail: [
          `${recent.length} in the last ${minutes} min${where}.`,
          summary(recent),
          rule.hint ?? '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    }
  }
  if (now - countingSince >= rule.quietMs && !failures.some((f) => now - f.at < rule.quietMs))
    return 'resolve'
  return 'keep'
}

async function checkFailures(now: number) {
  const rules: Rule[] = [...RULES]
  // Each job seen failing lately, and each still alerted on.
  const jobs = new Set(failuresOf('job:', 3 * 60 * MINUTE, now).map((f) => f.kind))
  const open = await prisma.opsAlert.findMany({
    where: { key: { startsWith: 'job:' }, resolvedAt: null },
    select: { key: true },
  })
  for (const { key } of open) jobs.add(key)
  for (const kind of jobs)
    rules.push({
      kind,
      title: `Background job ${kind.slice(4)} failing`,
      ...(kind.endsWith('-sweep') ? SWEEP_RULE : JOB_RULE),
    })
  for (const rule of rules) {
    const seen = failuresOf(rule.kind, Math.max(rule.windowMs, rule.quietMs), now)
    const verdict = judge(rule, seen, now, countingSince)
    if (verdict === 'resolve') await resolve(rule.kind, new Date(now))
    else if (verdict !== 'keep') await raise(verdict.alert, new Date(now))
  }
}

/** A cloud computer still creating or starting after this long is stuck. */
export const STUCK_MS = 20 * MINUTE
/** A cloud computer marked running whose runner stays away this long is down. */
export const OFFLINE_MS = 10 * MINUTE

/** Since when each running cloud computer has had no runner connected. */
const offlineSince = new Map<string, number>()

type CloudComputer = {
  id: string
  name: string
  status: string
  updatedAt: Date
  workspace: { name: string }
}

/** What is wrong with a cloud computer now, if anything. */
export function computerProblem(
  computer: CloudComputer,
  online: boolean,
  offlineFor: number,
  now: number,
): Alert | null {
  const which = `${computer.name} (${computer.workspace.name}, ${computer.id})`
  if (computer.status === 'error')
    return {
      key: `computer:${computer.id}`,
      severity: 'critical',
      title: `Cloud computer down: ${which}`,
      detail:
        'Its provider failed to create, start or wake it (the API logs say why). It starts again when someone sends it a message.',
    }
  if (
    (computer.status === 'creating' || computer.status === 'starting') &&
    !online &&
    now - computer.updatedAt.getTime() >= STUCK_MS
  )
    return {
      key: `computer:${computer.id}`,
      severity: 'critical',
      title: `Cloud computer stuck ${computer.status}: ${which}`,
      detail: `${computer.status} for ${Math.round((now - computer.updatedAt.getTime()) / MINUTE)} min, and its runner never connected.`,
    }
  if (computer.status === 'running' && !online && offlineFor >= OFFLINE_MS)
    return {
      key: `computer:${computer.id}`,
      severity: 'warning',
      title: `Cloud computer's runner not connected: ${which}`,
      detail: `Marked running, with no runner connected for ${Math.round(offlineFor / MINUTE)} min.`,
    }
  return null
}

async function checkComputers(now: number) {
  const computers = await prisma.computer.findMany({
    where: { kind: 'cloud', status: { in: ['creating', 'starting', 'running', 'error'] } },
    select: {
      id: true,
      name: true,
      status: true,
      updatedAt: true,
      workspaceId: true,
      workspace: { select: { name: true } },
    },
  })
  const found: Alert[] = []
  const seen = new Set<string>()
  for (const computer of computers) {
    seen.add(computer.id)
    const online = await hubs.get(computer.workspaceId).isOnline(computer.id)
    if (online || computer.status !== 'running') offlineSince.delete(computer.id)
    else if (!offlineSince.has(computer.id)) offlineSince.set(computer.id, now)
    const problem = computerProblem(
      computer,
      online,
      now - (offlineSince.get(computer.id) ?? now),
      now,
    )
    // Without a plan it is meant to be off (src/cloud.ts's enforcePlans): not a problem.
    if (problem && (!billingEnabled() || (await cloudEntitled(computer.workspaceId))))
      found.push(problem)
  }
  for (const id of offlineSince.keys()) if (!seen.has(id)) offlineSince.delete(id)
  await settle('computer:', found, new Date(now))

  const full = await prisma.ticket.findMany({
    where: { type: 'disk_full', status: 'open' },
    select: { workspaceId: true, payload: true, createdAt: true },
  })
  await settle(
    'disk:',
    full.map((t) => {
      const computerId = (t.payload as { computerId?: string } | null)?.computerId ?? t.workspaceId
      return {
        key: `disk:${computerId}`,
        severity: 'warning' as const,
        title: `Cloud computer's disk full: ${computerId}`,
        detail: `A disk_full ticket has been open since ${t.createdAt.toISOString().slice(0, 16)}Z. The runner should prevent this on its own: find out why it did not.`,
      }
    }),
    new Date(now),
  )
}

/** Brigade's endpoint at Stripe: there, and not disabled by Stripe after days of failures. */
async function checkStripeEndpoint(now: number) {
  if (!stripeClient || !env.STRIPE_WEBHOOK_SECRET) return
  const url = `${env.API_URL.replace(/\/+$/, '')}/api/billing/webhook`
  let endpoints
  try {
    endpoints = await stripeClient.webhookEndpoints.list({ limit: 100 })
  } catch (error) {
    // A restricted key without the Webhook Endpoints read permission: nothing to check.
    const status = (error as { statusCode?: number }).statusCode
    if (status === 401 || status === 403) return
    throw error
  }
  const ours = endpoints.data.find((e) => e.url === url)
  if (ours?.status === 'enabled') return resolve('stripe-endpoint', new Date(now))
  await raise(
    {
      key: 'stripe-endpoint',
      severity: 'critical',
      title: ours
        ? "Stripe disabled Brigade's billing webhook"
        : "Brigade's billing webhook is missing at Stripe",
      detail: `${url}: ${ours ? `status ${ours.status}` : 'no such endpoint'}. Subscriptions change in Stripe without Brigade hearing of it.`,
    },
    new Date(now),
  )
}

/** Invocation outcomes that are not the Worker's fault. */
const FINE = ['success', 'clientDisconnected', 'responseStreamDisconnected']
const CF_WINDOW_MS = 10 * MINUTE
export const CF_WARNING = 5
export const CF_CRITICAL = 50

type Outcome = { sum: { requests: number }; dimensions: { scriptName: string; status: string } }

/** The Workers' (and their Durable Objects') failed invocations, as alerts by Worker. */
export function workerProblems(rows: Outcome[]): Alert[] {
  const byScript = new Map<string, Map<string, number>>()
  for (const { sum, dimensions } of rows) {
    const statuses = byScript.get(dimensions.scriptName) ?? new Map<string, number>()
    statuses.set(dimensions.status, (statuses.get(dimensions.status) ?? 0) + sum.requests)
    byScript.set(dimensions.scriptName, statuses)
  }
  const alerts: Alert[] = []
  for (const [script, statuses] of byScript) {
    const total = [...statuses.values()].reduce((a, b) => a + b, 0)
    if (total < CF_WARNING) continue
    alerts.push({
      key: `worker:${script}`,
      severity: total >= CF_CRITICAL ? 'critical' : 'warning',
      title: `Worker ${script} failing`,
      detail: `${total} failed invocations in the last ${CF_WINDOW_MS / MINUTE} min: ${[...statuses]
        .map(([status, n]) => `${n} ${status}`)
        .join(', ')}. Workers & Pages › ${script} › Logs in Cloudflare says why.`,
    })
  }
  return alerts
}

async function checkWorkers(now: number) {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) return
  const filter = `{datetime_geq: $since, datetime_leq: $until, scriptName_like: "brigade%", status_notin: ${JSON.stringify(FINE)}}`
  const query = `query ($account: String!, $since: Time!, $until: Time!) {
    viewer { accounts(filter: {accountTag: $account}) {
      workers: workersInvocationsAdaptive(limit: 200, filter: ${filter}) { sum { requests } dimensions { scriptName status } }
      objects: durableObjectsInvocationsAdaptiveGroups(limit: 200, filter: ${filter}) { sum { requests } dimensions { scriptName status } }
    } }
  }`
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables: {
        account: env.CLOUDFLARE_ACCOUNT_ID,
        since: new Date(now - CF_WINDOW_MS).toISOString(),
        until: new Date(now).toISOString(),
      },
    }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = (await response.json()) as {
    data?: { viewer: { accounts: { workers: Outcome[]; objects: Outcome[] }[] } }
    errors?: { message: string }[] | null
  }
  if (!response.ok || body.errors?.length || !body.data)
    throw new Error(
      `Cloudflare analytics ${response.status}: ${body.errors?.map((e) => e.message).join('; ') ?? ''}`,
    )
  const account = body.data.viewer.accounts[0]
  await settle(
    'worker:',
    workerProblems([...(account?.workers ?? []), ...(account?.objects ?? [])]),
    new Date(now),
  )
}

/**
 * When the checks that need the database last succeeded, and why they failed since: the
 * Worker's cron (src/worker.ts) alerts when they stop. One that cannot reach the database
 * cannot alert either, so it counts as stopped.
 */
export let lastChecksAt = 0
export let lastCheckError: string | null = null

let runs = 0
let running = false
/** When the checks started: a restart of the API forgets the failures counted before. */
let countingSince = 0

/** Each check on its own: one that fails is logged, and the others still run. */
export async function runChecks(now = Date.now()) {
  if (running) return
  running = true
  try {
    // The first two need only the database; the others, Cloudflare's and Stripe's APIs too.
    const steps: [string, () => Promise<unknown>][] = [
      ['failures', () => checkFailures(now)],
      ['computers', () => checkComputers(now)],
    ]
    let failed: string | null = null
    if (runs % 5 === 0) steps.push(['workers', () => checkWorkers(now)])
    if (runs % 30 === 0) steps.push(['stripe endpoint', () => checkStripeEndpoint(now)])
    runs++
    for (const [i, [name, step]] of steps.entries())
      await step().catch((error: unknown) => {
        console.error(`ops: ${name} check failed: ${String(error)}`)
        if (i < 2) failed ??= `${name} check: ${String(error).slice(0, 300)}`
      })
    lastCheckError = failed
    if (!failed) lastChecksAt = Date.now()
  } finally {
    running = false
  }
}

/** Every minute, from the API's jobs (src/jobs.ts). */
export const watchOps = () => {
  countingSince = Date.now()
  setTimeout(() => void runChecks(), 30_000)
  setInterval(() => void runChecks(), MINUTE)
}
