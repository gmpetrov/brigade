// The repositories the workspace's GitHub connections reach: what a message
// can mention and a teammate can check out. Any member reads them, and the
// previews saved for them; an owner or admin forgets a saved preview. Any
// member sets a preview's variables (see preview-variables.ts).
import {
  PreviewRecipe,
  PreviewVariableName,
  RepositoryName,
  SetPreviewVariables,
  type SavedPreview,
} from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { audit } from '../audit.js'
import { workspaceRepositories } from '../git.js'
import { listVariables, removeVariable, setVariables } from '../preview-variables.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

/** The repository a path names, lowercase. */
function repositoryParam(owner: string, name: string) {
  const repo = RepositoryName.safeParse(`${owner}/${name}`)
  if (!repo.success) throw new HTTPException(404, { message: 'Repository not found' })
  return repo.data.toLowerCase()
}

export const repositories = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)
  .get('/', async (c) => c.json(await workspaceRepositories(c.var.db, c.var.scope).catch(() => [])))

  /** How each repository's preview starts, as a teammate saved it, and the variables people gave it. */
  .get('/previews', async (c) => {
    const { db } = c.var
    const rows = await db.previewRecipe.findMany({ orderBy: { repository: 'asc' } })
    const variables = await listVariables(db)
    const teammateIds = rows.flatMap((r) => (r.savedByTeammateId ? [r.savedByTeammateId] : []))
    const teammates = await db.teammate.findMany({
      where: { id: { in: teammateIds } },
      select: { id: true, name: true },
    })
    const saved = rows.flatMap((r): SavedPreview[] => {
      const recipe = PreviewRecipe.safeParse(r.recipe)
      if (!recipe.success) return []
      return [
        {
          repository: r.repository,
          recipe: recipe.data,
          savedBy: teammates.find((t) => t.id === r.savedByTeammateId) ?? null,
          savedFromSessionId: r.savedFromSessionId,
          updatedAt: r.updatedAt.toISOString(),
          variables: variables.get(r.repository) ?? [],
        },
      ]
    })
    // Variables set before a setup was saved (asked for while a teammate set it up).
    for (const [repository, list] of variables)
      if (!saved.some((p) => p.repository === repository))
        saved.push({
          repository,
          recipe: null,
          savedBy: null,
          savedFromSessionId: null,
          updatedAt: null,
          variables: list,
        })
    return c.json(saved.sort((a, b) => a.repository.localeCompare(b.repository)))
  })

  /** A repository's preview variables: a setting's value, a secret's name only. */
  .get('/:owner/:name/preview/variables', async (c) => {
    const repository = repositoryParam(c.req.param('owner'), c.req.param('name'))
    return c.json((await listVariables(c.var.db, [repository])).get(repository) ?? [])
  })

  /** Set some of a repository's preview variables: the next start of its preview uses them. */
  .put('/:owner/:name/preview/variables', async (c) => {
    const repository = repositoryParam(c.req.param('owner'), c.req.param('name'))
    const input = await parseBody(c.req.raw, SetPreviewVariables)
    await setVariables(c.var.db, c.var.scope, repository, input)
    return c.json((await listVariables(c.var.db, [repository])).get(repository) ?? [])
  })

  .delete('/:owner/:name/preview/variables/:variable', async (c) => {
    const repository = repositoryParam(c.req.param('owner'), c.req.param('name'))
    const name = PreviewVariableName.safeParse(c.req.param('variable'))
    if (!name.success) throw new HTTPException(404, { message: 'No such variable' })
    await removeVariable(c.var.db, c.var.scope, repository, name.data)
    return c.json({ ok: true })
  })

  /** Forget a repository's saved preview: the next one is set up again by a teammate. */
  .delete('/:owner/:name/preview', async (c) => {
    const { db, scope } = c.var
    if (scope.role !== 'owner' && scope.role !== 'admin')
      throw new HTTPException(403, { message: 'Only an owner or admin can forget a saved preview' })
    const repository = repositoryParam(c.req.param('owner'), c.req.param('name'))
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
