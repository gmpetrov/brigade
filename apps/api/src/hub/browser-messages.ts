// A dashboard's messages, as its workspace's hub takes them (src/hub/workspace-hub.ts): it
// follows threads (their events replayed, then live), says when it is in view, and relays
// takeover terminals to the runner that runs their shell.
import { BrowserToApi, type SequencedEvent } from '@brigade/contracts'
import { audit } from '../audit.js'
import { prisma, scoped } from '../db.js'
import { historyContext, pageStart } from '../thread-history.js'
import { specFor } from '../thread-spec.js'
import type { BrowserConn } from './host.js'
import type { WorkspaceHub } from './workspace-hub.js'

export async function onBrowserMessage(hub: WorkspaceHub, conn: BrowserConn, raw: string) {
  const send = (message: Parameters<WorkspaceHub['send']>[1]) => hub.send(conn, message)
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return send({ type: 'error', message: 'bad message' })
  }
  const parsed = BrowserToApi.safeParse(json)
  if (!parsed.success) return send({ type: 'error', message: 'bad message' })
  const message = parsed.data
  const { scope } = conn
  if (message.type === 'keepalive') return
  if (message.type === 'unsubscribe') {
    conn.sessions.delete(message.sessionId)
    hub.host.persist(conn)
    return
  }
  if (message.type === 'presence') return hub.notePresence(conn, message.visible)
  if (message.type === 'terminal.input' || message.type === 'terminal.close') {
    const terminal = conn.terminals.find((t) => t.terminalId === message.terminalId)
    if (!terminal) return
    if (message.type === 'terminal.close') hub.removeTerminal(conn, message.terminalId)
    hub.sendToRunner(terminal.computerId, message)
    return
  }
  if (message.type === 'terminal.open') return openTerminal(hub, conn, message)

  const session = await prisma.session.findFirst({
    where: {
      id: message.sessionId,
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
    },
  })
  if (!session) return send({ type: 'error', message: 'thread not found' })
  conn.sessions.add(session.id)
  hub.host.persist(conn)
  // Replay from storage; live events may interleave, and the client dedupes by seq.
  let afterSeq = message.afterSeq
  // Opened afresh: only the latest page, and what the whole thread needs from before it.
  if (message.tail && afterSeq === 0) {
    const firstSeq = await pageStart(session.id, session.lastSeq + 1)
    const context = await historyContext(session.id, firstSeq)
    send({ type: 'history', sessionId: session.id, firstSeq, context, lastSeq: session.lastSeq })
    afterSeq = firstSeq - 1
  }
  for (;;) {
    const rows = await prisma.sessionEvent.findMany({
      where: { sessionId: session.id, seq: { gt: afterSeq, lte: session.lastSeq } },
      orderBy: { seq: 'asc' },
      take: 500,
    })
    if (rows.length === 0) break
    send({
      type: 'events',
      events: rows.map((r) => ({
        sessionId: r.sessionId,
        seq: r.seq,
        event: r.data as unknown as SequencedEvent['event'],
      })),
    })
    afterSeq = rows.at(-1)!.seq
  }
  // And its status now, and its computer's: a dashboard that was away (a phone asleep) missed their changes.
  const now = await prisma.session.findUnique({
    where: { id: session.id },
    select: { status: true, computer: { select: { id: true, status: true } } },
  })
  if (now)
    send({
      type: 'thread.updated',
      sessionId: session.id,
      status: now.status,
      computer: {
        id: now.computer.id,
        online: hub.isOnline(now.computer.id),
        restarting: hub.isRestarting(now.computer.id),
        status: now.computer.status,
      },
    })
}

/** A takeover terminal on the thread's cloud computer: relayed between it and this dashboard. */
async function openTerminal(
  hub: WorkspaceHub,
  conn: BrowserConn,
  message: Extract<BrowserToApi, { type: 'terminal.open' }>,
) {
  const { scope } = conn
  const db = scoped(scope)
  const thread = await db.session.findFirst({
    where: { id: message.sessionId },
    include: {
      teammate: true,
      computer: true,
      teammates: { include: { teammate: true }, orderBy: { joinedAt: 'asc' } },
      parent: { select: { id: true, title: true } },
      task: { select: { id: true, title: true, description: true, completedAt: true } },
      startedBy: { select: { suggestions: true } },
    },
  })
  const fail = (text: string) => {
    hub.removeTerminal(conn, message.terminalId)
    hub.send(conn, {
      type: 'terminal.output',
      terminalId: message.terminalId,
      data: `\r\n${text}\r\n`,
    })
    hub.send(conn, { type: 'terminal.exit', terminalId: message.terminalId, code: null })
  }
  if (!thread || thread.computer.kind !== 'cloud')
    return fail('Terminals are only available on the cloud computer')
  if (thread.controlledByMemberId !== scope.memberId) return fail('Take over the thread first')
  if (hub.terminalOf(message.terminalId)) return
  hub.addTerminal(conn, {
    terminalId: message.terminalId,
    computerId: thread.computerId,
    sessionId: thread.id,
  })
  const spec = await specFor(db, thread, { requireUsage: false }).catch(() => null)
  if (!spec) return fail('This thread has no account on this computer')
  await hub.dispatch(thread.computer, {
    type: 'terminal.open',
    terminalId: message.terminalId,
    thread: spec,
    memberId: scope.memberId,
    cols: message.cols,
    rows: message.rows,
  })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'takeover.terminal_opened',
    target: { type: 'thread', id: thread.id },
  })
}
