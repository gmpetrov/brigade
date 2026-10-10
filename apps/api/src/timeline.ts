// A teammate's status timeline and a thread's run log. Both are read from the
// event, call and audit logs; neither has a store of its own.
import type { ScopedDb } from './db.js'

export type TimelineState = 'working' | 'waiting' | 'blocked' | 'done'
type Transition = { at: Date; state: TimelineState; note?: string }

/**
 * The events of one teammate in a thread. Harness events carry the teammate
 * that produced them; in a thread where turns say who answers (turn.started),
 * a member's message starts nobody's turn, and other unmarked events (a change
 * of control) concern everyone. Older threads had one teammate: the starter.
 */
export function eventsOf<E extends { type: string; data: unknown }>(
  events: E[],
  teammateId: string,
  starterId: string,
): E[] {
  const turns = events.some((e) => e.type === 'turn.started')
  return events.filter((e) => {
    const by = (e.data as { teammateId?: string } | null)?.teammateId
    if (by) return by === teammateId
    if (turns) return e.type !== 'message.user'
    return teammateId === starterId
  })
}

/** What each event means for the teammate's state in that thread. */
function transitionOf(type: string, data: Record<string, unknown>, at: Date): Transition | null {
  switch (type) {
    case 'turn.started':
    case 'message.user':
    case 'approval.resolved':
    case 'question.answered':
      return { at, state: 'working' }
    case 'question.asked':
      return { at, state: 'waiting', note: 'question' }
    case 'approval.requested':
      return { at, state: 'waiting', note: String(data.toolName ?? '') }
    case 'turn.completed':
      return { at, state: 'done' }
    case 'error':
      return { at, state: 'blocked', note: 'error' }
    case 'account.switched':
      return data.toAccountId ? null : { at, state: 'blocked', note: 'out of usage' }
    case 'control.changed':
      return data.controller === 'human'
        ? { at, state: 'blocked', note: 'taken over' }
        : { at, state: 'done' }
    default:
      return null
  }
}

const STATE_EVENTS = [
  'turn.started',
  'message.user',
  'question.asked',
  'question.answered',
  'approval.resolved',
  'approval.requested',
  'turn.completed',
  'error',
  'account.switched',
  'control.changed',
]

/** Per thread, the stretches of working, waiting for approval, blocked and done in a window. */
export async function teammateTimeline(db: ScopedDb, teammateId: string, from: Date, to: Date) {
  const sessions = await db.session.findMany({
    where: {
      teammates: { some: { teammateId } },
      updatedAt: { gte: from },
      createdAt: { lte: to },
    },
    select: {
      id: true,
      title: true,
      status: true,
      origin: true,
      createdAt: true,
      teammateId: true,
    },
    orderBy: { createdAt: 'asc' },
    take: 200,
  })
  const ids = sessions.map((s) => s.id)
  const [events, tickets] = await Promise.all([
    db.sessionEvent.findMany({
      where: { sessionId: { in: ids }, type: { in: STATE_EVENTS }, at: { lte: to } },
      select: { sessionId: true, type: true, at: true, data: true },
      orderBy: [{ sessionId: 'asc' }, { seq: 'asc' }],
    }),
    // Turns held back by a cap have no events yet: their ticket is the record.
    db.ticket.findMany({
      where: { sessionId: { in: ids }, type: 'cap', createdAt: { lte: to } },
      select: { sessionId: true, createdAt: true, resolvedAt: true, status: true, payload: true },
    }),
  ])
  const eventsBy = Map.groupBy(events, (e) => e.sessionId)
  const ticketsBy = Map.groupBy(tickets, (t) => t.sessionId!)

  const totals: Record<TimelineState, number> = { working: 0, waiting: 0, blocked: 0, done: 0 }
  const threads = sessions.map((session) => {
    const transitions: Transition[] = []
    for (const e of eventsOf(eventsBy.get(session.id) ?? [], teammateId, session.teammateId)) {
      const t = transitionOf(e.type, e.data as Record<string, unknown>, e.at)
      if (t) transitions.push(t)
    }
    for (const t of ticketsBy.get(session.id) ?? []) {
      if ((t.payload as { connectionId?: string }).connectionId) continue // shown as waiting
      transitions.push({ at: t.createdAt, state: 'blocked', note: 'daily cap' })
      if (t.status === 'denied' && t.resolvedAt)
        transitions.push({ at: t.resolvedAt, state: 'done' })
    }
    transitions.sort((a, b) => a.at.getTime() - b.at.getTime())

    const segments: { state: TimelineState; from: string; to: string; note?: string }[] = []
    for (const [i, t] of transitions.entries()) {
      const start = Math.max(t.at.getTime(), from.getTime())
      const end = Math.min(transitions[i + 1]?.at.getTime() ?? to.getTime(), to.getTime())
      if (end <= start) continue
      // A finished thread is done from then on; show it only up to the next activity.
      if (t.state === 'done' && i === transitions.length - 1) continue
      const last = segments.at(-1)
      if (last && last.state === t.state && last.note === t.note && Date.parse(last.to) === start) {
        last.to = new Date(end).toISOString()
      } else {
        segments.push({
          state: t.state,
          from: new Date(start).toISOString(),
          to: new Date(end).toISOString(),
          ...(t.note ? { note: t.note } : {}),
        })
      }
      totals[t.state] += (end - start) / 1000
    }
    const done = transitions.findLast((t) => t.state === 'done')
    return {
      id: session.id,
      title: session.title,
      status: session.status,
      origin: session.origin,
      segments,
      ...(done ? { doneAt: done.at.toISOString() } : {}),
    }
  })
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    totals,
    threads: threads.filter((t) => t.segments.length > 0 || t.doneAt),
  }
}

/**
 * A thread end to end: its events (without streaming deltas), connector calls,
 * tickets and the audit entries about it, in time order, with members named.
 */
export async function runLog(db: ScopedDb, sessionId: string) {
  const [events, calls, tickets] = await Promise.all([
    db.sessionEvent.findMany({
      where: { sessionId, type: { notIn: ['message.delta'] } },
      orderBy: { seq: 'asc' },
    }),
    db.connectionCall.findMany({
      where: { sessionId },
      include: { connection: { select: { label: true, externalAccount: true, kind: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    db.ticket.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } }),
  ])
  const audits = await db.auditEntry.findMany({
    where: {
      OR: [
        { targetType: 'thread', targetId: sessionId },
        { targetType: 'ticket', targetId: { in: tickets.map((t) => t.id) } },
      ],
    },
    orderBy: { at: 'asc' },
  })

  // Name every member who appears.
  const memberIds = new Set<string>()
  for (const e of events) {
    const id = (e.data as { memberId?: string | null }).memberId
    if (id) memberIds.add(id)
  }
  for (const a of audits) if (a.actorType === 'member') memberIds.add(a.actorId)
  for (const t of tickets) if (t.resolvedByMemberId) memberIds.add(t.resolvedByMemberId)
  const members = await db.member.findMany({
    where: { id: { in: [...memberIds] } },
    select: { id: true, user: { select: { name: true, email: true } } },
  })
  const names = Object.fromEntries(members.map((m) => [m.id, m.user.name || m.user.email]))

  type Entry = { at: string; source: string; type: string; data: unknown; seq?: number }
  const entries: Entry[] = [
    ...events.map((e) => ({
      at: e.at.toISOString(),
      source: 'event',
      type: e.type,
      seq: e.seq,
      data: e.data,
    })),
    ...calls.map((c) => ({
      at: c.createdAt.toISOString(),
      source: 'call',
      type: c.result,
      data: {
        connection: c.connection.externalAccount ?? c.connection.label,
        kind: c.connection.kind,
        operation: c.operation,
        write: c.write,
        target: c.target,
        error: c.error,
        ticketId: c.ticketId,
      },
    })),
    ...tickets.flatMap((t) => [
      {
        at: t.createdAt.toISOString(),
        source: 'ticket',
        type: `${t.type}.opened`,
        data: { id: t.id, title: t.title },
      },
      ...(t.resolvedAt
        ? [
            {
              at: t.resolvedAt.toISOString(),
              source: 'ticket',
              type: `${t.type}.${t.status}`,
              data: { id: t.id, title: t.title, memberId: t.resolvedByMemberId },
            },
          ]
        : []),
    ]),
    ...audits.map((a) => ({
      at: a.at.toISOString(),
      source: 'audit',
      type: a.action,
      data: { actorType: a.actorType, actorId: a.actorId, ...(a.data as object | null) },
    })),
  ]
  entries.sort((a, b) => a.at.localeCompare(b.at) || (a.seq ?? 0) - (b.seq ?? 0))
  return { entries, members: names }
}
