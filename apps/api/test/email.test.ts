import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, beforeEach, describe, test } from 'node:test'
import pg from 'pg'

// The Email App (src/mail/) against a real database, with Resend played by a fake fetch: the
// local database of apps/api/.env, in two organizations of its own (names must be unique across
// them) that it removes at the end. Without a database to reach, the database tests are skipped.
const fromEnvFile = () => {
  try {
    const line = readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('DATABASE_URL='))
    return line?.slice('DATABASE_URL='.length).replace(/^"|"$/g, '') || undefined
  } catch {
    return undefined
  }
}
process.env.DATABASE_URL ??= fromEnvFile() ?? 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const WEBHOOK_KEY = Buffer.from('a-webhook-secret-for-tests-only!').toString('base64')
process.env.RESEND_API_KEY = 're_test_key'
process.env.RESEND_WEBHOOK_SECRET = `whsec_${WEBHOOK_KEY}`
process.env.MAIL_DOMAIN = 'mails.brigade.test'

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select 1 from "MailMessage" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const names = await import('../src/mail/names.js')
const text = await import('../src/mail/text.js')
const { verifyWebhook } = await import('../src/mail/resend.js')
const { gmailAuthentication } = await import('../src/mail/identity.js')

describe('names', () => {
  test('a name is lowercase letters, digits and hyphens, 2 to 30, never reserved', () => {
    assert.equal(names.nameProblem('riley'), null)
    assert.equal(names.nameProblem('riley-2'), null)
    assert.match(names.nameProblem('Riley') ?? '', /lowercase/)
    assert.match(names.nameProblem('ri.ley') ?? '', /lowercase/)
    assert.match(names.nameProblem('-riley') ?? '', /starts and ends/)
    assert.match(names.nameProblem('ri--ley') ?? '', /two hyphens/)
    assert.match(names.nameProblem('r') ?? '', /2 to 30/)
    assert.match(names.nameProblem('support') ?? '', /reserved/)
    assert.match(names.nameProblem('postmaster') ?? '', /reserved/)
    for (const word of ['chief', 'georges', 'brigade', 'contact', 'sales'])
      assert.match(names.nameProblem(word) ?? '', /reserved/, word)
  })

  test('candidates: the teammate’s own name first, then -2, -3', () => {
    const [first, second, third] = [...take(names.candidates('Rïley Bot!'), 3)]
    assert.deepEqual([first, second, third], ['riley-bot', 'riley-bot-2', 'riley-bot-3'])
    // A reserved or too short name starts at -2.
    assert.equal(take(names.candidates('Support'), 1)[0], 'support-2')
    assert.equal(take(names.candidates('Chief'), 1)[0], 'chief-2')
    assert.equal(take(names.candidates('R'), 1)[0], 'r-agent')
  })

  test('only Brigade’s domain is Brigade’s mail, whatever the case or the display name', () => {
    assert.equal(names.localOn('Riley <Riley.Lovarank@MAILS.brigade.test>'), 'riley.lovarank')
    assert.equal(names.localOn('riley@mails.brigade.test.evil.com'), null)
    assert.equal(names.localOn('riley@other.test'), null)
    assert.deepEqual(names.partsOf('riley.lovarank.0k3f9a'), {
      name: 'riley',
      rest: ['lovarank', '0k3f9a'],
    })
  })

  test('a sign-up token starts with a digit, so it never reads as a project', () => {
    for (let i = 0; i < 50; i++) assert.match(names.aliasToken(), /^\d[a-z0-9]{5}$/)
  })
})

describe('webhook signature (Svix)', () => {
  const secret = `whsec_${WEBHOOK_KEY}`
  const sign = (id: string, timestamp: string, body: string) =>
    `v1,${createHmac('sha256', Buffer.from(WEBHOOK_KEY, 'base64')).update(`${id}.${timestamp}.${body}`).digest('base64')}`
  test('accepts Resend’s signature, refuses another, an old one and a missing one', () => {
    const now = Date.now()
    const ts = String(Math.floor(now / 1000))
    const body = '{"type":"email.received"}'
    assert.equal(
      verifyWebhook(
        body,
        { id: 'msg_1', timestamp: ts, signature: sign('msg_1', ts, body) },
        secret,
        now,
      ),
      true,
    )
    // One of several signatures, as during a secret's rotation.
    assert.equal(
      verifyWebhook(
        body,
        { id: 'msg_1', timestamp: ts, signature: `v1,AAAA ${sign('msg_1', ts, body)}` },
        secret,
        now,
      ),
      true,
    )
    assert.equal(
      verifyWebhook(
        `${body} `,
        { id: 'msg_1', timestamp: ts, signature: sign('msg_1', ts, body) },
        secret,
        now,
      ),
      false,
    )
    const old = String(Math.floor(now / 1000) - 600)
    assert.equal(
      verifyWebhook(
        body,
        { id: 'msg_1', timestamp: old, signature: sign('msg_1', old, body) },
        secret,
        now,
      ),
      false,
    )
    assert.equal(verifyWebhook(body, { id: 'msg_1', timestamp: ts }, secret, now), false)
    assert.equal(
      verifyWebhook(
        body,
        { id: 'msg_1', timestamp: ts, signature: sign('msg_1', ts, body) },
        '',
        now,
      ),
      false,
    )
  })
})

describe('text', () => {
  test('HTML as text keeps each link, since a sign-up’s link is the point', () => {
    const got = text.htmlToText(
      '<html><head><style>p{}</style></head><body><p>Hi&nbsp;Ada,</p><p>Confirm: <a href="https://x.test/c?t=1&amp;u=2">confirm your email</a></p><p>Code: <b>482913</b></p><script>bad()</script></body></html>',
    )
    assert.match(got, /Hi Ada,/)
    assert.match(got, /confirm your email \(https:\/\/x\.test\/c\?t=1&u=2\)/)
    assert.match(got, /Code: 482913/)
    assert.doesNotMatch(got, /bad\(\)|p\{\}/)
  })
  test('a secret is never mailed', () => {
    assert.equal(text.secretIn('Here: sk_live_abcdefghijklmnop'), 'a Stripe secret key')
    assert.equal(text.secretIn('-----BEGIN RSA PRIVATE KEY-----'), 'a private key')
    assert.equal(text.secretIn('password: hunter2hunter2'), 'a password')
    assert.equal(text.secretIn('Your order #4821 ships today.'), null)
  })
  test('machines’ mail and delivery failures are told by their headers', () => {
    assert.equal(text.automaticHeaders({ 'auto-submitted': 'auto-replied' }), true)
    assert.equal(text.automaticHeaders({ 'list-id': '<news.acme.test>' }), true)
    assert.equal(text.automaticHeaders({ 'auto-submitted': 'no' }), false)
    assert.equal(text.bounceOf('MAILER-DAEMON@mx.test', {}), true)
    assert.equal(
      text.bounceOf('a@b.test', {
        'content-type': 'multipart/report; report-type=delivery-status',
      }),
      true,
    )
    assert.equal(text.bounceOf('a@b.test', {}), false)
  })
  test('Gmail’s DKIM counts only when it signed for the From domain', () => {
    assert.equal(
      gmailAuthentication(
        'mx.google.com; dkim=pass header.i=@acme.test; spf=pass; dmarc=pass',
        'Ada <ada@acme.test>',
      )?.dkim,
      'pass',
    )
    assert.equal(
      gmailAuthentication(
        'mx.google.com; dkim=pass header.i=@evil.test; spf=pass; dmarc=fail',
        'ada@acme.test',
      )?.dkim,
      'gray',
    )
  })
})

function take<T>(it: Iterable<T>, n: number) {
  const out: T[] = []
  for (const v of it) {
    out.push(v)
    if (out.length >= n) break
  }
  return out
}

// ---------------------------------------------------------------------------
// Against the database
// ---------------------------------------------------------------------------

const { prisma, scoped } = await import('../src/db.js')
const addresses = await import('../src/mail/addresses.js')
const inbound = await import('../src/mail/inbound.js')
const outbound = await import('../src/mail/outbound.js')
const { deliver } = await import('../src/triggers.js')

const id = randomUUID().slice(0, 8)
const orgs = [`org-mail-a-${id}`, `org-mail-b-${id}`]
const users = [`user-mail-a-${id}`, `user-mail-b-${id}`]
const members = [`mem-mail-a-${id}`, `mem-mail-b-${id}`]
const adaEmail = `ada-${id}@acme.test`
type Scope = { organizationId: string; workspaceId: string }
let a: Scope
let b: Scope
let riley: { id: string; name: string }
let rileyB: { id: string; name: string }
let computerId: string
let projectId: string
const realFetch = globalThis.fetch

/** Resend as the API asks it: received emails by id, sends, and sent emails' Message-IDs. */
const resend = {
  received: new Map<string, unknown>(),
  sent: [] as { body: Record<string, unknown> }[],
  cancelled: [] as string[],
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const ws = (scope: Scope, role: 'owner' | 'admin' | 'member' = 'owner') => ({
  ...scope,
  userId: scope === a ? users[0]! : users[1]!,
  memberId: scope === a ? members[0]! : members[1]!,
  role,
})

before(async () => {
  if (skip) return
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    if (url.host !== 'api.resend.com') throw new Error(`unexpected request ${url}`)
    const received = /^\/emails\/receiving\/([^/]+)$/.exec(url.pathname)?.[1]
    if (received)
      return resend.received.has(received)
        ? json(resend.received.get(received))
        : json({ message: 'Not found' }, 404)
    if (url.pathname === '/emails' && init?.method === 'POST') {
      resend.sent.push({ body: JSON.parse(String(init.body)) })
      return json({ id: `sent-${randomUUID()}` })
    }
    const cancel = /^\/emails\/([^/]+)\/cancel$/.exec(url.pathname)?.[1]
    if (cancel) {
      resend.cancelled.push(cancel)
      return json({ id: cancel })
    }
    throw new Error(`unexpected request ${url}`)
  }) as typeof fetch

  for (const [i, org] of orgs.entries()) {
    await prisma.organization.create({ data: { id: org, name: `Mail ${i}`, slug: org } })
    await prisma.user.create({
      data: {
        id: users[i]!,
        name: i === 0 ? 'Ada' : 'Bob',
        email: i === 0 ? adaEmail : `bob-${id}@acme.test`,
      },
    })
    await prisma.member.create({
      data: { id: members[i]!, organizationId: org, userId: users[i]!, role: 'owner' },
    })
  }
  const wa = await prisma.workspace.create({ data: { organizationId: orgs[0]!, name: 'Mail A' } })
  const wb = await prisma.workspace.create({ data: { organizationId: orgs[1]!, name: 'Mail B' } })
  a = { organizationId: orgs[0]!, workspaceId: wa.id }
  b = { organizationId: orgs[1]!, workspaceId: wb.id }
  // Names are unique across Brigade: these tests' own, so another run's never collide.
  riley = await prisma.teammate.create({ data: { ...a, name: `Riley ${id}` } })
  rileyB = await prisma.teammate.create({ data: { ...b, name: `Riley ${id}` } })
  computerId = (
    await prisma.computer.create({
      data: { ...a, kind: 'member_machine', memberId: members[0]!, name: 'Laptop' },
    })
  ).id
  await prisma.account.create({
    data: {
      ...a,
      memberId: members[0]!,
      computerId,
      provider: 'claude_code',
      label: 'Claude',
      status: 'ready',
    },
  })
  projectId = (await prisma.project.create({ data: { ...a, name: 'Lovarank' } })).id
})

beforeEach(() => {
  resend.received.clear()
  resend.sent.length = 0
  resend.cancelled.length = 0
})

after(async () => {
  globalThis.fetch = realFetch
  if (skip) return
  // Names stay reserved for good, so the test removes its own by hand.
  await prisma.mailAddress.deleteMany({ where: { organizationId: { in: orgs } } })
  await prisma.organization.deleteMany({ where: { id: { in: orgs } } })
  await prisma.user.deleteMany({ where: { id: { in: users } } })
  await prisma.$disconnect()
})

const base = () => `riley-${id}`.toLowerCase()

/** An email as Resend gives it, kept for its id, and the webhook's event for it. */
function mail(input: {
  to: string[]
  from?: string
  subject?: string
  text?: string
  headers?: Record<string, string>
  dkim?: string
  messageId?: string
}) {
  const emailId = randomUUID()
  const messageId = input.messageId ?? `<${randomUUID()}@sender.test>`
  resend.received.set(emailId, {
    id: emailId,
    to: input.to,
    from: input.from ?? 'stranger@outside.test',
    created_at: new Date().toISOString(),
    subject: input.subject ?? 'Hello',
    html: null,
    text: input.text ?? 'Hi there',
    headers: { from: input.from ?? 'Stranger <stranger@outside.test>', ...input.headers },
    authentication: { spf: 'pass', dkim: input.dkim ?? 'gray', dmarc: 'gray' },
    message_id: messageId,
    attachments: [],
  })
  return {
    email_id: emailId,
    from: input.from ?? 'stranger@outside.test',
    to: input.to,
    subject: input.subject ?? 'Hello',
    message_id: messageId,
    created_at: new Date().toISOString(),
  }
}

/** Keep and deliver one email; the rows it made. */
async function arrive(event: ReturnType<typeof mail>) {
  await inbound.received(event)
  const rows = await prisma.mailMessage.findMany({ where: { resendId: event.email_id } })
  for (const row of rows) await inbound.processMail(row.id).catch(() => undefined)
  return prisma.mailMessage.findMany({ where: { resendId: event.email_id } })
}

let titles = 0
const thread = (origin: 'member' | 'trigger' = 'member', extra: Record<string, unknown> = {}) =>
  prisma.session.create({
    data: {
      ...a,
      teammateId: riley.id,
      startedByMemberId: members[0]!,
      computerId,
      title: `Thread ${++titles}`,
      status: 'idle',
      origin,
      ...extra,
    },
  })

describe('addresses', { skip }, () => {
  test('a name is unique across Brigade, never given again, and kept by its agent', async () => {
    const dbA = scoped(a)
    const dbB = scoped(b)
    const mine = await addresses.enableAgentAddress(dbA, ws(a), riley, base())
    assert.equal(mine.name, base())
    // Another workspace's Riley: the name is taken, its own -2 is offered.
    await assert.rejects(addresses.enableAgentAddress(dbB, ws(b), rileyB, base()), /is taken/)
    assert.equal(await addresses.suggestName(base()), `${base()}-2`)
    const theirs = await addresses.enableAgentAddress(dbB, ws(b), rileyB)
    assert.equal(theirs.name, `${base()}-2`)
    // Turned off, the name stays reserved: nobody else gets it.
    await addresses.disableAddress(dbA, ws(a), mine.id)
    assert.equal(await addresses.boxOf(base()), null)
    assert.equal(await addresses.suggestName(base()), `${base()}-3`)
    // Turned on again, Riley gets its own name back, on a new account.
    const again = await addresses.enableAgentAddress(dbA, ws(a), riley)
    assert.equal(again.name, base())
    assert.notEqual(again.connectionId, mine.connectionId)
    const grants = await prisma.grant.findMany({ where: { connectionId: again.connectionId! } })
    assert.deepEqual(
      grants.map((g) => [g.teammateId, g.scope]),
      [[riley.id, 'read_write']],
    )
  })

  test('a recipient means one box: the address, a project’s variant, a sign-up address, or none', async () => {
    const db = scoped(a)
    const slug = await addresses.projectSlug(db, projectId)
    assert.equal(slug, 'lovarank')
    assert.equal(await addresses.projectSlug(db, projectId), 'lovarank')
    const plain = await addresses.boxOf(base())
    assert.equal(plain?.projectId, null)
    const variant = await addresses.boxOf(`${base()}.lovarank`)
    assert.equal(variant?.projectId, projectId)
    assert.equal(await addresses.boxOf(`${base()}.nope`), null)
    assert.equal(await addresses.boxOf(`nobody-${id}`), null)
    // Renamed, the project keeps its slug.
    await prisma.project.update({ where: { id: projectId }, data: { name: 'Lovarank SEO' } })
    assert.equal(await addresses.projectSlug(db, projectId), 'lovarank')
  })
})

describe('receiving', { skip }, () => {
  const to = (local: string) => `${local}@mails.brigade.test`

  test('only Brigade’s domain is kept, once per box, even when Resend sends it twice', async () => {
    const event = mail({ to: [to(`${base()}.lovarank`), 'someone@other-product.test'] })
    assert.equal(await inbound.received(event), 1)
    assert.equal(await inbound.received(event), 0)
    const other = mail({ to: ['inbox@other-product.test'] })
    assert.equal(await inbound.received(other), 0)
    assert.equal(await prisma.mailMessage.count({ where: { resendId: other.email_id } }), 0)
    assert.equal(await prisma.mailMessage.count({ where: { resendId: event.email_id } }), 1)
  })

  test('a stranger’s mail with no rule stays in the box, for 30 days', async () => {
    const [row] = await arrive(mail({ to: [to(base())], subject: 'Partnership?' }))
    assert.equal(row!.status, 'done')
    assert.equal(row!.route, 'box')
    assert.equal(row!.sender, 'unknown')
    assert.ok(row!.expiresAt && row!.expiresAt.getTime() > Date.now() + 29 * 86_400_000)
  })

  test('a mail of the box a thread reads is that thread’s, with what waited before it', async () => {
    const db = scoped(a)
    const address = await db.mailAddress.findFirstOrThrow({ where: { teammateId: riley.id } })
    const session = await thread('member')
    const subject = `Welcome ${randomUUID()}`
    const [first] = await arrive(mail({ to: [to(base())], subject }))
    const [welcome] = await arrive(
      mail({
        to: [to(base())],
        subject: `Re: ${subject}`,
        headers: { 'in-reply-to': first!.messageId! },
      }),
    )
    assert.equal(welcome!.conversationId, first!.conversationId)
    const [later] = await arrive(mail({ to: [to(base())], subject: 'Unrelated' }))
    const { email } = await import('../src/connectors/email.js')
    await email.operations.email_read!.run(
      {
        scope: a,
        connectionId: address.connectionId!,
        teammateId: riley.id,
        thread: session,
        callId: randomUUID(),
        fetch: globalThis.fetch,
      } as never,
      { id: welcome!.id } as never,
    )
    const rows = await prisma.mailMessage.findMany({
      where: { id: { in: [first!.id, welcome!.id, later!.id] } },
    })
    const of = (id: string) => rows.find((r) => r.id === id)!
    for (const id of [first!.id, welcome!.id]) {
      assert.equal(of(id).sessionId, session.id)
      assert.equal(of(id).route, 'read')
      assert.equal(of(id).expiresAt, null)
    }
    // Another conversation still waits in the box.
    assert.equal(of(later!.id).sessionId, null)
    assert.equal(of(later!.id).route, 'box')
  })

  test('a reply that fails to leave leaves the mail it answers To do', async () => {
    const db = scoped(a)
    const session = await thread()
    const address = await db.mailAddress.findFirstOrThrow({
      where: { teammateId: riley.id },
      include: { domain: true },
    })
    const [original] = await arrive(mail({ to: [to(base())] }))
    const savedFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('Resend unavailable')
    }) as typeof fetch
    try {
      await assert.rejects(
        outbound.sendDraft(db, a, {
          address,
          thread: session,
          teammateId: riley.id,
          draft: {
            to: ['stranger@outside.test'],
            subject: 'Re: Hello',
            text: 'Answer',
            replyTo: original!.id,
          },
          callId: randomUUID(),
        }),
        /Resend unavailable/,
      )
    } finally {
      globalThis.fetch = savedFetch
    }
    const row = await db.mailMessage.findFirstOrThrow({ where: { id: original!.id } })
    assert.equal(row.sessionId, null)
    assert.equal(row.route, 'box')
  })

  test('reading a follow-up never takes another thread’s sign-up mail in its conversation', async () => {
    const db = scoped(a)
    const owner = await thread()
    const reader = await thread()
    const address = await db.mailAddress.findFirstOrThrow({ where: { teammateId: riley.id } })
    const alias = await addresses.newAlias(db, {
      address,
      projectId: null,
      sessionId: owner.id,
      teammateId: riley.id,
      purpose: 'private sign-up',
      waitMinutes: 60,
    })
    const [secret] = await arrive(mail({ to: [to(alias.local)], text: 'Code 123456' }))
    // As delivery leaves it when the waiting thread cannot take it now.
    await db.mailMessage.updateMany({
      where: { id: secret!.id },
      data: { sessionId: null, route: 'box' },
    })
    const [followUp] = await arrive(
      mail({
        to: [to(base())],
        headers: { 'in-reply-to': secret!.messageId! },
        text: 'Public follow-up',
      }),
    )
    const { email } = await import('../src/connectors/email.js')
    await email.operations.email_read!.run(
      {
        scope: a,
        connectionId: address.connectionId!,
        teammateId: riley.id,
        thread: reader,
        callId: randomUUID(),
        fetch: globalThis.fetch,
      } as never,
      { id: followUp!.id } as never,
    )
    const rows = await prisma.mailMessage.findMany({
      where: { id: { in: [secret!.id, followUp!.id] } },
    })
    assert.equal(rows.find((r) => r.id === secret!.id)!.sessionId, null)
    assert.equal(rows.find((r) => r.id === followUp!.id)!.sessionId, reader.id)
  })

  test('a sign-up code goes to the thread that made the address, and no rule sees it', async () => {
    const db = scoped(a)
    const session = await thread('member', { projectId })
    const address = await db.mailAddress.findFirstOrThrow({ where: { teammateId: riley.id } })
    const alias = await addresses.newAlias(db, {
      address,
      projectId,
      sessionId: session.id,
      teammateId: riley.id,
      purpose: 'Notion sign-up',
      waitMinutes: 60,
    })
    assert.match(alias.local, new RegExp(`^${base()}\\.lovarank\\.\\d[a-z0-9]{5}$`))
    // A rule that would take anything: it must not, the thread waits on this one.
    const rule = await prisma.trigger.create({
      data: {
        ...a,
        connectionId: address.connectionId!,
        teammateId: riley.id,
        label: 'Everything',
        event: 'email_received',
        createdByMemberId: members[0]!,
        projectId,
      },
    })
    const [row] = await arrive(
      mail({
        to: [to(alias.local)],
        from: 'noreply@notion.test',
        subject: 'Your code',
        text: 'Your code is 482913',
        headers: { 'auto-submitted': 'auto-generated' },
      }),
    )
    assert.equal(row!.route, 'awaited')
    assert.equal(row!.sessionId, session.id)
    const wakeup = await prisma.wakeup.findFirstOrThrow({
      where: { sessionId: session.id, kind: 'reply' },
    })
    assert.match(wakeup.note, /482913/)
    assert.match(wakeup.note, /Notion sign-up/)
    assert.equal(await prisma.session.count({ where: { triggerId: rule.id } }), 0)
    await prisma.trigger.delete({ where: { id: rule.id } })
  })

  test('email_wait takes the code as it arrives, instead of a wake-up', async () => {
    const db = scoped(a)
    const session = await thread('member')
    const address = await db.mailAddress.findFirstOrThrow({ where: { teammateId: riley.id } })
    const alias = await addresses.newAlias(db, {
      address,
      projectId: null,
      sessionId: session.id,
      teammateId: riley.id,
      purpose: 'Linear',
      waitMinutes: 10,
    })
    const waited = inbound.awaitMail(session.id, 5_000)
    const [row] = await arrive(mail({ to: [to(alias.local)], subject: 'Code 1234' }))
    assert.equal(await waited, row!.id)
    assert.equal(await prisma.wakeup.count({ where: { sessionId: session.id } }), 0)
  })

  test('a member’s verified mail to an agent is their request; an unverified one is a stranger’s', async () => {
    const before = await prisma.session.count({ where: { ...a, startedByMemberId: members[0]! } })
    const [forged] = await arrive(
      mail({ to: [to(base())], from: adaEmail, subject: 'Forged', dkim: 'fail' }),
    )
    assert.equal(forged!.sender, 'unknown')
    assert.equal(forged!.route, 'box')
    const [request] = await arrive(
      mail({
        to: [to(`${base()}.lovarank`)],
        from: adaEmail,
        subject: 'Please look at the SEO report',
        dkim: 'pass',
      }),
    )
    // Its computer is offline here: the thread it started never ran, so it went, and the mail
    // waits to be tried again rather than lie in the box.
    assert.equal(request!.sender, 'member')
    assert.equal(request!.status, 'pending')
    assert.match(request!.error ?? '', /offline/)
    assert.equal(
      await prisma.session.count({ where: { ...a, startedByMemberId: members[0]! } }),
      before,
    )
  })

  test('the first matching rule takes the mail, in their order; the others never see it', async () => {
    const db = scoped(a)
    const address = await db.mailAddress.findFirstOrThrow({ where: { teammateId: riley.id } })
    const make = (label: string, position: number, options: Record<string, string>) =>
      prisma.trigger.create({
        data: {
          ...a,
          connectionId: address.connectionId!,
          teammateId: riley.id,
          label,
          event: 'email_received',
          options,
          createdByMemberId: members[0]!,
          projectId,
          position,
        },
      })
    const invoices = await make('Invoices', 0, { subject: 'invoice' })
    const rest = await make('The rest', 1, {})
    const tickets = (triggerId: string) =>
      prisma.ticket.count({ where: { ...a, payload: { path: ['triggerId'], equals: triggerId } } })
    // The computer is offline: the rule that took it says so in a ticket, and the mail waits.
    const [first] = await arrive(
      mail({ to: [to(`${base()}.lovarank`)], subject: 'Your invoice for October' }),
    )
    assert.equal(first!.status, 'pending')
    assert.equal(await tickets(invoices.id), 1)
    assert.equal(await tickets(rest.id), 0)
    const [second] = await arrive(mail({ to: [to(`${base()}.lovarank`)], subject: 'Lunch?' }))
    assert.equal(second!.status, 'pending')
    assert.equal(await tickets(rest.id), 1)
    // Mail to the address without a project is not Lovarank's: its rules leave it.
    const [plain] = await arrive(mail({ to: [to(base())], subject: 'Your invoice' }))
    assert.equal(plain!.route, 'box')
    await prisma.trigger.deleteMany({ where: { id: { in: [invoices.id, rest.id] } } })
    await prisma.ticket.deleteMany({ where: { ...a } })
    await prisma.mailMessage.deleteMany({ where: { id: { in: [first!.id, second!.id] } } })
  })

  test('a reply to mail a thread sent wakes that thread, and its bounce too', async () => {
    const db = scoped(a)
    const session = await thread('member')
    const address = await db.mailAddress.findFirstOrThrow({
      where: { teammateId: riley.id },
      include: { domain: true },
    })
    const sent = await outbound.sendDraft(db, a, {
      address,
      thread: { ...session, projectId: null },
      teammateId: riley.id,
      draft: { to: ['partner@outside.test'], subject: 'A proposal', text: 'Shall we?' },
      callId: randomUUID(),
    })
    assert.equal(resend.sent.length, 1)
    const body = resend.sent[0]!.body
    assert.equal(body.from, `Riley ${id} <${base()}@mails.brigade.test>`)
    assert.ok(Date.parse(String(body.scheduled_at)) > Date.now() + 20_000)
    // Resend tells its Message-ID once it has left.
    const out = await prisma.mailMessage.findUniqueOrThrow({ where: { id: sent.id } })
    await outbound.statusChanged('email.sent', {
      email_id: out.resendId!,
      message_id: '<proposal-1@ses.test>',
    })
    const [answer] = await arrive(
      mail({
        to: [to(base())],
        from: 'partner@outside.test',
        subject: 'Re: A proposal',
        text: 'Yes!\n\nOn Mon, Riley wrote:\n> Shall we?',
        headers: { 'in-reply-to': '<proposal-1@ses.test>', references: '<proposal-1@ses.test>' },
      }),
    )
    assert.equal(answer!.route, 'awaited')
    assert.equal(answer!.conversationId, sent.conversationId)
    const wakeup = await prisma.wakeup.findFirstOrThrow({
      where: { sessionId: session.id, kind: 'reply' },
    })
    assert.match(wakeup.note, /Yes!/)
    // Only the new part: the quote stays in email_read.
    assert.doesNotMatch(wakeup.note, /Shall we\?/)
    // A bounce of what it sent comes back to it too.
    await outbound.statusChanged('email.bounced', {
      email_id: out.resendId!,
      bounce: { message: 'No such user' },
    })
    const bounced = await prisma.wakeup.findFirstOrThrow({
      where: { sessionId: session.id, sourceId: `email-status:${sent.id}` },
    })
    assert.match(bounced.note, /No such user/)
  })

  test('a mail to two of the workspace’s addresses is delivered once; a reply sent from Gmail is the person’s', async () => {
    const db = scoped(a)
    const inbox = await addresses.createInbox(db, ws(a), { projectId, label: 'Support' })
    // Its project may have been renamed Lovarank SEO above: a new name takes the new name.
    assert.match(inbox.name, /^support-lovarank(-seo)?-[a-z0-9]{4}$/)
    await prisma.mailAddress.update({
      where: { id: inbox.id },
      data: { publicAddress: `support-${id}@lovarank.test` },
    })
    const rows = await arrive(mail({ to: [to(base()), to(inbox.name)], subject: 'Twice' }))
    assert.deepEqual(rows.map((r) => r.route).sort(), ['box', 'box'])
    const once = mail({ to: [to(inbox.name)], subject: 'Same', messageId: '<same-1@x.test>' })
    const twice = mail({ to: [to(base())], subject: 'Same', messageId: '<same-1@x.test>' })
    const session = await thread('member')
    // The first goes to a thread (here, one waiting on its conversation), the copy does not.
    await prisma.replyWatch.create({
      data: {
        ...a,
        sessionId: session.id,
        teammateId: riley.id,
        connectionId: inbox.connectionId!,
        conversationKey: 'conv-same',
        to: 'x',
        subject: 'x',
        until: new Date(Date.now() + 3600_000),
      },
    })
    // Kept as the webhook keeps it, already read, in the conversation the thread waits on.
    const first = await prisma.mailMessage.create({
      data: {
        ...a,
        addressId: inbox.id,
        box: `${inbox.id}:-`,
        direction: 'in',
        status: 'pending',
        resendId: once.email_id,
        messageId: once.message_id,
        conversationId: 'conv-same',
        fromAddress: once.from,
        subject: 'Same',
        text: 'Same',
        sender: 'unknown',
      },
    })
    await inbound.processMail(first.id)
    assert.equal(
      (await prisma.mailMessage.findUniqueOrThrow({ where: { id: first.id } })).route,
      'awaited',
    )
    const [copy] = await arrive(twice)
    assert.equal(copy!.route, 'duplicate')
    const [own] = await arrive(
      mail({ to: [to(inbox.name)], from: `support-${id}@lovarank.test`, subject: 'Re: Same' }),
    )
    assert.equal(own!.route, 'own_copy')
    const [testMail] = await arrive(
      mail({
        to: [to(inbox.name)],
        from: 'noreply@mails.brigade.test',
        headers: { 'x-brigade-test': 'x' },
      }),
    )
    assert.equal(testMail!.route, 'test')
  })

  test('a conversation that keeps waking threads is a loop: the next mail stays in the box', async () => {
    const session = await thread('member')
    const db = scoped(a)
    const address = await db.mailAddress.findFirstOrThrow({ where: { teammateId: riley.id } })
    for (let i = 0; i < 8; i++)
      await prisma.mailMessage.create({
        data: {
          ...a,
          addressId: address.id,
          box: `${address.id}:-`,
          direction: 'in',
          status: 'done',
          conversationId: 'conv-loop',
          fromAddress: 'bot@outside.test',
          messageId: `<loop-${i}@x.test>`,
          sessionId: session.id,
          route: 'awaited',
        },
      })
    const [row] = await arrive(
      mail({
        to: [to(base())],
        from: 'bot@outside.test',
        headers: { 'in-reply-to': '<loop-7@x.test>' },
      }),
    )
    assert.equal(row!.conversationId, 'conv-loop')
    assert.equal(row!.route, 'loop')
  })
})

describe('sending', { skip }, () => {
  test('checks: recipients of the conversation only, no secret, no second answer after a person’s', async () => {
    const db = scoped(a)
    const session = await thread('member')
    const address = await db.mailAddress.findFirstOrThrow({
      where: { teammateId: riley.id },
      include: { domain: true },
    })
    const box = `${address.id}:-`
    const original = await prisma.mailMessage.create({
      data: {
        ...a,
        addressId: address.id,
        box,
        direction: 'in',
        status: 'done',
        conversationId: 'conv-check',
        fromAddress: 'client@outside.test',
        to: [`${base()}@mails.brigade.test`],
        messageId: '<c1@x.test>',
        subject: 'Help',
        receivedAt: new Date(Date.now() - 60_000),
      },
    })
    const check = (draft: Partial<Parameters<typeof outbound.checkDraft>[1]['draft']>) =>
      outbound.checkDraft(db, {
        address,
        thread: { ...session, projectId: null },
        draft: {
          to: ['client@outside.test'],
          subject: '',
          text: 'Here you go',
          replyTo: original.id,
          ...draft,
        },
      })
    assert.equal(await check({}), null)
    assert.match((await check({ to: ['someone@else.test'] })) ?? '', /not in this conversation/)
    assert.equal(await check({ to: ['someone@else.test'], newRecipients: true }), null)
    assert.match(
      (await check({ text: 'key: sk_live_0123456789abcdef' })) ?? '',
      /Stripe secret key/,
    )
    await prisma.mailMessage.create({
      data: {
        ...a,
        addressId: address.id,
        box,
        direction: 'in',
        status: 'done',
        conversationId: 'conv-check',
        fromAddress: 'support@lovarank.test',
        route: 'own_copy',
        subject: 'Re: Help',
      },
    })
    assert.match((await check({})) ?? '', /already replied/)
  })

  test('a mail can be cancelled in its window, not after', async () => {
    const db = scoped(a)
    const session = await thread('member')
    const address = await db.mailAddress.findFirstOrThrow({
      where: { teammateId: riley.id },
      include: { domain: true },
    })
    const sent = await outbound.sendDraft(db, a, {
      address,
      thread: { ...session, projectId: null },
      teammateId: riley.id,
      draft: { to: [adaEmail], subject: 'Note', text: 'For you' },
      callId: randomUUID(),
    })
    assert.deepEqual(
      await outbound.cancelMail(db, a, sent.id, { type: 'member', id: members[0]! }),
      { cancelled: true },
    )
    assert.equal(resend.cancelled.length, 1)
    await assert.rejects(
      outbound.cancelMail(db, a, sent.id, { type: 'member', id: members[0]! }),
      /cannot be cancelled/,
    )
  })

  test('a mail set for later leaves then, can be cancelled until then, and is followed from then', async () => {
    const db = scoped(a)
    const session = await thread('member')
    const address = await db.mailAddress.findFirstOrThrow({
      where: { teammateId: riley.id },
      include: { domain: true },
    })
    const send = (sendAt: Date) =>
      outbound.sendDraft(db, a, {
        address,
        thread: { ...session, projectId: null },
        teammateId: riley.id,
        draft: { to: ['partner@outside.test'], subject: 'Monday', text: 'See you', sendAt },
        callId: randomUUID(),
      })
    const monday = new Date(Date.now() + 3 * 86_400_000)
    const before = resend.sent.length
    const sent = await send(monday)
    assert.equal(sent.sendAt.toISOString(), monday.toISOString())
    assert.equal(resend.sent[before]!.body.scheduled_at, monday.toISOString())
    // Its replies are followed from when it leaves, not from now.
    assert.ok(sent.watch && sent.watch.until.getTime() > monday.getTime() + 86_400_000)
    // A time already past leaves in its window to cancel, as one sent now.
    const late = await send(new Date(Date.now() - 60_000))
    assert.ok(late.sendAt.getTime() > Date.now() + 20_000)
    assert.ok(late.sendAt.getTime() < Date.now() + 31_000)
    // Days later, still cancelled.
    assert.deepEqual(
      await outbound.cancelMail(db, a, sent.id, { type: 'member', id: members[0]! }),
      { cancelled: true },
    )
    // Further than Resend holds mail: refused before anyone is asked.
    assert.match(
      (await outbound.checkDraft(db, {
        address,
        thread: { ...session, projectId: null },
        draft: {
          to: ['partner@outside.test'],
          subject: 'Too far',
          text: 'Next year',
          sendAt: new Date(Date.now() + 40 * 86_400_000),
        },
      })) ?? '',
      /up to 30 days ahead/,
    )
  })
})

describe('the webhook route', { skip }, () => {
  test('Resend’s signed delivery is kept; an unsigned one is refused', async () => {
    const { events } = await import('../src/routes/events.js')
    const event = mail({ to: [`${base()}@mails.brigade.test`], subject: 'Through the route' })
    const body = JSON.stringify({
      type: 'email.received',
      created_at: new Date().toISOString(),
      data: event,
    })
    const ts = String(Math.floor(Date.now() / 1000))
    const signature = `v1,${createHmac('sha256', Buffer.from(WEBHOOK_KEY, 'base64')).update(`msg_x.${ts}.${body}`).digest('base64')}`
    const refused = await events.request('/resend', {
      method: 'POST',
      body,
      headers: { 'svix-id': 'msg_x', 'svix-timestamp': ts, 'svix-signature': 'v1,AAAA' },
    })
    assert.equal(refused.status, 401)
    const ok = await events.request('/resend', {
      method: 'POST',
      body,
      headers: { 'svix-id': 'msg_x', 'svix-timestamp': ts, 'svix-signature': signature },
    })
    assert.equal(ok.status, 200)
    assert.equal(await prisma.mailMessage.count({ where: { resendId: event.email_id } }), 1)
  })
})

describe('rules on any mailbox', { skip }, () => {
  test('a conversation a person took over stays theirs: the event waits there, no thread starts', async () => {
    const db = scoped(a)
    const address = await db.mailAddress.findFirstOrThrow({ where: { teammateId: riley.id } })
    const rule = await prisma.trigger.create({
      data: {
        ...a,
        connectionId: address.connectionId!,
        teammateId: riley.id,
        label: 'Support',
        event: 'email_received',
        createdByMemberId: members[0]!,
      },
    })
    const held = await thread('trigger', {
      triggerId: rule.id,
      conversationKey: 'conv-held',
      controlledByMemberId: members[0]!,
    })
    const before = await prisma.session.count({ where: { triggerId: rule.id } })
    const got = await deliver(
      {
        ...rule,
        teammate: await prisma.teammate.findUniqueOrThrow({ where: { id: riley.id } }),
        connection: await prisma.connection.findUniqueOrThrow({
          where: { id: address.connectionId! },
        }),
      },
      {
        eventId: `evt-${randomUUID()}`,
        eventType: 'email',
        title: 'Re: help',
        text: 'The customer answered',
        conversationKey: 'conv-held',
        mailbox: true,
      },
    )
    assert.deepEqual(got, { ok: true, threadId: held.id, paused: true })
    assert.equal(await prisma.session.count({ where: { triggerId: rule.id } }), before)
    const waiting = await prisma.wakeup.findFirstOrThrow({
      where: { sessionId: held.id, status: 'pending' },
    })
    assert.equal(waiting.note, 'The customer answered')
    await prisma.trigger.delete({ where: { id: rule.id } })
  })

  test('a mailbox rule past its threads for the day leaves the mail and tells a person once', async () => {
    const db = scoped(a)
    const address = await db.mailAddress.findFirstOrThrow({ where: { teammateId: riley.id } })
    const rule = await prisma.trigger.create({
      data: {
        ...a,
        connectionId: address.connectionId!,
        teammateId: riley.id,
        label: 'Capped',
        event: 'email_received',
        options: { perDay: '1' },
        createdByMemberId: members[0]!,
      },
    })
    await thread('trigger', { triggerId: rule.id, conversationKey: 'conv-cap-0' })
    const full = {
      ...rule,
      teammate: await prisma.teammate.findUniqueOrThrow({ where: { id: riley.id } }),
      connection: await prisma.connection.findUniqueOrThrow({
        where: { id: address.connectionId! },
      }),
    }
    for (let i = 1; i <= 2; i++) {
      const got = await deliver(full, {
        eventId: `evt-cap-${i}-${id}`,
        eventType: 'email',
        title: 't',
        text: 't',
        conversationKey: `conv-cap-${i}`,
        mailbox: true,
      })
      assert.ok('capped' in got)
    }
    assert.equal(
      await prisma.ticket.count({
        where: { ...a, payload: { path: ['capOfTriggerId'], equals: rule.id } },
      }),
      1,
    )
    await prisma.trigger.delete({ where: { id: rule.id } })
  })
})

describe('races and boundaries', { skip }, () => {
  test('email_wait must return the email it consumes', async () => {
    const db = scoped(a)
    const session = await thread('member')
    const address = await db.mailAddress.findFirstOrThrow({ where: { teammateId: riley.id } })
    const alias = await addresses.newAlias(db, {
      address,
      projectId: null,
      sessionId: session.id,
      teammateId: riley.id,
      purpose: 'race',
      waitMinutes: 10,
    })
    const { email } = await import('../src/connectors/email.js')
    const ctx = {
      scope: a,
      connectionId: address.connectionId!,
      teammateId: riley.id,
      thread: session,
      callId: randomUUID(),
      fetch: globalThis.fetch,
    }
    const waiting = email.operations.email_wait!.run(ctx as never, { seconds: 5 } as never)
    await new Promise((r) => setTimeout(r, 100))
    const delivering = arrive(
      mail({ to: [`${alias.local}@mails.brigade.test`], subject: 'wait-race' }),
    )
    const result = (await waiting) as { emails: unknown[] }
    await delivering
    assert.equal(result.emails.length, 1, 'consumed without wakeup but email_wait returned nothing')
  })

  test('reply to a different project variant must not deliver to the original project', async () => {
    const db = scoped(a)
    const address = await db.mailAddress.findFirstOrThrow({ where: { teammateId: riley.id } })
    const session = await thread('member', { projectId })
    const p2 = await db.project.create({ data: { name: `Other ${id}` } as never })
    const slug = await addresses.projectSlug(db, p2.id)
    const original = await db.mailMessage.create({
      data: {
        addressId: address.id,
        projectId,
        box: `${address.id}:${projectId}`,
        direction: 'out',
        status: 'sent',
        conversationId: `cross-${id}`,
        messageId: `<cross-${id}@x.test>`,
        fromAddress: `${base()}.lovarank@mails.brigade.test`,
        text: 'original',
        sessionId: session.id,
      } as never,
    })
    await db.replyWatch.create({
      data: {
        sessionId: session.id,
        teammateId: riley.id,
        connectionId: address.connectionId!,
        conversationKey: original.conversationId,
        to: 'x',
        subject: 'x',
        until: new Date(Date.now() + 3600000),
      } as never,
    })
    const [row] = await arrive(
      mail({
        to: [`${base()}.${slug}@mails.brigade.test`],
        subject: 'Private other-project message',
        headers: { 'in-reply-to': original.messageId! },
      }),
    )
    assert.notEqual(
      row!.sessionId,
      session.id,
      'other project body delivered to original project thread',
    )
  })

  test('two concurrently delivered copies must only wake one thread', async () => {
    const db = scoped(a)
    const address = await db.mailAddress.findFirstOrThrow({ where: { teammateId: riley.id } })
    const sessions = await Promise.all([thread(), thread()])
    const alias = await addresses.newAlias(db, {
      address,
      projectId: null,
      sessionId: sessions[0]!.id,
      teammateId: riley.id,
      purpose: 'concurrent',
      waitMinutes: 10,
    })
    const inbox = await addresses.createInbox(db, ws(a), { projectId, label: 'Race' })
    await db.replyWatch.create({
      data: {
        sessionId: sessions[1]!.id,
        teammateId: riley.id,
        connectionId: inbox.connectionId!,
        conversationKey: `race-${id}`,
        to: 'x',
        subject: 'x',
        until: new Date(Date.now() + 3600000),
      } as never,
    })
    const common = {
      direction: 'in',
      status: 'pending',
      messageId: `<race-${id}@x.test>`,
      fromAddress: 'stranger@outside.test',
      text: 'pre-read race',
      subject: 'race',
      conversationId: `race-${id}`,
      sender: 'unknown',
    }
    const rows = await Promise.all([
      db.mailMessage.create({
        data: {
          ...common,
          addressId: address.id,
          box: `${address.id}:-`,
          aliasId: alias.id,
        } as never,
      }),
      db.mailMessage.create({
        data: { ...common, addressId: inbox.id, box: `${inbox.id}:-` } as never,
      }),
    ])
    await Promise.all(rows.map((row) => inbound.processMail(row.id)))
    const delivered = await db.mailMessage.count({
      where: { id: { in: rows.map((r) => r.id) }, sessionId: { not: null } },
    })
    assert.equal(delivered, 1, 'both copies of one Message-ID woke different threads')
  })
})

describe('who may do what', { skip }, () => {
  test('a valid DKIM signature with failed DMARC must not impersonate a member', async () => {
    const { senderOf } = await import('../src/mail/identity.js')
    const sender = await senderOf(scoped(a), a, adaEmail, 'Forged', { dkim: 'pass', dmarc: 'fail' })
    assert.notEqual(
      sender.kind,
      'member',
      'unrelated-domain DKIM can pass while the From address is forged',
    )
  })
  test('a different member must not prompt an owners private thread by email', async () => {
    const db = scoped(a)
    const member = await prisma.member.upsert({
      where: { id: `mem-review-${id}` },
      create: {
        id: `mem-review-${id}`,
        organizationId: a.organizationId,
        userId: users[1]!,
        role: 'member',
      },
      update: {},
    })
    const session = await thread('member', { othersMayPrompt: false })
    const address = await db.mailAddress.findFirstOrThrow({
      where: { teammateId: riley.id },
      include: { connection: true },
    })
    const { memberRequestThread } = await import('../src/mail/member-mail.js')
    const old = await db.teammate.findFirstOrThrow({ where: { id: riley.id } })
    // A cap makes prompting observable without needing a running computer.
    await db.teammate.update({
      where: { id: riley.id },
      data: { caps: { computerHoursPerDay: 0 } },
    })
    try {
      const result = await memberRequestThread(
        db,
        a,
        {
          id: 'review-auth',
          resendId: null,
          addressId: address.id,
          projectId: null,
          subject: 'private reply',
          text: 'Do this with your private Apps',
          inReplyTo: '<private@x.test>',
          fromAddress: `bob-${id}@acme.test`,
          attachments: [],
          address,
        },
        { kind: 'member', memberId: member.id, line: 'Bob' },
        session.id,
      )
      assert.equal(
        result,
        null,
        'another member prompted the owners thread and created a cap ticket',
      )
    } finally {
      await db.teammate.update({ where: { id: riley.id }, data: { caps: old.caps as never } })
    }
  })
  test('existing conversation must beat a newly matching earlier rule', async () => {
    const db = scoped(a)
    const address = await db.mailAddress.findFirstOrThrow({
      where: { teammateId: riley.id },
      include: { connection: true },
    })
    const make = (label: string, position: number, options: object) =>
      db.trigger.create({
        data: {
          connectionId: address.connectionId!,
          teammateId: riley.id,
          createdByMemberId: members[0]!,
          event: 'email_received',
          label,
          position,
          options,
        } as never,
      })
    const first = await make('Urgent', 0, { subject: 'urgent' })
    const rest = await make('Rest', 1, {})
    const held = await thread('trigger', {
      triggerId: rest.id,
      conversationKey: 'rule-priority',
      controlledByMemberId: members[0]!,
    })
    const { dispatch } = await import('../src/triggers.js')
    try {
      const result = await dispatch(address.connection!, {
        id: randomUUID(),
        type: 'email',
        payload: {
          id: randomUUID(),
          threadId: 'rule-priority',
          projectId: null,
          subject: 'Now urgent',
          from: 'client@outside.test',
          to: 'x',
          body: 'Please respond',
          labels: [],
        },
      })
      assert.equal(
        result.threadId,
        held.id,
        'the first rule took a conversation already controlled in the second rules thread',
      )
    } finally {
      await db.trigger.deleteMany({ where: { id: { in: [first.id, rest.id] } } })
    }
  })
})

describe('offline computers', { skip }, () => {
  test('member mail to an offline laptop must remain pending for delivery', async () => {
    const [row] = await arrive(
      mail({
        to: [`${base()}@mails.brigade.test`],
        from: adaEmail,
        subject: 'Offline request',
        dkim: 'pass',
      }),
    )
    assert.equal(
      row!.status,
      'pending',
      'member mail was marked done/box although its created thread failed offline',
    )
  })
})

describe('rule preview privacy', { skip }, () => {
  test('a regular member must not preview someone elses personal Gmail', async () => {
    const db = scoped(a)
    // A regular member of A (the test before may have made it already).
    await prisma.member.upsert({
      where: { id: `mem-review-${id}` },
      create: {
        id: `mem-review-${id}`,
        organizationId: a.organizationId,
        userId: users[1]!,
        role: 'member',
      },
      update: {},
    })
    const { appFor } = await import('../src/apps.js')
    const { sealSecret } = await import('../src/vault.js')
    const { auth } = await import('../src/auth.js')
    const { email } = await import('../src/routes/email.js')
    const app = await appFor(db, ws(a), 'gmail')
    const connection = await db.connection.create({
      data: {
        appId: app.id,
        kind: 'gmail',
        label: 'Private',
        externalAccount: adaEmail,
        reach: 'mine',
        createdByMemberId: members[0]!,
        vaultSecretId: await sealSecret(db, a, {
          accessToken: 'test-only',
          refreshToken: 'test-only',
          expiresAt: Date.now() + 3600000,
        }),
      } as never,
    })
    const realSession = auth.api.getSession
    const previousFetch = globalThis.fetch
    ;(auth.api as any).getSession = async () => ({
      user: { id: users[1]! },
      session: {
        id: 'test-session',
        activeOrganizationId: a.organizationId,
        activeWorkspaceId: a.workspaceId,
      },
    })
    globalThis.fetch = (async () =>
      json({
        messages: [{ id: 'private-email' }],
        id: 'private-email',
        threadId: 'private-conversation',
        payload: {
          headers: [
            { name: 'From', value: 'private@outside.test' },
            { name: 'Subject', value: 'Confidential owner mail' },
          ],
        },
      })) as typeof fetch
    try {
      const result = await email.request('/rules/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId: connection.id, options: {} }),
      })
      const body = await result.text()
      assert.equal(result.status, 403, body)
    } finally {
      ;(auth.api as any).getSession = realSession
      globalThis.fetch = previousFetch
    }
  })
})

describe('a conversation’s thread that cannot take more now', { skip }, () => {
  test('a sixth follow-up waits in the box: no new thread, no rule', async () => {
    const db = scoped(a)
    const address = await db.mailAddress.findFirstOrThrow({ where: { teammateId: riley.id } })
    const controlled = await thread('member', { controlledByMemberId: members[0]! })
    const original = await db.mailMessage.create({
      data: {
        addressId: address.id,
        box: `${address.id}:-`,
        direction: 'in',
        status: 'done',
        fromAddress: adaEmail,
        text: 'original member request',
        messageId: `<controlled-${id}@x.test>`,
        conversationId: `controlled-${id}`,
        route: 'member',
        sessionId: controlled.id,
      } as never,
    })
    await db.wakeup.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        organizationId: a.organizationId,
        workspaceId: a.workspaceId,
        sessionId: controlled.id,
        teammateId: riley.id,
        kind: 'reply',
        status: 'pending',
        note: `previous follow-up ${i}`,
        wakeAt: new Date(),
        sourceId: `prior-controlled-${id}-${i}`,
      })) as never,
    })
    const old = await db.teammate.findFirstOrThrow({ where: { id: riley.id } })
    // Make a new thread observable without connecting a runner: its initial prompt hits a cap.
    await db.teammate.update({
      where: { id: riley.id },
      data: { caps: { computerHoursPerDay: 0 } },
    })
    const before = await prisma.session.count({ where: { ...a } })
    try {
      const [row] = await arrive(
        mail({
          to: [`${base()}@mails.brigade.test`],
          from: adaEmail,
          dkim: 'pass',
          subject: 'Sixth follow-up while a person controls the conversation',
          headers: { 'in-reply-to': original.messageId! },
        }),
      )
      assert.equal(row!.route, 'box')
      assert.equal(row!.sessionId, null)
      assert.equal(await prisma.session.count({ where: { ...a } }), before)
    } finally {
      await db.teammate.update({ where: { id: riley.id }, data: { caps: old.caps as never } })
    }
  })
})

describe('the workspace’s own domains, and mailboxes’ addresses on them', { skip }, () => {
  test('a domain receives directly or by forwarding; any mailbox writes as its address there, never as Brigade’s', async () => {
    const db = scoped(a)
    const { auth } = await import('../src/auth.js')
    const { email } = await import('../src/routes/email.js')
    const { senderOfBox } = await import('../src/mail/addresses.js')
    const realSession = auth.api.getSession
    const previousFetch = globalThis.fetch
    ;(auth.api as any).getSession = async () => ({
      user: { id: users[0]! },
      session: {
        id: 'test-session',
        activeOrganizationId: a.organizationId,
        activeWorkspaceId: a.workspaceId,
      },
    })
    const forward = `forward-${id}.test`
    const direct = `direct-${id}.test`
    const refused = `refused-${id}.test`
    const mx: Record<string, string[]> = {
      [forward]: ['1 smtp.google.com.'],
      [refused]: [],
      [direct]: [],
    }
    const created: { name: string; receiving: string }[] = []
    const removed: string[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname === 'cloudflare-dns.com')
        return json({
          Status: 0,
          Answer: (mx[url.searchParams.get('name')!] ?? []).map((data) => ({ type: 15, data })),
        })
      if (url.pathname === '/domains' && init?.method !== 'GET') {
        const body = JSON.parse(String(init?.body)) as {
          name: string
          capabilities: { receiving: string }
        }
        if (body.name === refused)
          return json({ name: 'validation_error', message: 'Domain already exists' }, 422)
        created.push({ name: body.name, receiving: body.capabilities.receiving })
        return json({ id: `dom-${body.name}`, name: body.name, status: 'not_started', records: [] })
      }
      if (url.pathname.startsWith('/domains/') && init?.method === 'DELETE') {
        removed.push(url.pathname)
        return json({ id: url.pathname.split('/')[2] })
      }
      // The rest of Resend (reading a received mail): the suite's own fake.
      return previousFetch(input, init)
    }) as typeof fetch
    const call = (path: string, method = 'GET', body?: unknown) =>
      email.request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    try {
      // Where its mail goes now says how Brigade receives it.
      const looked = (await (await call(`/domains/lookup?name=${forward}`)).json()) as {
        suggested: string
        mx: string[]
      }
      assert.deepEqual([looked.suggested, looked.mx], ['forward', ['smtp.google.com']])
      assert.equal(
        ((await (await call(`/domains/lookup?name=${direct}`)).json()) as { suggested: string })
          .suggested,
        'direct',
      )
      // Receiving directly would take a provider's mail away: refused.
      assert.equal(
        (await call('/domains', 'POST', { name: forward, receiving: 'direct' })).status,
        400,
      )
      assert.equal((await call('/domains', 'POST', { name: 'mails.brigade.test' })).status, 400)
      assert.equal((await call('/domains', 'POST', { name: refused })).status, 409)
      assert.equal((await call('/domains', 'POST', { name: forward })).status, 201)
      assert.equal((await call('/domains', 'POST', { name: direct })).status, 201)
      assert.equal((await call('/domains', 'POST', { name: forward })).status, 409)
      assert.deepEqual(created, [
        { name: forward, receiving: 'disabled' },
        { name: direct, receiving: 'enabled' },
      ])

      // An agent's address on a domain: not before it is added, then its own.
      const rileys = await db.mailAddress.findFirstOrThrow({ where: { teammateId: riley.id } })
      const setAddress = (address: string | null) =>
        call(`/addresses/${rileys.id}`, 'PATCH', { address })
      const unknown = await setAddress(`riley@unknown-${id}.test`)
      assert.equal(unknown.status, 400)
      assert.match(await unknown.text(), /Add unknown-.* first/)
      assert.equal((await setAddress(`riley@${direct}`)).status, 200)

      // It writes as it only: until its domain is verified, nothing goes out.
      const load = () =>
        db.mailAddress.findFirstOrThrow({ where: { id: rileys.id }, include: { domain: true } })
      await assert.rejects(senderOfBox(db, await load(), projectId), /cannot send yet/)
      await db.mailDomain.updateMany({ where: { name: direct }, data: { status: 'verified' } })
      assert.equal((await senderOfBox(db, await load(), projectId)).address, `riley@${direct}`)

      // Mail to it on a direct domain arrives in its mailbox; on a forwarded one, only through
      // the forward (to its address on Brigade's domain).
      const [arrived] = await arrive(mail({ to: [`riley@${direct}`], subject: 'Direct' }))
      assert.equal(arrived?.addressId, rileys.id)
      const notForwarded = mail({ to: [`riley@${forward}`] })
      assert.equal(await inbound.received(notForwarded), 0)

      // A shared mailbox on a domain not added: refused before anything is made.
      const inboxes = () => db.mailAddress.count({ where: { kind: 'inbox', projectId } })
      const before = await inboxes()
      const notAdded = await call('/inboxes', 'POST', {
        projectId,
        label: 'Support',
        publicAddress: `support@unknown-${id}.test`,
      })
      assert.equal(notAdded.status, 400)
      assert.equal(await inboxes(), before)
      // A turned-off mailbox kept its address: a new one takes it.
      const old = await addresses.createInbox(db, ws(a), { projectId, label: 'Old' })
      await db.mailAddress.updateMany({
        where: { id: old.id },
        data: { publicAddress: `help@${forward}`, releasedAt: new Date() },
      })
      const made = await call('/inboxes', 'POST', {
        projectId,
        label: 'Help',
        publicAddress: `help@${forward}`,
      })
      const body = (await made.json()) as { id: string; publicAddress: string }
      assert.equal(made.status, 201, JSON.stringify(body))
      assert.equal(body.publicAddress, `help@${forward}`)
      assert.equal(
        (await db.mailAddress.findFirstOrThrow({ where: { id: old.id } })).publicAddress,
        null,
      )

      // A domain goes only once no mailbox has an address on it.
      const domains = (await (await call('/domains')).json()) as { id: string; name: string }[]
      const directRow = domains.find((d) => d.name === direct)!
      assert.equal((await call(`/domains/${directRow.id}`, 'DELETE')).status, 409)
      assert.equal((await setAddress(null)).status, 200)
      assert.equal((await call(`/domains/${directRow.id}`, 'DELETE')).status, 204)
      assert.deepEqual(removed, [`/domains/dom-${direct}`])
    } finally {
      ;(auth.api as any).getSession = realSession
      globalThis.fetch = previousFetch
    }
  })
  test('replies come back to the project that wrote, a domain only claimed receives nothing, and DNS or Resend failing changes nothing', async () => {
    const db = scoped(a)
    const domains = await import('../src/mail/domains.js')
    const previousFetch = globalThis.fetch
    const name = `replies-${id}.test`
    const claimed = `claimed-${id}.test`
    let deleting: 'fails' | 'gone' | 'ok' = 'fails'
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname === 'cloudflare-dns.com') {
        const asked = url.searchParams.get('name')!
        return json({
          Status: asked.startsWith('servfail-') ? 2 : asked.startsWith('nx-') ? 3 : 0,
          Answer: [],
        })
      }
      if (url.pathname === '/domains' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { name: string }
        return json({ id: `dom-${body.name}`, name: body.name, status: 'not_started', records: [] })
      }
      if (url.pathname.startsWith('/domains/') && init?.method === 'DELETE') {
        if (deleting === 'fails') throw new Error('Resend unreachable')
        if (deleting === 'gone') return json({ message: 'Domain not found' }, 404)
        return json({ id: url.pathname.split('/')[2] })
      }
      return previousFetch(input, init)
    }) as typeof fetch
    try {
      // A resolver's failure is not a domain without mail: nothing is suggested from it.
      await assert.rejects(domains.lookupDomain(`servfail-${id}.test`), /DNS could not be read/)
      await assert.rejects(domains.lookupDomain(`nx-${id}.test`), /not in DNS/)

      // Riley writes from a Lovarank thread as riley@ its domain; the reply, to that one address
      // with no project, goes back to Lovarank's conversation and its thread.
      await domains.addDomain(db, ws(a), { name, receiving: 'direct' })
      await db.mailDomain.updateMany({ where: { name }, data: { status: 'verified' } })
      const rileys = await db.mailAddress.findFirstOrThrow({ where: { teammateId: riley.id } })
      await domains.setPublicAddress(db, ws(a), rileys.id, `riley@${name}`)
      const address = await db.mailAddress.findFirstOrThrow({
        where: { id: rileys.id },
        include: { domain: true },
      })
      const session = await thread('member', { projectId })
      const write = async (subject: string, messageId: string) => {
        const sent = await outbound.sendDraft(db, a, {
          address,
          thread: session,
          teammateId: riley.id,
          draft: { to: ['partner@outside.test'], subject, text: 'Shall we?' },
          callId: randomUUID(),
        })
        const out = await prisma.mailMessage.findUniqueOrThrow({ where: { id: sent.id } })
        assert.equal(out.fromAddress, `riley@${name}`)
        await outbound.statusChanged('email.sent', {
          email_id: out.resendId!,
          message_id: messageId,
        })
        return out
      }
      const first = await write('Directly', `<direct-${id}@ses.test>`)
      const [direct] = await arrive(
        mail({
          to: [`riley@${name}`],
          from: 'partner@outside.test',
          subject: 'Re: Directly',
          headers: { 'in-reply-to': `<direct-${id}@ses.test>` },
        }),
      )
      assert.deepEqual(
        [direct!.projectId, direct!.box, direct!.conversationId, direct!.sessionId],
        [projectId, first.box, first.conversationId, session.id],
      )
      // Forwarded to its address on Brigade's domain: the same.
      const second = await write('Forwarded', `<forwarded-${id}@ses.test>`)
      const [forwarded] = await arrive(
        mail({
          to: [`${rileys.name}@mails.brigade.test`],
          from: 'partner@outside.test',
          subject: 'Re: Forwarded',
          headers: { references: `<forwarded-${id}@ses.test>` },
        }),
      )
      assert.deepEqual(
        [forwarded!.projectId, forwarded!.conversationId, forwarded!.sessionId],
        [projectId, second.conversationId, session.id],
      )
      // New mail to it answers nothing: no project.
      const [fresh] = await arrive(mail({ to: [`riley@${name}`], subject: 'Hello' }))
      assert.equal(fresh!.projectId, null)

      // A domain claimed but never verified gets no copy of mail that only names its address.
      await domains.addDomain(db, ws(a), { name: claimed, receiving: 'direct' })
      const desk = await addresses.createInbox(db, ws(a), { projectId, label: 'Desk' })
      await domains.setPublicAddress(db, ws(a), desk.id, `desk@${claimed}`)
      const named = await arrive(
        mail({ to: [`${rileys.name}@mails.brigade.test`, `desk@${claimed}`], subject: 'Both' }),
      )
      assert.deepEqual(
        named.map((m) => m.addressId),
        [rileys.id],
      )
      assert.equal(await inbound.received(mail({ to: [`desk@${claimed}`] })), 0)

      // Resend not removing a domain leaves it here, to try again; gone there already, it goes.
      const claimedRow = await db.mailDomain.findFirstOrThrow({ where: { name: claimed } })
      await domains.setPublicAddress(db, ws(a), desk.id, null)
      await assert.rejects(domains.removeDomain(db, ws(a), claimedRow.id), /try again/)
      assert.ok(await db.mailDomain.findFirst({ where: { id: claimedRow.id } }))
      deleting = 'gone'
      await domains.removeDomain(db, ws(a), claimedRow.id)
      assert.equal(await db.mailDomain.findFirst({ where: { id: claimedRow.id } }), null)

      await domains.setPublicAddress(db, ws(a), rileys.id, null)
    } finally {
      globalThis.fetch = previousFetch
    }
  })
  test('a domain another workspace added is theirs once verified, for three days, or while its records are in its DNS; else it is taken from them, a claim at a time', async () => {
    const domains = await import('../src/mail/domains.js')
    const previousFetch = globalThis.fetch
    const name = `taken-${id}.test`
    const dkim = `resend._domainkey.${name}`
    let txt: { Status: number; Answer?: { type: number; data: string }[] } = { Status: 3 }
    let deleting: 'fails' | 'pauses' | 'ok' = 'ok'
    // Resend's DELETE held until the test lets it go.
    const holdDelete = () => ({
      paused: Promise.withResolvers<void>(),
      resume: Promise.withResolvers<void>(),
    })
    let gate = holdDelete()
    const removed: string[] = []
    let resendSays = 'pending'
    const records = [
      {
        record: 'DKIM',
        type: 'TXT',
        name: 'resend._domainkey',
        value: 'p=KEY A',
        status: 'pending',
      },
    ]
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname === 'cloudflare-dns.com')
        return json(url.searchParams.get('name') === dkim ? txt : { Status: 0, Answer: [] })
      const domain = /^\/domains\/([^/]+)/.exec(url.pathname)?.[1]
      if (url.pathname === '/domains' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { name: string }
        return json({
          id: `dom-${body.name}-${removed.length}`,
          name: body.name,
          status: 'not_started',
          records,
        })
      }
      if (domain && url.pathname.endsWith('/verify')) return json({ id: domain })
      if (domain && init?.method === 'DELETE') {
        if (deleting === 'fails') throw new Error('Resend unreachable')
        if (deleting === 'pauses') {
          gate.paused.resolve()
          await gate.resume.promise
        }
        removed.push(domain)
        return json({ id: domain })
      }
      if (domain) return json({ id: domain, status: resendSays, records })
      return previousFetch(input, init)
    }) as typeof fetch
    try {
      const dbA = scoped(a)
      const dbB = scoped(b)
      const first = await domains.addDomain(dbA, ws(a), { name, receiving: 'direct' })
      const desk = await addresses.createInbox(dbA, ws(a), { projectId, label: 'Taken' })
      await domains.setPublicAddress(dbA, ws(a), desk.id, `desk@${name}`)
      const status = async () =>
        (await prisma.mailDomain.findUnique({ where: { id: first.id } }))?.status
      // As it was (its check, started for A when its key was found, may have made it pending).
      const asItWas = async () => assert.ok(['failed', 'pending'].includes((await status())!))
      // Within its three days: A's.
      await assert.rejects(domains.addDomain(dbB, ws(b), { name }), /has until .* to verify it/)
      await prisma.mailDomain.updateMany({
        where: { id: first.id },
        data: { createdAt: new Date(Date.now() - 4 * 86_400_000), status: 'failed' },
      })
      // Past them, but A's DKIM key is in its DNS (split in quoted strings, as TXT is): A's,
      // given back as it was.
      txt = { Status: 0, Answer: [{ type: 16, data: '"p=KEY" " A"' }] }
      await assert.rejects(domains.addDomain(dbB, ws(b), { name }), /it is theirs/)
      await asItWas()
      // DNS failing proves nothing either way: nothing is taken.
      txt = { Status: 2 }
      await assert.rejects(domains.addDomain(dbB, ws(b), { name }), /DNS could not be read/)
      await asItWas()
      // Resend not removing it: nothing is taken.
      txt = { Status: 3 }
      deleting = 'fails'
      await assert.rejects(domains.addDomain(dbB, ws(b), { name }), /try again/)
      await asItWas()
      // Verified meanwhile by A's own check: A's for good.
      resendSays = 'verified'
      await domains.checkDomain(dbA, first.id)
      deleting = 'ok'
      await assert.rejects(domains.addDomain(dbB, ws(b), { name }), /used by another workspace/)
      assert.equal(removed.length, 0)

      // A takeover under way holds its claim: A's check cannot mark it verified meanwhile, a
      // second workspace's add cannot start another, and no mailbox of A's gets an address on it.
      await prisma.mailDomain.updateMany({ where: { id: first.id }, data: { status: 'pending' } })
      const late = await addresses.createInbox(dbA, ws(a), { projectId, label: 'Late' })
      deleting = 'pauses'
      const taking = domains.addDomain(dbB, ws(b), { name })
      await gate.paused.promise
      await assert.rejects(domains.checkDomain(dbA, first.id), /being taken over/)
      assert.equal(await status(), 'claimed')
      await assert.rejects(domains.addDomain(dbB, ws(b), { name }), /used by another workspace/)
      await assert.rejects(
        domains.setPublicAddress(dbA, ws(a), late.id, `late@${name}`),
        /being taken over/,
      )
      // One given just before the claim, still being written: it goes with the domain.
      await prisma.mailAddress.update({
        where: { id: late.id },
        data: { publicAddress: `late@${name}`, domainId: first.id },
      })
      gate.resume.resolve()
      const taken = await taking
      assert.equal(taken.workspaceId, b.workspaceId)
      assert.deepEqual(removed, [first.resendDomainId])
      assert.equal(await status(), undefined)
      for (const mailbox of [desk.id, late.id]) {
        const lost = await prisma.mailAddress.findUniqueOrThrow({ where: { id: mailbox } })
        assert.deepEqual([lost.publicAddress, lost.domainId], [null, null])
      }
      // One written after its domain went cannot point at it.
      await assert.rejects(
        prisma.mailAddress.update({
          where: { id: late.id },
          data: { publicAddress: `late@${name}`, domainId: first.id },
        }),
      )
      // B gets the address A's mailbox had.
      const bDesk = await addresses.createInbox(dbB, ws(b), {
        projectId: (await prisma.project.create({ data: { ...b, name: 'Taker' } })).id,
        label: 'Desk',
      })
      await domains.setPublicAddress(dbB, ws(b), bDesk.id, `late@${name}`)
      assert.ok(
        await prisma.auditEntry.findFirst({
          where: { workspaceId: a.workspaceId, action: 'email.domain.taken_over' },
        }),
      )
      await domains.setPublicAddress(dbB, ws(b), bDesk.id, null)
      await domains.removeDomain(dbB, ws(b), taken.id)

      // A takeover whose claim ran out while Resend held it (its call is bounded well within it,
      // so this models a stopped clock) settles nothing: the domain A verified meanwhile stays A's,
      // with its mailbox's address.
      const kept = `kept-${id}.test`
      resendSays = 'pending'
      deleting = 'ok'
      const second = await domains.addDomain(dbA, ws(a), { name: kept, receiving: 'direct' })
      await domains.setPublicAddress(dbA, ws(a), desk.id, `desk@${kept}`)
      await prisma.mailDomain.updateMany({
        where: { id: second.id },
        data: { createdAt: new Date(Date.now() - 4 * 86_400_000) },
      })
      gate = holdDelete()
      deleting = 'pauses'
      const stale = domains.addDomain(dbB, ws(b), { name: kept })
      await gate.paused.promise
      await prisma.mailDomain.updateMany({
        where: { id: second.id },
        data: { checkedAt: new Date(Date.now() - 11 * 60_000) },
      })
      resendSays = 'verified'
      assert.equal((await domains.checkDomain(dbA, second.id)).status, 'verified')
      gate.resume.resolve()
      await assert.rejects(stale, /used by another workspace/)
      assert.equal(
        (await prisma.mailDomain.findUniqueOrThrow({ where: { id: second.id } })).status,
        'verified',
      )
      assert.equal(
        (await prisma.mailAddress.findUniqueOrThrow({ where: { id: desk.id } })).publicAddress,
        `desk@${kept}`,
      )
      await domains.setPublicAddress(dbA, ws(a), desk.id, null)
    } finally {
      gate.resume.resolve()
      globalThis.fetch = previousFetch
    }
  })
})
