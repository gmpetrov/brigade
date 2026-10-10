// Repositories: the GitHub repositories the workspace works on, with a setup
// script for fresh checkouts and notes for teammates. Any member reads them;
// owners and admins change them, since a setup script runs on the computers.
import { SaveRepository, type Repository } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { audit } from '../audit.js'
import { workspaceRepositories } from '../git.js'
import { parseBody, requireRole, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

const view = (row: {
  id: string
  repository: string
  setupScript: string | null
  notes: string
  updatedAt: Date
}): Repository => ({
  id: row.id,
  repository: row.repository,
  setupScript: row.setupScript,
  notes: row.notes,
  updatedAt: row.updatedAt.toISOString(),
})

export const repositories = new Hono<AppEnv>()
  .use(requireUser)
  .use(requireWorkspace)

  .get('/', async (c) => {
    const rows = await c.var.db.repository.findMany({ orderBy: { repository: 'asc' } })
    return c.json(rows.map(view))
  })

  /** What the workspace's GitHub connections reach, to pick one to set up. */
  .get('/available', async (c) =>
    c.json(await workspaceRepositories(c.var.db, c.var.scope).catch(() => [])),
  )

  /** Set up a repository, or change its setup. */
  .put('/', async (c) => {
    const { scope, db } = c.var
    requireRole(scope, 'owner', 'admin')
    const input = await parseBody(c.req.raw, SaveRepository)
    const existing = await db.repository.findFirst({ where: { repository: input.repository } })
    const data = { setupScript: input.setupScript, notes: input.notes }
    const row = existing
      ? await db.repository.update({ where: { id: existing.id }, data })
      : await db.repository.create({ data: { repository: input.repository, ...data } as never })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: existing ? 'repository.updated' : 'repository.added',
      target: { type: 'repository', id: row.id },
      data: { repository: row.repository, setupScript: row.setupScript },
    })
    return c.json(view(row))
  })

  .delete('/:id', async (c) => {
    const { scope, db } = c.var
    requireRole(scope, 'owner', 'admin')
    const row = await db.repository.findFirst({ where: { id: c.req.param('id') } })
    if (!row) throw new HTTPException(404, { message: 'Repository not found' })
    await db.repository.deleteMany({ where: { id: row.id } })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'repository.removed',
      target: { type: 'repository', id: row.id },
      data: { repository: row.repository },
    })
    return c.json({ ok: true })
  })
