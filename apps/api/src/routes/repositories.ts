// The repositories the workspace's GitHub connections reach: what a message
// can mention and a teammate can check out. Any member reads them, and the
// previews saved for them; an owner or admin forgets a saved preview.
import { PreviewRecipe, RepositoryName, type SavedPreviewRecipe } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { audit } from '../audit.js'
import { workspaceRepositories } from '../git.js'
import { requireUser, requireWorkspace, type AppEnv } from '../scope.js'

export const repositories = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)
  .get('/', async (c) => c.json(await workspaceRepositories(c.var.db, c.var.scope).catch(() => [])))

  /** How each repository's preview starts, as a teammate saved it. */
  .get('/previews', async (c) => {
    const { db } = c.var
    const rows = await db.previewRecipe.findMany({ orderBy: { repository: 'asc' } })
    const teammateIds = rows.flatMap((r) => (r.savedByTeammateId ? [r.savedByTeammateId] : []))
    const teammates = await db.teammate.findMany({
      where: { id: { in: teammateIds } },
      select: { id: true, name: true },
    })
    return c.json(
      rows.flatMap((r): SavedPreviewRecipe[] => {
        const recipe = PreviewRecipe.safeParse(r.recipe)
        if (!recipe.success) return []
        return [
          {
            repository: r.repository,
            recipe: recipe.data,
            savedBy: teammates.find((t) => t.id === r.savedByTeammateId) ?? null,
            savedFromSessionId: r.savedFromSessionId,
            updatedAt: r.updatedAt.toISOString(),
          },
        ]
      }),
    )
  })

  /** Forget a repository's saved preview: the next one is set up again by a teammate. */
  .delete('/:owner/:name/preview', async (c) => {
    const { db, scope } = c.var
    if (scope.role !== 'owner' && scope.role !== 'admin')
      throw new HTTPException(403, { message: 'Only an owner or admin can forget a saved preview' })
    const repo = RepositoryName.safeParse(`${c.req.param('owner')}/${c.req.param('name')}`)
    if (!repo.success) throw new HTTPException(404, { message: 'Repository not found' })
    const repository = repo.data.toLowerCase()
    const { count } = await db.previewRecipe.deleteMany({ where: { repository } })
    if (!count) throw new HTTPException(404, { message: 'No saved preview for that repository' })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'preview.recipe_forgotten',
      target: { type: 'repository', id: repository },
    })
    return c.json({ ok: true })
  })
