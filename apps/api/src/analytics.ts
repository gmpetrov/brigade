// Product analytics (docs/analytics.md): events to PostHog's capture API, from the API rather
// than browsers, which block trackers. Off without POSTHOG_KEY (locally, in tests, previews
// and self-hosted Brigades). Never any content: ids, counts and closed lists only
// (src/analytics-events.ts), and no email address, even of the person.
//
// Nothing here waits on PostHog or throws into a request: events are queued, sent together a
// moment later in one request, and a failure is only logged. On Cloudflare the API runs in
// Durable Objects, which stay up to send them; a run in the Worker's own isolate waits for
// them before it ends (flushAnalytics, src/worker.ts).
import { getOAuthState } from 'better-auth/api'
import {
  emissionsOf,
  FIRST_EVENTS,
  safeProps,
  type AnalyticsProps,
  type AuditInput,
} from './analytics-events.js'
import { env } from './config.js'
import { onScopedWrite, prisma, Prisma } from './db.js'
import { parseSignupSource, signupProperties } from './signup-source.js'

export type { AnalyticsProps } from './analytics-events.js'

export const analyticsOn = () => Boolean(env.POSTHOG_KEY)

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

type Message = { event: string; distinct_id: string; timestamp: string; properties: object }

const queue: Message[] = []
let scheduled = false
/** Sends and lookups under way, which flushAnalytics waits for. */
const underWay = new Set<Promise<unknown>>()

/** At most this many events in one request. */
const BATCH = 100

function send() {
  if (queue.length === 0) return
  const batch = queue.splice(0, BATCH)
  if (queue.length) send()
  background(
    fetch(`${env.POSTHOG_HOST.replace(/\/+$/, '')}/batch/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: env.POSTHOG_KEY, batch }),
      signal: AbortSignal.timeout(10_000),
    }).then((response) => {
      if (!response.ok) console.warn(`analytics: PostHog answered ${response.status}`)
    }),
  )
}

/** Work that no request waits for: kept until done, its failure only logged. */
function background(work: Promise<unknown>) {
  const kept = work
    .catch((error: unknown) => console.warn(`analytics: ${String(error)}`))
    .finally(() => underWay.delete(kept))
  underWay.add(kept)
}

/** Everything queued, sent now; resolves once all of it is done. */
export async function flushAnalytics() {
  while (underWay.size || queue.length) {
    send()
    await Promise.allSettled([...underWay])
  }
}

export type TrackInput = {
  /** The person's user id, or `workspace:<id>` for an event of no one's. */
  distinctId: string
  workspaceId?: string | null
  organizationId?: string | null
  properties?: AnalyticsProps
  /** Person properties, set each time. */
  set?: AnalyticsProps
  /** Person properties set by the first event that has them, never changed after. */
  setOnce?: AnalyticsProps
  /** No person behind it: PostHog makes no profile for its distinct id. */
  personless?: boolean
}

/** Queue one event. A no-op without POSTHOG_KEY. */
export function track(event: string, input: TrackInput) {
  if (!analyticsOn()) return
  queue.push({
    event,
    distinct_id: input.distinctId,
    timestamp: new Date().toISOString(),
    properties: {
      ...safeProps(input.properties ?? {}),
      ...(input.workspaceId && { $groups: { workspace: input.workspaceId } }),
      ...(input.organizationId && { organization_id: input.organizationId }),
      ...(input.set && { $set: input.set }),
      ...(input.setOnce && { $set_once: input.setOnce }),
      ...(input.personless && { $process_person_profile: false }),
      $lib: 'brigade-api',
    },
  })
  if (queue.length >= BATCH) return send()
  if (scheduled) return
  scheduled = true
  setTimeout(() => {
    scheduled = false
    send()
  }, 0)
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** Whom an event is of: a user, or nobody (a workspace's own work). */
export type Person = { userId: string; internal: boolean }

/** Whether an address is one of Brigade's own people (POSTHOG_INTERNAL_EMAIL_DOMAINS). */
export function isInternalEmail(email: string, domains = env.POSTHOG_INTERNAL_EMAIL_DOMAINS) {
  const domain = email.split('@').pop()?.toLowerCase() ?? ''
  return domains.some((d) => domain === d || domain.endsWith(`.${d}`))
}

/** Looked up once per process: a member's or a thread's person does not change. */
const people = new Map<string, Person | null>()
const PEOPLE_KEPT = 5_000

async function remembered(key: string, find: () => Promise<Person | null>) {
  if (people.has(key)) return people.get(key)!
  const person = await find()
  if (people.size >= PEOPLE_KEPT) people.clear()
  people.set(key, person)
  return person
}

const personOfUser = (user: { id: string; email: string }): Person => ({
  userId: user.id,
  internal: isInternalEmail(user.email),
})

/** A member's person. Audit actors fall back to the user id before a membership exists (auth.ts). */
export const personOfMember = (memberId: string) =>
  remembered(`member:${memberId}`, async () => {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: { user: { select: { id: true, email: true } } },
    })
    if (member) return personOfUser(member.user)
    const user = await prisma.user.findUnique({
      where: { id: memberId },
      select: { id: true, email: true },
    })
    return user ? personOfUser(user) : null
  })

/** A thread's person: the member it runs for, who started it. */
export const personOfThread = (threadId: string) =>
  remembered(`thread:${threadId}`, async () => {
    const thread = await prisma.session.findUnique({
      where: { id: threadId },
      select: { startedByMemberId: true },
    })
    return thread ? personOfMember(thread.startedByMemberId) : null
  })

/** Whether this is the person's first such event; marks it done. */
async function firstTime(userId: string, event: string) {
  const { count } = await prisma.analyticsFirst.createMany({
    data: [{ userId, event }],
    skipDuplicates: true,
  })
  return count === 1
}

/**
 * Send an event of a person, or of the workspace when nobody is behind it (a teammate's work
 * in no member's thread, a webhook): `workspace:<id>`, without a profile. Events of
 * FIRST_EVENTS get `first`.
 */
export async function trackFor(
  person: Person | null,
  event: string,
  scope: { organizationId: string; workspaceId?: string | null },
  properties: AnalyticsProps = {},
) {
  if (!analyticsOn()) return
  const first: AnalyticsProps =
    person && FIRST_EVENTS.has(event) ? { first: await firstTime(person.userId, event) } : {}
  track(event, {
    distinctId: person?.userId ?? `workspace:${scope.workspaceId ?? scope.organizationId}`,
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
    properties: { ...properties, ...first },
    ...(person ? { set: { internal: person.internal } } : { personless: true }),
  })
}

/** trackFor, not waited on. */
export function trackLater(
  person: Person | null | Promise<Person | null>,
  event: string,
  scope: { organizationId: string; workspaceId?: string | null },
  properties: AnalyticsProps = {},
) {
  if (!analyticsOn()) return
  background(Promise.resolve(person).then((p) => trackFor(p, event, scope, properties)))
}

// ---------------------------------------------------------------------------
// Workspaces (PostHog's group `workspace`)
// ---------------------------------------------------------------------------

/** A workspace's group properties: members, plan and creation. Never its name. */
export function identifyWorkspace(workspaceId: string) {
  if (!analyticsOn()) return
  background(
    (async () => {
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { organizationId: true, createdAt: true },
      })
      if (!workspace) return
      const { workspacePlan, entitles } = await import('./billing.js')
      const [members, plan] = await Promise.all([
        prisma.member.count({ where: { organizationId: workspace.organizationId } }),
        workspacePlan(workspaceId),
      ])
      queue.push({
        event: '$groupidentify',
        distinct_id: `workspace:${workspaceId}`,
        timestamp: new Date().toISOString(),
        properties: {
          $group_type: 'workspace',
          $group_key: workspaceId,
          $group_set: {
            member_count: members,
            plan: plan && entitles(plan.status) ? plan.plan : 'free',
            created_at: workspace.createdAt.toISOString(),
          },
          $process_person_profile: false,
          $lib: 'brigade-api',
        },
      })
      send()
    })(),
  )
}

/** Each workspace of an organization, after its members changed. */
function identifyWorkspacesOf(organizationId: string) {
  background(
    prisma.workspace
      .findMany({ where: { organizationId }, select: { id: true } })
      .then((rows) => rows.forEach((w) => identifyWorkspace(w.id))),
  )
}

// ---------------------------------------------------------------------------
// From the audit log (src/audit.ts)
// ---------------------------------------------------------------------------

const GROUP_CHANGES = new Set(['workspace.created', 'workspace.updated'])
const MEMBER_CHANGES = new Set(['member.added', 'member.removed'])

type AuditEntry = {
  organizationId: string
  workspaceId: string | null
  actor: { type: AuditInput['actorType']; id: string }
  action: string
  target: { type: string; id: string }
  data?: unknown
  track?: AnalyticsProps
}

/** Whose an audit entry's events are: the member who acted, else the thread's starter. */
async function personOfEntry(entry: AuditEntry) {
  if (entry.actor.type === 'member') return personOfMember(entry.actor.id)
  const data = (entry.data ?? {}) as Record<string, unknown>
  const threadId =
    entry.target.type === 'thread'
      ? entry.target.id
      : typeof data.threadId === 'string'
        ? data.threadId
        : typeof data.sessionId === 'string'
          ? data.sessionId
          : undefined
  return threadId ? personOfThread(threadId) : null
}

/** An answered ticket's kind, and how long it waited for its answer. */
async function ticketFacts(entry: AuditEntry): Promise<AnalyticsProps> {
  const data = (entry.data ?? {}) as Record<string, unknown>
  const ticketId =
    typeof data.ticketId === 'string'
      ? data.ticketId
      : entry.target.type === 'ticket'
        ? entry.target.id
        : undefined
  if (!ticketId) return {}
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { type: true, createdAt: true },
  })
  if (!ticket) return {}
  return {
    kind: ticket.type,
    response_s: Math.round((Date.now() - ticket.createdAt.getTime()) / 1000),
  }
}

/** The events an audit entry sends, sent; not waited on. */
export function trackAudit(entry: AuditEntry) {
  if (!analyticsOn()) return
  if (entry.workspaceId && GROUP_CHANGES.has(entry.action)) identifyWorkspace(entry.workspaceId)
  if (MEMBER_CHANGES.has(entry.action)) identifyWorkspacesOf(entry.organizationId)
  const input: AuditInput = {
    action: entry.action,
    actorType: entry.actor.type,
    data: entry.data,
    ...(entry.track && { track: entry.track }),
  }
  if (emissionsOf(input).length === 0) return
  background(
    (async () => {
      const [person, facts] = await Promise.all([
        personOfEntry(entry),
        emissionsOf(input).some((e) => e.event === 'ticket_answered')
          ? ticketFacts(entry)
          : Promise.resolve({}),
      ])
      const emissions = emissionsOf({ ...input, track: { ...facts, ...input.track } })
      for (const emission of emissions)
        await trackFor(person, emission.event, entry, emission.properties)
    })(),
  )
}

// ---------------------------------------------------------------------------
// Tickets, as each is made (from any of the places that make one)
// ---------------------------------------------------------------------------

onScopedWrite((model, scope, operation, result) => {
  if (!analyticsOn() || model !== 'Ticket' || operation !== 'create') return
  const ticket = result as { type: string; sessionId: string | null }
  trackLater(ticket.sessionId ? personOfThread(ticket.sessionId) : null, 'ticket_opened', scope, {
    feature: 'tickets',
    kind: ticket.type,
  })
})

// ---------------------------------------------------------------------------
// Sign-up (src/auth.ts, after a user is made)
// ---------------------------------------------------------------------------

/** How the account was made, from better-auth's endpoint. */
export function signupMethod(path: string | undefined) {
  if (!path) return 'other'
  if (path === '/sign-in/email-otp') return 'email_code'
  if (path.startsWith('/callback/') || path.startsWith('/oauth2/callback')) return 'google'
  if (path === '/sign-up/email') return 'password'
  return 'other'
}

/**
 * Keep where the person came from on the user, once (a user that has it keeps it), and send
 * `signed_up` with it. The sign-up page sends it with the code (`signupSource` in the body),
 * or through Google's round trip (the OAuth state's `additionalData.signupSource`).
 */
export async function recordSignup(
  user: { id: string; email: string },
  context: { path?: string; body?: unknown } | null,
) {
  const body = (context?.body ?? {}) as Record<string, unknown>
  let raw = body.signupSource
  if (raw === undefined) {
    const state = await getOAuthState<{ signupSource?: unknown }>().catch(() => null)
    raw = state?.signupSource
  }
  const source = parseSignupSource(raw)
  const method = signupMethod(context?.path)
  const { count } = await prisma.user.updateMany({
    where: { id: user.id, attribution: { equals: Prisma.DbNull } },
    data: { attribution: { ...source, method } },
  })
  if (count === 0 || !analyticsOn()) return
  const internal = isInternalEmail(user.email)
  track('signed_up', {
    distinctId: user.id,
    properties: { feature: 'onboarding', method, channel: source.channel },
    setOnce: signupProperties(source, method),
    set: { internal },
  })
}

// ---------------------------------------------------------------------------
// Turns (src/hub/runner-messages.ts, once a run of a thread's events is stored)
// ---------------------------------------------------------------------------

type StoredEvent = { seq: number; event: { type: string; at: string; [key: string]: unknown } }

/** A teammate's harness, once per process. */
const harnesses = new Map<string, string | null>()
async function harnessOf(teammateId: string) {
  if (harnesses.has(teammateId)) return harnesses.get(teammateId)!
  const row = await prisma.teammate.findUnique({
    where: { id: teammateId },
    select: { harness: true },
  })
  if (harnesses.size >= PEOPLE_KEPT) harnesses.clear()
  harnesses.set(teammateId, row?.harness ?? null)
  return row?.harness ?? null
}

/**
 * `turn_completed` for each turn these events end: done, interrupted, or error (the thread
 * failed). Its length runs from the turn's start. Each run of events comes here once.
 */
export function trackTurns(
  session: { id: string; organizationId: string; workspaceId: string; teammateId: string },
  events: StoredEvent[],
) {
  if (!analyticsOn()) return
  const ends = events.filter(
    ({ event }, i) =>
      event.type === 'turn.completed' ||
      // A failure without the turn's end after it ends the turn too.
      (event.type === 'error' &&
        !events.slice(i + 1).some((e) => e.event.type === 'turn.completed')),
  )
  if (ends.length === 0) return
  background(
    (async () => {
      const person = await personOfThread(session.id)
      for (const { seq, event } of ends) {
        const started =
          events.findLast((e) => e.seq < seq && e.event.type === 'turn.started')?.event ??
          ((
            await prisma.sessionEvent.findFirst({
              where: { sessionId: session.id, type: 'turn.started', seq: { lt: seq } },
              orderBy: { seq: 'desc' },
              select: { data: true },
            })
          )?.data as StoredEvent['event'] | undefined)
        const teammateId =
          (typeof event.teammateId === 'string' && event.teammateId) ||
          (typeof started?.teammateId === 'string' && started.teammateId) ||
          session.teammateId
        const seconds = started ? (Date.parse(event.at) - Date.parse(started.at)) / 1000 : NaN
        const harness = await harnessOf(teammateId)
        await trackFor(person, 'turn_completed', session, {
          feature: 'threads',
          outcome:
            event.type === 'error'
              ? 'error'
              : event.finishReason === 'interrupted'
                ? 'interrupted'
                : event.finishReason === 'error'
                  ? 'error'
                  : 'done',
          ...(harness && { harness }),
          ...(Number.isFinite(seconds) && seconds >= 0 && { duration_s: Math.round(seconds) }),
        })
      }
    })(),
  )
}
