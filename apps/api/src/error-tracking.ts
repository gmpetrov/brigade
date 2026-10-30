// Error tracking (docs/analytics.md › Errors): the API's own failures and the dashboard's, sent
// to PostHog's error tracking as `$exception` events, through the product events' queue
// (src/analytics.ts). Off without POSTHOG_KEY.
//
// What PostHog needs to group an error and say where it happened (its type, message and stack
// frames), and nothing of a workspace's content: a message loses its email addresses and keeps
// only the site of a link, a page only its first two segments (`/app/pulls`, never a repo's
// name). The same error is sent at most a few times a minute, so a loop that fails cannot spend
// PostHog's quota.
import {
  chromeStackLineParser,
  createStackParser,
  geckoStackLineParser,
  nodeStackLineParser,
  type Exception,
  type StackFrame,
} from '@posthog/core/error-tracking'
import type { ErrorReport } from '@brigade/contracts'
import { analyticsOn, enqueue } from './analytics.js'
import { env } from './config.js'
import { redact } from './connectors/types.js'
import { onFailureError } from './ops/failures.js'

const apiStack = createStackParser('node:javascript', nodeStackLineParser)
const browserStack = createStackParser(
  'web:javascript',
  chromeStackLineParser,
  geckoStackLineParser,
)

const MESSAGE_MAX = 500
/** An error's causes followed, at most. */
const CAUSES_MAX = 3
/** The same error, sent at most this many times a minute by one process. */
const SAME_PER_MINUTE = 5
const KEPT = 1_000

/**
 * A message without keys or tokens, even masked (`sk_live_****ABCD`, as Stripe's errors say),
 * email addresses, or more of a link than its site, on one line, short.
 */
export function scrubMessage(text: string) {
  return redact(text)
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, '[redacted token]')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/\b(https?:\/\/[^\s/?#'"`)]+)([^\s'"`)]*)/g, (_, site: string, rest: string) =>
      rest.length > 1 ? `${site}/…` : `${site}${rest}`,
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MESSAGE_MAX)
}

/** A page's path, cut to its first two segments: `/app/threads/abc` is `/app/threads`. */
export function scrubPath(path: string) {
  return `/${path.split(/[?#]/)[0]!.split('/').filter(Boolean).slice(0, 2).join('/')}`
}

/** A frame's file without its query: a script's address may carry a token. */
const scrubFrames = (frames: StackFrame[]) =>
  frames.map((f) => (f.filename ? { ...f, filename: f.filename.split(/[?#]/)[0] } : f))

/** An error and its causes, as PostHog's `$exception_list`. */
function exceptionsOf(error: unknown, handled: boolean): Exception[] {
  const list: Exception[] = []
  let current: unknown = error
  for (let id = 0; id <= CAUSES_MAX && current != null; id++) {
    const thrown = current instanceof Error ? current : undefined
    list.push({
      type: thrown?.name || 'Error',
      value: scrubMessage(thrown ? thrown.message : String(current)),
      mechanism:
        id === 0
          ? { type: 'generic', handled, synthetic: false, exception_id: 0 }
          : {
              type: 'chained',
              source: 'cause',
              synthetic: false,
              exception_id: id,
              parent_id: id - 1,
            },
      ...(thrown?.stack && {
        stacktrace: { type: 'raw' as const, frames: scrubFrames(apiStack(thrown.stack)) },
      }),
    })
    current = thrown?.cause
  }
  return list
}

const recent = new Map<string, { since: number; count: number }>()

/** Whether this error may go now: not sent SAME_PER_MINUTE times in the last minute. */
export function mayGo(key: string, now = Date.now()) {
  const seen = recent.get(key)
  if (!seen || now - seen.since >= 60_000) {
    if (recent.size >= KEPT) recent.clear()
    recent.set(key, { since: now, count: 1 })
    return true
  }
  seen.count++
  return seen.count <= SAME_PER_MINUTE
}

type Where = {
  /** Where it was met: `api` (a request), `job:<name>`, `hub-op:<name>`, `dashboard`… */
  kind: string
  source: 'api' | 'dashboard'
  /** The person who met it; else the workspace's, else the API's own. */
  userId?: string | null
  workspaceId?: string | null
  properties?: Record<string, string>
}

function send(exceptions: Exception[], where: Where) {
  const first = exceptions[0]!
  if (!mayGo(`${where.source}|${where.kind}|${first.type}|${first.value?.slice(0, 120)}`)) return
  enqueue({
    event: '$exception',
    distinct_id:
      where.userId ?? (where.workspaceId ? `workspace:${where.workspaceId}` : 'brigade-api'),
    timestamp: new Date().toISOString(),
    properties: {
      $exception_list: exceptions,
      $exception_level: 'error',
      source: where.source,
      kind: where.kind,
      ...where.properties,
      ...(where.workspaceId && { $groups: { workspace: where.workspaceId } }),
      ...(!where.userId && { $process_person_profile: false }),
      $lib: 'brigade-api',
    },
  })
}

/** An error the API met, to PostHog. Never throws. */
export function captureError(
  error: unknown,
  where: { kind: string; workspaceId?: string | null; handled?: boolean },
) {
  if (!analyticsOn()) return
  try {
    send(exceptionsOf(error, where.handled ?? false), {
      ...where,
      source: 'api',
      ...(process.env.BRIGADE_BUILD_ID && { properties: { build: process.env.BRIGADE_BUILD_ID } }),
    })
  } catch (failure) {
    console.warn(`error tracking: ${String(failure)}`)
  }
}

/** How the dashboard met an error, in PostHog's words (posthog-js's own). */
const MECHANISMS = {
  uncaught: 'onerror',
  unhandled_rejection: 'onunhandledrejection',
  boundary: 'react_error_boundary',
} as const

/** Whether a stack's frame is the dashboard's own code: a script of one of its sites. */
const ownFrame = (frame: StackFrame) =>
  env.WEB_URL.some((site) => frame.filename?.startsWith(`${site}/`))

/**
 * An error the dashboard met (`POST /api/errors`), to PostHog. One whose stack holds none of the
 * dashboard's own scripts is dropped: a browser extension's, or a page's frame's.
 */
export function captureReport(
  report: ErrorReport,
  who: { userId: string; workspaceId?: string | null },
) {
  if (!analyticsOn()) return false
  const frames = report.stack ? scrubFrames(browserStack(report.stack)) : []
  if (frames.length && !frames.some(ownFrame)) return false
  send(
    [
      {
        type: report.type || 'Error',
        value: scrubMessage(report.value),
        mechanism: {
          type: MECHANISMS[report.how],
          handled: report.how === 'boundary',
          synthetic: false,
          exception_id: 0,
        },
        ...(frames.length && { stacktrace: { type: 'raw' as const, frames } }),
      },
    ],
    {
      kind: 'dashboard',
      source: 'dashboard',
      userId: who.userId,
      workspaceId: who.workspaceId,
      properties: {
        how: report.how,
        ...(report.build && { build: report.build }),
        ...(report.path && { path: scrubPath(report.path) }),
      },
    },
  )
  return true
}

// The failures the ops checks count (src/ops/failures.ts) that carry an error: a job that threw,
// a webhook that could not be taken… With their stack, here.
onFailureError((kind, error, workspaceId) => captureError(error, { kind, workspaceId }))
