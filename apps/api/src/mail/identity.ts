// Who wrote an email: a member of the workspace (when the mail server proved it: DKIM or DMARC
// passed), someone its mailboxes exchanged mail with before (a contact), one of Brigade's own
// addresses, or a stranger. A member's mail is a request with their rights; anyone else's is
// data, never an order. Shared by every mail source (Brigade's addresses, Gmail).
import { prisma, type Scope, type ScopedDb } from '../db.js'
import { bareAddress, localOn } from './names.js'

export type Authentication = { spf?: string; dkim?: string; dmarc?: string } | null | undefined

/** The receiving server proved the From domain: an aligned DKIM signature, or DMARC. */
export const authenticated = (auth: Authentication) =>
  auth?.dkim === 'pass' || auth?.dmarc === 'pass'

/**
 * Gmail's own Authentication-Results header ("dkim=pass header.i=@acme.com; … dmarc=pass"),
 * as the results Resend gives. DKIM counts only when it signed for the From domain.
 */
export function gmailAuthentication(header: string | undefined, from: string): Authentication {
  if (!header) return null
  const domain = bareAddress(from).split('@')[1] ?? ''
  const result = (name: string) =>
    header.match(new RegExp(`\\b${name}=(\\w+)`, 'i'))?.[1]?.toLowerCase()
  const dkimDomain = header
    .match(/\bdkim=pass[^;]*header\.(?:i|d)=@?([^\s;]+)/i)?.[1]
    ?.toLowerCase()
  const aligned = !!dkimDomain && (dkimDomain === domain || domain.endsWith(`.${dkimDomain}`))
  return {
    spf: result('spf'),
    dkim: result('dkim') === 'pass' ? (aligned ? 'pass' : 'gray') : result('dkim'),
    dmarc: result('dmarc'),
  }
}

export type Sender = {
  kind: 'member' | 'contact' | 'unknown' | 'brigade'
  memberId?: string
  memberName?: string
  contactId?: string
  /** For the teammate: who this is, in a line. */
  line: string
}

/**
 * Who sent it, and their contact when the workspace knows them. A member is recognized only
 * when the mail is authenticated: anyone can write a member's address in From.
 */
export async function senderOf(
  db: ScopedDb,
  scope: Scope,
  from: string,
  name: string,
  auth: Authentication,
): Promise<Sender> {
  const address = bareAddress(from)
  if (localOn(address))
    return { kind: 'brigade', line: `${address}, one of Brigade's own addresses` }
  const member = await prisma.member.findFirst({
    where: {
      organizationId: scope.organizationId,
      user: { email: { equals: address, mode: 'insensitive' } },
    },
    include: { user: { select: { name: true } } },
  })
  if (member && authenticated(auth))
    return {
      kind: 'member',
      memberId: member.id,
      memberName: member.user.name,
      line: `${member.user.name} (${address}), a member of this workspace; the mail server verified it`,
    }
  const handle = await db.contactHandle.findFirst({ where: { kind: 'email', value: address } })
  if (handle) {
    await db.contactHandle.updateMany({
      where: { id: handle.id },
      data: { lastSeenAt: new Date() },
    })
    return {
      kind: 'contact',
      contactId: handle.contactId,
      line: `${name ? `${name} ` : ''}<${address}>, a known contact`,
    }
  }
  return {
    kind: 'unknown',
    line: `${name ? `${name} ` : ''}<${address}>${
      member
        ? ', whose address is a member’s, but the mail server could not verify it'
        : ', someone this workspace has not exchanged mail with'
    }`,
  }
}

/**
 * The contact for an address the workspace exchanges mail with (it wrote to them, or their
 * mail went to a thread), made the first time: their next mail is from a known contact. Spam
 * left in a box makes none.
 */
export async function contactFor(db: ScopedDb, address: string, name = '') {
  const value = bareAddress(address)
  if (localOn(value)) return null
  const handle = await db.contactHandle.findFirst({ where: { kind: 'email', value } })
  if (handle) return handle.contactId
  const contact = await db.contact.create({ data: { name: name.slice(0, 200) } as never })
  try {
    await db.contactHandle.create({
      data: { contactId: contact.id, kind: 'email', value } as never,
    })
    return contact.id
  } catch {
    await db.contact.deleteMany({ where: { id: contact.id } })
    return (
      (await db.contactHandle.findFirst({ where: { kind: 'email', value } }))?.contactId ?? null
    )
  }
}

/** The threads this contact's mail went to before, newest first: a line for the teammate. */
export async function historyOf(db: ScopedDb, contactId: string | undefined, except?: string) {
  if (!contactId) return ''
  const earlier = await db.mailMessage.findMany({
    where: {
      contactId,
      sessionId: { not: null },
      ...(except ? { NOT: { conversationId: except } } : {}),
    },
    orderBy: { receivedAt: 'desc' },
    distinct: ['sessionId'],
    take: 5,
    select: { sessionId: true, subject: true, receivedAt: true },
  })
  if (!earlier.length) return ''
  return `Earlier threads with them: ${earlier
    .map(
      (m) =>
        `"${m.subject || '(no subject)'}" (thread ${m.sessionId}, ${m.receivedAt.toISOString().slice(0, 10)})`,
    )
    .join('; ')}.`
}
