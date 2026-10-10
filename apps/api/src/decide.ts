// A person resolves a ticket: approves or denies an action, allows work past a
// cap, or dismisses a notice. The Tickets page and the thread view both come here.
import { randomUUID } from 'node:crypto'
import {
  parseMentions,
  type Ask,
  type Question,
  type QuestionAnswer,
  type TicketAnswer,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit } from './audit.js'
import { decideTicket } from './connector-calls.js'
import { scoped } from './db.js'
import { broadcastThreadStatus, dispatch } from './hub.js'
import type { WorkspaceScope } from './scope.js'
import { loadThread, specFor, teammateIn } from './thread-spec.js'
import { joinThread, promptThread } from './work.js'

/**
 * A person answers the harness's question. Answers go to the thread as its
 * next input; a question asking for a secret takes options, a credential from
 * the vault (by mention, never its value) or a decline.
 */
export async function answerQuestion(
  scope: WorkspaceScope,
  ticketId: string,
  answer: QuestionAnswer,
) {
  const db = scoped(scope)
  const ticket = await db.ticket.findFirst({
    where: { id: ticketId, type: 'question', status: 'open' },
    include: { session: true },
  })
  const payload = ticket?.payload as TicketPayload | undefined
  if (!ticket?.sessionId || payload?.source !== 'harness' || !payload.questionId)
    throw new HTTPException(404, { message: 'Question not found or already answered' })
  const isAdmin = scope.role === 'owner' || scope.role === 'admin'
  if (!isAdmin && ticket.session?.startedByMemberId !== scope.memberId)
    throw new HTTPException(403, {
      message: 'Only the member who started the thread, or an admin, can answer',
    })
  if (answer.action !== 'declined') {
    const questions = new Map((payload.questions ?? []).map((q) => [q.id, q]))
    for (const [id, a] of Object.entries(answer.answers)) {
      const question = questions.get(id)
      if (!question) throw new HTTPException(400, { message: `Unknown question ${id}` })
      const options = new Set(question.options?.map((o) => o.id) ?? [])
      if (a.optionIds.some((o) => !options.has(o)))
        throw new HTTPException(400, { message: 'Unknown option' })
      if (
        a.freeform &&
        typeof question.allowFreeForm === 'object' &&
        question.allowFreeForm.secret &&
        !onlyCredentialMentions(a.freeform)
      )
        throw new HTTPException(400, {
          message:
            'Brigade never passes a secret in a message. Pick a credential from the vault instead, or decline.',
        })
    }
  }
  const thread = await loadThread(db, ticket.sessionId)
  const sent = await dispatch(thread.computer, {
    type: 'thread.answer',
    commandId: randomUUID(),
    // The answer goes to the harness of the teammate that asked.
    thread: await specFor(db, thread, { teammate: teammateIn(thread, payload.teammateId) }),
    questionId: payload.questionId,
    answer,
    memberId: scope.memberId,
  })
  if (sent === 'offline')
    throw new HTTPException(409, {
      message: 'That computer is offline. Start its runner and try again.',
    })
  await db.ticket.updateMany({
    where: { id: ticket.id, status: 'open' },
    data: { status: 'resolved', resolvedByMemberId: scope.memberId, resolvedAt: new Date() },
  })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: answer.action === 'declined' ? 'question.declined' : 'question.answered',
    target: { type: 'thread', id: thread.id },
    data: { ticketId: ticket.id },
  })
  return { ok: true as const, live: true }
}

/**
 * A person answers a ticket the teammate opened (open_ticket): every ask, or
 * a decline. The answers go to the teammate as the tool's result; changes to
 * a draft sent to another teammate also go to that teammate as a message.
 */
export async function answerTicket(scope: WorkspaceScope, ticketId: string, answer: TicketAnswer) {
  const db = scoped(scope)
  const ticket = await db.ticket.findFirst({
    where: { id: ticketId, type: 'request', status: 'open' },
    include: { session: true },
  })
  const payload = ticket?.payload as TicketPayload | undefined
  if (!ticket?.sessionId || payload?.source !== 'harness' || !payload.requestId)
    throw new HTTPException(404, { message: 'Ticket not found or already answered' })
  const isAdmin = scope.role === 'owner' || scope.role === 'admin'
  if (!isAdmin && ticket.session?.startedByMemberId !== scope.memberId)
    throw new HTTPException(403, {
      message: 'Only the member who started the thread, or an admin, can answer',
    })
  const thread = await loadThread(db, ticket.sessionId)
  const asker = teammateIn(thread, payload.teammateId)
  // Changes sent on to another teammate: [teammate id, what to tell it].
  const handoffs: [string, string][] = []
  if (answer.action === 'answered') {
    const asks = payload.asks ?? []
    for (const id of Object.keys(answer.replies))
      if (!asks.some((a) => a.id === id))
        throw new HTTPException(400, { message: `Unknown ask ${id}` })
    for (const ask of asks) {
      const reply = answer.replies[ask.id]
      if (!reply || reply.type !== ask.type)
        throw new HTTPException(400, { message: `Answer every ask (${ask.id})` })
      if (ask.type === 'decision' && reply.type === 'decision') {
        const ids = ask.options?.map((o) => o.id) ?? ['approve', 'decline']
        if (!ids.includes(reply.optionId))
          throw new HTTPException(400, { message: `Unknown option ${reply.optionId}` })
      }
      if (ask.type === 'input' && reply.type === 'input') {
        if (!reply.text.trim()) throw new HTTPException(400, { message: `Answer ${ask.id}` })
        if (ask.secret && !onlyCredentialMentions(reply.text))
          throw new HTTPException(400, {
            message: 'Pick a credential from the vault: Brigade never passes a secret in a message',
          })
      }
      if (ask.type === 'approval' && reply.type === 'approval' && !reply.approved) {
        if (!reply.changes?.trim())
          throw new HTTPException(400, { message: 'Say what should change' })
        if (reply.sendTo && reply.sendTo !== asker.id) {
          const to = await db.teammate.findFirst({
            where: { id: reply.sendTo, archivedAt: null },
          })
          if (!to) throw new HTTPException(404, { message: 'That teammate was not found' })
          handoffs.push([
            to.id,
            `Changes requested to ${asker.name}'s draft "${ask.title}":\n\n${reply.changes}\n\nThe draft:\n\n${ask.draft}`,
          ])
        }
      }
    }
  }
  const sent = await dispatch(thread.computer, {
    type: 'thread.ticket',
    commandId: randomUUID(),
    thread: await specFor(db, thread, { teammate: asker }),
    requestId: payload.requestId,
    answer,
    memberId: scope.memberId,
  })
  if (sent === 'offline')
    throw new HTTPException(409, {
      message: 'That computer is offline. Start its runner and try again.',
    })
  await db.ticket.updateMany({
    where: { id: ticket.id, status: 'open' },
    data: {
      status: answer.action === 'declined' ? 'denied' : 'resolved',
      resolvedByMemberId: scope.memberId,
      resolvedAt: new Date(),
    },
  })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: answer.action === 'declined' ? 'ticket.declined' : 'ticket.answered',
    target: { type: 'thread', id: thread.id },
    data: { requestId: payload.requestId, ticketId: ticket.id },
  })
  for (const [teammateId, text] of handoffs) {
    await joinThread(db, thread.id, [teammateId])
    await promptThread(db, scope, await loadThread(db, thread.id), {
      text,
      memberId: scope.memberId,
      teammateIds: [teammateId],
    })
  }
  return { ok: true as const }
}

/** An answer made only of credential mentions: it names vault entries, not secrets. */
const onlyCredentialMentions = (text: string) => {
  const parts = parseMentions(text)
  return (
    parts.some((p) => typeof p !== 'string') &&
    parts.every((p) => (typeof p === 'string' ? !p.trim() : p.kind === 'credential'))
  )
}

type TicketPayload = {
  /** A connector call waiting in this API process. */
  connectionId?: string
  /** A harness approval or question: the harness's own id for it. */
  source?: 'harness'
  /** The teammate whose harness asked, in a thread with several. */
  teammateId?: string
  approvalId?: string
  questionId?: string
  questions?: Question[]
  /** A ticket the teammate opened: its open_ticket call's id and its asks. */
  requestId?: string
  asks?: Ask[]
  /** A turn held back by a cap, and who answers it. */
  pending?: { text: string; memberId: string | null; teammateIds?: string[]; handoff?: boolean }
  /** A sign-in ticket's account. */
  accountId?: string
  /** The member a notice is for. */
  memberId?: string
}

export async function resolveTicket(
  scope: WorkspaceScope,
  ticketId: string,
  input: { approved: boolean; reason?: string },
): Promise<{ ok: true; live: boolean }> {
  const db = scoped(scope)
  const ticket = await db.ticket.findFirst({
    where: { id: ticketId, status: 'open' },
    include: { session: true },
  })
  if (!ticket) throw new HTTPException(404, { message: 'Ticket not found or already resolved' })
  const payload = ticket.payload as TicketPayload
  const isAdmin = scope.role === 'owner' || scope.role === 'admin'
  const isStarter = ticket.session?.startedByMemberId === scope.memberId
  const actor = { type: 'member' as const, id: scope.memberId }
  const close = (status: 'approved' | 'denied' | 'resolved') =>
    db.ticket.updateMany({
      where: { id: ticket.id, status: 'open' },
      data: { status, resolvedByMemberId: scope.memberId, resolvedAt: new Date() },
    })
  const reason = input.reason ? { reason: input.reason } : {}

  if (ticket.type === 'cap') {
    if (!isAdmin)
      throw new HTTPException(403, { message: 'Only an admin can allow work past a cap' })
    if (payload.connectionId) {
      return { ok: true, live: await decideTicket(scope, ticket.id, input) }
    }
    await close(input.approved ? 'approved' : 'denied')
    await audit({
      ...scope,
      actor,
      action: input.approved ? 'cap.allowed' : 'cap.denied',
      target: { type: 'ticket', id: ticket.id },
      ...(input.reason ? { data: reason } : {}),
    })
    if (!ticket.sessionId) return { ok: true, live: false }
    const thread = await loadThread(db, ticket.sessionId)
    if (input.approved && payload.pending) {
      await promptThread(db, scope, thread, payload.pending, { skipCaps: true })
    } else {
      // Never started: done. Started before: it waits for its next message.
      const status = thread.lastSeq > 0 ? 'idle' : 'done'
      await db.session.updateMany({ where: { id: thread.id }, data: { status } })
      broadcastThreadStatus(scope.workspaceId, thread.id, status)
    }
    return { ok: true, live: true }
  }

  if (ticket.type === 'approval') {
    if (!isAdmin && !isStarter)
      throw new HTTPException(403, {
        message: 'Only the member who started the thread, or an admin, can decide',
      })
    if (payload.source !== 'harness')
      return { ok: true, live: await decideTicket(scope, ticket.id, input) }
    // The harness asked before a built-in tool call: the answer goes to the runner.
    if (!ticket.sessionId || !payload.approvalId)
      throw new HTTPException(409, { message: 'This approval has no thread' })
    const thread = await loadThread(db, ticket.sessionId)
    const sent = await dispatch(thread.computer, {
      type: 'thread.approval',
      commandId: randomUUID(),
      thread: await specFor(db, thread, { teammate: teammateIn(thread, payload.teammateId) }),
      approvalId: payload.approvalId,
      approved: input.approved,
      ...reason,
      memberId: scope.memberId,
    })
    if (sent === 'offline')
      throw new HTTPException(409, {
        message: 'That computer is offline. Start its runner and try again.',
      })
    await close(input.approved ? 'approved' : 'denied')
    await audit({
      ...scope,
      actor,
      action: input.approved ? 'approval.approved' : 'approval.denied',
      target: { type: 'thread', id: thread.id },
      data: { approvalId: payload.approvalId, ticketId: ticket.id, ...reason },
    })
    return { ok: true, live: true }
  }

  // The harness's question is answered in the thread; from the queue it can only be declined.
  if (ticket.type === 'question' && payload.source === 'harness') {
    if (input.approved)
      throw new HTTPException(409, { message: 'Answer this question in its thread' })
    return answerQuestion(scope, ticket.id, { action: 'declined' })
  }
  // Likewise a ticket the teammate opened.
  if (ticket.type === 'request' && payload.source === 'harness') {
    if (input.approved)
      throw new HTTPException(409, { message: 'Answer this ticket in its thread' })
    await answerTicket(scope, ticket.id, { action: 'declined' })
    return { ok: true, live: true }
  }

  // Notices (sign-in, usage limit, question): dismissed by whoever they concern, or an admin.
  const concerns = payload.memberId ? payload.memberId === scope.memberId : isStarter
  if (!isAdmin && !concerns)
    throw new HTTPException(403, { message: 'This ticket is for another member' })
  await close('resolved')
  await audit({
    ...scope,
    actor,
    action: 'ticket.dismissed',
    target: { type: 'ticket', id: ticket.id },
  })
  return { ok: true, live: false }
}
