import { randomUUID } from 'node:crypto'
import {
  HandBack,
  TakeOver,
  ResolveApproval,
  SendMessage,
  StartThread,
  type ThreadSpec,
  type ApiToRunner,
} from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { audit } from '../audit.js'
import { decideTicket } from '../connector-calls.js'
import type { ScopedDb } from '../db.js'
import { broadcastThreadStatus, dispatch } from '../hub.js'
import { usableAccounts } from './accounts.js'
import { loadThread, noAccount, specFor } from '../thread-spec.js'
import {
  parseBody,
  requireUser,
  requireWorkspace,
  type AppEnv,
  type WorkspaceScope,
} from '../scope.js'

/** Prompting or approving spends the starter's subscription: only they may, unless they allow it. */
function requireMayPrompt(
  scope: WorkspaceScope,
  thread: {
    startedByMemberId: string
    othersMayPrompt: boolean
    controlledByMemberId: string | null
  },
) {
  if (thread.startedByMemberId !== scope.memberId && !thread.othersMayPrompt) {
    throw new HTTPException(403, {
      message: "This thread runs on another member's subscription. Fork it to continue.",
    })
  }
  if (thread.controlledByMemberId) {
    throw new HTTPException(409, {
      message: 'A person has control of this thread. It continues when they hand it back.',
    })
  }
}

/** Send to the thread's computer; a stopped workspace computer is resumed first. */
async function deliver(computer: { id: string; kind: string }, message: ApiToRunner) {
  if ((await dispatch(computer, message)) === 'offline') {
    throw new HTTPException(409, {
      message: 'That computer is offline. Start its runner and try again.',
    })
  }
}

export const threads = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .get('/', async (c) => {
    const teammateId = c.req.query('teammateId')
    const rows = await c.var.db.session.findMany({
      where: teammateId ? { teammateId } : {},
      orderBy: { updatedAt: 'desc' },
      take: 100,
      include: {
        teammate: { select: { id: true, name: true } },
        startedBy: { select: { id: true, user: { select: { name: true } } } },
      },
    })
    return c.json(rows)
  })

  .get('/:id', async (c) => {
    const thread = await c.var.db.session.findFirst({
      where: { id: c.req.param('id') },
      include: {
        teammate: { select: { id: true, name: true, harness: true, model: true } },
        computer: { select: { id: true, name: true, kind: true } },
        account: { select: { id: true, label: true, status: true } },
        startedBy: { select: { id: true, user: { select: { name: true } } } },
      },
    })
    if (!thread) throw new HTTPException(404, { message: 'Thread not found' })
    return c.json({
      ...thread,
      mayPrompt: thread.startedByMemberId === c.var.scope.memberId || thread.othersMayPrompt,
    })
  })

  /** A new top-level message starts a new thread with a fresh context. */
  .post('/', async (c) => {
    const { scope, db } = c.var
    const input = await parseBody(c.req.raw, StartThread)
    const teammate = await db.teammate.findFirst({
      where: { id: input.teammateId, archivedAt: null },
    })
    if (!teammate) throw new HTTPException(404, { message: 'Teammate not found' })
    const computer = await db.computer.findFirst({ where: { id: input.computerId } })
    if (!computer || (computer.kind === 'member_machine' && computer.memberId !== scope.memberId)) {
      throw new HTTPException(404, { message: 'Computer not found' })
    }
    // A thread runs on the starting member's accounts, never anyone else's.
    const [account] = await usableAccounts(db, {
      memberId: scope.memberId,
      computerId: computer.id,
      provider: teammate.harness,
      preferredId: input.accountId ?? null,
    })
    if (!account) throw noAccount(teammate.harness)

    const thread = await db.session.create({
      data: {
        teammateId: teammate.id,
        startedByMemberId: scope.memberId,
        computerId: computer.id,
        accountId: account.id,
        title: input.text.split('\n')[0]!.slice(0, 120),
      } as never,
      include: { teammate: true, computer: true },
    })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'thread.started',
      target: { type: 'thread', id: thread.id },
      data: { teammateId: teammate.id, computerId: computer.id, accountId: account.id },
    })
    const sent = await dispatch(computer, {
      type: 'thread.prompt',
      commandId: randomUUID(),
      thread: await specFor(db, thread),
      text: input.text,
      memberId: scope.memberId,
    })
    if (sent === 'offline') {
      await db.session.updateMany({ where: { id: thread.id }, data: { status: 'failed' } })
      throw new HTTPException(409, {
        message: 'That computer is offline. Start its runner and try again.',
      })
    }
    return c.json({ id: thread.id }, 201)
  })

  /** A reply continues the same harness session. */
  .post('/:id/messages', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    requireMayPrompt(scope, thread)
    if (thread.status === 'waiting')
      throw new HTTPException(409, { message: 'Approve or deny the pending request first' })
    const { text } = await parseBody(c.req.raw, SendMessage)
    await deliver(thread.computer, {
      type: 'thread.prompt',
      commandId: randomUUID(),
      thread: await specFor(db, thread),
      text,
      memberId: scope.memberId,
    })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'thread.prompted',
      target: { type: 'thread', id: thread.id },
    })
    return c.json({ ok: true })
  })

  .post('/:id/approvals', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    requireMayPrompt(scope, thread)
    const input = await parseBody(c.req.raw, ResolveApproval)
    // A connector write waiting on this thread: the API decides, not the harness.
    const ticket = await db.ticket.findFirst({
      where: { id: input.approvalId, sessionId: thread.id, type: 'approval', status: 'open' },
    })
    if (ticket) {
      const live = await decideTicket(scope, ticket.id, {
        approved: input.approved,
        ...(input.reason ? { reason: input.reason } : {}),
      })
      return c.json({ ok: true, live })
    }
    await deliver(thread.computer, {
      type: 'thread.approval',
      commandId: randomUUID(),
      thread: await specFor(db, thread),
      approvalId: input.approvalId,
      approved: input.approved,
      ...(input.reason ? { reason: input.reason } : {}),
      memberId: scope.memberId,
    })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: input.approved ? 'approval.approved' : 'approval.denied',
      target: { type: 'thread', id: thread.id },
      data: { approvalId: input.approvalId },
    })
    return c.json({ ok: true })
  })

  .post('/:id/interrupt', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    requireMayPrompt(scope, thread)
    await deliver(thread.computer, {
      type: 'thread.interrupt',
      commandId: randomUUID(),
      sessionId: thread.id,
    })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'thread.interrupted',
      target: { type: 'thread', id: thread.id },
    })
    return c.json({ ok: true })
  })

  /** Takeover: a person steps in; the teammate stops now or after its current turn. */
  .post('/:id/takeover', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    if (thread.computer.kind !== 'cloud') {
      throw new HTTPException(409, {
        message:
          'On your own machine, just use your machine. Takeover is for the workspace computer.',
      })
    }
    if (thread.controlledByMemberId && thread.controlledByMemberId !== scope.memberId) {
      throw new HTTPException(409, { message: 'Another member has control of this thread' })
    }
    const { interrupt } = await parseBody(c.req.raw, TakeOver)
    await db.session.updateMany({
      where: { id: thread.id },
      data: { controlledByMemberId: scope.memberId },
    })
    await deliver(thread.computer, {
      type: 'thread.takeover',
      commandId: randomUUID(),
      thread: await specFor(db, thread, { requireUsage: false }),
      memberId: scope.memberId,
      interrupt,
    })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'takeover.started',
      target: { type: 'thread', id: thread.id },
      data: { interrupt },
    })
    return c.json({ ok: true })
  })

  /** Hand back: the teammate continues, told the person's note and what changed. */
  .post('/:id/handback', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    if (thread.controlledByMemberId !== scope.memberId)
      throw new HTTPException(409, { message: 'You do not have control of this thread' })
    const { note } = await parseBody(c.req.raw, HandBack)
    await db.session.updateMany({ where: { id: thread.id }, data: { controlledByMemberId: null } })
    await deliver(thread.computer, {
      type: 'thread.handback',
      commandId: randomUUID(),
      thread: await specFor(db, thread, { requireUsage: false }),
      memberId: scope.memberId,
      note,
    })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'takeover.ended',
      target: { type: 'thread', id: thread.id },
    })
    return c.json({ ok: true })
  })

  /** Only the starter changes who may prompt on their subscription. */
  .patch('/:id', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    if (thread.startedByMemberId !== scope.memberId)
      throw new HTTPException(403, {
        message: 'Only the member who started this thread can change it',
      })
    const input = await parseBody(
      c.req.raw,
      z.object({ othersMayPrompt: z.boolean().optional(), private: z.boolean().optional() }),
    )
    await db.session.updateMany({ where: { id: thread.id }, data: input })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'thread.updated',
      target: { type: 'thread', id: thread.id },
      data: input,
    })
    broadcastThreadStatus(scope.workspaceId, thread.id, thread.status)
    return c.json({ ok: true })
  })
