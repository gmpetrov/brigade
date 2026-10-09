import { CreateTeammate, UpdateTeammate, SetGrant } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { audit } from '../audit.js'
import { parseBody, requireRole, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

export const teammates = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .get('/', async (c) => {
    const rows = await c.var.db.teammate.findMany({
      where: { archivedAt: null },
      orderBy: { createdAt: 'asc' },
    })
    return c.json(rows)
  })

  .get('/:id', async (c) => {
    const row = await c.var.db.teammate.findFirst({ where: { id: c.req.param('id') } })
    if (!row) throw new HTTPException(404, { message: 'Teammate not found' })
    return c.json(row)
  })

  .post('/', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const input = await parseBody(c.req.raw, CreateTeammate)
    const row = await c.var.db.teammate.create({ data: input as never })
    await audit({
      ...c.var.scope,
      actor: { type: 'member', id: c.var.scope.memberId },
      action: 'teammate.created',
      target: { type: 'teammate', id: row.id },
      data: { name: row.name, harness: row.harness },
    })
    return c.json(row, 201)
  })

  .patch('/:id', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const input = await parseBody(c.req.raw, UpdateTeammate)
    const { count } = await c.var.db.teammate.updateMany({
      where: { id: c.req.param('id'), archivedAt: null },
      data: input,
    })
    if (count === 0) throw new HTTPException(404, { message: 'Teammate not found' })
    await audit({
      ...c.var.scope,
      actor: { type: 'member', id: c.var.scope.memberId },
      action: 'teammate.updated',
      target: { type: 'teammate', id: c.req.param('id') },
      data: { fields: Object.keys(input) },
    })
    return c.json(await c.var.db.teammate.findFirst({ where: { id: c.req.param('id') } }))
  })

  /** Which connections this teammate may use, and how. No grant means no access. */
  .get('/:id/grants', async (c) => {
    const rows = await c.var.db.grant.findMany({ where: { teammateId: c.req.param('id') } })
    return c.json(rows.map((g) => ({ connectionId: g.connectionId, scope: g.scope })))
  })

  .put('/:id/grants', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const { db, scope } = c.var
    const input = await parseBody(c.req.raw, SetGrant)
    const teammate = await db.teammate.findFirst({
      where: { id: c.req.param('id'), archivedAt: null },
    })
    const connection = await db.connection.findFirst({
      where: { id: input.connectionId, status: { not: 'removed' } },
    })
    if (!teammate || !connection)
      throw new HTTPException(404, { message: 'Teammate or connection not found' })
    await db.grant.deleteMany({ where: { teammateId: teammate.id, connectionId: connection.id } })
    if (input.scope !== 'none') {
      await db.grant.create({
        data: { teammateId: teammate.id, connectionId: connection.id, scope: input.scope } as never,
      })
    }
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'grant.set',
      target: { type: 'teammate', id: teammate.id },
      data: { connectionId: connection.id, scope: input.scope },
    })
    return c.json({ ok: true })
  })

  .delete('/:id', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const { count } = await c.var.db.teammate.updateMany({
      where: { id: c.req.param('id'), archivedAt: null },
      data: { archivedAt: new Date() },
    })
    if (count === 0) throw new HTTPException(404, { message: 'Teammate not found' })
    await audit({
      ...c.var.scope,
      actor: { type: 'member', id: c.var.scope.memberId },
      action: 'teammate.archived',
      target: { type: 'teammate', id: c.req.param('id') },
    })
    return c.body(null, 204)
  })
