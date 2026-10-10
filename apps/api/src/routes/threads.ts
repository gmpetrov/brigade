import { randomUUID } from 'node:crypto'
import {
  FILE_VIEW_MAX,
  VIEWABLE_FILE,
  AnswerQuestion,
  AnswerTicket,
  DesktopClipboard,
  HandBack,
  mentionsToText,
  TakeOver,
  ResolveApproval,
  SendMessage,
  StartThread,
  type ThreadFile,
  type ThreadSpec,
  type ApiToRunner,
} from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { readAttachment, toInfo } from '../attachments.js'
import { audit } from '../audit.js'
import { desktopUrl, ensureRunning } from '../cloud.js'
import { openView } from '../desktop-proxy.js'
import { answerQuestion, answerTicket, resolveTicket } from '../decide.js'
import type { ScopedDb } from '../db.js'
import { broadcastThreadStatus, desktopClipboard, dispatch, readThreadFile } from '../hub.js'
import { contentTypeFor, isText } from '../library.js'
import { loadThread, specFor } from '../thread-spec.js'
import { joinThread, mentionedTeammates, promptWithAttachments, startThread } from '../work.js'
import { runLog } from '../timeline.js'
import {
  parseBody,
  requireUser,
  requireWorkspace,
  type AppEnv,
  type WorkspaceScope,
} from '../scope.js'

/** The ids of a thread's teammates, the one asked for first (whose folder is tried first). */
function teammatesFirst(
  thread: { teammateId: string; teammates: { teammateId: string }[] },
  asked: string | undefined,
) {
  const ids = [...new Set([thread.teammateId, ...thread.teammates.map((t) => t.teammateId)])]
  return asked && ids.includes(asked) ? [asked, ...ids.filter((i) => i !== asked)] : ids
}

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

/** A thread started with files and no words is named after its first file. */
async function attachedTitle(db: ScopedDb, attachmentIds: string[]) {
  const first = attachmentIds[0]
  const row = first ? await db.attachment.findFirst({ where: { id: first } }) : null
  const more = attachmentIds.length > 1 ? ` and ${attachmentIds.length - 1} more` : ''
  return row ? `${row.name}${more}` : 'Files'
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
      // A teammate's threads: those it started and those it joined.
      where: teammateId ? { teammates: { some: { teammateId } } } : {},
      orderBy: { updatedAt: 'desc' },
      take: 100,
      include: {
        teammate: { select: { id: true, name: true } },
        teammates: {
          select: { teammate: { select: { id: true, name: true } } },
          orderBy: { joinedAt: 'asc' },
        },
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
        teammates: {
          select: {
            joinedAt: true,
            lastTurnAt: true,
            teammate: { select: { id: true, name: true, harness: true, model: true } },
          },
          orderBy: { joinedAt: 'asc' },
        },
        computer: { select: { id: true, name: true, kind: true } },
        account: { select: { id: true, label: true, status: true } },
        startedBy: { select: { id: true, user: { select: { name: true } } } },
        trigger: { select: { id: true, label: true, event: true } },
        tickets: {
          where: { status: 'open' },
          select: { id: true, type: true, title: true, payload: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
        attachments: { include: { attachment: true }, orderBy: { createdAt: 'asc' } },
      },
    })
    if (!thread) throw new HTTPException(404, { message: 'Thread not found' })
    return c.json({
      ...thread,
      attachments: thread.attachments.map((a) => toInfo(a.attachment, a.path)),
      mayPrompt: thread.startedByMemberId === c.var.scope.memberId || thread.othersMayPrompt,
    })
  })

  /**
   * A file the thread mentions, for the panel beside it. A library path is
   * read from the library (the computer may be stopped); anything else from
   * the computer: the teammate's working folder for this thread, or the
   * library mirror. Any member who can see the thread can see its files.
   */
  .get('/:id/file', async (c) => {
    const { db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    // `src/a.ts:42` names a line; the panel shows the whole file.
    const path = (c.req.query('path') ?? '')
      .trim()
      .replace(/:\d+(:\d+)?$/, '')
      .replace(/^\.\//, '')
    if (!path || path.length > 1000) throw new HTTPException(400, { message: 'Which file?' })

    // A file given to the thread: its original, from the bucket (the computer may be stopped).
    const relative = path.startsWith('/')
      ? path.match(new RegExp(`/threads/${thread.id}/(attachments/.+)$`))?.[1]
      : path
    const given =
      relative &&
      (await db.threadAttachment.findFirst({
        where: { sessionId: thread.id, path: relative, attachment: { status: 'ready' } },
        include: { attachment: true },
      }))
    if (given) {
      const row = given.attachment
      const text =
        isText(row.contentType) &&
        new TextDecoder('utf-8', { fatal: false }).decode(
          (await readAttachment(c.var.scope, row.id)).subarray(0, FILE_VIEW_MAX),
        )
      return c.json({
        source: 'attachment',
        path: given.path,
        attachmentId: row.id,
        contentType: row.contentType,
        size: row.size,
        ...(text === false ? {} : { text }),
        truncated: row.size > FILE_VIEW_MAX,
      } satisfies ThreadFile)
    }

    // The library: its own path, or its mirror's path on a computer.
    const mirrored = path.startsWith('/') ? path.match(/\/library\/(.+)$/)?.[1] : undefined
    const library = await db.document.findFirst({
      where: { kind: 'library', path: { in: [path, ...(mirrored ? [mirrored] : [])] } },
    })
    if (library) {
      const row = library
      const editable = row.contentType.startsWith('text/') || /json|yaml|xml/.test(row.contentType)
      return c.json({
        source: 'library',
        path: row.path,
        documentId: row.id,
        contentType: row.contentType,
        size: row.size,
        // The extracted text of a text file is the file itself (indexed up to 400k characters).
        ...(editable && row.text.length < 400_000 ? { text: row.text } : {}),
        truncated: false,
      } satisfies ThreadFile)
    }

    const result = await readThreadFile(thread.computerId, {
      sessionId: thread.id,
      teammateIds: teammatesFirst(thread, c.req.query('teammateId')),
      path,
    })
    if (!result.ok)
      throw new HTTPException(result.error === 'not_found' ? 404 : 409, {
        message:
          result.error === 'not_found'
            ? `No file "${path}" in the library or the teammate's folder`
            : (result.error ?? 'Could not read the file'),
      })
    return c.json({
      source: 'thread',
      path: result.path ?? path,
      contentType: contentTypeFor(result.path ?? path),
      size: result.size ?? 0,
      ...(result.text === undefined ? {} : { text: result.text }),
      truncated: result.truncated ?? false,
      ...(result.teammateId ? { teammateId: result.teammateId } : {}),
    } satisfies ThreadFile)
  })

  /**
   * An image or PDF in a teammate's working folder, such as one it generated,
   * as itself. Inline but sandboxed: the dashboard shows a PDF from a copy it fetches.
   */
  .get('/:id/image', async (c) => {
    const thread = await loadThread(c.var.db, c.req.param('id'))
    const path = (c.req.query('path') ?? '').trim().replace(/^\.\//, '')
    if (!path || path.length > 1000 || !VIEWABLE_FILE.test(path))
      throw new HTTPException(400, { message: 'Which image or PDF?' })
    const result = await readThreadFile(thread.computerId, {
      sessionId: thread.id,
      teammateIds: teammatesFirst(thread, c.req.query('teammateId')),
      path,
      image: true,
    })
    if (!result.ok || result.data === undefined)
      throw new HTTPException(result.error === 'not_found' ? 404 : 409, {
        message:
          result.error === 'not_found'
            ? `No "${path}" in the teammate's folder`
            : (result.error ?? 'Could not read the file'),
      })
    return c.body(Buffer.from(result.data, 'base64'), 200, {
      'content-type': contentTypeFor(path),
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.split('/').pop()!)}`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
      'cache-control': 'private, max-age=3600',
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
    const firstLine = mentionsToText(input.text).split('\n')[0]!
    const { thread, outcome } = await startThread(db, scope, {
      teammate,
      computer,
      memberId: scope.memberId,
      accountId: input.accountId ?? null,
      title: firstLine || (await attachedTitle(db, input.attachmentIds)),
      text: input.text,
      attachmentIds: input.attachmentIds,
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
    const { text, attachmentIds } = await parseBody(c.req.raw, SendMessage)
    // Teammates the message mentions answer it, joining the thread if new; otherwise whoever answered last.
    const mentioned = await mentionedTeammates(db, text)
    const joined = mentioned.filter((id) => !thread.teammates.some((t) => t.teammateId === id))
    if (joined.length > 0) await joinThread(db, thread.id, joined)
    const outcome = await promptWithAttachments(
      db,
      scope,
      joined.length > 0 ? await loadThread(db, thread.id) : thread,
      {
        text,
        memberId: scope.memberId,
        ...(mentioned.length ? { teammateIds: mentioned } : {}),
        attachmentIds,
      },
      { memberId: scope.memberId },
    )
    if (outcome === 'offline')
      throw new HTTPException(409, {
        message: 'That computer is offline. Start its runner and try again.',
      })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'thread.prompted',
      target: { type: 'thread', id: thread.id },
      ...(joined.length > 0 ? { data: { joined } } : {}),
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

  /** Answer a ticket the teammate opened in this thread. */
  .post('/:id/tickets', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    requireMayPrompt(scope, thread)
    const input = await parseBody(c.req.raw, AnswerTicket)
    const ticket = await db.ticket.findFirst({
      where: {
        sessionId: thread.id,
        type: 'request',
        status: 'open',
        payload: { path: ['requestId'], equals: input.requestId },
      },
    })
    if (!ticket) throw new HTTPException(404, { message: 'Ticket not found or already answered' })
    return c.json(await answerTicket(scope, ticket.id, input.answer))
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
