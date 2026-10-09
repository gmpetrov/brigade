import { ResolveTicket } from '@brigade/contracts'
import { Hono } from 'hono'
import { resolveTicket } from '../decide.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

/** Everything waiting on a person in this workspace. */
export const tickets = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .get('/', async (c) => {
    const status = c.req.query('status') === 'all' ? undefined : 'open'
    const rows = await c.var.db.ticket.findMany({
      where: status ? { status } : {},
      include: {
        session: {
          select: {
            id: true,
            title: true,
            origin: true,
            startedByMemberId: true,
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
