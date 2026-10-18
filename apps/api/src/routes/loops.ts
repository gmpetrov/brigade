import { InstallLoop, UpdateLoop } from '@brigade/contracts'
import { Hono } from 'hono'
import {
  getInstallation,
  installLoop,
  listInstallations,
  setLoopPaused,
  templates,
  templateView,
  uninstallLoop,
} from '../loops.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

/** Playbooks: the templates Brigade ships, and those installed in the workspace. */
export const loops = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .get('/catalog', (c) => c.json([...templates().values()].map(templateView)))

  /** ?project=<id|none>: a project's playbooks, or those in none. */
  .get('/', async (c) => c.json(await listInstallations(c.var.db, c.req.query('project'))))

  .get('/:id', async (c) => c.json(await getInstallation(c.var.db, c.req.param('id'))))

  /** It runs on the installer's accounts. An owner or admin's is active at once; a member's waits for one. */
  .post('/', async (c) => {
    const input = await parseBody(c.req.raw, InstallLoop)
    return c.json(await installLoop(c.var.db, c.var.scope, input), 201)
  })

  /** paused: false resumes it, or activates one that waits (an owner or admin). */
  .patch('/:id', async (c) => {
    const { paused } = await parseBody(c.req.raw, UpdateLoop)
    const id = c.req.param('id')
    return c.json(
      paused === undefined
        ? await getInstallation(c.var.db, id)
        : await setLoopPaused(c.var.db, c.var.scope, id, paused),
    )
  })

  /** Its triggers, schedules and skills go with it. */
  .delete('/:id', async (c) => {
    await uninstallLoop(c.var.db, c.var.scope, c.req.param('id'))
    return c.body(null, 204)
  })
