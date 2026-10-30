import { ErrorReport } from '@brigade/contracts'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { createMiddleware } from 'hono/factory'
import { captureReport } from '../error-tracking.js'
import { requireUser, type AppEnv } from '../scope.js'

/** At most this many reports a minute from one person, in one process. */
const PER_MINUTE = 30
/** A report's body at most: its fields' limits (ErrorReport) and JSON's own, with room. */
export const REPORT_MAX_BYTES = 32 * 1024
const counts = new Map<string, { since: number; count: number }>()

/** Whether this person sent PER_MINUTE reports already in the last minute; counts this one. */
function tooMany(userId: string, now = Date.now()) {
  const seen = counts.get(userId)
  if (!seen || now - seen.since >= 60_000) {
    if (counts.size >= 5_000) counts.clear()
    counts.set(userId, { since: now, count: 1 })
    return false
  }
  return ++seen.count > PER_MINUTE
}

/** Over the limit, a report is dropped before its body is read. */
const limited = createMiddleware<AppEnv>(async (c, next) =>
  tooMany(c.var.userId) ? c.body(null, 204) : next(),
)

/**
 * The dashboard's errors (apps/web/lib/error-reports.ts), passed on to PostHog's error tracking
 * (src/error-tracking.ts). Answers 204 whatever becomes of one: sent, dropped or over the limit.
 * Its body is read only up to REPORT_MAX_BYTES, however it comes (a length or chunks): the API's
 * object holds every workspace's requests, and a report must never fill its memory.
 */
export const errors = new Hono<AppEnv>().use(requireUser, limited).post(
  '/',
  bodyLimit({
    maxSize: REPORT_MAX_BYTES,
    onError: (c) => c.json({ error: 'Report too large' }, 413),
  }),
  async (c) => {
    const input = ErrorReport.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: 'Expected an error report' }, 400)
    captureReport(input.data, { userId: c.var.userId, workspaceId: c.var.activeWorkspaceId })
    return c.body(null, 204)
  },
)
