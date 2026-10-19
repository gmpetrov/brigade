import { DecidePlaybookApprovals } from '@brigade/contracts'
import { Hono } from 'hono'
import { decidePlaybookApprovals, playbookApprovals } from '../playbook-approvals.js'
import { parseBody, type AppEnv } from '../scope.js'

/**
 * A playbook's approvals, as one item (playbook-approvals.ts). Mounted under /playbooks, whose
 * middleware has the member and workspace. One is decided at /tickets/:id/resolve, as anywhere.
 */
export const playbookApprovalRoutes = new Hono<AppEnv>()
  /** Its open approvals, each with what it will do. */
  .get('/:id/approvals', async (c) =>
    c.json(await playbookApprovals(c.var.db, c.var.scope, c.req.param('id'))),
  )

  /** Several at once ("Approve all 8"): decided in bulk, they do not count toward its trust. */
  .post('/:id/approvals/decide', async (c) => {
    const input = await parseBody(c.req.raw, DecidePlaybookApprovals)
    return c.json(await decidePlaybookApprovals(c.var.scope, c.req.param('id'), input))
  })
