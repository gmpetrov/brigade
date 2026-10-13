import { CreateProject, SetProjectRepositories, UpdateProject } from '@brigade/contracts'
import { Hono } from 'hono'
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  setArchived,
  setProjectRepositories,
  updateProject,
} from '../projects.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

/** Projects: any member makes, edits, archives and deletes them; every change is audited. */
export const projects = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  /** Archived ones included; the sidebar leaves them out. ?repository=owner/name: those that link it. */
  .get('/', async (c) => c.json(await listProjects(c.var.db, c.req.query('repository'))))

  .get('/:id', async (c) => c.json(await getProject(c.var.db, c.var.scope, c.req.param('id'))))

  .post('/', async (c) => {
    const input = await parseBody(c.req.raw, CreateProject)
    return c.json(await createProject(c.var.db, c.var.scope, input), 201)
  })

  .patch('/:id', async (c) => {
    const input = await parseBody(c.req.raw, UpdateProject)
    return c.json(await updateProject(c.var.db, c.var.scope, c.req.param('id'), input))
  })

  /** Replaces the list. Only repositories a GitHub connection reaches can be added. */
  .put('/:id/repositories', async (c) => {
    const input = await parseBody(c.req.raw, SetProjectRepositories)
    return c.json(await setProjectRepositories(c.var.db, c.var.scope, c.req.param('id'), input))
  })

  .post('/:id/archive', async (c) => {
    await setArchived(c.var.db, c.var.scope, c.req.param('id'), true)
    return c.json({ ok: true })
  })

  .post('/:id/unarchive', async (c) => {
    await setArchived(c.var.db, c.var.scope, c.req.param('id'), false)
    return c.json({ ok: true })
  })

  /** Its threads and tasks stay, in no project. */
  .delete('/:id', async (c) => {
    await deleteProject(c.var.db, c.var.scope, c.req.param('id'))
    return c.body(null, 204)
  })
