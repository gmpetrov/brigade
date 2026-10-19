import {
  ActivatePlaybook,
  InstallPlaybook,
  UpdatePlaybook,
  UpdatePlaybookAction,
} from '@brigade/contracts'
import { Hono } from 'hono'
import { changeAction, flagCall } from '../playbook-autonomy.js'
import { latestDryRun } from '../playbook-dry-runs.js'
import {
  activatePlaybook,
  getInstallation,
  isAdminRole,
  installPlaybook,
  listInstallations,
  requestActivation,
  setPlaybookPaused,
  templates,
  templateView,
  uninstallPlaybook,
} from '../playbooks.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'
import { playbookApprovalRoutes } from './playbook-approvals.js'

/** Playbooks: the templates Brigade ships, and those installed in the workspace. */
export const playbooks = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)
  .route('/', playbookApprovalRoutes)

  .get('/catalog', (c) => c.json([...templates().values()].map(templateView)))

  /** ?project=<id|none>: a project's playbooks, or those in none. */
  .get('/', async (c) =>
    c.json(await listInstallations(c.var.db, c.req.query('project'), c.var.scope)),
  )

  .get('/:id', async (c) => c.json(await getInstallation(c.var.db, c.req.param('id'), c.var.scope)))

  /** Its latest dry run: the report, one event at a time. */
  .get('/:id/dry-run', async (c) => c.json(await latestDryRun(c.var.db, c.req.param('id'))))

  /**
   * The Activate button. An owner or admin activates it; a member asks one, in one ticket
   * (in the thread it was installed from, when given).
   */
  .post('/:id/activate', async (c) => {
    const { threadId } = await parseBody(c.req.raw, ActivatePlaybook)
    const id = c.req.param('id')
    if (isAdminRole(c.var.scope.role))
      return c.json({ ticketId: null, playbook: await activatePlaybook(c.var.db, c.var.scope, id) })
    const thread = threadId
      ? await c.var.db.session.findFirst({ where: { id: threadId }, select: { id: true } })
      : null
    const { ticketId } = await requestActivation(c.var.db, c.var.scope, id, thread?.id ?? null)
    return c.json({ ticketId, playbook: await getInstallation(c.var.db, id, c.var.scope) })
  })

  /**
   * An action's level (Asks first, On its own, Never) and what limits it on its own: its owner,
   * an owner or an admin, within the template's ceiling. Teammates have no way to.
   */
  .patch('/:id/actions/:key', async (c) => {
    const input = await parseBody(c.req.raw, UpdatePlaybookAction)
    const id = c.req.param('id')
    await changeAction(c.var.db, c.var.scope, id, c.req.param('key'), input)
    return c.json(await getInstallation(c.var.db, id, c.var.scope))
  })

  /** A call it made on its own was wrong: its action goes back to asking first. */
  .post('/:id/calls/:callId/flag', async (c) => {
    const id = c.req.param('id')
    await flagCall(c.var.db, c.var.scope, id, c.req.param('callId'))
    return c.json(await getInstallation(c.var.db, id, c.var.scope))
  })

  /** It runs on the installer's accounts, in setup until it is activated. */
  .post('/', async (c) => {
    const input = await parseBody(c.req.raw, InstallPlaybook)
    return c.json(await installPlaybook(c.var.db, c.var.scope, input), 201)
  })

  /** paused: false resumes it, or activates one that waits (an owner or admin). */
  .patch('/:id', async (c) => {
    const { paused } = await parseBody(c.req.raw, UpdatePlaybook)
    const id = c.req.param('id')
    return c.json(
      paused === undefined
        ? await getInstallation(c.var.db, id, c.var.scope)
        : await setPlaybookPaused(c.var.db, c.var.scope, id, paused),
    )
  })

  /** Its triggers, schedules and skills go with it. */
  .delete('/:id', async (c) => {
    await uninstallPlaybook(c.var.db, c.var.scope, c.req.param('id'))
    return c.body(null, 204)
  })
