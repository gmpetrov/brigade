import { randomUUID } from 'node:crypto'
import {
  CreateTeam,
  CreateTeammate,
  DesktopClipboard,
  isHarnessModel,
  OpenBrowser,
  UpdateTeammate,
  SetGrant,
  TeachRecording,
  type TeachState,
} from '@brigade/contracts'
import { desktopClipboard, dispatch } from '../hub.js'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { requireAccountManager } from '../apps.js'
import { audit } from '../audit.js'
import { ensureRunning } from '../cloud.js'
import type { ScopedDb } from '../db.js'
import { watchDesktop } from '../desktop-proxy.js'
import { refuseChiefName } from '../chief.js'
import { deleteTriggers, resync } from './triggers.js'
import { usageToday } from '../caps.js'
import { endRecording, holdRecording, recorder } from '../teaching.js'
import { teammateTimeline } from '../timeline.js'
import { parseBody, requireRole, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

export const teammates = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .get('/', async (c) => {
    // The chief first: it is where new work starts.
    const rows = await c.var.db.teammate.findMany({
      where: { archivedAt: null },
      orderBy: [{ kind: 'desc' }, { createdAt: 'asc' }],
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
   * The workspace computer's desktop, from a teammate: the screen its threads run
   * on, its own browser among them. To watch, or to record a task on it (Teach a
   * task), which wakes a stopped computer as a thread's control does.
   */
  .post('/:id/desktop', async (c) => {
    const { scope, db } = c.var
    const { teammate, computer } = await teammateComputer(db, c.req.param('id'))
    if (computer.status !== 'running' && recorder(computer.id) === scope.memberId) {
      await ensureRunning(computer.id)
      // 503: the dashboard asks again until the computer is up.
      throw new HTTPException(503, { message: 'Starting the cloud computer…' })
    }
    const view = await watchDesktop(computer)
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'desktop.watched',
      target: { type: 'teammate', id: teammate.id },
    })
    return c.json(view)
  })

  /** Copy and paste through the desktop view, while this member records a task on it. */
  .post('/:id/desktop/clipboard', async (c) => {
    const { scope, db } = c.var
    const { computer } = await teammateComputer(db, c.req.param('id'))
    if (recorder(computer.id) !== scope.memberId)
      throw new HTTPException(409, { message: 'Start recording to use the desktop clipboard' })
    const { text } = await parseBody(c.req.raw, DesktopClipboard)
    try {
      return c.json({ text: await desktopClipboard(computer.id, text) })
    } catch (error) {
      throw new HTTPException(503, { message: (error as Error).message })
    }
  })

  /**
   * Before Teach a task records: who records on the cloud computer already, and how
   * many threads run there (their teammates may use the screen meanwhile).
   */
  .get('/:id/teach', async (c) => {
    const { db } = c.var
    const { computer } = await teammateComputer(db, c.req.param('id'))
    return c.json(await teachState(db, computer.id, c.var.scope.memberId, c.req.query('threadId')))
  })

  /**
   * Teach a task holds the cloud computer while it records, renewed by the dashboard
   * until it ends. No thread is needed: a recording from Home starts its thread once sent.
   */
  .post('/:id/teach', async (c) => {
    const { scope, db } = c.var
    const { computer } = await teammateComputer(db, c.req.param('id'))
    const { threadId } = await parseBody(c.req.raw, TeachRecording)
    const other = holdRecording(computer.id, scope.memberId)
    if (other)
      throw new HTTPException(409, {
        message: `${await memberName(db, other)} is recording a task on the cloud computer. Try again once they’re done.`,
      })
    void ensureRunning(computer.id).catch(() => undefined)
    return c.json(await teachState(db, computer.id, scope.memberId, threadId))
  })
  .post('/:id/teach/end', async (c) => {
    const { scope, db } = c.var
    const { computer } = await teammateComputer(db, c.req.param('id'))
    endRecording(computer.id, scope.memberId)
    return c.json({ ok: true })
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
        message: 'Teammate browsers live on the cloud computer, and this workspace has none',
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
    refuseChiefName(input.name)
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

  /**
   * The team a person accepted from the chief's proposal, as they edited it.
   * Each teammate gets the connections it needs that the workspace has, and
   * starts out asking before every write; the rest it gets once connected.
   */
  .post('/team', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const { db, scope } = c.var
    const { teammates: proposed } = await parseBody(c.req.raw, CreateTeam)
    for (const t of proposed) refuseChiefName(t.name)
    const connections = await db.connection.findMany({
      where: { status: { not: 'removed' }, kind: { not: 'webhook' } },
      orderBy: { createdAt: 'asc' },
    })
    // They run on the same agent as the chief, which runs on the member's account.
    const chief = await db.teammate.findFirst({ where: { kind: 'chief' } })
    const created = []
    for (const t of proposed) {
      const row = await db.teammate.create({
        data: {
          name: t.name,
          instructions: t.instructions,
          harness: chief?.harness ?? 'claude_code',
          permissionPolicy: { connectorWrites: 'ask' },
        } as never,
      })
      for (const need of t.connections) {
        const connection = connections.find((x) => x.kind === need.kind)
        if (!connection) continue
        await db.grant.create({
          data: { teammateId: row.id, connectionId: connection.id, scope: need.scope } as never,
        })
      }
      await audit({
        ...scope,
        actor: { type: 'member', id: scope.memberId },
        action: 'teammate.created',
        target: { type: 'teammate', id: row.id },
        data: {
          name: row.name,
          harness: row.harness,
          from: 'chief',
          connections: t.connections.map((x) => `${x.kind}:${x.scope}`),
        },
      })
      created.push({ id: row.id, name: row.name })
    }
    return c.json({ teammates: created }, 201)
  })

  .patch('/:id', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const input = await parseBody(c.req.raw, UpdateTeammate)
    if (input.name !== undefined) {
      const chief = await c.var.db.teammate.findFirst({
        where: { id: c.req.param('id'), kind: 'chief' },
        select: { name: true },
      })
      // The chief keeps its name, so @chief always reaches it.
      if (chief) {
        if (input.name !== chief.name)
          throw new HTTPException(400, { message: "The chief's name can't change" })
      } else refuseChiefName(input.name)
    }
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
        ...(input.libraryAccess ? { libraryAccess: input.libraryAccess } : {}),
      },
    })
    return c.json(await c.var.db.teammate.findFirst({ where: { id: c.req.param('id') } }))
  })

  /** Which connections this teammate may use, and how. No grant means no access. */
  .get('/:id/grants', async (c) => {
    const rows = await c.var.db.grant.findMany({ where: { teammateId: c.req.param('id') } })
    return c.json(rows.map((g) => ({ connectionId: g.connectionId, scope: g.scope })))
  })

  /** Give a teammate an account, or take it back: an admin, or the member who connected it. */
  .put('/:id/grants', async (c) => {
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
    requireAccountManager(scope, connection)
    if (connection.kind === 'webhook')
      throw new HTTPException(400, {
        message: 'A custom app only sends events; there is nothing to grant',
      })
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
    if (await c.var.db.teammate.count({ where: { id: c.req.param('id'), kind: 'chief' } }))
      throw new HTTPException(400, { message: 'Every workspace keeps its chief' })
    const { count } = await c.var.db.teammate.updateMany({
      // Every workspace keeps its chief.
      where: { id: c.req.param('id'), archivedAt: null, kind: 'teammate' },
      data: { archivedAt: new Date() },
    })
    if (count === 0) throw new HTTPException(404, { message: 'Teammate not found' })
    // Its triggers go, and with them the vendor subscriptions only they needed.
    const removed = await deleteTriggers(c.var.db, { teammateId: c.req.param('id') })
    await resync(
      c.var.scope,
      removed.map((t) => t.connectionId),
    )
    await audit({
      ...c.var.scope,
      actor: { type: 'member', id: c.var.scope.memberId },
      action: 'teammate.archived',
      target: { type: 'teammate', id: c.req.param('id') },
    })
    return c.body(null, 204)
  })

/** The teammate, and the workspace's cloud computer its threads run on. */
async function teammateComputer(db: ScopedDb, id: string) {
  const teammate = await db.teammate.findFirst({ where: { id, archivedAt: null } })
  if (!teammate) throw new HTTPException(404, { message: 'Teammate not found' })
  const computer = await db.computer.findFirst({
    where: { kind: 'cloud', status: { notIn: ['destroyed', 'error'] } },
  })
  if (!computer)
    throw new HTTPException(409, {
      message: "This workspace has no cloud computer: its teammates run on members' machines",
    })
  return { teammate, computer }
}

async function memberName(db: ScopedDb, memberId: string) {
  const member = await db.member.findFirst({
    where: { id: memberId },
    select: { user: { select: { name: true } } },
  })
  return member?.user.name || 'Another member'
}

/** Who else records on the computer, and how many threads run there besides this one. */
async function teachState(db: ScopedDb, computerId: string, memberId: string, threadId?: string) {
  const by = recorder(computerId)
  const running = await db.session.count({
    where: {
      computerId,
      status: { in: ['starting', 'running'] },
      ...(threadId && { id: { not: threadId } }),
    },
  })
  return {
    recordingBy: by && by !== memberId ? await memberName(db, by) : null,
    running,
  } satisfies TeachState
}
