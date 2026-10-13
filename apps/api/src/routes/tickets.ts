import { ResolveTicket } from '@brigade/contracts'
import { Hono } from 'hono'
import { resolveTicket } from '../decide.js'
import { projectWhere } from '../projects.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

/** Everything waiting on a person in this workspace. */
export const tickets = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  /** ?project=<id|none>: tickets of a project's threads, or of threads in none. */
  .get('/', async (c) => {
    const status = c.req.query('status') === 'all' ? undefined : 'open'
    const project = projectWhere(c.req.query('project'))
    const rows = await c.var.db.ticket.findMany({
      where: {
        ...(status ? { status } : {}),
        ...('projectId' in project ? { session: { is: project } } : {}),
      },
      include: {
        session: {
          select: {
            id: true,
            title: true,
            origin: true,
            startedByMemberId: true,
            projectId: true,
            teammate: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    return c.json(rows)
  })

  /** Approve, deny or dismiss. Who may depends on the kind of ticket. */
  .post('/:id/resolve', async (c) => {
    const input = await parseBody(c.req.raw, ResolveTicket)
    return c.json(await resolveTicket(c.var.scope, c.req.param('id'), input))
  })
