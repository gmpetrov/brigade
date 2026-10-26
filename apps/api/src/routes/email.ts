// The Email App in the dashboard: turning it on, agents' addresses, projects' inboxes (their own
// address and domain, their forwarding), the rules' order and a rule tried on past mail, each
// address's journal, a test mail, and cancelling a mail in its window.
import {
  CreateDomain,
  CreateInbox,
  EnableAgentAddress,
  SetMailboxAddress,
  OrderRules,
  PreviewRule,
  UpdateInbox,
  type MailJournalEntry,
} from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { appFor } from '../apps.js'
import { audit } from '../audit.js'
import { triggersOf } from '../connectors/index.js'
import type { ScopedDb } from '../db.js'
import { createInbox, disableAddress, enableAgentAddress, suggestName } from '../mail/addresses.js'
import {
  addDomain,
  checkDomain,
  checkPublicAddress,
  domainFor,
  listDomains,
  lookupDomain,
  removeDomain,
  setPublicAddress,
} from '../mail/domains.js'
import { addressOf, mailDomain } from '../mail/names.js'
import { cancelMail } from '../mail/outbound.js'
import { resendConfigured, sendEmail } from '../mail/resend.js'
import { parseBody, requireRole, requireUser, requireWorkspace, type AppEnv } from '../scope.js'
import { requireMayPrompt } from '../thread-spec.js'
import { unavailable } from '../subscriptions/index.js'

/** An address as the dashboard shows it. */
async function view(
  db: ScopedDb,
  a: {
    id: string
    kind: 'agent' | 'inbox'
    name: string
    teammateId: string | null
    projectId: string | null
    connectionId: string | null
    publicAddress: string | null
    displayName: string | null
    releasedAt: Date | null
    createdAt: Date
    domain: {
      id: string
      name: string
      status: string
      receiving: string
      records: unknown
      checkedAt: Date | null
    } | null
  },
  names: { teammates: Map<string, string>; projects: Map<string, string> },
) {
  const variants =
    a.kind === 'agent'
      ? await db.mailProject.findMany({
          where: { projectId: { not: null } },
          select: { slug: true, projectId: true },
        })
      : []
  return {
    id: a.id,
    kind: a.kind,
    name: a.name,
    address: addressOf(a.name),
    on: !a.releasedAt && !!a.connectionId,
    connectionId: a.connectionId,
    teammate: a.teammateId
      ? { id: a.teammateId, name: names.teammates.get(a.teammateId) ?? 'Archived teammate' }
      : null,
    project: a.projectId
      ? { id: a.projectId, name: names.projects.get(a.projectId) ?? 'Deleted project' }
      : null,
    /** An agent's address in each project it was used in. */
    variants: variants.map((v) => ({
      projectId: v.projectId!,
      project: names.projects.get(v.projectId!) ?? '',
      address: addressOf(`${a.name}.${v.slug}`),
    })),
    publicAddress: a.publicAddress,
    displayName: a.displayName,
    domain: a.domain
      ? {
          id: a.domain.id,
          name: a.domain.name,
          status: a.domain.status,
          receiving: a.domain.receiving,
          records: a.domain.records,
          checkedAt: a.domain.checkedAt?.toISOString() ?? null,
        }
      : null,
    createdAt: a.createdAt.toISOString(),
  }
}

async function names(db: ScopedDb) {
  const [teammates, projects] = await Promise.all([
    db.teammate.findMany({ select: { id: true, name: true } }),
    db.project.findMany({ select: { id: true, name: true } }),
  ])
  return {
    teammates: new Map(teammates.map((t) => [t.id, t.name])),
    projects: new Map(projects.map((p) => [p.id, p.name])),
  }
}

const loadAddress = async (db: ScopedDb, id: string) => {
  const address = await db.mailAddress.findFirst({ where: { id }, include: { domain: true } })
  if (!address) throw new HTTPException(404, { message: 'No such address' })
  return address
}

export const email = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  /** The App's state: whether this server can run it, whether the workspace has it, its addresses. */
  .get('/', async (c) => {
    const { db } = c.var
    const app = await db.app.findFirst({ where: { key: 'email' } })
    const rows = await db.mailAddress.findMany({
      include: { domain: true },
      orderBy: { createdAt: 'asc' },
    })
    const known = await names(db)
    return c.json({
      available: resendConfigured() && !unavailable('email'),
      unavailable: unavailable('email'),
      domain: mailDomain(),
      enabled: Boolean(app),
      appId: app?.id ?? null,
      addresses: await Promise.all(rows.map((a) => view(db, a, known))),
    })
  })

  /** Owners and admins: the workspace gets the App; each agent's address is then turned on one by one. */
  .post('/enable', async (c) => {
    const { db, scope } = c.var
    requireRole(scope, 'owner', 'admin')
    const reason = unavailable('email')
    if (reason) throw new HTTPException(409, { message: reason })
    const app = await appFor(db, scope, 'email')
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'email.enabled',
      target: { type: 'app', id: app.id },
    })
    return c.json({ appId: app.id })
  })

  /** The name an agent would get: its own if free, else name-2, name-3… */
  .get('/agents/:teammateId/suggestion', async (c) => {
    const teammate = await c.var.db.teammate.findFirst({ where: { id: c.req.param('teammateId') } })
    if (!teammate) throw new HTTPException(404, { message: 'No such teammate' })
    const existing = await c.var.db.mailAddress.findFirst({ where: { teammateId: teammate.id } })
    const name = existing?.name ?? (await suggestName(teammate.name))
    return c.json({ name, address: addressOf(name), kept: Boolean(existing) })
  })

  /** Owners and admins: turn an agent's address on, with a name of their choice the first time. */
  .post('/agents/:teammateId', async (c) => {
    const { db, scope } = c.var
    requireRole(scope, 'owner', 'admin')
    if (!(await db.app.count({ where: { key: 'email' } })))
      throw new HTTPException(409, { message: 'Turn the Email App on first' })
    const input = await parseBody(c.req.raw, EnableAgentAddress)
    const teammate = await db.teammate.findFirst({
      where: { id: c.req.param('teammateId'), archivedAt: null },
    })
    if (!teammate) throw new HTTPException(404, { message: 'No such teammate' })
    // Its address on one of the workspace's domains: checked before anything is turned on.
    if (input.address) {
      await domainFor(db, input.address)
      await checkPublicAddress(db, input.address)
    }
    const row = await enableAgentAddress(db, scope, teammate, input.name)
    if (input.address) await setPublicAddress(db, scope, row.id, input.address)
    return c.json(await view(db, await loadAddress(db, row.id), await names(db)), 201)
  })

  /** Owners and admins: turn it off. The name stays the agent's for good. */
  .delete('/agents/:teammateId', async (c) => {
    const { db, scope } = c.var
    requireRole(scope, 'owner', 'admin')
    const row = await db.mailAddress.findFirst({ where: { teammateId: c.req.param('teammateId') } })
    if (!row) throw new HTTPException(404, { message: 'No address' })
    await disableAddress(db, scope, row.id)
    return c.body(null, 204)
  })

  /** Owners and admins: a project's inbox, on a generated name. */
  .post('/inboxes', async (c) => {
    const { db, scope } = c.var
    requireRole(scope, 'owner', 'admin')
    if (!(await db.app.count({ where: { key: 'email' } })))
      throw new HTTPException(409, { message: 'Turn the Email App on first' })
    const input = await parseBody(c.req.raw, CreateInbox)
    // Checked before the inbox is made, so a refused address leaves no inbox behind.
    if (input.publicAddress) {
      await domainFor(db, input.publicAddress)
      await checkPublicAddress(db, input.publicAddress)
    }
    const row = await createInbox(db, scope, input)
    if (input.publicAddress)
      try {
        await setPublicAddress(db, scope, row.id, input.publicAddress)
      } catch (error) {
        // Taken meanwhile (another request at the same moment): the new inbox goes too.
        await db.mailAddress.deleteMany({ where: { id: row.id } })
        if (row.connectionId) await db.connection.deleteMany({ where: { id: row.connectionId } })
        throw error
      }
    return c.json(await view(db, await loadAddress(db, row.id), await names(db)), 201)
  })

  /** Owners and admins: its name on what it sends, and the address customers write to. */
  .patch('/inboxes/:id', async (c) => {
    const { db, scope } = c.var
    requireRole(scope, 'owner', 'admin')
    const input = await parseBody(c.req.raw, UpdateInbox)
    const inbox = await loadAddress(db, c.req.param('id'))
    if (inbox.kind !== 'inbox') throw new HTTPException(400, { message: 'Not an inbox' })
    if (input.displayName)
      await db.mailAddress.update({
        where: { id: inbox.id },
        data: { displayName: input.displayName },
      })
    if (input.publicAddress !== undefined)
      await setPublicAddress(db, scope, inbox.id, input.publicAddress)
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'email.inbox.updated',
      target: { type: 'mail_address', id: inbox.id },
      data: input,
    })
    return c.json(await view(db, await loadAddress(db, inbox.id), await names(db)))
  })

  .delete('/inboxes/:id', async (c) => {
    const { db, scope } = c.var
    requireRole(scope, 'owner', 'admin')
    const inbox = await loadAddress(db, c.req.param('id'))
    if (inbox.kind !== 'inbox') throw new HTTPException(400, { message: 'Not an inbox' })
    await disableAddress(db, scope, inbox.id)
    return c.body(null, 204)
  })

  /**
   * Owners and admins: a mailbox's address, an agent's or a project's, on one of the workspace's
   * domains, or null for Brigade's own only.
   */
  .patch('/addresses/:id', async (c) => {
    const { db, scope } = c.var
    requireRole(scope, 'owner', 'admin')
    const { address } = await parseBody(c.req.raw, SetMailboxAddress)
    const row = await loadAddress(db, c.req.param('id'))
    await setPublicAddress(db, scope, row.id, address)
    return c.json(await view(db, await loadAddress(db, row.id), await names(db)))
  })

  /** The workspace's domains, each with the mailboxes' addresses on it. */
  .get('/domains', async (c) => c.json(await listDomains(c.var.db)))

  /** Where a domain's mail goes now, before it is added: so how Brigade had best receive it. */
  .get('/domains/lookup', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    return c.json(await lookupDomain(c.req.query('name') ?? ''))
  })

  /** Owners and admins: add a domain (to Resend too), receiving directly or by forwarding. */
  .post('/domains', async (c) => {
    const { db, scope } = c.var
    requireRole(scope, 'owner', 'admin')
    if (!(await db.app.count({ where: { key: 'email' } })))
      throw new HTTPException(409, { message: 'Turn the Email App on first' })
    const input = await parseBody(c.req.raw, CreateDomain)
    const row = await addDomain(db, scope, input)
    return c.json(
      (await listDomains(db)).find((d) => d.id === row.id),
      201,
    )
  })

  /** Owners and admins: remove a domain no mailbox has an address on. */
  .delete('/domains/:id', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    await removeDomain(c.var.db, c.var.scope, c.req.param('id'))
    return c.body(null, 204)
  })

  /** Ask Resend to check a domain's DNS records now. */
  .post('/domains/:id/check', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const row = await checkDomain(c.var.db, c.req.param('id'))
    return c.json({
      status: row.status,
      records: row.records,
      checkedAt: row.checkedAt?.toISOString() ?? null,
    })
  })

  /**
   * The address's journal: each email and where it went, newest first. Never its text: who wrote
   * and the subject, the thread or rule that took it.
   */
  .get('/addresses/:id/journal', async (c) => {
    const { db } = c.var
    const address = await loadAddress(db, c.req.param('id'))
    const rows = await db.mailMessage.findMany({
      where: { addressId: address.id },
      orderBy: { receivedAt: 'desc' },
      take: Math.min(Number(c.req.query('limit')) || 50, 200),
      include: {
        session: { select: { id: true, title: true } },
        alias: { select: { local: true } },
      },
    })
    const rules = await db.trigger.findMany({
      where: { id: { in: rows.map((r) => r.triggerId).filter((id): id is string => !!id) } },
      select: { id: true, label: true },
    })
    const slugs = await db.mailProject.findMany({ select: { slug: true, projectId: true } })
    const local = (row: (typeof rows)[number]) =>
      row.alias?.local ??
      (row.projectId
        ? `${address.name}.${slugs.find((s) => s.projectId === row.projectId)?.slug ?? ''}`
        : address.name)
    const entries: MailJournalEntry[] = rows.map((row) => ({
      id: row.id,
      direction: row.direction,
      status: row.status,
      from: row.fromName ? `${row.fromName} <${row.fromAddress}>` : row.fromAddress,
      to: row.to,
      // A sign-up's mail is its thread's: its subject often carries the code itself.
      subject: row.aliasId ? 'Mail to a sign-up address' : row.subject,
      at: row.receivedAt.toISOString(),
      route: (row.route as MailJournalEntry['route']) ?? null,
      routeNote: row.routeNote,
      thread: row.session ? { id: row.session.id, title: row.session.title } : null,
      rule: rules.find((r) => r.id === row.triggerId) ?? null,
      address: addressOf(local(row)),
      sender: row.sender,
    }))
    return c.json(entries)
  })

  /**
   * An inbox's latest mail from Google's forwarding check, with its code: what a person types in
   * Gmail's settings to confirm forwarding support@ here.
   */
  .get('/addresses/:id/forwarding', async (c) => {
    const { db, scope } = c.var
    requireRole(scope, 'owner', 'admin')
    const address = await loadAddress(db, c.req.param('id'))
    const row = await db.mailMessage.findFirst({
      where: {
        addressId: address.id,
        direction: 'in',
        fromAddress: { in: ['forwarding-noreply@google.com', 'mail-noreply@google.com'] },
      },
      orderBy: { receivedAt: 'desc' },
    })
    if (!row) return c.json({ found: false })
    const code =
      row.text.match(/(?:confirmation code|code de confirmation)\D{0,20}(\d{6,12})/i)?.[1] ?? null
    const link =
      row.text.match(/https:\/\/mail(?:-settings)?\.google\.com\/mail\/[^\s<>)]+/)?.[0] ?? null
    return c.json({
      found: true,
      at: row.receivedAt.toISOString(),
      subject: row.subject,
      code,
      link,
    })
  })

  /**
   * Send a test mail through the whole loop: from Brigade's own sender to the address (or to the
   * address customers write to, which should forward it here). It shows in the journal and goes
   * to no rule.
   */
  .post('/addresses/:id/test', async (c) => {
    const { db, scope } = c.var
    requireRole(scope, 'owner', 'admin')
    const address = await loadAddress(db, c.req.param('id'))
    if (address.releasedAt) throw new HTTPException(409, { message: 'This address is turned off' })
    const to =
      c.req.query('public') === '1' && address.publicAddress
        ? address.publicAddress
        : addressOf(address.name)
    const token = `${address.id}.${Date.now()}`
    await sendEmail(
      {
        from: `Brigade <${addressOf('noreply')}>`,
        to: [to],
        subject: `Brigade test mail for ${addressOf(address.name)}`,
        text: 'This is a test from Brigade, to check that mail to this address arrives. It goes to no rule and starts no thread.',
        headers: { 'X-Brigade-Test': token },
      },
      `brigade-test-${token}`,
    )
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'email.test_sent',
      target: { type: 'mail_address', id: address.id },
      data: { to },
    })
    return c.json({ sent: true, to })
  })

  /** Owners and admins: the order of an address's rules. */
  .put('/rules/order', async (c) => {
    const { db, scope } = c.var
    requireRole(scope, 'owner', 'admin')
    const { triggerIds } = await parseBody(c.req.raw, OrderRules)
    const rows = await db.trigger.findMany({
      where: { id: { in: triggerIds } },
      select: { id: true, connectionId: true },
    })
    if (rows.length !== triggerIds.length || new Set(rows.map((r) => r.connectionId)).size !== 1)
      throw new HTTPException(400, { message: 'Give the rules of one account, each once' })
    for (const [position, id] of triggerIds.entries())
      await db.trigger.updateMany({ where: { id }, data: { position } })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'trigger.reordered',
      target: { type: 'connection', id: rows[0]!.connectionId },
      data: { triggerIds },
    })
    return c.json({ ok: true })
  })

  /**
   * A rule tried on the account's latest mail before it is made: which of the last 20 it would
   * have taken. Nothing starts.
   */
  .post('/rules/preview', async (c) => {
    const { db, scope } = c.var
    // Who makes rules (owners and admins), on an account they may read: a member's own Gmail
    // (reach mine) shows its mail to no one else.
    requireRole(scope, 'owner', 'admin')
    const input = await parseBody(c.req.raw, PreviewRule)
    const connection = await db.connection.findFirst({
      where: { id: input.connectionId, status: { not: 'removed' } },
    })
    if (!connection) throw new HTTPException(404, { message: 'No such account' })
    if (connection.reach === 'mine' && connection.createdByMemberId !== scope.memberId)
      throw new HTTPException(403, { message: 'This account is another member’s own' })
    const definition = triggersOf(connection.kind).email_received
    if (!definition?.replay)
      throw new HTTPException(400, { message: 'This account’s rules cannot be tried on past mail' })
    // The account's own fetch, for its replay and for matching (a Gmail search asks Gmail).
    const fetch =
      connection.kind === 'email'
        ? (url: string, init?: RequestInit) => globalThis.fetch(url, init)
        : await (await import('../connector-calls.js')).authorisedFetch(db, scope, connection)
    let past: Awaited<ReturnType<NonNullable<typeof definition.replay>>>
    if (connection.kind === 'email') {
      // Its own box only: an agent's rule watches its project's variant.
      past = await definition.replay({}, { fetch, connectionId: connection.id }, 20)
      const address = await db.mailAddress.findFirst({ where: { connectionId: connection.id } })
      if (address?.kind === 'agent')
        past = past.filter(
          (e) =>
            ((e.payload as { projectId?: string | null }).projectId ?? null) ===
            (input.projectId ?? null),
        )
    } else {
      past = await definition.replay({}, { fetch }, 20)
    }
    const results = []
    for (const e of past) {
      const p = e.payload as { from?: string; subject?: string; date?: string }
      results.push({
        id: e.id,
        from: p.from ?? '',
        subject: p.subject ?? '',
        at: e.at,
        matches: definition.matches
          ? await definition.matches(e, input.options, { fetch, connectionId: connection.id })
          : true,
      })
    }
    return c.json({ results })
  })

  /** Cancel a mail a thread sent, in its window: whoever may prompt the thread. */
  .post('/messages/:id/cancel', async (c) => {
    const { db, scope } = c.var
    const row = await db.mailMessage.findFirst({
      where: { id: c.req.param('id'), direction: 'out' },
    })
    if (!row?.sessionId) throw new HTTPException(404, { message: 'No such email' })
    const thread = await db.session.findFirst({ where: { id: row.sessionId } })
    if (!thread) throw new HTTPException(404, { message: 'No such email' })
    requireMayPrompt(scope, { ...thread, controlledByMemberId: null })
    return c.json(await cancelMail(db, scope, row.id, { type: 'member', id: scope.memberId }))
  })
