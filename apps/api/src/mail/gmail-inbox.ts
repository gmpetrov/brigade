// A Gmail account's mail, kept for the Inbox (src/inbox.ts) as its inbox reader reads it
// (src/subscriptions/gmail.ts), with where it went: the thread waiting on its conversation, the
// rule that took it, or nowhere. The same table as Brigade's own addresses' mail, so the Inbox
// lists every source with one query. All of it for a shared account put in the Inbox; for any
// other account, a member's own included, only what went to a thread (a rule's, a playbook's,
// one waiting on its conversation): the rest of the mailbox, personal mail, is never kept.
import { mailbox } from '@brigade/contracts'
import type { ReceivedEmail } from '../connectors/gmail.js'
import { scoped, type Scope } from '../db.js'
import { BOX_DAYS } from './inbound.js'
import { bareAddress } from './names.js'

/**
 * Whether the Inbox shows this account's mail: Gmail, shared with the workspace, and put in the
 * Inbox by its owner or an admin (a shared account may still hold someone's personal mail).
 */
export const inInbox = (connection: { kind: string; reach: string; inbox: boolean }) =>
  connection.kind === 'gmail' && connection.reach === 'workspace' && connection.inbox

/** Gmail's own tabs of mail nobody answers: kept out of the Inbox. */
const NOISE = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'SPAM', 'TRASH'])

const addresses = (value: string | undefined) =>
  (value ?? '').match(/[^\s<>,;"()]+@[^\s<>,;"()]+/g)?.map((a) => a.toLowerCase()) ?? []

export async function keepGmail(
  connection: {
    id: string
    organizationId: string
    workspaceId: string
    kind: string
    reach: string
    inbox: boolean
  },
  email: ReceivedEmail,
  outcome: { route: 'awaited' | 'rule' | 'cap' | 'box'; sessionId?: string; triggerId?: string },
) {
  const taken = outcome.route !== 'box'
  if (connection.kind !== 'gmail' || !(inInbox(connection) || taken)) return
  // Promotions and the like, unless a thread took it.
  if (!taken && email.labels?.some((l) => NOISE.has(l))) return
  const scope: Scope = {
    organizationId: connection.organizationId,
    workspaceId: connection.workspaceId,
  }
  const db = scoped(scope)
  const from = mailbox(email.from ?? '')
  const at = Date.parse(email.date ?? '')
  const data = {
    route: outcome.route,
    sessionId: outcome.sessionId ?? null,
    triggerId: outcome.triggerId ?? null,
    expiresAt: outcome.sessionId ? null : new Date(Date.now() + BOX_DAYS * 86_400_000),
  }
  try {
    await db.mailMessage.create({
      data: {
        connectionId: connection.id,
        box: `gmail:${connection.id}`,
        sourceId: email.id,
        direction: 'in',
        status: 'done',
        conversationId: email.threadId,
        messageId: email.rfcMessageId ?? null,
        fromAddress: bareAddress(from.address),
        fromName: (from.name ?? '').slice(0, 200),
        to: addresses(email.to),
        cc: addresses(email.cc),
        subject: (email.subject ?? '').slice(0, 1000),
        text: (email.body ?? '').slice(0, 100_000),
        automatic: email.automatic,
        attachments: (email.attachments ?? []).map((a) => ({
          id: a.partId,
          filename: a.filename,
          contentType: a.mimeType,
          size: a.size,
          ...(a.inline ? { inline: true } : {}),
        })),
        receivedAt: Number.isFinite(at) ? new Date(at) : new Date(),
        ...data,
      } as never,
    })
  } catch (error) {
    // Read again (a retry of the reader): where it went now, if it went somewhere.
    if ((error as { code?: string }).code !== 'P2002') throw error
    if (outcome.sessionId)
      await db.mailMessage.updateMany({
        where: { box: `gmail:${connection.id}`, sourceId: email.id, sessionId: null },
        data,
      })
  }
}
