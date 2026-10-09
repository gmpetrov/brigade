import { randomUUID } from 'node:crypto'
import {
  AnswerQuestion,
  DesktopClipboard,
  HandBack,
  mentionsToText,
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
import { desktopUrl, ensureRunning } from '../cloud.js'
import { openView } from '../desktop-proxy.js'
import { answerQuestion, resolveTicket } from '../decide.js'
import type { ScopedDb } from '../db.js'
import { broadcastThreadStatus, desktopClipboard, dispatch } from '../hub.js'
import { loadThread, specFor } from '../thread-spec.js'
import { promptThread, startThread } from '../work.js'
import { runLog } from '../timeline.js'
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
const openCapTicket = (db: ScopedDb, sessionId: string) =>
  db.ticket.findFirst({ where: { sessionId, type: 'cap', status: 'open' } })

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
        webhook: { select: { id: true, label: true } },
        tickets: {
          where: { status: 'open' },
          select: { id: true, type: true, title: true, payload: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!thread) throw new HTTPException(404, { message: 'Thread not found' })
    return c.json({
      ...thread,
      mayPrompt: thread.startedByMemberId === c.var.scope.memberId || thread.othersMayPrompt,
    })
  })

  /** The thread end to end: events, connector calls, tickets and who did what. */
  .get('/:id/log', async (c) => {
    const thread = await loadThread(c.var.db, c.req.param('id'))
    return c.json(await runLog(c.var.db, thread.id))
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
    const { thread, outcome } = await startThread(db, scope, {
      teammate,
      computer,
      memberId: scope.memberId,
      accountId: input.accountId ?? null,
      title: mentionsToText(input.text).split('\n')[0]!,
      text: input.text,
    })
    if (outcome === 'offline') {
      throw new HTTPException(409, {
        message: 'That computer is offline. Start its runner and try again.',
      })
    }
    return c.json({ id: thread.id, paused: outcome === 'paused' }, 201)
  })

  /** A reply continues the same harness session. */
  .post('/:id/messages', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    requireMayPrompt(scope, thread)
    if (thread.status === 'waiting')
      throw new HTTPException(409, { message: 'Approve or deny the pending request first' })
    if (thread.status === 'paused' && (await openCapTicket(db, thread.id)))
      throw new HTTPException(409, {
        message: 'This thread is paused at a daily cap. An admin decides in Tickets.',
      })
    const { text } = await parseBody(c.req.raw, SendMessage)
    const outcome = await promptThread(db, scope, thread, { text, memberId: scope.memberId })
    if (outcome === 'offline')
      throw new HTTPException(409, {
        message: 'That computer is offline. Start its runner and try again.',
      })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'thread.prompted',
      target: { type: 'thread', id: thread.id },
    })
    return c.json({ ok: true, paused: outcome === 'paused' })
  })

  .post('/:id/approvals', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    requireMayPrompt(scope, thread)
    const input = await parseBody(c.req.raw, ResolveApproval)
    // The approval's ticket: a connector write (its id is the ticket's) or a harness request.
    const ticket = await db.ticket.findFirst({
      where: {
        sessionId: thread.id,
        status: 'open',
        OR: [
          { id: input.approvalId },
          { payload: { path: ['approvalId'], equals: input.approvalId } },
        ],
      },
    })
    if (ticket) {
      return c.json(
        await resolveTicket(scope, ticket.id, {
          approved: input.approved,
          ...(input.reason ? { reason: input.reason } : {}),
        }),
      )
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

  /** Answer the harness's question in this thread. */
  .post('/:id/answers', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    requireMayPrompt(scope, thread)
    const input = await parseBody(c.req.raw, AnswerQuestion)
    const ticket = await db.ticket.findFirst({
      where: {
        sessionId: thread.id,
        type: 'question',
        status: 'open',
        payload: { path: ['questionId'], equals: input.questionId },
      },
    })
    if (!ticket) throw new HTTPException(404, { message: 'Question not found or already answered' })
    return c.json(await answerQuestion(scope, ticket.id, input.answer))
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

  /**
   * The computer's desktop: watch the teammate work, or use it after taking
   * over. Watching never wakes a stopped computer; having control does.
   */
  .post('/:id/desktop', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    if (thread.computer.kind !== 'cloud') {
      throw new HTTPException(409, {
        message: "This thread runs on a member's own machine. Its desktop is theirs.",
      })
    }
    if (thread.computer.status !== 'running') {
      if (thread.controlledByMemberId === scope.memberId) {
        await ensureRunning(thread.computer.id)
        // 503: the dashboard asks again until the computer is up.
        throw new HTTPException(503, { message: 'Starting the workspace computer…' })
      }
      throw new HTTPException(409, {
        message: 'The workspace computer is not running. It starts with the next message.',
      })
    }
    const url = await desktopUrl(thread.computer)
    if (!url)
      throw new HTTPException(409, {
        message: 'The desktop is not available yet. Try again in a moment.',
      })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'desktop.watched',
      target: { type: 'thread', id: thread.id },
    })
    // Relayed through this API. View only until takeover is the viewer's own
    // setting, not a boundary: any member may take over anyway.
    return c.json(await openView(url))
  })

  /**
   * Copy and paste through the desktop view: set the desktop's clipboard, or
   * read it. VNC alone carries neither direction reliably. In control only.
   */
  .post('/:id/desktop/clipboard', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    if (thread.computer.kind !== 'cloud' || thread.controlledByMemberId !== scope.memberId) {
      throw new HTTPException(409, { message: 'Take over to use the desktop clipboard' })
    }
    const { text } = await parseBody(c.req.raw, DesktopClipboard)
    try {
      return c.json({ text: await desktopClipboard(thread.computer.id, text) })
    } catch (error) {
      throw new HTTPException(503, { message: (error as Error).message })
    }
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
