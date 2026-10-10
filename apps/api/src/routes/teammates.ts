import { randomUUID } from 'node:crypto'
import {
  CreateTeammate,
  isHarnessModel,
  OpenBrowser,
  UpdateTeammate,
  SetGrant,
} from '@brigade/contracts'
import { dispatch } from '../hub.js'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { audit } from '../audit.js'
import { usageToday } from '../caps.js'
import { teammateTimeline } from '../timeline.js'
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

  /** Per thread: working, waiting for approval, blocked and done. Default: the last 24 hours. */
  .get('/:id/timeline', async (c) => {
    const teammate = await c.var.db.teammate.findFirst({ where: { id: c.req.param('id') } })
    if (!teammate) throw new HTTPException(404, { message: 'Teammate not found' })
    const to = new Date(c.req.query('to') ?? Date.now())
    const from = new Date(c.req.query('from') ?? to.getTime() - 24 * 3600_000)
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to)
      throw new HTTPException(400, { message: 'Bad time range' })
    if (to.getTime() - from.getTime() > 31 * 24 * 3600_000)
      throw new HTTPException(400, { message: 'At most 31 days at a time' })
    const [timeline, usage] = await Promise.all([
      teammateTimeline(c.var.db, teammate.id, from, to),
      usageToday(c.var.db, teammate),
    ])
    return c.json({ ...timeline, usage })
  })

  /**
   * Open a window of the teammate's browser on the workspace computer, e.g. to
   * sign it in to a site. The person then uses the computer's desktop.
   */
  .post('/:id/browser', async (c) => {
    const { scope, db } = c.var
    const teammate = await db.teammate.findFirst({
      where: { id: c.req.param('id'), archivedAt: null },
    })
    if (!teammate) throw new HTTPException(404, { message: 'Teammate not found' })
    const { url } = await parseBody(c.req.raw, OpenBrowser)
    const computer = await db.computer.findFirst({
      where: { kind: 'cloud', status: { notIn: ['destroyed', 'error'] } },
    })
    if (!computer)
      throw new HTTPException(409, {
        message: 'Teammate browsers live on the workspace computer, and this workspace has none',
      })
    await dispatch(computer, {
      type: 'browser.open',
      commandId: randomUUID(),
      teammateId: teammate.id,
      teammateName: teammate.name,
      ...(url ? { url } : {}),
    })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'browser.opened',
      target: { type: 'teammate', id: teammate.id },
      data: { computerId: computer.id, ...(url ? { url } : {}) },
    })
    return c.json({ computerId: computer.id })
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
    if (input.harness !== undefined || input.model !== undefined) {
      const current = await c.var.db.teammate.findFirst({
        where: { id: c.req.param('id'), archivedAt: null },
        select: { harness: true, model: true },
      })
      if (!current) throw new HTTPException(404, { message: 'Teammate not found' })
      const harness = input.harness ?? current.harness
      const model = input.model === undefined ? current.model : input.model
      // A model saved before the list existed stays until someone changes it.
      const unchanged = harness === current.harness && model === current.model
      if (!unchanged && !isHarnessModel(harness, model)) {
        // A new harness can't run the old one's model: fall back to the account's default.
        if (input.model === undefined) input.model = null
        else throw new HTTPException(400, { message: 'Not a model this agent can run' })
      }
    }
    // Changing caps or the permission policy is an admin's decision, recorded with the new values.
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
      data: {
        fields: Object.keys(input),
        ...(input.caps ? { caps: input.caps } : {}),
        ...(input.permissionPolicy ? { permissionPolicy: input.permissionPolicy } : {}),
      },
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
