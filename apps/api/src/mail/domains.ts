// A workspace's own domains (acme.com, team.acme.com): added once in Inbox › Mail settings › Domains,
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
import {
  createDomain,
  deleteDomain,
  getDomain,
  ResendError,
  verifyDomain,
  type ResendDomain,
} from './resend.js'

const CHECK_EVERY_MS = 10 * 60_000
/**
 * Past this, a domain whose records never showed is marked failed (it can be checked again), and
 * another workspace may add it instead: the one whose records then show is the one that owns it.
 */
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

/**
 * Public DNS (Cloudflare's, over HTTPS): a name's records of a type, or null when the name does not
 * exist (NXDOMAIN). Any other failure is a 502: a resolver failing is never an empty answer.
 */
async function lookup(name: string, type: 'MX' | 'TXT') {
  const unread = () => new HTTPException(502, { message: 'DNS could not be read, try again' })
  const response = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
    { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(10_000) },
  ).catch(() => {
    throw unread()
  })
  if (!response.ok) throw unread()
  const answer = (await response.json()) as {
    Status: number
    Answer?: { type: number; data: string }[]
  }
  if (answer.Status === 3) return null
  if (answer.Status !== 0) throw unread()
  return (answer.Answer ?? []).filter((a) => a.type === (type === 'MX' ? 15 : 16))
}

/** A domain's MX hosts, best first. */
export async function mxOf(name: string): Promise<string[]> {
  const answers = await lookup(name, 'MX')
  if (!answers)
    throw new HTTPException(400, { message: `${name} is not in DNS: check its spelling` })
  return answers
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
 * directly is refused while its mail goes to another provider: it would take that mail away. A
 * domain another workspace added is theirs once verified, and for three days before that; past
 * them, still unverified, it is taken from them (`takeOver`), so nobody keeps a domain they only
 * claimed from the workspace that owns it.
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
  const other = await prisma.mailDomain.findUnique({ where: { name } })
  if (other) stillTheirs(other)
  const receiving = input.receiving ?? lookup.suggested
  if (receiving === 'direct' && lookup.mx.length > 0 && !lookup.brigade)
    throw new HTTPException(400, {
      message: `${name}'s mail goes to ${lookup.mx[0]}: receiving it directly would take it from there. Forward its addresses, or use a subdomain such as team.${name}.`,
    })
  if (other) await takeOver(other)
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

type DomainRow = NonNullable<Awaited<ReturnType<typeof prisma.mailDomain.findUnique>>>

/**
 * A takeover in progress (`takeOver`): the domain is `claimed`, its claim's time in `checkedAt`.
 * Nothing marks it verified meanwhile. A claim older than this was left by a takeover that never
 * finished: the domain is as it was.
 */
const CLAIM_MS = 10 * 60_000
/** The longest a takeover waits on Resend: well within its claim, so it never outlives it. */
const TAKE_MS = 60_000
const CLAIMED = 'claimed'
const claimed = (row: { status: string; checkedAt: Date | null }, now = Date.now()) =>
  row.status === CLAIMED && !!row.checkedAt && row.checkedAt.getTime() > now - CLAIM_MS
/** Not claimed by a takeover now: what a check may write over. */
const unclaimed = (now = Date.now()) => ({
  NOT: { status: CLAIMED, checkedAt: { gt: new Date(now - CLAIM_MS) } },
})

/** A 409 while another workspace's domain is plainly still theirs: verified, or under three days. */
function stillTheirs(other: DomainRow) {
  if (other.status === 'verified' || claimed(other))
    throw new HTTPException(409, {
      message: `${other.name} is used by another workspace on Brigade`,
    })
  const free = other.createdAt.getTime() + GIVE_UP_MS
  if (Date.now() < free)
    throw new HTTPException(409, {
      message: `Another workspace on Brigade added ${other.name} and has until ${new Date(free).toUTCString()} to verify it. If ${other.name} is yours, add it after that.`,
    })
}

/**
 * Whether the DKIM key Resend gave a domain's row is in the domain's public DNS: whoever put it
 * there controls the domain, verified by Resend or not yet. Brigade reads it itself rather than
 * asking Resend, whose verification runs later.
 */
async function recordsInDns(row: DomainRow) {
  const keys = ((row.records ?? []) as { record?: string; name?: string; value?: string }[]).filter(
    (r) => r.record === 'DKIM' && r.name && r.value,
  )
  for (const key of keys) {
    // Its selector (resend._domainkey), under the domain itself whatever zone Resend names it in.
    const selector = key.name!.split('._domainkey')[0]
    const found = await lookup(`${selector}._domainkey.${row.name}`, 'TXT')
    const want = key.value!.replace(/\s+/g, '')
    if (found?.some((a) => a.data.replace(/"\s*"/g, '').replace(/["\s]/g, '').includes(want)))
      return true
  }
  return false
}

/**
 * Another workspace's domain left unverified for three days, taken from it. Claimed first, in one
 * guarded write, so that from then on no check marks it verified and no mailbox gets an address on
 * it; then its DKIM key is looked for in its DNS (found: it is theirs after all, and stays); then
 * it leaves Resend, it goes, and its mailboxes lose their addresses on it (they could never send or
 * receive as them), in one transaction. The claim's time is its token: each step after Resend's
 * goes on only while the claim is still this takeover's. Anything failing gives the claim back.
 */
async function takeOver(other: DomainRow) {
  const scope = { organizationId: other.organizationId, workspaceId: other.workspaceId }
  const db = scoped(scope)
  const now = Date.now()
  let token = new Date(now)
  const claim = await db.mailDomain.updateMany({
    where: {
      id: other.id,
      createdAt: { lt: new Date(now - GIVE_UP_MS) },
      OR: [
        { status: { in: ['pending', 'failed'] } },
        { status: CLAIMED, checkedAt: { lte: new Date(now - CLAIM_MS) } },
      ],
    },
    data: { status: CLAIMED, checkedAt: token },
  })
  const lost = () =>
    new HTTPException(409, { message: `${other.name} is used by another workspace on Brigade` })
  if (!claim.count) throw lost()
  const ours = () => ({ id: other.id, status: CLAIMED, checkedAt: token })
  let theirs = false
  try {
    theirs = await recordsInDns(other)
    if (theirs)
      throw new HTTPException(409, {
        message: `${other.name}'s DNS has the records another workspace on Brigade was given: it is theirs`,
      })
    // Renewed just before Resend is asked, which takes TAKE_MS at most: the claim holds throughout.
    const renewed = new Date()
    const held = await db.mailDomain.updateMany({ where: ours(), data: { checkedAt: renewed } })
    if (!held.count) throw lost()
    token = renewed
    if (other.resendDomainId)
      await removeFromResend(other.name, other.resendDomainId, AbortSignal.timeout(TAKE_MS))
  } catch (error) {
    await db.mailDomain.updateMany({
      where: ours(),
      data: { status: other.status === CLAIMED ? 'pending' : other.status },
    })
    // Theirs: Resend can mark it verified now.
    if (theirs) void checkDomain(db, other.id).catch(() => undefined)
    throw error
  }
  // In one transaction, only while still this takeover's (a claim it lost is someone else's to
  // settle): the domain goes, then its addresses, by name. One given while it went lands before
  // (and goes now) or after (refused: its domain is no more); nothing is left half done.
  await prisma
    .$transaction(async (tx) => {
      const gone = await tx.mailDomain.deleteMany({
        where: { ...ours(), workspaceId: other.workspaceId },
      })
      if (!gone.count) {
        console.error(
          `mail domain ${other.name}: its takeover lost its claim after Resend removed it`,
        )
        throw lost()
      }
      await tx.mailAddress.updateMany({
        where: { workspaceId: other.workspaceId, publicAddress: { endsWith: `@${other.name}` } },
        data: { publicAddress: null, domainId: null },
      })
    })
    .catch(async (error: unknown) => {
      // Out of Resend already (a second removal there is a 404, as good): taken again at once.
      await db.mailDomain.updateMany({
        where: ours(),
        data: { status: other.status === CLAIMED ? 'pending' : other.status },
      })
      throw error
    })
  // Written outside its scoped client: its dashboards are told here (loaded late, as the hub
  // loads much of the API).
  void import('../hub.js').then(({ hubs }) =>
    hubs.get(other.workspaceId).notifyList('mail.updated'),
  )
  await audit({
    ...scope,
    actor: { type: 'system', id: 'brigade' },
    action: 'email.domain.taken_over',
    target: { type: 'mail_domain', id: other.id },
    data: { name: other.name, reason: 'not verified within three days' },
  })
}

/** A domain out of Resend; gone already is as good. A 502 when Resend did not remove it. */
export async function removeFromResend(name: string, resendDomainId: string, signal?: AbortSignal) {
  await deleteDomain(resendDomainId, signal).catch((error: unknown) => {
    if (error instanceof ResendError && error.status === 404) return
    console.warn(`mail domain ${name}: not removed from Resend`, error)
    throw new HTTPException(502, {
      message: `Resend did not remove ${name}: try again in a moment`,
    })
  })
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
  // A takeover's claim, or one left by a takeover that never finished: not verified, as before.
  status: (row.status === CLAIMED ? 'pending' : row.status) as MailDomainView['status'],
  receiving: row.receiving as DomainReceiving,
  records: row.records as MailDomainView['records'],
  checkedAt: row.checkedAt?.toISOString() ?? null,
  addresses: (row.addresses ?? []).flatMap((a) => (a.publicAddress ? [a.publicAddress] : [])),
})

/**
 * Remove a domain no mailbox has an address on: from Resend first. When Resend does not remove it,
 * it stays here too, so removing it can be tried again (Resend would refuse to add it again).
 */
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
  if (row.resendDomainId) await removeFromResend(row.name, row.resendDomainId)
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
  await db.mailAddress
    .update({ where: { id: mailbox.id }, data: { publicAddress: address, domainId: domain.id } })
    .catch((error: unknown) => {
      // Its domain went meanwhile (taken over by another workspace).
      if ((error as { code?: string }).code === 'P2003')
        throw new HTTPException(409, { message: `${domain.name} is no longer this workspace's` })
      throw error
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
  if (!domain)
    throw new HTTPException(400, {
      message: `Add ${name} in Inbox › Mail settings › Domains first`,
    })
  if (claimed(domain))
    throw new HTTPException(409, {
      message: `${name} is being taken over by a workspace on Brigade that added it after its three days`,
    })
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

/**
 * Read what Resend says of a domain's records, and keep it: never over a takeover's claim
 * (`takeOver`), which wins from the moment it is made. Resend is asked to verify it only when it
 * is not verifying it already: asking again puts a domain back to pending, even one whose records
 * just passed, so asking at each check would keep it pending for good.
 */
export async function checkDomain(db: ScopedDb, domainId: string) {
  const row = await db.mailDomain.findFirst({ where: { id: domainId } })
  if (!row?.resendDomainId) throw new HTTPException(404, { message: 'No such domain' })
  const taking = new HTTPException(409, {
    message: `${row.name} is being taken over by a workspace on Brigade that added it after its three days`,
  })
  if (claimed(row)) throw taking
  let domain = await getDomain(row.resendDomainId)
  if (domain.status !== 'verified' && domain.status !== 'pending') {
    await verifyDomain(row.resendDomainId).catch(() => undefined)
    domain = await getDomain(row.resendDomainId)
  }
  const kept = await db.mailDomain.updateMany({
    where: { id: row.id, ...unclaimed() },
    data: { status: statusOf(domain.status), records: recordsOf(domain), checkedAt: new Date() },
  })
  if (!kept.count) throw taking
  return db.mailDomain.findFirstOrThrow({ where: { id: row.id } })
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
        await db.mailDomain.updateMany({
          where: { id: row.id, status: 'pending' },
          data: { status: 'failed' },
        })
    } catch (error) {
      console.warn(`mail domain ${row.name}: not checked`, error)
      // A takeover's claim keeps its own time.
      await db.mailDomain.updateMany({
        where: { id: row.id, status: 'pending' },
        data: { checkedAt: new Date(now) },
      })
    }
  }
}
