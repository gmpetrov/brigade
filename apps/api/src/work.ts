// Starting a teammate's next turn. Members' messages, webhooks and approved
// caps all come through here, so caps are checked in one place.
import { randomUUID } from 'node:crypto'
import { mentionedIds } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit } from './audit.js'
import { capLabel, turnCapReached } from './caps.js'
import type { RunnerToApi } from '@brigade/contracts'
import { scoped, type Scope, type ScopedDb } from './db.js'
import { broadcastThreadStatus, dispatch, runnerProtocol } from './hub.js'
import { usableAccounts } from './routes/accounts.js'
import {
  currentTeammate,
  loadThread,
  noAccount,
  specFor,
  teammateIn,
  type LoadedThread,
} from './thread-spec.js'

type Thread = LoadedThread

/** A message for the thread, and the teammates that answer it in order (default: the current one). */
type Prompt = { text: string; memberId: string | null; teammateIds?: string[]; handoff?: boolean }

const MAX_TEAMMATES_PER_MESSAGE = 5

/**
 * The teammates a message mentions, in order: they answer it. Unknown or
 * archived ones are an error, so a typo never goes to someone else instead.
 */
export async function mentionedTeammates(db: ScopedDb, text: string): Promise<string[]> {
  const mentioned = [...new Set(mentionedIds(text, 'teammate'))]
  if (mentioned.length === 0) return []
  if (mentioned.length > MAX_TEAMMATES_PER_MESSAGE)
    throw new HTTPException(400, {
      message: `Mention at most ${MAX_TEAMMATES_PER_MESSAGE} teammates in one message`,
    })
  const found = await db.teammate.count({ where: { id: { in: mentioned }, archivedAt: null } })
  if (found !== mentioned.length)
    throw new HTTPException(404, { message: 'A mentioned teammate was not found or is archived' })
  return mentioned
}

/** Bring teammates into a thread. Those already in it stay as they are. */
export async function joinThread(db: ScopedDb, sessionId: string, teammateIds: string[]) {
  await db.threadTeammate.createMany({
    data: teammateIds.map((teammateId) => ({ sessionId, teammateId })) as never,
    skipDuplicates: true,
  })
}

/**
 * Send a prompt to the thread's computer, unless a daily cap is reached: then
 * the thread pauses and a cap ticket holds the prompt until an admin decides.
 */
export async function promptThread(
  db: ScopedDb,
  scope: Scope,
  thread: Thread,
  prompt: Prompt,
  options: { isNew?: boolean; skipCaps?: boolean } = {},
): Promise<'sent' | 'queued' | 'offline' | 'paused'> {
  const ids = prompt.teammateIds?.length ? prompt.teammateIds : [currentTeammate(thread).id]
  const responders = ids.map((id) => teammateIn(thread, id))
  if (responders.length > 1 || responders[0]!.id !== thread.teammateId) {
    const protocol = runnerProtocol(thread.computer.id)
    if (protocol !== undefined && protocol < 2)
      throw new HTTPException(409, {
        message: "This computer's runner is too old for threads with several teammates. Update it.",
      })
  }
  for (const teammate of options.skipCaps ? [] : responders) {
    const reached = await turnCapReached(db, teammate, {
      id: thread.id,
      isNew: (options.isNew ?? false) && teammate.id === thread.teammateId,
    })
    if (reached) {
      await db.session.updateMany({ where: { id: thread.id }, data: { status: 'paused' } })
      const ticket = await db.ticket.create({
        data: {
          sessionId: thread.id,
          type: 'cap',
          title: `${teammate.name} reached its cap of ${reached.limit} ${capLabel[reached.cap]}`,
          payload: {
            ...reached,
            teammateId: teammate.id,
            pending: { ...prompt, teammateIds: ids },
          },
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
  const specs = []
  for (const teammate of responders) specs.push(await specFor(db, thread, { teammate }))
  // The last to answer is the one a later message without a mention goes to.
  const now = Date.now()
  for (const [i, teammate] of responders.entries())
    await db.threadTeammate.updateMany({
      where: { sessionId: thread.id, teammateId: teammate.id },
      data: { lastTurnAt: new Date(now + i) },
    })
  const [first, ...then] = specs
  return dispatch(thread.computer, {
    type: 'thread.prompt',
    commandId: randomUUID(),
    thread: first!,
    text: prompt.text,
    memberId: prompt.memberId,
    then,
    ...(prompt.handoff ? { handoff: true } : {}),
  })
}

/** Teammates answering one another stop after this many turns without a member's message. */
const MAX_TURNS_WITHOUT_MEMBER = 50

/**
 * A teammate's reply mentioned others in the thread: they answer next, as if a
 * member had asked them, within the caps and the chain limit.
 */
export async function handoffThread(
  runner: { computerId: string; organizationId: string; workspaceId: string },
  message: Extract<RunnerToApi, { type: 'thread.handoff' }>,
) {
  const scope: Scope = { organizationId: runner.organizationId, workspaceId: runner.workspaceId }
  const db = scoped(scope)
  // A runner may only hand on threads on its own computer.
  const session = await db.session.findFirst({
    where: { id: message.sessionId, computerId: runner.computerId },
  })
  if (!session || session.status === 'paused' || session.status === 'failed') return
  const thread = await loadThread(db, session.id)
  const inThread = new Set(thread.teammates.map((t) => t.teammateId))
  if (!inThread.has(message.fromTeammateId)) return
  const ids = [...new Set(message.teammateIds)].filter(
    (id) => id !== message.fromTeammateId && inThread.has(id),
  )
  if (ids.length === 0) return
  const lastMember = await db.sessionEvent.findFirst({
    where: { sessionId: session.id, type: 'message.user' },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  })
  const turns = await db.sessionEvent.count({
    where: { sessionId: session.id, type: 'turn.started', seq: { gt: lastMember?.seq ?? 0 } },
  })
  if (turns >= MAX_TURNS_WITHOUT_MEMBER)
    return console.log(`thread ${session.id}: handoff stopped after ${turns} turns`)
  await audit({
    ...scope,
    actor: { type: 'teammate', id: message.fromTeammateId },
    action: 'thread.handed_off',
    target: { type: 'thread', id: session.id },
    data: { to: ids },
  })
  await promptThread(db, scope, thread, {
    text: '',
    memberId: null,
    teammateIds: ids,
    handoff: true,
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
  // Teammates the first message mentions answer after the starting one. A webhook's text is untrusted: it summons nobody.
  const teammateIds = [
    input.teammate.id,
    ...(input.origin ? [] : await mentionedTeammates(db, input.text)).filter(
      (id) => id !== input.teammate.id,
    ),
  ]
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
  await joinThread(db, created.id, teammateIds)
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
    { text: input.text, memberId: input.origin ? null : input.memberId, teammateIds },
    { isNew: true },
  ).catch(async (error: unknown) => {
    // E.g. a mentioned teammate's harness has no account: the thread never ran.
    await db.session.updateMany({ where: { id: thread.id }, data: { status: 'failed' } })
    throw error
  })
  if (outcome === 'offline')
    await db.session.updateMany({ where: { id: thread.id }, data: { status: 'failed' } })
  return { thread, outcome }
}
