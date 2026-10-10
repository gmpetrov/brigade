// Pull requests: any member reads them and asks a teammate to review one;
// owners and admins merge, or arm a review to merge once approved.
import { MergePullRequest, RepositoryName, RequestReview } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import {
  listPulls,
  mergeNow,
  needsAttention,
  openCount,
  pullDetail,
  requestReview,
  stopLoop,
} from '../pull-requests.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

function target(params: { owner: string; name: string; number: string }) {
  const repo = RepositoryName.safeParse(`${params.owner}/${params.name}`)
  const number = Number(params.number)
  if (!repo.success || !Number.isInteger(number) || number < 1)
    throw new HTTPException(404, { message: 'Pull request not found' })
  return { repo: repo.data, number }
}

export const pulls = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .get('/', async (c) => {
    const state = c.req.query('state') === 'closed' ? 'closed' : 'open'
    return c.json(await listPulls(c.var.db, c.var.scope, state))
  })

  /** For the sidebar: how many are open and how many wait on a person. Database only, no GitHub call. */
  .get('/attention', async (c) => {
    const [count, open] = await Promise.all([needsAttention(c.var.db), openCount(c.var.db)])
    return c.json({ count, open })
  })

  .get('/:owner/:name/:number', async (c) => {
    const { repo, number } = target(c.req.param())
    return c.json(await pullDetail(c.var.db, c.var.scope, repo, number))
  })

  .post('/:owner/:name/:number/review', async (c) => {
    const { repo, number } = target(c.req.param())
    const input = await parseBody(c.req.raw, RequestReview)
    return c.json(await requestReview(c.var.scope, repo, number, input))
  })

  .post('/:owner/:name/:number/stop', async (c) => {
    const { repo, number } = target(c.req.param())
    await stopLoop(c.var.scope, repo, number)
    return c.json({ ok: true })
  })

  .post('/:owner/:name/:number/merge', async (c) => {
    const { repo, number } = target(c.req.param())
    const input = await parseBody(c.req.raw, MergePullRequest)
    await mergeNow(c.var.scope, repo, number, input.method)
    return c.json({ ok: true })
  })
