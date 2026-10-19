import { randomUUID } from 'node:crypto'
import {
  FILE_VIEW_MAX,
  FOCUS_PROTOCOL,
  VIEWABLE_FILE,
  AnswerQuestion,
  AnswerTicket,
  DesktopClipboard,
  HandBack,
  InterruptThread,
  mentionsToText,
  MESSAGE_COMMANDS,
  messageCommand,
  MoveThread,
  skillCommand,
  PreviewAction,
  StartPreview,
  QueuedMessageAction,
  TakeOver,
  ResolveApproval,
  SendMessage,
  SetProject,
  StartThread,
  UpdateThread,
  type ThreadFile,
  type ThreadSpec,
  type ApiToRunner,
  type PreviewView,
  type ThreadPreviewState,
} from '@brigade/contracts'
import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { readAttachment, toInfo } from '../attachments.js'
import { audit } from '../audit.js'
import {
  latestPreview,
  livePreview,
  previewLogs,
  previewOffline,
  previewStates,
  startPreview,
  touchPreview,
} from '../app-previews.js'
import { ensureRunning, hostedPort } from '../cloud.js'
import { applyPick, checkPick } from '../designs.js'
import { watchDesktop } from '../desktop-proxy.js'
import { answerQuestion, answerTicket, resolveTicket } from '../decide.js'
import type { ScopedDb } from '../db.js'
import {
  broadcastSchedule,
  broadcastTask,
  broadcastThreadStatus,
  desktopClipboard,
  dispatch,
  eventsWaitingSince,
  readThreadFile,
  runnerProtocol,
  sendToRunner,
} from '../hub.js'
import { contentTypeFor, isText } from '../library.js'
import { projectWhere, usableProject } from '../projects.js'
import { currentTeammate, loadThread, requireMayPrompt, specFor } from '../thread-spec.js'
import { movePublic, requestMove } from '../move.js'
import {
  handBack,
  joinThread,
  mentionedTeammates,
  promptWithAttachments,
  startThread,
} from '../work.js'
import { waitingOnPerson } from '../pull-requests.js'
import { reopenOnMessage } from '../tasks.js'
import { recorder } from '../teaching.js'
import { setThreadArchived } from '../thread-archive.js'
import { descendants } from '../children.js'
import { deleteThread } from '../thread-delete.js'
import { cancelWakeup } from '../wakeups.js'
import { surface } from '../playbooks.js'
import { runLog } from '../timeline.js'
import { historyContext, pageEvents, pageStart } from '../thread-history.js'
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

/** Starting, restarting and stopping a thread's preview is for people who may write in it. */
function mayPrompt(
  thread: { startedByMemberId: string | null; othersMayPrompt: boolean },
  memberId: string,
) {
  if (thread.startedByMemberId !== memberId && !thread.othersMayPrompt)
    throw new HTTPException(403, { message: 'Only who may write in this thread can do that' })
}

const isAdmin = (scope: WorkspaceScope) => scope.role === 'owner' || scope.role === 'admin'

/** Renaming and archiving a thread is for who may write in it, and admins. */
function mayChange(
  scope: WorkspaceScope,
  thread: { startedByMemberId: string | null; othersMayPrompt: boolean },
) {
  if (thread.startedByMemberId !== scope.memberId && !thread.othersMayPrompt && !isAdmin(scope))
    throw new HTTPException(403, { message: 'Only who may write in this thread can do that' })
}

async function archive(c: Context<AppEnv>, on: boolean) {
  const { scope, db } = c.var
  const thread = await loadThread(db, c.req.param('id')!)
  mayChange(scope, thread)
  await setThreadArchived(scope, thread.id, on)
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: on ? 'thread.archived' : 'thread.unarchived',
    target: { type: 'thread', id: thread.id },
  })
  return c.json({ ok: true })
}

/**
 * Unread for a member: a teammate finished a turn after they last looked, or since it
 * started when they never have.
 */
const unread = (lastTurnAt: Date | null | undefined, seenAt: Date | undefined) =>
  !!lastTurnAt && (!seenAt || lastTurnAt > seenAt)

export const threads = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  /** ?teammateId= for a teammate's threads; ?project=<id|none> for a project's, or those in none. */
  .get('/', async (c) => {
    const teammateId = c.req.query('teammateId')
    // With a limit, a page in the order they were started, newest first (the threads
    // panel reads them as a conversation): `before` is the oldest one already shown.
    // `sort=activity` instead: the latest active first (the teammate menu's recent ones).
    const asked = Math.trunc(Number(c.req.query('limit')))
    const limit = asked > 0 ? Math.min(asked, 100) : undefined
    const before = c.req.query('before')
    const include = {
      teammate: { select: { id: true, name: true } },
      teammates: {
        select: { teammate: { select: { id: true, name: true } } },
        orderBy: { joinedAt: 'asc' as const },
      },
      startedBy: { select: { id: true, user: { select: { name: true } } } },
      // Where it runs: the sidebar marks a member's own machine.
      computer: { select: { kind: true, name: true } },
    }
    const rows = await c.var.db.session.findMany({
      where: {
        // A teammate's threads: those it started and those it joined.
        ...(teammateId ? { teammates: { some: { teammateId } } } : {}),
        ...projectWhere(c.req.query('project')),
        // Archived ones only when asked for: ?archived=1.
        archivedAt: c.req.query('archived') === '1' ? { not: null } : null,
        // Child threads show in their parent, not in lists.
        parentId: null,
        // A playbook's runs, once a person took part in them (src/playbooks.ts).
        OR: [{ playbookRunId: null }, { surfacedAt: { not: null } }],
      },
      ...(limit
        ? {
            orderBy:
              c.req.query('sort') === 'activity'
                ? [{ updatedAt: 'desc' as const }, { id: 'desc' as const }]
                : [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
            take: limit,
            ...(before ? { cursor: { id: before }, skip: 1 } : {}),
          }
        : { orderBy: { updatedAt: 'desc' as const }, take: 100 }),
      include,
    })
    // This member's pins. The whole list (the sidebar's) has every pinned thread, however
    // long ago it was active.
    const pins = await c.var.db.threadPin.findMany({
      where: { memberId: c.var.scope.memberId },
      select: { sessionId: true, pinnedAt: true },
    })
    if (!limit && !teammateId && !c.req.query('project') && c.req.query('archived') !== '1') {
      const loaded = new Set(rows.map((r) => r.id))
      const missing = pins.map((p) => p.sessionId).filter((id) => !loaded.has(id))
      if (missing.length)
        rows.push(
          ...(await c.var.db.session.findMany({
            where: { id: { in: missing }, archivedAt: null, parentId: null },
            include,
          })),
        )
    }
    // How much each one was answered, for the list's replies line: people's messages
    // after the first, and the teammates' turns.
    const counts = rows.length
      ? await c.var.db.sessionEvent.groupBy({
          by: ['sessionId', 'type'],
          where: {
            sessionId: { in: rows.map((r) => r.id) },
            type: { in: ['message.user', 'turn.completed'] },
          },
          _count: { _all: true },
          _max: { at: true },
        })
      : []
    // Its open pull requests that wait on a person, the same ones Home lists.
    const pulls = rows.length
      ? await c.var.db.pullRequest.groupBy({
          by: ['sessionId'],
          where: { ...waitingOnPerson, sessionId: { in: rows.map((r) => r.id) } },
          _count: { _all: true },
        })
      : []
    // Children it waits for, at work: it shows as working, as for its own background work.
    const working = rows.length
      ? await c.var.db.session.groupBy({
          by: ['parentId'],
          where: {
            parentId: { in: rows.map((r) => r.id) },
            awaited: true,
            status: { in: ['starting', 'running'] },
          },
          _count: { _all: true },
        })
      : []
    // Whose preview is up: the sidebar marks them. Not on a computer that is gone, whatever
    // the events say, as on the preview panel.
    const previews = await previewStates(
      c.var.db,
      rows.map((r) => r.id),
    )
    // When this member last looked at each: a teammate's turn after it is unread for them.
    const reads = rows.length
      ? await c.var.db.threadRead.findMany({
          where: { memberId: c.var.scope.memberId, sessionId: { in: rows.map((r) => r.id) } },
          select: { sessionId: true, seenAt: true },
        })
      : []
    return c.json(
      rows.map((row) => {
        const of = (type: string) => counts.find((n) => n.sessionId === row.id && n.type === type)
        const messages = of('message.user')
        const turns = of('turn.completed')
        const asked = Math.max(0, (messages?._count._all ?? 0) - 1)
        const latest = [asked ? messages?._max.at : null, turns?._max.at]
          .filter((at): at is Date => !!at)
          .sort((x, y) => y.getTime() - x.getTime())[0]
        return {
          ...row,
          replies: asked + (turns?._count._all ?? 0),
          lastReplyAt: latest?.toISOString() ?? null,
          unread: unread(turns?._max.at, reads.find((r) => r.sessionId === row.id)?.seenAt),
          pullsWaiting: pulls.find((p) => p.sessionId === row.id)?._count._all ?? 0,
          childrenWorking: working.find((w) => w.parentId === row.id)?._count._all ?? 0,
          pinnedAt: pins.find((p) => p.sessionId === row.id)?.pinnedAt.toISOString() ?? null,
          eventsWaitingSince: eventsWaitingSince(row.id),
          previewRunning:
            !!previews.get(row.id) && !previewOffline({ id: row.computerId, ...row.computer }),
        }
      }),
    )
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
        schedule: { select: { id: true, title: true } },
        parent: { select: { id: true, title: true } },
        // Shown in it, newest first: each a line that opens it.
        children: {
          select: {
            id: true,
            title: true,
            status: true,
            origin: true,
            awaited: true,
            report: true,
            reportDeliveredAt: true,
            createdAt: true,
            teammate: { select: { id: true, name: true } },
            schedule: { select: { id: true, title: true } },
            tickets: {
              where: { status: 'open' },
              select: { id: true, type: true, title: true, createdAt: true },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        },
        reportingSchedules: { select: { id: true, title: true, pausedAt: true } },
        tickets: {
          where: { status: 'open' },
          select: { id: true, type: true, title: true, payload: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
        attachments: { include: { attachment: true }, orderBy: { createdAt: 'asc' } },
        task: { select: { id: true, title: true, completedAt: true } },
        project: { select: { id: true, name: true, icon: true, logo: true, archivedAt: true } },
        wakeups: {
          where: { status: 'pending', kind: 'wakeup' },
          select: { id: true, teammateId: true, note: true, wakeAt: true },
          orderBy: { wakeAt: 'asc' },
        },
      },
    })
    if (!thread) throw new HTTPException(404, { message: 'Thread not found' })
    return c.json({
      ...thread,
      // Where it is going, not the message that goes with it.
      move: movePublic(thread.move),
      attachments: thread.attachments.map((a) => toInfo(a.attachment, a.path)),
      mayPrompt: thread.startedByMemberId === c.var.scope.memberId || thread.othersMayPrompt,
      eventsWaitingSince: eventsWaitingSince(thread.id),
    })
  })

  /**
   * An older page of the thread's events: those before `before`, from a turn's start. Without
   * `before`, the latest page and what the whole thread needs from before it, as a socket's
   * `history` then `events` bring them: the dashboard opens a thread on it, with the thread,
   * and its socket only brings what follows.
   */
  .get('/:id/events', async (c) => {
    if (c.req.query('before') === undefined) {
      const thread = await c.var.db.session.findFirst({
        where: { id: c.req.param('id') },
        select: { id: true, lastSeq: true },
      })
      if (!thread) throw new HTTPException(404, { message: 'Thread not found' })
      const firstSeq = await pageStart(thread.id, thread.lastSeq + 1)
      const [context, events] = await Promise.all([
        historyContext(thread.id, firstSeq),
        pageEvents(thread.id, firstSeq, thread.lastSeq + 1),
      ])
      return c.json({ firstSeq, lastSeq: thread.lastSeq, context, events })
    }
    const before = z.coerce.number().int().min(1).safeParse(c.req.query('before'))
    if (!before.success)
      throw new HTTPException(400, { message: 'before must be a sequence number' })
    const thread = await c.var.db.session.findFirst({
      where: { id: c.req.param('id') },
      select: { id: true },
    })
    if (!thread) throw new HTTPException(404, { message: 'Thread not found' })
    const firstSeq = await pageStart(thread.id, before.data)
    return c.json({ firstSeq, events: await pageEvents(thread.id, firstSeq, before.data) })
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

    // The library: its own path, or its mirror's path on a computer (a teammate's own
    // mirror, in a folder named after its Linux user, on runners since protocol 13).
    const mirrored = path.startsWith('/')
      ? path.match(/\/library\/(?:bt-[a-z0-9]{1,28}\/)?(.+)$/)?.[1]
      : undefined
    const library = await db.document.findFirst({
      where: {
        kind: 'library',
        deletedAt: null,
        path: { in: [path, ...(mirrored ? [mirrored] : [])] },
      },
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
    // Looked up together, each a trip to the database; their errors still in this order.
    const [teammate, computer, project] = await Promise.all([
      db.teammate.findFirst({ where: { id: input.teammateId, archivedAt: null } }),
      db.computer.findFirst({ where: { id: input.computerId } }),
      usableProject(db, input.projectId).then(
        (id) => ({ id }),
        (error: unknown) => ({ error }),
      ),
    ])
    if (!teammate) throw new HTTPException(404, { message: 'Teammate not found' })
    if (!computer || (computer.kind === 'member_machine' && computer.memberId !== scope.memberId)) {
      throw new HTTPException(404, { message: 'Computer not found' })
    }
    // A thread runs on the starting member's accounts, never anyone else's.
    // The title is what the message is about, not the command it starts with.
    const skill = input.text.startsWith('/')
      ? skillCommand(
          input.text,
          (await db.skill.findMany({ select: { name: true } })).map((s) => s.name),
        )
      : null
    // A skill names what was asked: `/release-notes for 2.4` is "release-notes for 2.4".
    const asked =
      messageCommand(input.text)?.rest ??
      (skill ? `${skill.skill} ${skill.rest}`.trim() : input.text)
    const firstLine = mentionsToText(asked).split('\n')[0]!
    if ('error' in project) throw project.error
    const projectId = project.id
    const { thread, outcome } = await startThread(db, scope, {
      teammate,
      computer,
      memberId: scope.memberId,
      accountId: input.accountId ?? null,
      // A recording sent from Home without a note: what the thread is for, not its files' names.
      title:
        firstLine ||
        (messageCommand(input.text)?.command === 'teach'
          ? MESSAGE_COMMANDS.teach.label
          : await attachedTitle(db, input.attachmentIds)),
      text: input.text,
      attachmentIds: input.attachmentIds,
      projectId,
      effort: input.effort ?? null,
    })
    if (outcome === 'offline') {
      throw new HTTPException(409, {
        message: 'That computer is offline. Start its runner and try again.',
      })
    }
    return c.json({ id: thread.id, paused: outcome === 'paused' }, 201)
  })

  /** A reply continues the same harness session. */
  /** This member looked at it: what the teammates wrote so far is read. */
  .post('/:id/read', async (c) => {
    const sessionId = c.req.param('id')
    const thread = await c.var.db.session.findFirst({
      where: { id: sessionId },
      select: { id: true },
    })
    if (!thread) return c.json({ error: 'Thread not found' }, 404)
    const memberId = c.var.scope.memberId
    await c.var.db.threadRead.upsert({
      where: { memberId_sessionId: { memberId, sessionId } },
      create: {
        organizationId: c.var.scope.organizationId,
        workspaceId: c.var.scope.workspaceId,
        memberId,
        sessionId,
        seenAt: new Date(),
      },
      update: { seenAt: new Date() },
    })
    return c.json({ ok: true })
  })

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
    const { text, attachmentIds, messageId, steer, pick, replyTo, moveTo } = await parseBody(
      c.req.raw,
      SendMessage,
    )
    // A playbook's run a member writes in joins their Threads, and counts as stepping in.
    await surface(db, thread, true)
    // A design picked from the thread's options: checked first, moved once the message is sent.
    const picking = pick ? await checkPick(db, thread.id, pick) : undefined
    // Teammates the message mentions answer it, joining the thread if new; otherwise whoever answered last.
    const mentioned = await mentionedTeammates(db, text)
    const joined = mentioned.filter((id) => !thread.teammates.some((t) => t.teammateId === id))
    if (joined.length > 0) await joinThread(db, thread.id, joined)
    // Continue on another computer: the message goes with the thread once it is there.
    if (moveTo) {
      await requestMove(
        db,
        scope,
        joined.length > 0 ? await loadThread(db, thread.id) : thread,
        moveTo,
        {
          text,
          memberId: scope.memberId,
          ...(mentioned.length ? { teammateIds: mentioned } : {}),
          attachmentIds,
          ...(messageId ? { messageId } : {}),
          ...(replyTo ? { replyTo } : {}),
        },
      )
      if (picking) await applyPick(db, scope, { type: 'member', id: scope.memberId }, picking)
      if (thread.archivedAt) await setThreadArchived(scope, thread.id, false)
      await reopenOnMessage(scope, thread)
      return c.json({ ok: true, paused: false, delivery: 'moving' })
    }
    const outcome = await promptWithAttachments(
      db,
      scope,
      joined.length > 0 ? await loadThread(db, thread.id) : thread,
      {
        text,
        memberId: scope.memberId,
        ...(mentioned.length ? { teammateIds: mentioned } : {}),
        attachmentIds,
        ...(messageId ? { messageId } : {}),
        ...(steer ? { steer } : {}),
        ...(replyTo ? { replyTo } : {}),
      },
      { memberId: scope.memberId },
    )
    if (outcome === 'offline')
      throw new HTTPException(409, {
        message: 'That computer is offline. Start its runner and try again.',
      })
    if (picking) await applyPick(db, scope, { type: 'member', id: scope.memberId }, picking)
    // Written in again, an archived thread is back in the sidebar.
    if (thread.archivedAt) await setThreadArchived(scope, thread.id, false)
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'thread.prompted',
      target: { type: 'thread', id: thread.id },
      ...(joined.length > 0 ? { data: { joined } } : {}),
    })
    await reopenOnMessage(scope, thread)
    // starting: a stopped computer starts first, and gets the message when its runner connects.
    return c.json({
      ok: true,
      paused: outcome === 'paused',
      delivery: outcome === 'queued' ? 'starting' : outcome,
    })
  })

  /** Continue on another computer without a message: the teammate picks up where it was. */
  .post('/:id/move', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    const { computerId } = await parseBody(c.req.raw, MoveThread)
    await requestMove(db, scope, thread, computerId)
    return c.json({ ok: true })
  })

  /** A message still queued: cancel it, change its text, or steer it into the running turn. */
  .post('/:id/messages/:messageId', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    requireMayPrompt(scope, thread)
    const input = await parseBody(c.req.raw, QueuedMessageAction)
    const protocol = runnerProtocol(thread.computer.id)
    if (protocol !== undefined && protocol < 11)
      throw new HTTPException(409, {
        message: "This computer's runner is too old to change queued messages. Update it.",
      })
    await deliver(thread.computer, {
      type: 'thread.queued',
      commandId: randomUUID(),
      sessionId: thread.id,
      messageId: c.req.param('messageId'),
      action: input.action,
      ...(input.action === 'edit' ? { text: input.text } : {}),
      memberId: scope.memberId,
    })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: `thread.message_${input.action === 'cancel' ? 'cancelled' : input.action === 'edit' ? 'edited' : 'steered'}`,
      target: { type: 'thread', id: thread.id },
      data: { messageId: c.req.param('messageId') },
    })
    return c.json({ ok: true })
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
          ...(input.always ? { always: true } : {}),
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
    // The body is optional: without a turn, whichever runs stops.
    const turnId = InterruptThread.safeParse(await c.req.json().catch(() => ({}))).data?.turnId
    await deliver(thread.computer, {
      type: 'thread.interrupt',
      commandId: randomUUID(),
      sessionId: thread.id,
      ...(turnId ? { turnId } : {}),
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
        throw new HTTPException(503, { message: 'Starting the cloud computer…' })
      }
      throw new HTTPException(409, {
        message: 'The cloud computer is not running. It starts with the next message.',
      })
    }
    const view = await watchDesktop(thread.computer)
    // The screen is shared by every thread on the computer: show this one's tab,
    // unless a person is using the screen (in control of a thread, or recording a task).
    const inUse = async () =>
      recorder(thread.computer.id) ||
      (await db.session.count({
        where: { computerId: thread.computer.id, controlledByMemberId: { not: null } },
      }))
    if ((runnerProtocol(thread.computer.id) ?? 0) >= FOCUS_PROTOCOL && !(await inUse()))
      sendToRunner(
        thread.computer.id,
        { type: 'browser.focus', teammateId: currentTeammate(thread).id, sessionId: thread.id },
        { touch: false },
      )
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'desktop.watched',
      target: { type: 'thread', id: thread.id },
    })
    // View only until takeover is the viewer's own setting, not a boundary: any
    // member may take over anyway.
    return c.json(view)
  })

  /**
   * Open the thread's live preview: the address of the app its teammate runs.
   * On the workspace computer the provider hosts it publicly, behind a token
   * only people who may see the thread get; on a member's own machine it is
   * that machine's localhost. touch: the dashboard still has it open, which
   * keeps it (and the workspace computer) from stopping.
   */
  .post('/:id/preview', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    const { touch } = await parseBody(c.req.raw, z.object({ touch: z.boolean().optional() }))
    const preview = await livePreview(db, thread)
    if (touch) {
      touchPreview(thread.computer.id, thread.id)
      return c.body(null, 204)
    }
    // Its events may be stale (the runner restarted): ask the runner, which also touches it.
    const live = await previewLogs(thread.computer.id, thread.id)
    if (!live.ok)
      throw new HTTPException(409, {
        message: 'The preview is no longer running. Start it again from the preview panel.',
      })
    touchPreview(thread.computer.id, thread.id)
    // The runner's proxy in front of the app; the app itself from runners before it.
    const port = preview.publicPort ?? preview.port
    if (thread.computer.kind !== 'cloud')
      return c.json({ url: `http://localhost:${port}`, local: true } satisfies PreviewView)
    const { url } = await hostedPort(thread.computer, port)
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'preview.opened',
      target: { type: 'thread', id: thread.id },
      data: { port: preview.port },
    })
    return c.json({ url } satisfies PreviewView)
  })

  /**
   * Start the thread's preview without a turn: again as it last ran, or from
   * a saved setup of a repository the thread has checked out. When there is
   * none, says so, and the dashboard asks the teammate to set it up.
   */
  .post('/:id/preview/start', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    mayPrompt(thread, scope.memberId)
    const { repository } = await parseBody(c.req.raw, StartPreview)
    const result = await startPreview(db, thread, repository)
    if (result.outcome === 'started')
      await audit({
        ...scope,
        actor: { type: 'member', id: scope.memberId },
        action: 'preview.started',
        target: { type: 'thread', id: thread.id },
        ...(repository ? { data: { repository } } : {}),
      })
    return c.json(result)
  })

  /** The thread's preview, for a page other than the thread's own (a pull request's). */
  .get('/:id/preview/state', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    const latest = await latestPreview(db, thread.id, thread.computer.id)
    const offline = previewOffline(thread.computer)
    // Its events say it runs, but its computer is gone: it stopped with it.
    const preview =
      latest && offline && (latest.status === 'starting' || latest.status === 'running')
        ? { ...latest, status: 'stopped' as const, reason: offline }
        : latest
    const teammate = thread.teammates.find((t) => t.teammateId === preview?.teammateId)?.teammate
    return c.json({
      preview,
      teammateName: (teammate ?? thread.teammate).name,
      computerName: thread.computer.name,
      cloud: thread.computer.kind === 'cloud',
      mayControl: thread.startedByMemberId === scope.memberId || thread.othersMayPrompt,
    } satisfies ThreadPreviewState)
  })

  /** Restart or stop the thread's preview. For people who may prompt the thread. */
  .post('/:id/preview/control', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    mayPrompt(thread, scope.memberId)
    const { action } = await parseBody(c.req.raw, z.object({ action: PreviewAction }))
    await livePreview(db, thread)
    if (
      !sendToRunner(thread.computer.id, { type: 'preview.control', sessionId: thread.id, action })
    )
      throw new HTTPException(409, { message: 'The computer is offline' })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: action === 'stop' ? 'preview.stopped' : 'preview.restarted',
      target: { type: 'thread', id: thread.id },
    })
    return c.json({ ok: true })
  })

  /** The preview's recent output (its dev server's console). */
  .get('/:id/preview/logs', async (c) => {
    const { db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    await livePreview(db, thread)
    const result = await previewLogs(thread.computer.id, thread.id)
    if (!result.ok) throw new HTTPException(409, { message: result.error ?? 'No output' })
    return c.json({ text: result.text ?? '' })
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
        message: 'On your own machine, just use your machine. Takeover is for the cloud computer.',
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
    await surface(db, thread, true)
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
    await handBack(db, scope, thread, note)
    return c.json({ ok: true })
  })

  /**
   * Into a project or out of one: any member, as it only organizes. Its next
   * turn gets the new project's context; its task follows.
   */
  .put('/:id/project', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    const { projectId } = await parseBody(c.req.raw, SetProject)
    const next = (await usableProject(db, projectId)) ?? null
    // Moving is not activity: the thread keeps its place in lists.
    await db.session.updateMany({
      where: { id: thread.id },
      data: { projectId: next, updatedAt: thread.updatedAt },
    })
    if (thread.taskId)
      await db.task.updateMany({ where: { id: thread.taskId }, data: { projectId: next } })
    // Its child threads, schedule runs among them, and the schedules reporting here follow.
    const family = await descendants(db, thread.id)
    if (family.length)
      await db.session.updateMany({ where: { id: { in: family } }, data: { projectId: next } })
    const reporting = await db.schedule.findMany({
      where: { parentSessionId: { in: [thread.id, ...family] } },
      select: { id: true },
    })
    if (reporting.length) {
      await db.schedule.updateMany({
        where: { id: { in: reporting.map((s) => s.id) } },
        data: { projectId: next },
      })
      for (const s of reporting) broadcastSchedule(scope.workspaceId, s.id)
    }
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'thread.moved',
      target: { type: 'thread', id: thread.id },
      data: { from: thread.projectId, to: next },
    })
    broadcastThreadStatus(scope.workspaceId, thread.id, thread.status)
    return c.json({ ok: true })
  })

  /** Rename it: who may write in it, or an admin. */
  .put('/:id/title', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    mayChange(scope, thread)
    const { title } = await parseBody(
      c.req.raw,
      z.object({ title: z.string().trim().min(1).max(200) }),
    )
    // Not activity: the thread keeps its place in the list.
    await db.session.updateMany({
      where: { id: thread.id },
      data: { title, updatedAt: thread.updatedAt },
    })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'thread.renamed',
      target: { type: 'thread', id: thread.id },
      data: { from: thread.title, to: title },
    })
    broadcastThreadStatus(scope.workspaceId, thread.id, thread.status)
    return c.json({ ok: true })
  })

  /** Pin it to the top of this member's sidebar; DELETE unpins it. Each member's own. */
  .post('/:id/pin', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    await surface(db, thread)
    await db.threadPin.upsert({
      where: { memberId_sessionId: { memberId: scope.memberId, sessionId: thread.id } },
      create: {
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        memberId: scope.memberId,
        sessionId: thread.id,
      },
      update: {},
    })
    return c.json({ ok: true })
  })
  .delete('/:id/pin', async (c) => {
    const { scope, db } = c.var
    await db.threadPin.deleteMany({
      where: { memberId: scope.memberId, sessionId: c.req.param('id') },
    })
    return c.json({ ok: true })
  })

  /** Cancel a wake-up a teammate set in it: who may change the thread. */
  .delete('/:id/wakeups/:wakeupId', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    mayChange(scope, thread)
    await cancelWakeup(db, scope, thread, c.req.param('wakeupId'))
    return c.json({ ok: true })
  })

  /** Archive it: out of everyone's sidebar until someone writes in it; DELETE brings it back. */
  .post('/:id/archive', async (c) => archive(c, true))
  .delete('/:id/archive', async (c) => archive(c, false))

  /** Delete it for good, with its files in the bucket: its starter or an admin. */
  .delete('/:id', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    if (thread.startedByMemberId !== scope.memberId && !isAdmin(scope))
      throw new HTTPException(403, {
        message: 'Only the member who started this thread or an admin can delete it',
      })
    const { taskId } = await deleteThread(
      db,
      scope,
      { type: 'member', id: scope.memberId },
      thread.id,
    )
    broadcastThreadStatus(scope.workspaceId, thread.id, 'deleted')
    if (taskId) broadcastTask(scope.workspaceId, taskId)
    return c.json({ ok: true })
  })

  /**
   * Only the starter changes who may prompt on their subscription and whether it is
   * private; who may write in it changes its effort, which the next turn runs with.
   */
  .patch('/:id', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    const input = await parseBody(c.req.raw, UpdateThread)
    if (
      (input.othersMayPrompt !== undefined || input.private !== undefined) &&
      thread.startedByMemberId !== scope.memberId
    )
      throw new HTTPException(403, {
        message: 'Only the member who started this thread can change it',
      })
    if (input.effort !== undefined) mayPrompt(thread, scope.memberId)
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
