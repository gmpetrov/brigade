import { ErrorReport } from '@brigade/contracts'
import { Hono } from 'hono'
import { captureReport } from '../error-tracking.js'
import { requireUser, type AppEnv } from '../scope.js'

/** At most this many reports a minute from one person, in one process. */
const PER_MINUTE = 30
const counts = new Map<string, { since: number; count: number }>()

function tooMany(userId: string, now = Date.now()) {
  const seen = counts.get(userId)
  if (!seen || now - seen.since >= 60_000) {
    if (counts.size >= 5_000) counts.clear()
    counts.set(userId, { since: now, count: 1 })
    return false
  }
  return ++seen.count > PER_MINUTE
}

/**
 * The dashboard's errors (apps/web/lib/error-reports.ts), passed on to PostHog's error tracking
 * (src/error-tracking.ts). Answers 204 whatever becomes of one: sent, dropped or over the limit.
 */
export const errors = new Hono<AppEnv>().use(requireUser).post('/', async (c) => {
  const input = ErrorReport.safeParse(await c.req.json().catch(() => null))
  if (!input.success) return c.json({ error: 'Expected an error report' }, 400)
  if (!tooMany(c.var.userId))
    captureReport(input.data, { userId: c.var.userId, workspaceId: c.var.activeWorkspaceId })
  return c.body(null, 204)
})
