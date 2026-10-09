// Starting a teammate's next turn. Members' messages, webhooks and approved
// caps all come through here, so caps are checked in one place.
import { randomUUID } from 'node:crypto'
import { audit } from './audit.js'
import { capLabel, turnCapReached } from './caps.js'
import type { Scope, ScopedDb } from './db.js'
import { broadcastThreadStatus, dispatch } from './hub.js'
import { usableAccounts } from './routes/accounts.js'
import { loadThread, noAccount, specFor } from './thread-spec.js'

type Thread = Awaited<ReturnType<typeof loadThread>>

/**
 * Send a prompt to the thread's computer, unless a daily cap is reached: then
 * the thread pauses and a cap ticket holds the prompt until an admin decides.
 */
export async function promptThread(
  db: ScopedDb,
  scope: Scope,
  thread: Thread,
  prompt: { text: string; memberId: string | null },
  options: { isNew?: boolean; skipCaps?: boolean } = {},
): Promise<'sent' | 'queued' | 'offline' | 'paused'> {
  if (!options.skipCaps) {
    const reached = await turnCapReached(db, thread.teammate, {
      id: thread.id,
      isNew: options.isNew ?? false,
    })
    if (reached) {
      await db.session.updateMany({ where: { id: thread.id }, data: { status: 'paused' } })
      const ticket = await db.ticket.create({
        data: {
          sessionId: thread.id,
          type: 'cap',
          title: `${thread.teammate.name} reached its cap of ${reached.limit} ${capLabel[reached.cap]}`,
          payload: { ...reached, teammateId: thread.teammate.id, pending: prompt },
        } as never,
      })
      await audit({
        ...scope,
        actor: { type: 'system', id: 'brigade' },
        action: 'cap.reached',
        target: { type: 'thread', id: thread.id },
        data: { ...reached, ticketId: ticket.id },
      })
      broadcastThreadStatus(scope.workspaceId, thread.id, 'paused')
      return 'paused'
    }
  }
  return dispatch(thread.computer, {
    type: 'thread.prompt',
    commandId: randomUUID(),
    thread: await specFor(db, thread),
    text: prompt.text,
    memberId: prompt.memberId,
  })
}

/**
 * A new thread with a fresh context, on the starting member's accounts. For a
 * webhook, the member who set it up. Throws when they have no usable account.
 */
export async function startThread(
  db: ScopedDb,
  scope: Scope,
  input: {
    teammate: { id: string; name: string; harness: 'claude_code' | 'codex' }
    computer: { id: string }
    memberId: string
    accountId?: string | null
    title: string
    text: string
    origin?: { webhookId: string }
  },
) {
  const [account] = await usableAccounts(db, {
    memberId: input.memberId,
    computerId: input.computer.id,
    provider: input.teammate.harness,
    preferredId: input.accountId ?? null,
  })
  if (!account) throw noAccount(input.teammate.harness)
  const created = await db.session.create({
    data: {
      teammateId: input.teammate.id,
      startedByMemberId: input.memberId,
      computerId: input.computer.id,
      accountId: account.id,
      title: input.title.slice(0, 120),
      ...(input.origin ? { origin: 'webhook', webhookId: input.origin.webhookId } : {}),
    } as never,
  })
  await audit({
    ...scope,
    actor: input.origin
      ? { type: 'system', id: `webhook:${input.origin.webhookId}` }
      : { type: 'member', id: input.memberId },
    action: 'thread.started',
    target: { type: 'thread', id: created.id },
    data: {
      teammateId: input.teammate.id,
      computerId: input.computer.id,
      accountId: account.id,
      ...(input.origin ? { webhookId: input.origin.webhookId } : {}),
    },
  })
  const thread = await loadThread(db, created.id)
  const outcome = await promptThread(
    db,
    scope,
    thread,
    { text: input.text, memberId: input.origin ? null : input.memberId },
    { isNew: true },
  )
  if (outcome === 'offline')
    await db.session.updateMany({ where: { id: thread.id }, data: { status: 'failed' } })
  return { thread, outcome }
}
