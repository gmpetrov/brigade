import { addressOf } from '../mail/names.js'
import { mayWrite, openToOthers } from '../account-sharing.js'
import { randomUUID } from 'node:crypto'
import {
  ASIDE_PROTOCOL,
  clipReport,
  CODE_CHANGES_PROTOCOL,
  CODE_EDIT_PROTOCOL,
  CODE_TREE_PROTOCOL,
  CodeHashes,
  type CodeChange,
  type CodeEntry,
  FILE_VIEW_MAX,
  FindSource,
  RevertCode,
  SaveThreadFile,
  type SavedThreadFile,
  type SourceMatch,
  FOCUS_PROTOCOL,
  REPORT_START,
  RETRY_PROTOCOL,
  VIEWABLE_FILE,
  AnswerQuestion,
  AnswerTicket,
  DesktopClipboard,
  HandBack,
  InterruptThread,
  inParallel,
  mayChangeQueued,
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
  STORED_FILE_NAME,
  handbackAnswer,
  UpdateThread,
  type ThreadFile,
  type ThreadSpec,
  type Ask,
  type AgentEvent,
  type ApiToRunner,
  type PreviewView,
  type ThreadPreviewState,
} from '@brigade/contracts'
import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { toInfo } from '../attachments.js'
import { audit } from '../audit.js'
import { attachmentKey, presignGet, streamObject, threadFileKey } from '../bucket.js'
import {
  latestPreview,
  livePreview,
  previewLogs,
  previewOffline,
  previewOfflineIn,
  previewStates,
  startPreview,
  touchPreview,
} from '../app-previews.js'
import { desktopClipboard, hostedPort } from '../cloud.js'
import { applyPick, checkPick } from '../designs.js'
import { watchDesktop } from '../desktop-proxy.js'
import { answerQuestion, answerTicket, mayAnswer, resolveTicket } from '../decide.js'
import { prisma, type ScopedDb } from '../db.js'
import { hubs, scheduleUpdated, taskUpdated, threadUpdated } from '../hub.js'
import { codeFiles, findSource, readThreadFile, writeThreadFile } from '../runner-requests.js'
import { contentTypeFor, isText } from '../library.js'
import { projectWhere, usableProject } from '../projects.js'
import { localPreviewUrl } from '../preview-gateway.js'
import {
  currentTeammate,
  loadThread,
  requireMayPrompt,
  specFor,
  teammateIn,
  type LoadedThread,
} from '../thread-spec.js'
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
import { latersOf, setLater } from '../later.js'
import { descendants, reportConversation, reportOf } from '../children.js'
import { deleteThread } from '../thread-delete.js'
import { stopWatching } from '../replies.js'
import { cancelWakeup } from '../wakeups.js'
import { surface } from '../playbooks.js'
import { runLog } from '../timeline.js'
import {
  historyContext,
  pageEnd,
  pageEvents,
  pageStart,
  startAt,
  threadPrompts,
} from '../thread-history.js'
import { nextPinPosition, pinnedListThreads, threadLists } from '../lists.js'
import { noteInThread } from '../thread-notes.js'
import {
  parseBody,
  requireUser,
  requireWorkspace,
  type AppEnv,
  type WorkspaceScope,
} from '../scope.js'
import { headOf } from '../serve-object.js'

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

/**
 * Why a message can't go to a thread that waits on a person, or undefined: it can, and its
 * teammate reads it now while the ticket or question it asked stays open (ASIDE_PROTOCOL). It
 * can't while a decision holds a call (an approval before a built-in tool, an App write, a
 * credential, a trigger), nor on a runner from before that.
 */
async function waitingRefusal(
  db: ScopedDb,
  thread: { id: string; computer: { id: string; workspaceId: string } },
) {
  const held = await db.heldCall.findMany({
    where: { sessionId: thread.id, status: 'waiting' },
    select: { ticketId: true },
  })
  const deciding = await db.ticket.count({
    where: {
      sessionId: thread.id,
      status: 'open',
      OR: [
        { id: { in: held.map((h) => h.ticketId) } },
        { type: 'approval', payload: { path: ['source'], equals: 'harness' } },
      ],
    },
  })
  if (deciding) return 'Approve or deny the pending request first'
  const protocol = await hubs.get(thread.computer.workspaceId).runnerProtocol(thread.computer.id)
  if (protocol !== undefined && protocol < ASIDE_PROTOCOL)
    return 'Answer the pending request first, or update Brigade on this computer to write while it waits'
  return undefined
}

async function deliver(
  computer: { id: string; kind: string; workspaceId: string },
  message: ApiToRunner,
) {
  if ((await hubs.get(computer.workspaceId).dispatch(computer, message)) === 'offline') {
    throw new HTTPException(409, {
      message: 'That computer is offline. Start its runner and try again.',
    })
  }
}

/** Starting, restarting and stopping a thread's preview is for people who may write in it. */
function mayPrompt(
  thread: {
    startedByMemberId: string | null
    othersMayPrompt: boolean
    computer: { kind: string }
  },
  scope: WorkspaceScope,
) {
  if (!mayWrite(thread, scope))
    throw new HTTPException(403, { message: 'Only who may write in this thread can do that' })
}

const isAdmin = (scope: WorkspaceScope) => scope.role === 'owner' || scope.role === 'admin'

/** Editing code needs the computer on, with a runner that writes files (CODE_EDIT_PROTOCOL). */
async function requireCodeEdit(
  computer: { id: string; workspaceId: string },
  needs = CODE_EDIT_PROTOCOL,
) {
  const protocol = await hubs.get(computer.workspaceId).runnerProtocol(computer.id)
  if (protocol === undefined) throw new HTTPException(409, { message: 'The computer is offline' })
  if (protocol < needs)
    throw new HTTPException(409, {
      message: 'Update Brigade on this computer to edit code from here',
    })
}

/** The teammate of the thread whose working folder the code panel shows: one of its own. */
async function codeTeammate(
  thread: LoadedThread,
  teammateId: string | undefined,
  needs = CODE_TREE_PROTOCOL,
) {
  if (!teammateId || !thread.teammates.some((t) => t.teammateId === teammateId))
    throw new HTTPException(400, { message: 'That teammate is not in this thread' })
  await requireCodeEdit(thread.computer, needs)
  return teammateId
}

/** A code panel answer from the runner, or the HTTP error that says why not. */
function codeAnswer(result: Awaited<ReturnType<typeof codeFiles>>) {
  if (!result.ok)
    throw new HTTPException(result.error === 'not_found' ? 404 : 409, {
      message: result.error === 'not_found' ? 'No such folder' : (result.error ?? 'Could not read'),
    })
  return result
}

/** Edits already told to their thread, by thread, file and member: when. */
const editsNoted = new Map<string, number>()
const EDIT_NOTE_MS = 15 * 60_000

/**
 * "Ada edited `src/app.tsx`.": a line in the thread, and what its teammates read at their
 * next turn. Once per file and person in a while, not at each save.
 */
async function noteEdit(db: ScopedDb, scope: WorkspaceScope, threadId: string, path: string) {
  const key = `${threadId}\0${path}\0${scope.memberId}`
  const now = Date.now()
  if (now - (editsNoted.get(key) ?? 0) < EDIT_NOTE_MS) return
  for (const [k, at] of editsNoted) if (now - at >= EDIT_NOTE_MS) editsNoted.delete(k)
  editsNoted.set(key, now)
  const user = await prisma.user.findFirst({ where: { id: scope.userId }, select: { name: true } })
  await noteInThread(
    db,
    threadId,
    `${user?.name || 'A member'} edited \`${path}\` in the code editor. The change is saved in the working folder, not committed.`,
  )
}

/** Renaming and archiving a thread is for who may write in it, and admins. */
function mayChange(
  scope: WorkspaceScope,
  thread: {
    startedByMemberId: string | null
    othersMayPrompt: boolean
    computer: { kind: string }
  },
) {
  if (!mayWrite(thread, scope) && !isAdmin(scope))
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

/** A thread with the id the browser chose (`id`) exists already, in this workspace or another. */
const idTaken = (error: unknown, id: string | undefined): never => {
  if (id && (error as { code?: string }).code === 'P2002')
    throw new HTTPException(409, { message: 'That thread id is taken' })
  throw error
}

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
    // One thread, as the list has it: the sidebar shows the one open when it is not among
    // those it loaded. Archived or quiet, it is still the one open; a child thread is not
    // listed, its parent is, which shows it among its children.
    const only = c.req.query('id')
    const rows = await c.var.db.session.findMany({
      where: only
        ? { parentId: null, OR: [{ id: only }, { children: { some: { id: only } } }] }
        : {
            // A teammate's threads: those it started and those it joined.
            ...(teammateId ? { teammates: { some: { teammateId } } } : {}),
            ...projectWhere(c.req.query('project')),
            // Archived ones only when asked for: ?archived=1.
            archivedAt: c.req.query('archived') === '1' ? { not: null } : null,
            // Child threads show in their parent, not in lists.
            parentId: null,
            // A playbook's runs, once a person took part in them (src/playbooks.ts).
            OR: [{ playbookRunId: null, quiet: false }, { surfacedAt: { not: null } }],
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
      select: { sessionId: true, pinnedAt: true, position: true },
    })
    // And those they put away for later, all of them too: the filter's Later lists them.
    const laters = await latersOf(c.var.db, c.var.scope.memberId)
    if (
      !only &&
      !limit &&
      !teammateId &&
      !c.req.query('project') &&
      c.req.query('archived') !== '1'
    ) {
      const loaded = new Set(rows.map((r) => r.id))
      // And those on the lists they pinned, which show under each list, however old.
      const onPinnedLists = await pinnedListThreads(c.var.db, c.var.scope.memberId)
      const missing = [
        ...new Set([...pins.map((p) => p.sessionId), ...laters.keys(), ...onPinnedLists]),
      ].filter((id) => !loaded.has(id))
      // A child thread shows only in its parent, unless this member pinned it.
      const pinnedIds = new Set(pins.map((p) => p.sessionId))
      if (missing.length)
        rows.push(
          ...(await c.var.db.session.findMany({
            where: {
              id: { in: missing },
              archivedAt: null,
              OR: [{ parentId: null }, { id: { in: [...pinnedIds] } }],
            },
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
    // Its child threads, out of lists: the sidebar shows them under it, folded. Those a
    // teammate started (start_child), not a schedule's runs, which would fill it.
    const children = rows.length
      ? await c.var.db.session.findMany({
          where: { parentId: { in: rows.map((r) => r.id) }, origin: 'child', archivedAt: null },
          select: {
            id: true,
            title: true,
            status: true,
            parentId: true,
            updatedAt: true,
            computerId: true,
            computer: { select: { kind: true, name: true } },
          },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        })
      : []
    // Which of them a teammate answered since this member last looked.
    const [childTurns, childReads] = children.length
      ? await Promise.all([
          c.var.db.sessionEvent.groupBy({
            by: ['sessionId'],
            where: { sessionId: { in: children.map((r) => r.id) }, type: 'turn.completed' },
            _max: { at: true },
          }),
          c.var.db.threadRead.findMany({
            where: {
              memberId: c.var.scope.memberId,
              sessionId: { in: children.map((r) => r.id) },
            },
            select: { sessionId: true, seenAt: true },
          }),
        ])
      : [[], []]
    // The list each works on (docs/lists.md): the sidebar shows them under it.
    const lists = await threadLists(
      c.var.db,
      rows.map((r) => r.id),
    )
    // Whose preview is up, its child threads' too: the sidebar marks them. Not on a computer
    // that is gone, whatever the events say, as on the preview panel.
    const previews = await previewStates(c.var.db, [
      ...rows.map((r) => r.id),
      ...children.map((r) => r.id),
    ])
    // How its computers are connected, and whose events wait on them: from the hub.
    const hub = hubs.get(c.var.scope.workspaceId)
    const [presence, waitingSince] = await Promise.all([
      hub.presence([...new Set([...rows, ...children].map((r) => r.computerId))]),
      hub.eventsWaitingSince(rows.map((r) => r.id)),
    ])
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
          children: children
            .filter((child) => child.parentId === row.id)
            .map(({ parentId: _, computerId, computer, ...child }) => ({
              ...child,
              unread: unread(
                childTurns.find((t) => t.sessionId === child.id)?._max.at,
                childReads.find((r) => r.sessionId === child.id)?.seenAt,
              ),
              previewRunning:
                !!previews.get(child.id) &&
                !previewOfflineIn(presence, { id: computerId, ...computer }),
            })),
          list: lists.get(row.id) ?? null,
          pinnedAt: pins.find((p) => p.sessionId === row.id)?.pinnedAt.toISOString() ?? null,
          pinPosition: pins.find((p) => p.sessionId === row.id)?.position ?? null,
          laterAt: laters.get(row.id)?.toISOString() ?? null,
          eventsWaitingSince: waitingSince[row.id] ?? null,
          // Others than its starter write in it, so rename and archive it (account-sharing.ts).
          othersMayPrompt: openToOthers(row),
          previewRunning:
            !!previews.get(row.id) &&
            !previewOfflineIn(presence, { id: row.computerId, ...row.computer }),
        }
      }),
    )
  })

  .get('/:id', async (c) => {
    const thread = await c.var.db.session.findFirst({
      where: { id: c.req.param('id') },
      include: {
        teammate: { select: { id: true, name: true, title: true, harness: true, model: true } },
        teammates: {
          select: {
            joinedAt: true,
            lastTurnAt: true,
            teammate: { select: { id: true, name: true, harness: true, model: true } },
          },
          orderBy: { joinedAt: 'asc' },
        },
        computer: { select: { id: true, name: true, kind: true, status: true } },
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
            reportDueAt: true,
            createdAt: true,
            startedByMemberId: true,
            othersMayPrompt: true,
            computer: { select: { kind: true } },
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
        // Threads its report wakes besides its parent (follow_thread).
        followers: {
          select: { follower: { select: { id: true, title: true } } },
          orderBy: { createdAt: 'asc' },
        },
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
        // Emails sent from it whose replies wake it (src/replies.ts).
        replyWatches: {
          where: { until: { gt: new Date() } },
          select: {
            id: true,
            teammateId: true,
            to: true,
            subject: true,
            until: true,
            connection: { select: { kind: true, externalAccount: true, label: true } },
          },
          orderBy: { updatedAt: 'desc' },
        },
        // Sign-up addresses it made whose mail still comes to it (the Email App).
        mailAliases: {
          where: { waitUntil: { gt: new Date() } },
          select: { id: true, local: true, purpose: true, waitUntil: true, teammateId: true },
          orderBy: { createdAt: 'desc' },
        },
        // Emails it sent from Brigade's addresses, the latest: one in its window can be cancelled.
        mailMessages: {
          where: { direction: 'out' },
          select: {
            id: true,
            to: true,
            subject: true,
            status: true,
            sendAt: true,
            error: true,
            fromAddress: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    })
    if (!thread) throw new HTTPException(404, { message: 'Thread not found' })
    // This member's pin and later, for the thread's menu in its details.
    const mine = { memberId_sessionId: { memberId: c.var.scope.memberId, sessionId: thread.id } }
    const hub = hubs.get(c.var.scope.workspaceId)
    const [pin, later, presence, waitingSince] = await Promise.all([
      c.var.db.threadPin.findUnique({ where: mine, select: { pinnedAt: true } }),
      c.var.db.threadLater.findUnique({ where: mine, select: { laterAt: true } }),
      hub.presence([thread.computer.id]),
      hub.eventsWaitingSince([thread.id]),
    ])
    return c.json({
      ...thread,
      // Whether it is there, for everyone in the thread: /computers lists only the member's own.
      computer: {
        ...thread.computer,
        online: presence[thread.computer.id]?.online ?? false,
        restarting: presence[thread.computer.id]?.restarting ?? false,
      },
      pinnedAt: pin?.pinnedAt.toISOString() ?? null,
      laterAt: later?.laterAt.toISOString() ?? null,
      // Where it is going, not the message that goes with it.
      move: movePublic(thread.move),
      attachments: thread.attachments.map((a) => toInfo(a.attachment, a.path)),
      followers: thread.followers.map((f) => f.follower),
      // Whether this member may send a child's report now (POST /:id/report), as in the child itself.
      children: thread.children.map(
        ({ startedByMemberId, othersMayPrompt, computer, ...child }) => {
          // Its line shows the start of its report; the child keeps the whole of it.
          const report = reportOf(child.report)
          return {
            ...child,
            ...(report
              ? { report: { ...report, summary: clipReport(report.summary, REPORT_START) } }
              : {}),
            mayPrompt: mayWrite({ startedByMemberId, othersMayPrompt, computer }, c.var.scope),
          }
        },
      ),
      othersMayPrompt: openToOthers(thread),
      mayPrompt: mayWrite(thread, c.var.scope),
      eventsWaitingSince: waitingSince[thread.id] ?? null,
      mailAliases: thread.mailAliases.map((a) => ({ ...a, address: addressOf(a.local) })),
    })
  })

  /**
   * A page of the thread's events. `before`: the page ending there, from a turn's start, and
   * not before `since` when given (what the dashboard has already). `from`: the page holding
   * that event, from the turn's start or message at or before it, up to about a page on and
   * not past `until`: the timeline jumps there without loading what lies between. Without
   * either, the latest page and what the whole thread needs from before it, as a socket's
   * `history` then `events` bring them: the dashboard opens a thread on it, with the thread,
   * and its socket only brings what follows.
   */
  .get('/:id/events', async (c) => {
    const seq = z.coerce.number().int().min(1)
    const query = z
      .object({
        before: seq.optional(),
        since: seq.optional(),
        from: seq.optional(),
        until: seq.optional(),
      })
      .safeParse(c.req.query())
    if (!query.success)
      throw new HTTPException(400, { message: 'Pages are named by sequence numbers' })
    const { before, since, from, until } = query.data
    const thread = await c.var.db.session.findFirst({
      where: { id: c.req.param('id') },
      select: { id: true, lastSeq: true },
    })
    if (!thread) throw new HTTPException(404, { message: 'Thread not found' })
    if (from !== undefined) {
      const end = Math.min(until ?? thread.lastSeq + 1, thread.lastSeq + 1)
      const firstSeq = Math.min(await startAt(thread.id, from), end)
      const endSeq = await pageEnd(thread.id, firstSeq, end)
      return c.json({ firstSeq, endSeq, events: await pageEvents(thread.id, firstSeq, endSeq) })
    }
    if (before === undefined) {
      const firstSeq = await pageStart(thread.id, thread.lastSeq + 1)
      const [context, events] = await Promise.all([
        historyContext(thread.id, firstSeq),
        pageEvents(thread.id, firstSeq, thread.lastSeq + 1),
      ])
      return c.json({ firstSeq, lastSeq: thread.lastSeq, context, events })
    }
    const firstSeq = Math.max(await pageStart(thread.id, before), Math.min(since ?? 1, before))
    return c.json({ firstSeq, events: await pageEvents(thread.id, firstSeq, before) })
  })

  /** The messages people wrote in the thread, each one's start: the timeline beside a long thread. */
  .get('/:id/prompts', async (c) => {
    const thread = await c.var.db.session.findFirst({
      where: { id: c.req.param('id') },
      select: { id: true },
    })
    if (!thread) throw new HTTPException(404, { message: 'Thread not found' })
    return c.json(await threadPrompts(thread.id))
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
        // Its first part only, read as such: the rest never leaves the bucket.
        new TextDecoder('utf-8', { fatal: false }).decode(
          await headOf(attachmentKey(c.var.scope, row.id), FILE_VIEW_MAX),
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

    // The library: its own path, its mirror's path on a computer (a teammate's own
    // mirror, in a folder named after its Linux user, on runners since protocol 13),
    // or a path in the thread's project folder ("decisions/x.md" for "Projects/Acme/decisions/x.md").
    const mirrored = path.startsWith('/')
      ? path.match(/\/library\/(?:bt-[a-z0-9]{1,28}\/)?(.+)$/)?.[1]
      : undefined
    const project =
      !path.startsWith('/') && thread.projectId
        ? await db.project.findFirst({ where: { id: thread.projectId }, select: { folder: true } })
        : null
    const inProject = project?.folder ? `${project.folder.replace(/\/+$/, '')}/${path}` : undefined
    const candidates = [path, ...(mirrored ? [mirrored] : []), ...(inProject ? [inProject] : [])]
    const found = await db.document.findMany({
      where: { kind: 'library', deletedAt: null, path: { in: candidates } },
    })
    const fromLibrary = (row: (typeof found)[number]) => {
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
    const library = candidates.map((p) => found.find((d) => d.path === p)).find(Boolean)
    if (library) return fromLibrary(library)

    const result = await readThreadFile(thread.computer, {
      sessionId: thread.id,
      teammateIds: teammatesFirst(thread, c.req.query('teammateId')),
      path,
    })
    if (!result.ok) {
      // A bare name ("10-bold-alternative.md") for a file in a folder of the thread's
      // project: the only one of that name there. Never another project's file.
      const folder = project?.folder?.replace(/\/+$/, '')
      const named =
        folder && !path.includes('/')
          ? (
              await db.document.findMany({
                where: {
                  kind: 'library',
                  deletedAt: null,
                  path: { startsWith: `${folder}/`, endsWith: `/${path}` },
                },
                take: 20,
              })
            ).filter((d) => d.path.startsWith(`${folder}/`) && d.path.endsWith(`/${path}`))
          : []
      if (named.length === 1) return fromLibrary(named[0]!)
      throw new HTTPException(result.error === 'not_found' ? 404 : 409, {
        message:
          result.error === 'not_found'
            ? `No file "${path}" in the library or the teammate's folder`
            : (result.error ?? 'Could not read the file'),
      })
    }
    return c.json({
      source: 'thread',
      path: result.path ?? path,
      contentType: contentTypeFor(result.path ?? path),
      size: result.size ?? 0,
      ...(result.text === undefined ? {} : { text: result.text }),
      truncated: result.truncated ?? false,
      ...(result.teammateId ? { teammateId: result.teammateId } : {}),
      ...(result.hash ? { hash: result.hash } : {}),
    } satisfies ThreadFile)
  })

  /**
   * Save a text file of a teammate's working folder that a person edited in the file
   * panel: whoever may write to the thread. Refused (409) when it changed since it was
   * opened, unless the save has no `base`. The thread is told once in a while who
   * edited what, so its teammates know at their next turn.
   */
  .put('/:id/file', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    requireMayPrompt(scope, thread)
    const input = await parseBody(c.req.raw, SaveThreadFile)
    if (!thread.teammates.some((t) => t.teammateId === input.teammateId))
      throw new HTTPException(400, { message: 'That teammate is not in this thread' })
    await requireCodeEdit(thread.computer)
    const result = await writeThreadFile(thread.computer, {
      sessionId: thread.id,
      teammateId: input.teammateId,
      path: input.path,
      text: input.text,
      ...(input.base ? { base: input.base } : {}),
    })
    if (!result.ok || !result.hash)
      throw new HTTPException(result.conflict ? 409 : result.error === 'not_found' ? 404 : 409, {
        message: result.conflict
          ? 'The file changed since you opened it'
          : result.error === 'not_found'
            ? `No file "${input.path}" in the teammate's folder`
            : (result.error ?? 'Could not save the file'),
      })
    await noteEdit(db, scope, thread.id, input.path)
    return c.json({ hash: result.hash } satisfies SavedThreadFile)
  })

  /**
   * The code panel's tree: a folder of a teammate's working folder for the thread
   * (`path` relative to it, '' for itself), folders first. Any member who can see
   * the thread, as for its files.
   */
  .get('/:id/code', async (c) => {
    const thread = await loadThread(c.var.db, c.req.param('id'))
    const teammateId = await codeTeammate(thread, c.req.query('teammateId'))
    const result = codeAnswer(
      await codeFiles(thread.computer, {
        sessionId: thread.id,
        teammateId,
        op: 'list',
        path: (c.req.query('path') ?? '').replace(/^\.?\/+|\/+$/g, '').slice(0, 1000),
      }),
    )
    return c.json({ entries: result.entries ?? [], more: result.more ?? false } satisfies {
      entries: CodeEntry[]
      more: boolean
    })
  })

  /** Files of a teammate's working folder by name (find), or lines holding a text (grep). */
  .get('/:id/code/:op{find|grep}', async (c) => {
    const thread = await loadThread(c.var.db, c.req.param('id'))
    const teammateId = await codeTeammate(thread, c.req.query('teammateId'))
    const query = (c.req.query('q') ?? '').trim().slice(0, 200)
    const op = c.req.param('op') as 'find' | 'grep'
    const result = codeAnswer(
      await codeFiles(thread.computer, { sessionId: thread.id, teammateId, op, query }),
    )
    return c.json(op === 'find' ? { files: result.files ?? [] } : { matches: result.matches ?? [] })
  })

  /** Open files' hashes, to see when the teammate changed one (null: gone, or not text to edit). */
  .post('/:id/code/hashes', async (c) => {
    const thread = await loadThread(c.var.db, c.req.param('id'))
    const input = await parseBody(c.req.raw, CodeHashes)
    const teammateId = await codeTeammate(thread, input.teammateId)
    const result = codeAnswer(
      await codeFiles(thread.computer, {
        sessionId: thread.id,
        teammateId,
        op: 'hashes',
        paths: input.paths,
      }),
    )
    return c.json({ hashes: result.hashes ?? {} })
  })

  /**
   * The files of a teammate's working folder that differ from where their repository's
   * branch left its default branch (`base`, from newer runners), else from its last commit,
   * for the code panel's Changes, and those commits (`head`), so the panel sees when one
   * is made. Any member who can see the thread.
   */
  .get('/:id/code/changes', async (c) => {
    const thread = await loadThread(c.var.db, c.req.param('id'))
    const teammateId = await codeTeammate(thread, c.req.query('teammateId'), CODE_CHANGES_PROTOCOL)
    const result = codeAnswer(
      await codeFiles(thread.computer, { sessionId: thread.id, teammateId, op: 'changes' }),
    )
    return c.json({
      changes: result.changes ?? [],
      more: result.more ?? false,
      head: result.head ?? '',
      ...(result.base ? { base: result.base } : {}),
    } satisfies { changes: CodeChange[]; more: boolean; head: string; base?: string })
  })

  /** A file as Changes compares it to, for the editor to show what changed; null: in none. */
  .get('/:id/code/original', async (c) => {
    const thread = await loadThread(c.var.db, c.req.param('id'))
    const teammateId = await codeTeammate(thread, c.req.query('teammateId'), CODE_CHANGES_PROTOCOL)
    const path = (c.req.query('path') ?? '').trim()
    if (!path || path.length > 1000) throw new HTTPException(400, { message: 'Which file?' })
    const result = codeAnswer(
      await codeFiles(thread.computer, {
        sessionId: thread.id,
        teammateId,
        op: 'original',
        path,
      }),
    )
    return c.json({ text: result.original ?? null } satisfies { text: string | null })
  })

  /**
   * Put files of a teammate's working folder back as Changes compares them to (new
   * ones are deleted): whoever may write to the thread. The thread is told,
   * so its teammates know at their next turn.
   */
  .post('/:id/code/revert', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    requireMayPrompt(scope, thread)
    const input = await parseBody(c.req.raw, RevertCode)
    const teammateId = await codeTeammate(thread, input.teammateId, CODE_CHANGES_PROTOCOL)
    const paths = [...new Set(input.paths)]
    const { base } = codeAnswer(
      await codeFiles(thread.computer, { sessionId: thread.id, teammateId, op: 'revert', paths }),
    )
    const user = await prisma.user.findFirst({
      where: { id: scope.userId },
      select: { name: true },
    })
    const named = paths
      .slice(0, 5)
      .map((p) => `\`${p}\``)
      .join(', ')
    const more = paths.length > 5 ? ` and ${paths.length - 5} more` : ''
    await noteInThread(
      db,
      thread.id,
      base
        ? `${user?.name || 'A member'} reverted ${named}${more} in the code editor to how they are on ${base}, where this branch left it. Their changes on the branch are undone and new files deleted, in the folder and the index: commit that to keep it.`
        : `${user?.name || 'A member'} reverted ${named}${more} to the last commit in the code editor. Their changes since are undone, and new files deleted.`,
    )
    return c.json({ ok: true })
  })

  /**
   * Where an element picked in the thread's preview is written: files of the
   * preview's folder holding its text, best first, to open in the file panel.
   */
  .post('/:id/source', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    requireMayPrompt(scope, thread)
    const input = await parseBody(c.req.raw, FindSource)
    if (!thread.teammates.some((t) => t.teammateId === input.teammateId))
      throw new HTTPException(400, { message: 'That teammate is not in this thread' })
    await requireCodeEdit(thread.computer)
    const result = await findSource(thread.computer, {
      sessionId: thread.id,
      teammateId: input.teammateId,
      cwd: input.cwd,
      text: input.text,
      ...(input.components ? { components: input.components } : {}),
    })
    if (!result.ok) throw new HTTPException(409, { message: result.error ?? 'Could not search' })
    return c.json({ matches: result.matches ?? [] } satisfies { matches: SourceMatch[] })
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
    const result = await readThreadFile(thread.computer, {
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

  /**
   * An image or PDF a teammate's tool returned, which the thread's events name
   * (STORED_FILE): from the bucket, so it shows while the computer is stopped too. Its
   * name is its hash, so it never changes. An image is a redirect to the bucket's signed
   * URL. A PDF comes through here: the dashboard reads it with the member's session
   * (pdf.js), which a redirect to the bucket would lose.
   */
  .get('/:id/files/:name', async (c) => {
    const name = c.req.param('name')
    if (!STORED_FILE_NAME.test(name)) throw new HTTPException(400, { message: 'Which file?' })
    const thread = await c.var.db.session.findFirst({
      where: { id: c.req.param('id') },
      select: { id: true },
    })
    if (!thread) throw new HTTPException(404, { message: 'Thread not found' })
    const key = threadFileKey(c.var.scope, thread.id, name)
    const contentType = contentTypeFor(name)
    const disposition = `inline; filename="${name}"`
    if (contentType.startsWith('image/'))
      try {
        const signed = await presignGet(key, { contentType, disposition })
        // The signed URL works a little longer than the browser keeps this.
        c.header('cache-control', `private, max-age=${signed.seconds - 60}`)
        return c.redirect(signed.url, 302)
      } catch {
        // No R2 (development): through the API.
      }
    const body = await streamObject(key)
    if (!body) throw new HTTPException(404, { message: 'The file is missing from storage' })
    return c.body(body, 200, {
      'content-type': contentType,
      'content-disposition': disposition,
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
      'cache-control': 'private, max-age=31536000, immutable',
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
    // A thread runs on the accounts its starter may use (src/account-sharing.ts).
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
      // Chosen by the browser, which opened the thread already: never one that exists.
      ...(input.id ? { id: input.id, fresh: true } : {}),
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
    }).catch((error: unknown) => idTaken(error, input.id))
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
    const refused = thread.status === 'waiting' ? await waitingRefusal(db, thread) : undefined
    if (refused) throw new HTTPException(409, { message: refused })
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
    // A design picked from the thread's options: checked first, copied once the message is sent.
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

  /**
   * A message still queued: steer it into the running turn, or cancel, edit or send to run in
   * parallel one a person wrote.
   */
  .post('/:id/messages/:messageId', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    requireMayPrompt(scope, thread)
    const input = await parseBody(c.req.raw, QueuedMessageAction)
    const messageId = c.req.param('messageId')
    // Who wrote it, from the latest time it was queued: the runner refuses as well.
    const queued = await db.sessionEvent.findFirst({
      where: {
        sessionId: thread.id,
        type: 'message.queued',
        data: { path: ['messageId'], equals: messageId },
      },
      orderBy: { seq: 'desc' },
      select: { data: true },
    })
    const data = queued?.data as { memberId?: string | null; text?: string } | undefined
    const memberId = data?.memberId
    // Another member's own words are theirs to change: anyone who may write steers them in.
    if (memberId && memberId !== scope.memberId && input.action !== 'steer')
      throw new HTTPException(403, {
        message:
          'Another member wrote this message: only they can change it. Steer it, or write your own.',
      })
    if (memberId !== undefined && !mayChangeQueued(memberId, input.action))
      throw new HTTPException(409, {
        message:
          'Brigade sent this message, so it cannot be edited, cancelled or run in parallel. Steer it, or write your own.',
      })
    if (input.action === 'parallel') {
      // A child thread cannot start children of its own (src/children.ts).
      if (thread.parentId)
        throw new HTTPException(409, {
          message: 'This is a child thread, so it cannot start another one. Steer it instead.',
        })
      if (data?.text === undefined)
        throw new HTTPException(409, { message: 'This message was already read.' })
    }
    const protocol = await hubs.get(thread.workspaceId).runnerProtocol(thread.computer.id)
    if (protocol !== undefined && protocol < 11)
      throw new HTTPException(409, {
        message: "This computer's runner is too old to change queued messages. Update it.",
      })
    const command = (action: 'cancel' | 'edit' | 'steer', text?: string) =>
      deliver(thread.computer, {
        type: 'thread.queued',
        commandId: randomUUID(),
        sessionId: thread.id,
        messageId,
        action,
        ...(text !== undefined ? { text } : {}),
        memberId: scope.memberId,
      })
    if (input.action === 'parallel') {
      // Any runner that can steer does this: the ask goes with the message, then into the turn.
      await command('edit', inParallel(data!.text!))
      await command('steer')
    } else await command(input.action, input.action === 'edit' ? input.text : undefined)
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: `thread.message_${{ cancel: 'cancelled', edit: 'edited', steer: 'steered', parallel: 'sent_in_parallel' }[input.action]}`,
      target: { type: 'thread', id: thread.id },
      data: { messageId },
    })
    return c.json({ ok: true })
  })

  .post('/:id/approvals', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    requireMayPrompt(scope, thread)
    const input = await parseBody(c.req.raw, ResolveApproval)
    // The approval's ticket: a connector write (its id is the ticket's) or a harness request.
    const tickets = await db.ticket.findMany({
      where: {
        sessionId: thread.id,
        OR: [
          { id: input.approvalId },
          { payload: { path: ['approvalId'], equals: input.approvalId } },
        ],
      },
      select: { id: true, status: true },
    })
    const ticket = tickets.find((t) => t.status === 'open')
    // Decided already (twice, or by someone else): nothing waits on it any more. Sent on, the
    // runner would continue its teammate's turn with it, whatever that turn waits on now.
    if (!ticket && tickets.length > 0)
      throw new HTTPException(409, { message: 'This was decided already' })
    if (ticket) {
      return c.json(
        await resolveTicket(scope, ticket.id, {
          approved: input.approved,
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.always ? { always: true } : {}),
          ...(input.edited ? { edited: input.edited } : {}),
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
    // Control is answerTicket's to check: the member in control answers once done on the
    // computer, and control goes back with the answer.
    requireMayPrompt(scope, { ...thread, controlledByMemberId: null })
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

  /**
   * A child a person talked with: its last message goes to its parent now, as its report,
   * rather than once the person has been quiet a while (src/children.ts).
   */
  .post('/:id/report', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    requireMayPrompt(scope, thread)
    if (!thread.parentId)
      throw new HTTPException(409, { message: 'This thread has no parent to send it to.' })
    if (!(await reportConversation(scope, thread.id)))
      throw new HTTPException(409, {
        message: 'There is nothing to send: it already reported, or it is working.',
      })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'thread.report_sent',
      target: { type: 'thread', id: thread.id },
      data: { parentId: thread.parentId },
    })
    return c.json({ ok: true })
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

  /** The latest turn failed: its teammate tries it again, told the error it stopped on. */
  .post('/:id/retry', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    requireMayPrompt(scope, thread)
    const protocol = await hubs.get(thread.workspaceId).runnerProtocol(thread.computer.id)
    if (protocol !== undefined && protocol < RETRY_PROTOCOL)
      throw new HTTPException(409, {
        message: "This computer's Brigade is too old to try a turn again. Send a message instead.",
      })
    // The thread's latest turn event: an error, with the turn it ended before it.
    const [last, started] = await Promise.all([
      db.sessionEvent.findFirst({
        where: {
          sessionId: thread.id,
          type: { in: ['turn.started', 'turn.completed', 'error', 'message.user'] },
        },
        orderBy: { seq: 'desc' },
        select: { data: true },
      }),
      db.sessionEvent.findFirst({
        where: { sessionId: thread.id, type: 'turn.started' },
        orderBy: { seq: 'desc' },
        select: { data: true },
      }),
    ])
    const error = last?.data as AgentEvent | undefined
    if (error?.type !== 'error')
      throw new HTTPException(409, { message: 'There is nothing to try again: no turn failed.' })
    const turn = started?.data as AgentEvent | undefined
    const teammate = teammateIn(thread, turn?.type === 'turn.started' ? turn.teammateId : undefined)
    await deliver(thread.computer, {
      type: 'thread.retry',
      commandId: randomUUID(),
      thread: await specFor(db, thread, { teammate }),
      error: error.message.slice(0, 10_000),
      memberId: scope.memberId,
    })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'thread.retried',
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
        await hubs.get(thread.workspaceId).ensureRunning(thread.computer.id)
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
    const hub = hubs.get(thread.workspaceId)
    if (((await hub.runnerProtocol(thread.computer.id)) ?? 0) >= FOCUS_PROTOCOL && !(await inUse()))
      await hub.sendToRunner(
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
   * On the workspace computer it is public on the preview gateway, with an
   * access token for a few minutes that only people who may see the thread
   * get; on a member's own machine it is the thread's own name under that machine's localhost
   * (http://<thread>.localhost:<port>, as its runner says). touch: the dashboard still has it open, which
   * keeps it (and the workspace computer) from stopping.
   */
  .post('/:id/preview', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    const { touch } = await parseBody(c.req.raw, z.object({ touch: z.boolean().optional() }))
    const preview = await livePreview(db, thread)
    if (touch) {
      await touchPreview(thread.computer, thread.id)
      return c.body(null, 204)
    }
    // Its events may be stale (the runner restarted): ask the runner, which also touches it.
    const live = await previewLogs(thread.computer, thread.id)
    if (!live.ok)
      throw new HTTPException(409, {
        message: 'The preview is no longer running. Start it again from the preview panel.',
      })
    await touchPreview(thread.computer, thread.id)
    // The runner's proxy in front of the app; the app itself from runners before it.
    const port = preview.publicPort ?? preview.port
    if (thread.computer.kind !== 'cloud')
      return c.json({ url: localPreviewUrl(live.origin, port), local: true } satisfies PreviewView)
    const { url } = await hostedPort(thread.computer, port, thread.id)
    if (!url)
      throw new HTTPException(503, {
        message: 'The preview gateway did not answer. Try again in a moment.',
      })
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
    mayPrompt(thread, scope)
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
    const latest = await latestPreview(db, thread.id, thread.computer)
    const offline = await previewOffline(thread.computer)
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
      mayControl: mayWrite(thread, scope),
    } satisfies ThreadPreviewState)
  })

  /** Restart or stop the thread's preview. For people who may prompt the thread. */
  .post('/:id/preview/control', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    mayPrompt(thread, scope)
    const { action } = await parseBody(c.req.raw, z.object({ action: PreviewAction }))
    await livePreview(db, thread)
    if (
      !(await hubs.get(thread.workspaceId).sendToRunner(thread.computer.id, {
        type: 'preview.control',
        sessionId: thread.id,
        action,
      }))
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
    const result = await previewLogs(thread.computer, thread.id)
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
      return c.json({ text: await desktopClipboard(thread.computer, text) })
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
    const { note, replies } = await parseBody(c.req.raw, HandBack)
    // The teammate waits on a ticket to do something in its browser: handing back answers it,
    // with what the person answered of its other asks already.
    const ticket = await db.ticket.findFirst({
      where: { sessionId: thread.id, type: 'request', status: 'open' },
      orderBy: { createdAt: 'desc' },
    })
    const payload = ticket?.payload as { asks?: Ask[]; requestId?: string } | null
    const answer = handbackAnswer(
      payload?.asks ?? [],
      note,
      (payload?.requestId && replies?.[payload.requestId]) || {},
    )
    if (ticket && answer && mayAnswer(scope, thread)) await answerTicket(scope, ticket.id, answer)
    else await handBack(db, scope, thread, note)
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
      for (const s of reporting) void hubs.get(scope.workspaceId).broadcast(scheduleUpdated(s.id))
    }
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'thread.moved',
      target: { type: 'thread', id: thread.id },
      data: { from: thread.projectId, to: next },
    })
    void hubs.get(scope.workspaceId).broadcast(threadUpdated(thread.id, thread.status))
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
    void hubs.get(scope.workspaceId).broadcast(threadUpdated(thread.id, thread.status))
    return c.json({ ok: true })
  })

  /**
   * This member's pinned threads and lists in the order they dragged them to: the ids, first to
   * last, a list's as `list:<documentId>` (its sidebar row's).
   */
  .put('/pins/order', async (c) => {
    const { scope, db } = c.var
    const { ids } = await parseBody(c.req.raw, z.object({ ids: z.array(z.string()).max(500) }))
    // Only their own pins move; ids they did not pin are left out.
    await db.$transaction(
      ids.map((id, position) =>
        id.startsWith('list:')
          ? db.listPin.updateMany({
              where: { memberId: scope.memberId, documentId: id.slice('list:'.length) },
              data: { position },
            })
          : db.threadPin.updateMany({
              where: { memberId: scope.memberId, sessionId: id },
              data: { position },
            }),
      ),
    )
    return c.json({ ok: true })
  })

  /** Pin it to the top of this member's sidebar; DELETE unpins it. Each member's own. */
  .post('/:id/pin', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    await surface(db, thread)
    // At the end of Pinned, below the threads and lists the member placed.
    const position = await nextPinPosition(db, scope.memberId)
    await db.threadPin.upsert({
      where: { memberId_sessionId: { memberId: scope.memberId, sessionId: thread.id } },
      create: {
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        memberId: scope.memberId,
        sessionId: thread.id,
        position,
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

  /**
   * Put it away for later: out of this member's list and of what waits on them, until
   * something new happens in it (src/later.ts); DELETE puts it back. Each member's own.
   */
  .post('/:id/later', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    if (thread.parentId)
      throw new HTTPException(409, { message: 'A child thread shows in its parent.' })
    if (thread.archivedAt) throw new HTTPException(409, { message: 'Unarchive the thread first.' })
    await setLater(db, scope, thread, true)
    return c.json({ ok: true })
  })
  .delete('/:id/later', async (c) => {
    const { scope, db } = c.var
    await setLater(db, scope, await loadThread(db, c.req.param('id')), false)
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

  /** Stop waiting on replies in an email's conversation: who may change the thread. */
  .delete('/:id/replies/:watchId', async (c) => {
    const { scope, db } = c.var
    const thread = await loadThread(db, c.req.param('id'))
    mayChange(scope, thread)
    if (!(await stopWatching(db, scope, thread, c.req.param('watchId'))))
      throw new HTTPException(404, { message: 'This thread does not wait on that reply' })
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
    void hubs.get(scope.workspaceId).broadcast(threadUpdated(thread.id, 'deleted'))
    if (taskId) void hubs.get(scope.workspaceId).broadcast(taskUpdated(taskId))
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
    if (input.effort !== undefined) mayPrompt(thread, scope)
    await db.session.updateMany({ where: { id: thread.id }, data: input })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'thread.updated',
      target: { type: 'thread', id: thread.id },
      data: input,
    })
    void hubs.get(scope.workspaceId).broadcast(threadUpdated(thread.id, thread.status))
    return c.json({ ok: true })
  })
