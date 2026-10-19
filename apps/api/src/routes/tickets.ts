import {
  playbookApprovalOf,
  QuestionAnswer,
  ResolveTicket,
  TicketAnswer,
  type PlaybookManifest,
} from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { answerQuestion, answerTicket, resolveTicket } from '../decide.js'
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
            // A child's ticket also marks its parent, which shows the child.
            parentId: true,
            // Archived: it no longer waits on anyone (waitsOn), though the Tickets page lists it.
            archivedAt: true,
            teammate: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    // A playbook's approvals are one item wherever they wait (playbook-approvals.ts), named after it.
    const ids = [...new Set(rows.flatMap((t) => playbookApprovalOf(t)?.installationId ?? []))]
    const installations = ids.length
      ? await c.var.db.playbookInstallation.findMany({
          where: { id: { in: ids } },
          select: { id: true, manifest: true },
        })
      : []
    const names = new Map(
      installations.map((i) => [i.id, (i.manifest as PlaybookManifest).name] as const),
    )
    return c.json(
      rows.map((t) => {
        const id = playbookApprovalOf(t)?.installationId
        const name = id && names.get(id)
        return { ...t, playbook: name ? { id, name } : null }
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
