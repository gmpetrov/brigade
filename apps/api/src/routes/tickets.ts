import { QuestionAnswer, ResolveTicket, TicketAnswer } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { answerQuestion, answerTicket, resolveTicket } from '../decide.js'
import { latersOf } from '../later.js'
import { waitingTickets } from '../playbook-approvals.js'
import { projectWhere } from '../projects.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

/** Everything waiting on a person in this workspace. */
export const tickets = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  /**
   * ?project=<id|none>: tickets of a project's threads, or of threads in none. ?status=all: the
   * decided ones too. A playbook's open approvals are one, with their count (playbook-approvals.ts).
   */
  .get('/', async (c) => {
    const [rows, laters] = await Promise.all([
      waitingTickets(c.var.scope, {
        all: c.req.query('status') === 'all',
        project: projectWhere(c.req.query('project')),
      }),
      latersOf(c.var.db, c.var.scope.memberId),
    ])
    // Its thread put away for later by this member: it no longer waits on them (waitsOn),
    // as when archived. A child's goes with its parent.
    return c.json(
      rows.map((t) => {
        const thread = t.session && (t.session.parentId ?? t.session.id)
        const laterAt = thread ? laters.get(thread) : undefined
        return t.session
          ? { ...t, session: { ...t.session, laterAt: laterAt?.toISOString() ?? null } }
          : t
      }),
    )
  })

  /** Approve, deny or dismiss. Who may depends on the kind of ticket. */
  .post('/:id/resolve', async (c) => {
    const input = await parseBody(c.req.raw, ResolveTicket)
    return c.json(await resolveTicket(c.var.scope, c.req.param('id'), input))
  })

  /**
   * Answer a teammate's question or ticket outside its thread, as Home does. The starter
   * or an admin, the same as the tickets waiting on them (decide.ts).
   */
  .post('/:id/answer', async (c) => {
    const id = c.req.param('id')
    const ticket = await c.var.db.ticket.findFirst({
      where: { id, status: 'open' },
      select: { type: true },
    })
    if (ticket?.type === 'question') {
      const { answer } = await parseBody(c.req.raw, z.object({ answer: QuestionAnswer }))
      return c.json(await answerQuestion(c.var.scope, id, answer))
    }
    if (ticket?.type === 'request') {
      const { answer } = await parseBody(c.req.raw, z.object({ answer: TicketAnswer }))
      return c.json(await answerTicket(c.var.scope, id, answer))
    }
    throw new HTTPException(404, { message: 'Ticket not found or already answered' })
  })
