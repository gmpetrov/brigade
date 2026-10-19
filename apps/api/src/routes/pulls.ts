// Pull requests: any member reads them and asks a teammate to review one;
// owners and admins merge, close or reopen one, arm a review to merge once approved,
// or have the teammate that wrote one resolve its conflicts and then merge it.
import {
  MergePullRequest,
  PreviewPullRequest,
  RepositoryName,
  RequestReview,
  ResolvePullRequest,
  type PullRequestList,
} from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import {
  listPulls,
  mergeNow,
  needsAttention,
  openCount,
  previewPull,
  pullDetail,
  pullState,
  requestReview,
  resolveConflicts,
  setPullState,
  stopLoop,
} from '../pull-requests.js'
import type { ScopedDb } from '../db.js'
import { latersOf } from '../later.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

/** A pull request is a project's when its repository is, or a thread of the project opened it. */
async function inProject(db: ScopedDb, list: PullRequestList, projectId: string) {
  const [repositories, threads] = await Promise.all([
    db.projectRepository.findMany({ where: { projectId }, select: { repository: true } }),
    db.session.findMany({ where: { projectId, pullRequests: { some: {} } }, select: { id: true } }),
  ])
  const repos = new Set(repositories.map((r) => r.repository))
  const ids = new Set(threads.map((t) => t.id))
  const pulls = list.pulls.filter(
    (p) => repos.has(p.repository) || (p.tracking?.sessionId && ids.has(p.tracking.sessionId)),
  )
  return {
    ...list,
    pulls,
    repositories: list.repositories.filter(
      (r) => repos.has(r) || pulls.some((p) => p.repository === r),
    ),
    errors: list.errors.filter((e) => repos.has(e.repository)),
  }
}

function target(params: { owner: string; name: string; number: string }) {
  const repo = RepositoryName.safeParse(`${params.owner}/${params.name}`)
  const number = Number(params.number)
  if (!repo.success || !Number.isInteger(number) || number < 1)
    throw new HTTPException(404, { message: 'Pull request not found' })
  return { repo: repo.data, number }
}

export const pulls = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  /** ?project=<id>: those of its repositories or opened from its threads. */
  .get('/', async (c) => {
    const state = c.req.query('state') === 'closed' ? 'closed' : 'open'
    const list = await listPulls(c.var.db, c.var.scope, state)
    const projectId = c.req.query('project')
    return c.json(projectId ? await inProject(c.var.db, list, projectId) : list)
  })

  /**
   * For the sidebar and Home: how many are open, and those that wait on a person.
   * Database only, no GitHub call.
   */
  .get('/attention', async (c) => {
    // Not those of a thread this member put away for later (src/later.ts).
    const laters = await latersOf(c.var.db, c.var.scope.memberId)
    const [waiting, open] = await Promise.all([
      needsAttention(c.var.db, [...laters.keys()]),
      openCount(c.var.db),
    ])
    return c.json({ count: waiting.length, open, pulls: waiting })
  })

  .get('/:owner/:name/:number', async (c) => {
    const { repo, number } = target(c.req.param())
    return c.json(await pullDetail(c.var.db, c.var.scope, repo, number))
  })

  /** Without the diff or reviews, and checks only with `?checks=1`: for the pull request's card in a thread. */
  .get('/:owner/:name/:number/state', async (c) => {
    const { repo, number } = target(c.req.param())
    const checks = c.req.query('checks') === '1'
    return c.json(await pullState(c.var.db, c.var.scope, repo, number, { checks }))
  })

  .post('/:owner/:name/:number/review', async (c) => {
    const { repo, number } = target(c.req.param())
    const input = await parseBody(c.req.raw, RequestReview)
    return c.json(await requestReview(c.var.scope, repo, number, input))
  })

  /** Preview one without a thread: a teammate checks out its branch in a new thread and starts it. */
  .post('/:owner/:name/:number/preview', async (c) => {
    const { repo, number } = target(c.req.param())
    const input = await parseBody(c.req.raw, PreviewPullRequest)
    return c.json(await previewPull(c.var.scope, repo, number, input.teammateId))
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

  /** The teammate that wrote it resolves its conflicts in its thread; then it merges by itself. */
  .post('/:owner/:name/:number/resolve', async (c) => {
    const { repo, number } = target(c.req.param())
    const input = await parseBody(c.req.raw, ResolvePullRequest)
    return c.json(await resolveConflicts(c.var.scope, repo, number, input.method))
  })

  .post('/:owner/:name/:number/close', async (c) => {
    const { repo, number } = target(c.req.param())
    await setPullState(c.var.scope, repo, number, 'closed')
    return c.json({ ok: true })
  })

  .post('/:owner/:name/:number/reopen', async (c) => {
    const { repo, number } = target(c.req.param())
    await setPullState(c.var.scope, repo, number, 'open')
    return c.json({ ok: true })
  })
