import { USAGE_PERIODS, type UsagePeriod, type UsageResponse } from '@brigade/contracts'
import { Hono } from 'hono'
import { requireUser, requireWorkspace, type AppEnv } from '../scope.js'
import { usageReport } from '../usage.js'

/**
 * Settings › Usage: what the Claude and Codex subscriptions spent tokens on, over the last
 * ?days (1, 7 or 30; 7 by default). Owners and admins see the workspace's; a member, what
 * their own accounts spent.
 */
export const usage = new Hono<AppEnv>().use(requireUser, requireWorkspace).get('/', async (c) => {
  const asked = Number(c.req.query('days'))
  const days: UsagePeriod = (USAGE_PERIODS as readonly number[]).includes(asked)
    ? (asked as UsagePeriod)
    : 7
  return c.json<UsageResponse>(await usageReport(c.var.scope, days))
})
