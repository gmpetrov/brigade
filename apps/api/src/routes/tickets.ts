import { ResolveTicket } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { decideTicket } from '../connector-calls.js'
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
            startedByMemberId: true,
            teammate: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    return c.json(rows)
  })

  /** Approve or deny. The thread's starter, or an owner or admin, decides. */
  .post('/:id/resolve', async (c) => {
    const { scope, db } = c.var
    const ticket = await db.ticket.findFirst({
      where: { id: c.req.param('id'), status: 'open' },
      include: { session: true },
    })
    if (!ticket) throw new HTTPException(404, { message: 'Ticket not found or already resolved' })
    if (ticket.type !== 'approval')
      throw new HTTPException(409, { message: 'Only approvals are resolved here' })
    const isAdmin = scope.role === 'owner' || scope.role === 'admin'
    if (!isAdmin && ticket.session?.startedByMemberId !== scope.memberId) {
      throw new HTTPException(403, {
        message: 'Only the member who started the thread, or an admin, can decide',
      })
    }
    const input = await parseBody(c.req.raw, ResolveTicket)
    const live = await decideTicket(scope, ticket.id, input)
    return c.json({ ok: true, live })
  })
