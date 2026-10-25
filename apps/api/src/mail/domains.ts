// A workspace's own domain (lovarank.com) that a project inbox replies as (support@lovarank.com),
// once its DNS records are in place: added to Resend for sending only, checked until Resend says
// it is verified. One workspace per domain across Brigade, so nobody sends as another's domain.
import { HTTPException } from 'hono/http-exception'
import { audit } from '../audit.js'
import { prisma, scoped, type ScopedDb } from '../db.js'
import type { WorkspaceScope } from '../scope.js'
import { bareAddress, mailDomain } from './names.js'
import { createDomain, getDomain, verifyDomain, type ResendDomain } from './resend.js'

const CHECK_EVERY_MS = 10 * 60_000
/** Past this, a domain whose records never showed is marked failed (it can be checked again). */
const GIVE_UP_MS = 3 * 86_400_000

const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

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

/**
 * The address customers write to, for a project's inbox: its domain added for sending if new.
 * The records to add are what the dashboard shows, each with its state.
 */
export async function setPublicAddress(
  db: ScopedDb,
  scope: WorkspaceScope,
  addressId: string,
  given: string | null,
) {
  const inbox = await db.mailAddress.findFirst({ where: { id: addressId, kind: 'inbox', releasedAt: null } })
  if (!inbox) throw new HTTPException(404, { message: 'No such inbox' })
  if (!given) {
    await db.mailAddress.update({ where: { id: inbox.id }, data: { publicAddress: null, domainId: null } })
    return null
  }
  const address = bareAddress(given)
  const name = address.split('@')[1] ?? ''
  if (!/^[^@\s]+@[^@\s]+$/.test(address) || !DOMAIN.test(name))
    throw new HTTPException(400, { message: 'Not an email address' })
  if (name === mailDomain() || name.endsWith(`.${mailDomain()}`))
    throw new HTTPException(400, { message: 'That is already one of Brigade’s addresses' })
  const taken = await prisma.mailAddress.findFirst({
    where: { publicAddress: address, NOT: { id: inbox.id } },
    select: { id: true },
  })
  if (taken) throw new HTTPException(409, { message: `${address} is already another inbox’s` })
  const domain = await claimDomain(db, scope, name)
  await db.mailAddress.update({
    where: { id: inbox.id },
    data: { publicAddress: address, domainId: domain.id },
  })
  return domain
}

/** The workspace's row for a domain: made (and added to Resend) the first time. */
async function claimDomain(db: ScopedDb, scope: WorkspaceScope, name: string) {
  const own = await db.mailDomain.findFirst({ where: { name } })
  if (own) return own
  const elsewhere = await prisma.mailDomain.findUnique({ where: { name }, select: { id: true } })
  if (elsewhere) throw new HTTPException(409, { message: `${name} is used by another workspace on Brigade` })
  const created = await createDomain(name).catch(async (error: unknown) => {
    // Already in Resend's account (added by hand, or by another product on the shared account).
    throw new HTTPException(409, {
      message: `Resend would not add ${name}: ${error instanceof Error ? error.message : String(error)}`,
    })
  })
  const row = await db.mailDomain.create({
    data: {
      name,
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
    data: { name },
  })
  return row
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
