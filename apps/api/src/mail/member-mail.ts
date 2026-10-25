// A member writing to an agent's address, proved by the mail server: their request, as if typed
// in the chat with that agent, on their own subscription, in the project of the address's
// variant. Their files come along; a later mail of theirs in the conversation continues it.
import { splitQuoted } from '@brigade/contracts'
import { ingestExternal } from '../attachments.js'
import type { Scope, ScopedDb } from '../db.js'
import { loadThread } from '../thread-spec.js'
import { promptWithAttachments, startThread } from '../work.js'
import { mailFiles } from '../connectors/email.js'
import type { Sender } from './identity.js'

type Row = {
  id: string
  resendId: string | null
  addressId: string | null
  projectId: string | null
  subject: string
  text: string
  inReplyTo: string | null
  fromAddress: string
  attachments: unknown
  address: {
    name: string
    teammateId: string | null
    connectionId: string | null
    connection: { id: string; externalAccount: string | null } | null
  }
}

export async function memberRequestThread(
  db: ScopedDb,
  scope: Scope,
  row: Row,
  sender: Sender,
  sessionId: string | null,
): Promise<string | null> {
  if (!sender.memberId || !row.address.teammateId || !row.address.connectionId) return null
  const teammate = await db.teammate.findFirst({
    where: { id: row.address.teammateId, archivedAt: null },
  })
  if (!teammate) return null
  const own = row.inReplyTo ? splitQuoted(row.text).text : row.text
  const to = row.address.connection?.externalAccount ?? row.address.name
  const files = mailFiles(row)
  const attachmentIds = files.length
    ? await ingestExternal(db, scope, row.address.connectionId, files, {
        fetch: (url, init) => fetch(url, init),
      }).catch((error: unknown) => {
        console.warn(`mail ${row.id}: files left out`, error)
        return [] as string[]
      })
    : []
  const text = [
    `${sender.memberName ?? 'A member'} wrote to ${to} by email (the mail server verified it is them). Subject: ${row.subject || '(no subject)'}`,
    '',
    own.trim(),
    '',
    `If they expect the answer by email, reply with email_send and replyTo "${row.id}".`,
  ].join('\n')
  if (sessionId) {
    const thread = await loadThread(db, sessionId)
    // Their message only where they may prompt, as in the chat (requireMayPrompt).
    if (thread.controlledByMemberId) return null
    if (thread.startedByMemberId !== sender.memberId && !thread.othersMayPrompt) return null
    const outcome = await promptWithAttachments(
      db,
      scope,
      thread,
      { text, memberId: sender.memberId, attachmentIds },
      null,
    )
    // Its computer asleep: the mail waits and is tried again, as a rule's would.
    if (outcome === 'offline') throw new Error('The thread’s computer is offline')
    return sessionId
  }
  const computer =
    (await db.computer.findFirst({ where: { kind: 'cloud', status: { not: 'destroyed' } } })) ??
    (await db.computer.findFirst({
      where: { kind: 'member_machine', memberId: sender.memberId },
      orderBy: { updatedAt: 'desc' },
    }))
  if (!computer) throw new Error('The workspace has no computer to run the request on')
  const { thread, outcome } = await startThread(db, scope, {
    teammate,
    computer,
    memberId: sender.memberId,
    title: row.subject || `Email to ${to}`,
    text,
    attachmentIds,
    connectorFiles: true,
    projectId: row.projectId,
  })
  // Its computer asleep: the thread never ran, so it goes, and the mail is tried again later
  // (src/mail/jobs.ts) rather than left in the box.
  if (outcome === 'offline') {
    await db.session.deleteMany({ where: { id: thread.id } })
    throw new Error('The computer is offline')
  }
  return thread.id
}
