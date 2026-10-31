// A person resolves a ticket: approves or denies an action, allows work past a
// cap, or dismisses a notice. The Tickets page and the thread view both come here.
import { randomUUID } from 'node:crypto'
import {
  mentionedIds,
  parseMentions,
  type Ask,
  type PlaybookPromotionPayload,
  type Question,
  type QuestionAnswer,
  type ThreadAttachmentRef,
  type TicketAnswer,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { mayWrite } from './account-sharing.js'
import { usableIn } from './apps.js'
import { audit } from './audit.js'
import { decideTicket } from './connector-calls.js'
import { connectionsReaching } from './git.js'
import { appCatalog } from './connectors/index.js'
import { mcpAppKey } from './mcp-servers.js'
import type { ConnectorKind } from './connectors/types.js'
import { mayManage, type CredentialAction } from './credentials.js'
import { scoped, type ScopedDb } from './db.js'
import { hubs, threadUpdated } from './hub.js'
import { accountReaching } from './repository-grant.js'
import type { WorkspaceScope } from './scope.js'
import { decidePromotion } from './playbook-autonomy.js'
import { decideActivation } from './playbooks.js'
import { decideSkillProposal } from './skills.js'
import { loadThread, noteAsker, specFor, teammateIn } from './thread-spec.js'
import { handBack, joinThread, promptThread } from './work.js'

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
    include: { session: { include: { computer: { select: { kind: true } } } } },
  })
  const payload = ticket?.payload as TicketPayload | undefined
  if (!ticket?.sessionId || payload?.source !== 'harness' || !payload.questionId)
    throw new HTTPException(404, { message: 'Question not found or already answered' })
  if (!ticket.session || !mayAnswer(scope, ticket.session))
    throw new HTTPException(403, {
      message: 'Only who may write in the thread, or an admin, can answer',
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
            'Brigade never passes a secret in a message. Pick a saved secret instead, or decline.',
        })
    }
  }
  const thread = await loadThread(db, ticket.sessionId)
  // What they answer the teammate goes on with: their request now.
  if (answer.action !== 'declined') await noteAsker(db, thread.id, scope.memberId)
  const sent = await hubs.get(thread.computer.workspaceId).dispatch(thread.computer, {
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
 * Who may answer a thread's questions and tickets, and allow its teammates' steps: whoever may
 * write in it (src/account-sharing.ts), or an admin.
 */
export function mayAnswer(
  scope: WorkspaceScope,
  thread: { startedByMemberId: string; othersMayPrompt: boolean; computer: { kind: string } },
) {
  return scope.role === 'owner' || scope.role === 'admin' || mayWrite(thread, scope)
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
    include: { session: { include: { computer: { select: { kind: true } } } } },
  })
  const payload = ticket?.payload as TicketPayload | undefined
  if (!ticket?.sessionId || payload?.source !== 'harness' || !payload.requestId)
    throw new HTTPException(404, { message: 'Ticket not found or already answered' })
  if (!ticket.session || !mayAnswer(scope, ticket.session))
    throw new HTTPException(403, {
      message: 'Only who may write in the thread, or an admin, can answer',
    })
  const thread = await loadThread(db, ticket.sessionId)
  const asker = teammateIn(thread, payload.teammateId)
  // Changes sent on to another teammate: [teammate id, what to tell it].
  const handoffs: [string, string][] = []
  // App access granted from the ticket, given once every answer checks out.
  const grants: {
    app: NonNullable<Extract<Ask, { type: 'access' }>['app']>
    what: string
    connectionId?: string
  }[] = []
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
            message: 'Pick a saved secret: Brigade never passes a secret in a message',
          })
      }
      if (ask.type === 'variables' && reply.type === 'variables') {
        // Names only: the values were saved for the preview before the ticket was answered.
        const asked = ask.variables.map((v) => v.name)
        const named = [...reply.set, ...reply.skipped]
        if (
          named.length !== asked.length ||
          new Set(named).size !== named.length ||
          !asked.every((n) => named.includes(n))
        )
          throw new HTTPException(400, { message: 'Set or skip each variable' })
        const saved = await db.previewVariable.count({
          where: { repository: ask.repository.toLowerCase(), name: { in: reply.set } },
        })
        if (saved !== reply.set.length)
          throw new HTTPException(400, { message: 'Save the variables before answering' })
      }
      if (ask.type === 'access' && reply.type === 'access' && ask.app && reply.granted)
        grants.push({
          app: ask.app,
          what: ask.what,
          ...(reply.connectionId ? { connectionId: reply.connectionId } : {}),
        })
      if (ask.type === 'access' && reply.type === 'access' && reply.credential) {
        // A credential the person picked or just saved: one of this workspace's vault.
        const ids = mentionedIds(reply.credential, 'credential')
        if (
          ask.kind !== 'credential' ||
          !reply.granted ||
          !onlyCredentialMentions(reply.credential) ||
          (await db.credential.count({ where: { id: { in: ids } } })) !== new Set(ids).size
        )
          throw new HTTPException(400, { message: 'Pick a saved secret' })
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
  // The teammate takes no input while a person has control. The member in control answers once
  // done on the computer (a "verify you are human" check, say): control goes back with the answer.
  if (thread.controlledByMemberId === scope.memberId) await handBack(db, scope, thread, '')
  else if (thread.controlledByMemberId)
    throw new HTTPException(409, {
      message: 'Another member has control of this thread. It can be answered once they hand back.',
    })
  // Every account checked before any is given, then given before the answer goes out, so the
  // spec it carries has the App's tools.
  const accounts = []
  for (const grant of grants)
    accounts.push(
      await accountToGrant(db, scope, thread, grant.app, grant.what, grant.connectionId),
    )
  // Each for the teammate it names (a playbook's developer), else the one asking.
  const holders = []
  for (const grant of grants) holders.push(await accessHolder(db, asker, grant.app.teammate))
  for (const [i, account] of accounts.entries())
    await grantAccount(db, scope, holders[i]!.id, account, grants[i]!.app.scope)
  // What they answer the teammate goes on with: their request now.
  if (answer.action !== 'declined') await noteAsker(db, thread.id, scope.memberId)
  const sent = await hubs.get(thread.computer.workspaceId).dispatch(thread.computer, {
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

/**
 * The App's account to give the teammate that asked, from its ticket. It must be
 * one the person may give (theirs, or any for an owner or admin), usable in this
 * thread and, for a GitHub ask naming a repository, one whose installation reaches it.
 */
async function accountToGrant(
  db: ScopedDb,
  scope: WorkspaceScope,
  thread: { startedByMemberId: string },
  app: { kind: string; scope: 'read' | 'read_write'; url?: string; repository?: string },
  what: string,
  connectionId: string | undefined,
) {
  // An MCP server added by its URL: the App for that URL, whatever its name.
  let key: string | undefined
  try {
    key = app.kind === 'mcp' && app.url ? mcpAppKey(app.url) : undefined
  } catch {
    // not a URL
  }
  // No URL in the ask: the server added under the name the teammate gave, else the server of
  // the account the person picked in the ticket.
  if (app.kind === 'mcp' && !key && !app.url)
    key = (
      await db.app.findFirst({
        where: { key: { startsWith: 'mcp:' }, name: { equals: what.trim(), mode: 'insensitive' } },
      })
    )?.key
  if (app.kind === 'mcp' && !key && connectionId)
    key = (
      await db.connection.findFirst({
        where: { id: connectionId, kind: 'mcp' },
        include: { app: true },
      })
    )?.app.key
  if (app.kind === 'mcp' && !key)
    throw new HTTPException(400, { message: 'The ticket does not say which MCP server' })
  const server = key ? await db.app.findFirst({ where: { key } }) : null
  const entry = key
    ? { name: server?.name ?? 'the MCP server' }
    : appCatalog[app.kind as ConnectorKind]
  if (!entry || app.kind === 'webhook')
    throw new HTTPException(400, { message: `${app.kind} is not an App teammates can use` })
  const accounts = await db.connection.findMany({
    where: { kind: app.kind as ConnectorKind, status: 'active', ...(key ? { app: { key } } : {}) },
  })
  if (accounts.length === 0)
    throw new HTTPException(409, { message: `Connect ${entry.name} first` })
  const admin = scope.role === 'owner' || scope.role === 'admin'
  const givable = accounts.filter((c) => admin || c.createdByMemberId === scope.memberId)
  if (givable.length === 0)
    throw new HTTPException(403, {
      message: `Only the member who connected ${entry.name}, or an owner or admin, can give access to it`,
    })
  const usable = givable.filter((c) => usableIn(c, thread))
  const named = connectionId ? givable.find((c) => c.id === connectionId) : undefined
  if (named && !usableIn(named, thread))
    throw new HTTPException(409, {
      message: `${named.externalAccount ?? named.label} is kept to its owner's threads. Open it to every thread first, from Apps.`,
    })
  if (usable.length === 0)
    throw new HTTPException(409, {
      message: `This ${entry.name} account is kept to its owner's threads. Open it to every thread first, from Apps.`,
    })
  if (app.kind === 'github' && app.repository) {
    // Listed again if a few seconds old: the person may just have added it on GitHub.
    const reaching = await connectionsReaching(
      db,
      scope,
      app.repository,
      REACH_MAX_AGE_MS,
      usable.map((c) => c.id),
    ).catch((error) => {
      if (error instanceof HTTPException) throw error
      throw new HTTPException(502, { message: 'GitHub did not answer. Try again.' })
    })
    return accountReaching(app.repository, usable, new Set(reaching), connectionId)
  }
  const account = connectionId
    ? usable.find((c) => c.id === connectionId)
    : usable.length === 1
      ? usable[0]
      : undefined
  if (!account) throw new HTTPException(400, { message: `Pick the ${entry.name} account to give` })
  return account
}

/**
 * The teammate an access ask is for: the one it names, else the one asking. Brigade put its id
 * there when the ticket was stored (withTeammateIds), which the card shows too: by id alone.
 */
async function accessHolder(db: ScopedDb, asker: { id: string }, ref: string | undefined) {
  if (!ref?.trim()) return asker
  const teammate = await db.teammate.findFirst({ where: { id: ref.trim(), archivedAt: null } })
  if (!teammate)
    throw new HTTPException(404, {
      message: `This access is for "${ref}", which is not one of the workspace's teammates (or is archived). Decline it, and the teammate asks again.`,
    })
  return teammate
}

/** Give the teammate the account; an existing read and write grant stays. */
async function grantAccount(
  db: ScopedDb,
  scope: WorkspaceScope,
  teammateId: string,
  account: { id: string },
  access: 'read' | 'read_write',
) {
  const existing = await db.grant.findFirst({ where: { teammateId, connectionId: account.id } })
  if (existing?.scope === 'read_write' || existing?.scope === access) return
  await db.grant.deleteMany({ where: { teammateId, connectionId: account.id } })
  await db.grant.create({
    data: { teammateId, connectionId: account.id, scope: access } as never,
  })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'grant.set',
    target: { type: 'teammate', id: teammateId },
    data: { connectionId: account.id, scope: access, from: 'ticket' },
  })
}

/** How old a repository list may be when a person gives access for one of its repositories. */
const REACH_MAX_AGE_MS = 10_000

/** An answer made only of credential mentions: it names vault entries, not secrets. */
const onlyCredentialMentions = (text: string) => {
  const parts = parseMentions(text)
  return (
    parts.some((p) => typeof p !== 'string') &&
    parts.every((p) => (typeof p === 'string' ? !p.trim() : p.kind === 'credential'))
  )
}

type TicketPayload = {
  /** A teammate's trigger, waiting in this API process (trigger-calls.ts). */
  triggerAction?: 'create'
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
  pending?: {
    text: string
    memberId: string | null
    teammateIds?: string[]
    handoff?: boolean
    attachments?: ThreadAttachmentRef[]
    /** Its stable id (a wake-up's, a delivery's), kept so it reaches the thread once. */
    commandId?: string
  }
  /** A sign-in ticket's account. */
  accountId?: string
  /** The member a notice is for. */
  memberId?: string
  /** A credential's ticket: what it asks, and whether it may be allowed for good. */
  credentialAction?: CredentialAction
  credentialId?: string
  always?: boolean
  /** A teammate's skill proposal (SkillProposalPayload): an admin's call. */
  skillAction?: 'create' | 'update'
  /** A member asks an owner or admin to activate a playbook they installed. */
  playbookActivation?: boolean
  playbookInstallationId?: string
  /** Brigade proposes a playbook's action act on its own: its owner, an owner or an admin decides. */
  playbookPromotion?: PlaybookPromotionPayload
}

/**
 * Who decides a credential's ticket. Using a credential shared with the
 * teammate, or keeping one it saved: the member who started the thread, or an
 * admin. Sharing one with it, changing one, or letting it use one without
 * asking from now on: the credential's creator, or an admin.
 */
async function mayDecideCredential(
  db: ReturnType<typeof scoped>,
  scope: WorkspaceScope,
  payload: TicketPayload,
  who: { isAdmin: boolean; isStarter: boolean; always?: boolean },
) {
  if (who.always && !payload.always)
    throw new HTTPException(400, { message: 'This can only be allowed once' })
  const action = payload.credentialAction
  const managers = action === 'grant' || action === 'update' || (who.always && action !== 'create')
  if (!managers) {
    if (who.isAdmin || who.isStarter) return
    throw new HTTPException(403, {
      message: 'Only the member who started the thread, or an admin, can decide',
    })
  }
  const credential = payload.credentialId
    ? await db.credential.findFirst({ where: { id: payload.credentialId } })
    : null
  if (!credential) throw new HTTPException(404, { message: 'That secret is gone' })
  if (!mayManage(scope, credential))
    throw new HTTPException(403, {
      message:
        action === 'grant' || action === 'update'
          ? 'Only the secret’s creator, or an admin, can decide'
          : 'Only the secret’s creator, or an admin, can allow it for good',
    })
}

export async function resolveTicket(
  scope: WorkspaceScope,
  ticketId: string,
  given: {
    approved: boolean
    reason?: string
    always?: boolean
    /** An email's draft as the person changed it (EditedEmail). */
    edited?: Record<string, unknown>
  },
): Promise<{ ok: true; live: boolean }> {
  const { edited, ...rest } = given
  const input = { ...rest, ...(edited ? { input: edited } : {}) }
  const db = scoped(scope)
  const ticket = await db.ticket.findFirst({
    where: { id: ticketId, status: 'open' },
    include: { session: { include: { computer: { select: { kind: true } } } } },
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
      const { commandId, ...pending } = payload.pending
      await promptThread(db, scope, thread, pending, {
        skipCaps: true,
        ...(commandId ? { commandId } : {}),
      })
    } else {
      // Never started: done. Started before: it waits for its next message.
      const status = thread.lastSeq > 0 ? 'idle' : 'done'
      await db.session.updateMany({ where: { id: thread.id }, data: { status } })
      void hubs.get(scope.workspaceId).broadcast(threadUpdated(thread.id, status))
    }
    return { ok: true, live: true }
  }

  if (ticket.type === 'approval') {
    if (payload.playbookActivation) {
      // It runs with no one checking each write it may do alone: like importing skills, an admin's call.
      if (!isAdmin)
        throw new HTTPException(403, { message: 'Only an owner or admin can activate a playbook' })
      await decideActivation(db, scope, ticket, input.approved)
      return { ok: true, live: false }
    }
    if (payload.playbookPromotion) {
      // It would then act with no one checking: the playbook's owner (whose accounts it runs on)
      // or an owner or admin decides (decidePromotion checks which).
      await decidePromotion(db, scope, ticket, input.approved)
      return { ok: true, live: false }
    }
    if (payload.skillAction) {
      // A skill shapes what every teammate does: admins decide, like writing one.
      if (!isAdmin)
        throw new HTTPException(403, { message: 'Only an admin can add or change a skill' })
      await decideSkillProposal(db, scope, ticket, input.approved)
      return { ok: true, live: false }
    }
    if (payload.triggerAction) {
      // An outside event that starts work on someone's accounts: an admin's call, as on the Apps page.
      if (!isAdmin)
        throw new HTTPException(403, { message: 'Only an owner or admin can add a trigger' })
      return { ok: true, live: await decideTicket(scope, ticket.id, input) }
    }
    if (payload.credentialAction) {
      await mayDecideCredential(db, scope, payload, { isAdmin, isStarter, always: input.always })
      return { ok: true, live: await decideTicket(scope, ticket.id, input) }
    }
    // Whoever may write in the thread, but a write on a member's own account (an App account
    // only they use) is theirs to allow, or an admin's.
    // A playbook's writes measure how far it may act alone (playbook-autonomy.ts): the member
    // whose run it is decides them, or an admin.
    if (payload.playbookInstallationId && !isAdmin && !isStarter)
      throw new HTTPException(403, {
        message: 'Only the member who started the thread, or an admin, can decide',
      })
    if (!isAdmin && (!ticket.session || !mayAnswer(scope, ticket.session)))
      throw new HTTPException(403, {
        message: 'Only who may write in the thread, or an admin, can decide',
      })
    if (payload.connectionId && !isAdmin) {
      const connection = await db.connection.findFirst({
        where: { id: payload.connectionId },
        select: { reach: true, createdByMemberId: true },
      })
      if (connection?.reach === 'mine' && connection.createdByMemberId !== scope.memberId)
        throw new HTTPException(403, {
          message: 'This account is another member’s own: only they, or an admin, can allow it',
        })
    }
    if (payload.source !== 'harness')
      return { ok: true, live: await decideTicket(scope, ticket.id, input) }
    // The harness asked before a built-in tool call: the answer goes to the runner.
    if (!ticket.sessionId || !payload.approvalId)
      throw new HTTPException(409, { message: 'This approval has no thread' })
    const thread = await loadThread(db, ticket.sessionId)
    // Allowed, or told why not: what the teammate goes on with is theirs now.
    if (input.approved || input.reason) await noteAsker(db, thread.id, scope.memberId)
    const sent = await hubs.get(thread.computer.workspaceId).dispatch(thread.computer, {
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
