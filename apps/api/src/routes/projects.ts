import { CreateProject, ReadSite, SetProjectRepositories, UpdateProject } from '@brigade/contracts'
import { Hono } from 'hono'
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  projectLogo,
  setArchived,
  setProjectRepositories,
  updateProject,
} from '../projects.js'
import { describeSite, readSite } from '../project-sites.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

/** Projects: any member makes, edits, archives and deletes them; every change is audited. */
export const projects = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  /** Archived ones included; the sidebar leaves them out. ?repository=owner/name: those that link it. */
  .get('/', async (c) => c.json(await listProjects(c.var.db, c.req.query('repository'))))

  .get('/:id', async (c) => c.json(await getProject(c.var.db, c.var.scope, c.req.param('id'))))

  /** Its logo. The URL names the version (`?v=`), so a browser keeps it for good. */
  .get('/:id/logo', async (c) => {
    const logo = await projectLogo(c.var.db, c.var.scope, c.req.param('id'))
    return c.body(logo.bytes as Uint8Array<ArrayBuffer>, 200, {
      'content-type': logo.type,
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      // An SVG opened on its own runs nothing from the API's origin.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    })
  })

  /** A new project's name, description and logo, read from its website. */
  .post('/site', async (c) => {
    const { url } = await parseBody(c.req.raw, ReadSite)
    return c.json(await readSite(c.var.scope, url))
  })

  /** A brief of the site, written with the member's own account; or why not. */
  .post('/site/brief', async (c) => {
    const { url } = await parseBody(c.req.raw, ReadSite)
    return c.json(await describeSite(c.var.db, c.var.scope, url))
  })

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
