// What a runner's events do once stored (src/hub/runner-messages.ts): a thread's status follows
// from them, and they open and close what a person sees, tickets and accounts. Moved out of the
// hub with the hub per workspace (docs/workspace-hubs-plan.md): nothing here holds state of its
// own but noteEvents' failures, which are the running hub's.
import type { AgentEvent, RunnerToApi, SequencedEvent } from '@brigade/contracts'
import { noteAccountState } from '../account-health.js'
import { prisma, scoped, type Prisma } from '../db.js'
import type { Session } from '../generated/prisma/client.js'
import type { SessionStatus } from '../generated/prisma/enums.js'
import { resolveTurnEnded } from '../pull-requests.js'
import type { QueuedMessage } from '../recovery.js'
import { currentHub } from './context.js'

/** What a run of events opens or closes, tried again this long after it failed. */
export const NOTE_RETRY_MS = 15_000
/** How long it keeps failing before the thread goes on without it. */
const NOTE_GIVE_UP_MS = 2 * 60_000
/** When it first failed, by thread and the run's first event: the running hub's. */
const noteFailures = () => currentHub().local('note-failures', () => new Map<string, number>())

/**
 * Open and close what a run of events asks for: tickets, account states. Each step
 * is safe to do again. False when it should be tried again; after NOTE_GIVE_UP_MS
 * of failures it is given up on, logged, rather than hold the thread back forever.
 */
export async function noteEvents(session: Session, events: SequencedEvent[]) {
  const failed: unknown[] = []
  for (const note of [noteAccountState, noteAccountSwitches, noteTickets])
    await note(session, events).catch((error: unknown) => failed.push(error))
  const key = `${session.id}:${events[0]!.seq}`
  const since = noteFailures().get(key)
  if (!failed.length) {
    noteFailures().delete(key)
    return true
  }
  const range = `${events[0]!.seq}-${events.at(-1)!.seq}`
  if (since !== undefined && Date.now() - since >= NOTE_GIVE_UP_MS) {
    noteFailures().delete(key)
    console.error(
      `thread ${session.id}: gave up on the tickets and accounts of events ${range}`,
      ...failed,
    )
    return true
  }
  if (since === undefined) noteFailures().set(key, Date.now())
  console.error(
    `thread ${session.id}: tickets and accounts of events ${range} failed, trying again`,
    ...failed,
  )
  return false
}

/** How far back a message may still be queued on a runner. */
const QUEUED_FOR_MS = 7 * 24 * 60 * 60_000

/**
 * The messages shown as queued on a computer's threads, in the order they
 * came, with their latest text: queued, and neither read (message.user) nor
 * cancelled since. The runner says which it lost.
 */
export async function queuedMessagesOn(computerId: string): Promise<QueuedMessage[]> {
  const queued = await prisma.sessionEvent.findMany({
    where: {
      type: 'message.queued',
      at: { gte: new Date(Date.now() - QUEUED_FOR_MS) },
      session: { computerId },
    },
    select: { sessionId: true, seq: true },
  })
  if (queued.length === 0) return []
  const rows = await prisma.sessionEvent.findMany({
    where: {
      sessionId: { in: [...new Set(queued.map((q) => q.sessionId))] },
      type: { in: ['message.queued', 'message.user', 'message.cancelled'] },
      seq: { gte: Math.min(...queued.map((q) => q.seq)) },
    },
    orderBy: { seq: 'asc' },
    select: { sessionId: true, data: true },
  })
  const open = new Map<string, QueuedMessage>()
  for (const { sessionId, data } of rows) {
    const event = data as unknown as AgentEvent
    const messageId = 'messageId' in event ? event.messageId : undefined
    if (!messageId) continue
    const key = `${sessionId}:${messageId}`
    // Queued again (edited, or held for a person): it keeps its place, with the latest text.
    if (event.type === 'message.queued') open.set(key, { sessionId, messageId, queued: event })
    else open.delete(key)
  }
  return [...open.values()]
}

/** Each teammate whose turn ended: a pull request whose conflicts it resolved in the thread merges next. */
export async function noteTurnsEnded(
  session: { id: string; organizationId: string; workspaceId: string; teammateId: string },
  events: SequencedEvent[],
) {
  let current: string | undefined
  for (const { seq, event } of events) {
    if (event.type === 'turn.started') current = event.teammateId
    if (event.type !== 'turn.completed') continue
    const started =
      event.teammateId || current
        ? null
        : await prisma.sessionEvent.findFirst({
            where: { sessionId: session.id, type: 'turn.started', seq: { lt: seq } },
            orderBy: { seq: 'desc' },
            select: { data: true },
          })
    const teammateId =
      event.teammateId ??
      current ??
      (started?.data as { teammateId?: string } | undefined)?.teammateId ??
      session.teammateId
    await resolveTurnEnded(
      { organizationId: session.organizationId, workspaceId: session.workspaceId },
      session.id,
      teammateId,
    )
  }
}

/** A thread's status follows from its events, so it survives disconnects and replays. */
export function statusAfter(current: SessionStatus, event: AgentEvent): SessionStatus {
  switch (event.type) {
    // Noted while the teammate waits on a person (a hand back's note): no turn starts.
    case 'message.user':
      return event.waiting ? 'waiting' : 'running'
    case 'approval.resolved':
      return 'running'
    case 'approval.requested':
    case 'question.asked':
    case 'ticket.opened':
      return 'waiting'
    case 'question.answered':
    case 'ticket.answered':
    case 'turn.started':
      return 'running'
    // Answered a message while its ticket or question stays open: it still waits on a person.
    case 'turn.completed':
      return event.waiting ? 'waiting' : 'idle'
    case 'account.switched':
      return event.toAccountId ? current : 'paused'
    // A takeover pauses the teammate once its turn is over. Handed back before that, the turn
    // goes on: it still runs. Handed back after, it waits on what it asked, or on nothing.
    case 'control.changed':
      if (event.controller === 'human') return 'paused'
      return current === 'paused' ? (event.waiting ? 'waiting' : 'idle') : current
    case 'error':
      return 'failed'
    default:
      return current
  }
}

/**
 * A thread moved to another of its starter's accounts, or paused because none
 * has usage left: remember when the old one resets, and open a ticket on pause.
 */
async function noteAccountSwitches(
  session: { id: string; organizationId: string; workspaceId: string },
  events: SequencedEvent[],
) {
  const db = scoped(session)
  for (const { event } of events) {
    if (event.type !== 'account.switched') continue
    if (event.reason === 'usage_limit') {
      const until = event.resetsAt ? new Date(event.resetsAt) : new Date(Date.now() + 60 * 60_000)
      await prisma.account.updateMany({
        where: { id: event.fromAccountId },
        data: { exhaustedUntil: until },
      })
    }
    if (event.toAccountId) {
      await prisma.session.update({
        where: { id: session.id },
        data: { accountId: event.toAccountId },
      })
    } else if (
      // Noted again (noteEvents): its pause has its ticket already.
      !(await db.ticket.count({
        where: { sessionId: session.id, type: 'usage_limit', status: 'open' },
      }))
    ) {
      await db.ticket.create({
        data: {
          organizationId: session.organizationId,
          workspaceId: session.workspaceId,
          sessionId: session.id,
          type: 'usage_limit',
          title: 'Paused: every account has run out of usage',
          payload: { resetsAt: event.resetsAt },
        },
      })
    }
  }
}

/** Accounts already signed in on a member's own machine. */
export async function syncMachineLogins(
  computer: { id: string; organizationId: string; workspaceId: string; name: string },
  memberId: string,
  logins: NonNullable<Extract<RunnerToApi, { type: 'hello' }>['machineLogins']>,
) {
  for (const login of logins) {
    const existing = await prisma.account.findFirst({
      where: { computerId: computer.id, memberId, provider: login.provider, source: 'machine' },
    })
    const identity = { email: login.email ?? null, plan: login.plan ?? null }
    if (existing) {
      await prisma.account.update({
        where: { id: existing.id },
        data: login.loggedIn
          ? { ...identity, status: existing.status === 'needs_sign_in' ? 'ready' : existing.status }
          : { status: 'needs_sign_in' },
      })
    } else if (login.loggedIn) {
      const hasDefault = await prisma.account.count({
        where: { memberId, provider: login.provider, isDefault: true },
      })
      await prisma.account.create({
        data: {
          organizationId: computer.organizationId,
          workspaceId: computer.workspaceId,
          memberId,
          computerId: computer.id,
          provider: login.provider,
          source: 'machine',
          label: `${login.provider === 'codex' ? 'Codex' : 'Claude'} on ${computer.name}`,
          status: 'ready',
          isDefault: hasDefault === 0,
          ...identity,
        },
      })
    }
  }
}

/**
 * An access ask for another teammate (`app.teammate`, by id or name, as the teammate wrote it)
 * names it by id from the start, so the card and the grant always mean the same teammate, even
 * if one is renamed or two share a name: by its id, else the only one of that name. One no
 * teammate matches, or several do, stays as written, and granting it is refused.
 */
export async function withTeammateIds(
  session: { organizationId: string; workspaceId: string },
  events: SequencedEvent[],
): Promise<SequencedEvent[]> {
  if (!events.some((e) => e.event.type === 'ticket.opened')) return events
  const db = scoped(session)
  const resolve = async (ref: string) => {
    const byId = await db.teammate.findFirst({ where: { id: ref }, select: { id: true } })
    if (byId) return byId.id
    const named = await db.teammate.findMany({
      where: { name: { equals: ref.trim(), mode: 'insensitive' }, archivedAt: null },
      select: { id: true },
      take: 2,
    })
    return named.length === 1 ? named[0]!.id : ref
  }
  const out: SequencedEvent[] = []
  for (const e of events) {
    if (e.event.type !== 'ticket.opened') {
      out.push(e)
      continue
    }
    const asks = []
    for (const ask of e.event.asks)
      asks.push(
        ask.type === 'access' && ask.app?.teammate
          ? { ...ask, app: { ...ask.app, teammate: await resolve(ask.app.teammate) } }
          : ask,
      )
    out.push({ ...e, event: { ...e.event, asks } })
  }
  return out
}

/**
 * Keep the ticket queue in step with the thread: the harness asking before a
 * built-in tool call is a ticket, closed when answered; a usage-limit pause is
 * closed when someone prompts the thread again.
 */
async function noteTickets(
  session: { id: string; organizationId: string; workspaceId: string; teammateId: string },
  events: SequencedEvent[],
) {
  const db = scoped(session)
  for (const { event } of events) {
    if (event.type === 'approval.requested') {
      // Connector writes already have their ticket; its id is the approval id.
      const exists = await db.ticket.count({ where: { id: event.approvalId } })
      if (exists || (await asked(session.id, 'approvalId', event.approvalId))) continue
      const teammate = await eventTeammate(session, event)
      const input = JSON.stringify(event.input ?? null)
      await db.ticket.create({
        data: {
          organizationId: session.organizationId,
          workspaceId: session.workspaceId,
          sessionId: session.id,
          type: 'approval',
          title: `${teammate?.name ?? 'Teammate'}: ${event.toolName}${describeInput(event.input)}`,
          payload: {
            source: 'harness',
            teammateId: teammate?.id ?? session.teammateId,
            approvalId: event.approvalId,
            toolName: event.toolName,
            input:
              input.length <= 4000 ? (event.input as Prisma.InputJsonValue) : input.slice(0, 4000),
          },
        },
      })
    } else if (event.type === 'approval.resolved') {
      await db.ticket.updateMany({
        where: {
          sessionId: session.id,
          status: 'open',
          payload: { path: ['approvalId'], equals: event.approvalId },
        },
        data: {
          status: event.approved ? 'approved' : 'denied',
          resolvedByMemberId: event.memberId,
          resolvedAt: new Date(event.at),
        },
      })
    } else if (event.type === 'question.asked') {
      if (await asked(session.id, 'questionId', event.questionId)) continue
      const teammate = await eventTeammate(session, event)
      const first = event.questions[0]?.question ?? 'a question'
      await db.ticket.create({
        data: {
          organizationId: session.organizationId,
          workspaceId: session.workspaceId,
          sessionId: session.id,
          type: 'question',
          title: `${teammate?.name ?? 'Teammate'} asks: ${first.length > 160 ? `${first.slice(0, 157)}...` : first}`,
          payload: {
            source: 'harness',
            teammateId: teammate?.id ?? session.teammateId,
            questionId: event.questionId,
            questions: event.questions as unknown as Prisma.InputJsonValue,
          },
        },
      })
    } else if (event.type === 'ticket.opened') {
      if (await asked(session.id, 'requestId', event.requestId)) continue
      const teammate = await eventTeammate(session, event)
      const title = event.title.length > 160 ? `${event.title.slice(0, 157)}...` : event.title
      await db.ticket.create({
        data: {
          organizationId: session.organizationId,
          workspaceId: session.workspaceId,
          sessionId: session.id,
          type: 'request',
          title: `${teammate?.name ?? 'Teammate'}: ${title}`,
          payload: {
            source: 'harness',
            teammateId: teammate?.id ?? session.teammateId,
            requestId: event.requestId,
            asks: event.asks as unknown as Prisma.InputJsonValue,
          },
        },
      })
    } else if (event.type === 'ticket.answered') {
      await db.ticket.updateMany({
        where: {
          sessionId: session.id,
          status: 'open',
          payload: { path: ['requestId'], equals: event.requestId },
        },
        data: {
          status: event.answer.action === 'declined' ? 'denied' : 'resolved',
          resolvedByMemberId: event.memberId,
          resolvedAt: new Date(event.at),
        },
      })
    } else if (event.type === 'question.answered') {
      await db.ticket.updateMany({
        where: {
          sessionId: session.id,
          status: 'open',
          payload: { path: ['questionId'], equals: event.questionId },
        },
        data: {
          status: 'resolved',
          resolvedByMemberId: event.memberId,
          resolvedAt: new Date(event.at),
        },
      })
    } else if (event.type === 'message.user') {
      await db.ticket.updateMany({
        where: { sessionId: session.id, status: 'open', type: 'usage_limit' },
        data: {
          status: 'resolved',
          resolvedByMemberId: event.memberId,
          resolvedAt: new Date(event.at),
        },
      })
    }
  }
}

/** The thread has a ticket for this ask already: its events are noted again (noteEvents). */
async function asked(
  sessionId: string,
  key: 'approvalId' | 'questionId' | 'requestId',
  id: string,
) {
  const tickets = await prisma.ticket.count({
    where: { sessionId, payload: { path: [key], equals: id } },
  })
  return tickets > 0
}

/** The teammate whose harness produced an event: one in the thread, else the starting one. */
async function eventTeammate(
  session: { id: string; workspaceId: string; teammateId: string },
  event: AgentEvent,
) {
  const seat = event.teammateId
    ? await prisma.threadTeammate.findFirst({
        where: { sessionId: session.id, teammateId: event.teammateId },
        include: { teammate: true },
      })
    : null
  return seat?.teammate ?? prisma.teammate.findUnique({ where: { id: session.teammateId } })
}

/** The part of a tool call a person needs to decide: the command, file or URL. */
function describeInput(input: unknown) {
  if (!input || typeof input !== 'object') return ''
  const i = input as Record<string, unknown>
  const value = [i.command, i.file_path, i.path, i.url, i.cmd].find((v) => typeof v === 'string')
  return typeof value === 'string'
    ? ` (${value.length > 120 ? `${value.slice(0, 117)}...` : value})`
    : ''
}
