// A workspace's own domains (acme.com, team.acme.com): added once in Inbox › Mailboxes › Domains,
// then any of its mailboxes, an agent's or a project's, can have an address on one (riley@acme.com,
// support@acme.com). A domain sends through Resend once its DNS records are in, and its mail reaches
// Brigade one of two ways: directly (its MX points to Brigade's receiving) or by forwarding (its
// mail stays with its provider, Google's say, and each address is forwarded to its mailbox's own
// address on Brigade's domain). One workspace per domain across Brigade, so nobody sends or
// receives as another's.
import type { DomainLookup, DomainReceiving, MailDomainView } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit } from '../audit.js'
import { prisma, scoped, type ScopedDb } from '../db.js'
import type { WorkspaceScope } from '../scope.js'
import { bareAddress, mailDomain } from './names.js'
import { createDomain, deleteDomain, getDomain, verifyDomain, type ResendDomain } from './resend.js'

const CHECK_EVERY_MS = 10 * 60_000
/** Past this, a domain whose records never showed is marked failed (it can be checked again). */
const GIVE_UP_MS = 3 * 86_400_000

const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** Resend's receiving hosts: a domain whose MX points there is Brigade's to receive. */
const RESEND_MX = /(^|\.)(rmta\.net|resend\.com)\.?$/

const recordsOf = (domain: ResendDomain) =>
  (domain.records ?? []).map((r) => ({
    record: r.record,
    type: r.type,
    name: r.name,
    value: r.value,
    ...(r.priority !== undefined ? { priority: r.priority } : {}),
    status: r.status,
  }))

const statusOf = (resendStatus: string) =>
  resendStatus === 'verified' ? 'verified' : resendStatus === 'failed' ? 'failed' : 'pending'

const brigadeDomain = (name: string) => name === mailDomain() || name.endsWith(`.${mailDomain()}`)

/** A domain's MX hosts, best first, from public DNS (Cloudflare's, over HTTPS). */
export async function mxOf(name: string): Promise<string[]> {
  const response = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=MX`,
    { headers: { accept: 'application/dns-json' } },
  )
  if (!response.ok) throw new HTTPException(502, { message: 'DNS could not be read, try again' })
  const answer = (await response.json()) as {
    Status: number
    Answer?: { type: number; data: string }[]
  }
  return (answer.Answer ?? [])
    .filter((a) => a.type === 15)
    .map((a) => {
      const [priority, host] = a.data.trim().split(/\s+/)
      return { priority: Number(priority), host: (host ?? '').replace(/\.$/, '').toLowerCase() }
    })
    .filter((m) => m.host)
    .sort((a, b) => a.priority - b.priority)
    .map((m) => m.host)
}

const checkName = (given: string) => {
  const name = given.trim().toLowerCase().replace(/\.$/, '')
  if (!DOMAIN.test(name)) throw new HTTPException(400, { message: 'Not a domain name' })
  if (brigadeDomain(name)) throw new HTTPException(400, { message: 'That is Brigade’s own domain' })
  return name
}

/** Where a domain's mail goes now, and so how Brigade had best receive it. */
export async function lookupDomain(given: string): Promise<DomainLookup> {
  const name = checkName(given)
  const mx = await mxOf(name)
  const brigade = mx.length > 0 && mx.every((host) => RESEND_MX.test(host))
  return { name, mx, brigade, suggested: mx.length === 0 || brigade ? 'direct' : 'forward' }
}

/**
 * Add a domain to the workspace (and to Resend: sending, and receiving when direct). Receiving
 * directly is refused while its mail goes to another provider: it would take that mail away.
 */
export async function addDomain(
  db: ScopedDb,
  scope: WorkspaceScope,
  input: { name: string; receiving?: DomainReceiving },
) {
  const lookup = await lookupDomain(input.name)
  const { name } = lookup
  if (await db.mailDomain.findFirst({ where: { name }, select: { id: true } }))
    throw new HTTPException(409, { message: `${name} is already added` })
  if (await prisma.mailDomain.findUnique({ where: { name }, select: { id: true } }))
    throw new HTTPException(409, { message: `${name} is used by another workspace on Brigade` })
  const receiving = input.receiving ?? lookup.suggested
  if (receiving === 'direct' && lookup.mx.length > 0 && !lookup.brigade)
    throw new HTTPException(400, {
      message: `${name}'s mail goes to ${lookup.mx[0]}: receiving it directly would take it from there. Forward its addresses, or use a subdomain such as team.${name}.`,
    })
  const created = await createDomain(name, receiving === 'direct').catch((error: unknown) => {
    // Already in Resend's account (added by hand, or by another product on the shared account).
    throw new HTTPException(409, {
      message: `Resend would not add ${name}: ${error instanceof Error ? error.message : String(error)}`,
    })
  })
  const row = await db.mailDomain.create({
    data: {
      name,
      receiving,
      resendDomainId: created.id,
      status: statusOf(created.status),
      records: recordsOf(created),
      createdByMemberId: scope.memberId,
    } as never,
  })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'email.domain.added',
    target: { type: 'mail_domain', id: row.id },
    data: { name, receiving },
  })
  return row
}

/** The workspace's domains, each with the mailboxes' addresses on it. */
export async function listDomains(db: ScopedDb): Promise<MailDomainView[]> {
  const rows = await db.mailDomain.findMany({
    include: {
      addresses: { where: { releasedAt: null }, select: { publicAddress: true } },
    },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map(viewOf)
}

const viewOf = (
  row: Awaited<ReturnType<ScopedDb['mailDomain']['findFirstOrThrow']>> & {
    addresses?: { publicAddress: string | null }[]
  },
): MailDomainView => ({
  id: row.id,
  name: row.name,
  status: row.status as MailDomainView['status'],
  receiving: row.receiving as DomainReceiving,
  records: row.records as MailDomainView['records'],
  checkedAt: row.checkedAt?.toISOString() ?? null,
  addresses: (row.addresses ?? []).flatMap((a) => (a.publicAddress ? [a.publicAddress] : [])),
})

/** Remove a domain no mailbox has an address on: from Resend too. */
export async function removeDomain(db: ScopedDb, scope: WorkspaceScope, id: string) {
  const row = await db.mailDomain.findFirst({
    where: { id },
    include: { addresses: { where: { releasedAt: null }, select: { id: true } } },
  })
  if (!row) throw new HTTPException(404, { message: 'No such domain' })
  if (row.addresses.length > 0)
    throw new HTTPException(409, {
      message: `Mailboxes still have addresses on ${row.name}: change them first`,
    })
  if (row.resendDomainId)
    await deleteDomain(row.resendDomainId).catch((error: unknown) =>
      console.warn(`mail domain ${row.name}: not removed from Resend`, error),
    )
  // Turned-off mailboxes let it go too.
  await db.mailAddress.updateMany({
    where: { domainId: row.id },
    data: { publicAddress: null, domainId: null },
  })
  await db.mailDomain.deleteMany({ where: { id: row.id } })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'email.domain.removed',
    target: { type: 'mail_domain', id: row.id },
    data: { name: row.name },
  })
}

/**
 * A mailbox's address on one of the workspace's domains (an agent's or a project's), or null for
 * Brigade's own only. Its domain must be added first; it sends once that domain is verified.
 */
export async function setPublicAddress(
  db: ScopedDb,
  scope: WorkspaceScope,
  addressId: string,
  given: string | null,
) {
  const mailbox = await db.mailAddress.findFirst({ where: { id: addressId, releasedAt: null } })
  if (!mailbox) throw new HTTPException(404, { message: 'No such mailbox' })
  if (!given) {
    await db.mailAddress.update({
      where: { id: mailbox.id },
      data: { publicAddress: null, domainId: null },
    })
    return null
  }
  const domain = await domainFor(db, given)
  const address = await checkPublicAddress(db, given, mailbox.id)
  await db.mailAddress.update({
    where: { id: mailbox.id },
    data: { publicAddress: address, domainId: domain.id },
  })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'email.address.set',
    target: { type: 'mail_address', id: mailbox.id },
    data: { address },
  })
  return domain
}

/** The workspace's domain an address is on, or a 400 saying to add it first. */
export async function domainFor(db: ScopedDb, given: string) {
  const name = bareAddress(given).split('@')[1] ?? ''
  if (brigadeDomain(name)) throw new HTTPException(400, { message: 'That is Brigade’s own domain' })
  const domain = await db.mailDomain.findFirst({ where: { name } })
  if (!domain) throw new HTTPException(400, { message: `Add ${name} in Mailboxes › Domains first` })
  return domain
}

/**
 * An address on one of the workspace's domains, checked before a mailbox gets it: well formed,
 * not Brigade's own, and no other live mailbox's. A mailbox of this workspace turned off lets it
 * go. Returns it bare and lower-cased.
 */
export async function checkPublicAddress(db: ScopedDb, given: string, exceptId?: string) {
  const address = bareAddress(given)
  const name = address.split('@')[1] ?? ''
  if (!/^[^@\s]+@[^@\s]+$/.test(address) || !DOMAIN.test(name))
    throw new HTTPException(400, { message: 'Not an email address' })
  if (brigadeDomain(name))
    throw new HTTPException(400, { message: 'That is already one of Brigade’s addresses' })
  const taken = await prisma.mailAddress.findFirst({
    where: { publicAddress: address, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { id: true, releasedAt: true, workspaceId: true },
  })
  if (taken) {
    const own = await db.mailAddress.findFirst({ where: { id: taken.id }, select: { id: true } })
    if (!own || !taken.releasedAt)
      throw new HTTPException(409, { message: `${address} is already another mailbox’s` })
    // This workspace's mailbox turned off: the address is free again.
    await db.mailAddress.updateMany({
      where: { id: taken.id },
      data: { publicAddress: null, domainId: null },
    })
  }
  return address
}

/** Ask Resend to check a domain's records now, and keep what it says. */
export async function checkDomain(db: ScopedDb, domainId: string) {
  const row = await db.mailDomain.findFirst({ where: { id: domainId } })
  if (!row?.resendDomainId) throw new HTTPException(404, { message: 'No such domain' })
  if (row.status !== 'verified') await verifyDomain(row.resendDomainId).catch(() => undefined)
  const domain = await getDomain(row.resendDomainId)
  return db.mailDomain.update({
    where: { id: row.id },
    data: { status: statusOf(domain.status), records: recordsOf(domain), checkedAt: new Date() },
  })
}

/** The minute tick: each pending domain is checked every ten minutes, for three days. */
export async function checkDomains(now = Date.now()) {
  const pending = await prisma.mailDomain.findMany({
    where: {
      status: 'pending',
      OR: [{ checkedAt: null }, { checkedAt: { lt: new Date(now - CHECK_EVERY_MS) } }],
    },
    take: 5,
  })
  for (const row of pending) {
    const db = scoped({ organizationId: row.organizationId, workspaceId: row.workspaceId })
    try {
      const checked = await checkDomain(db, row.id)
      if (checked.status === 'pending' && now - row.createdAt.getTime() > GIVE_UP_MS)
        await db.mailDomain.updateMany({ where: { id: row.id }, data: { status: 'failed' } })
    } catch (error) {
      console.warn(`mail domain ${row.name}: not checked`, error)
      await db.mailDomain.updateMany({ where: { id: row.id }, data: { checkedAt: new Date(now) } })
    }
  }
}
