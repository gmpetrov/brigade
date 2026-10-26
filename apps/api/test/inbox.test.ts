import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { handedEmail, INBOX_HANDOFF, triggerEventText } from '@brigade/contracts'
import pg from 'pg'

// Sent mail goes through a Resend played by a fake fetch; set before src/ is imported below.
process.env.RESEND_API_KEY ??= 're_inbox_test'

// The Inbox (src/inbox.ts) against a real database, with Gmail played by a fake fetch: the local
// database of apps/api/.env, in an organization of its own that it removes at the end. Without a
// database to reach, it is skipped.
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
process.env.MAIL_DOMAIN = 'mails.brigade.test'

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select "inbox" from "Connection" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { prisma, scoped } = await import('../src/db.js')
const inbox = await import('../src/inbox.js')
const { sealSecret } = await import('../src/vault.js')

const id = randomUUID().slice(0, 8)
const org = `org-inbox-${id}`
const users = [`user-inbox-a-${id}`, `user-inbox-b-${id}`]
const members = [`mem-inbox-a-${id}`, `mem-inbox-b-${id}`]
type Scope = { organizationId: string; workspaceId: string }
let scope: Scope
let riley: { id: string; name: string }
let cody: { id: string; name: string }
let projectId: string
let agent: { id: string; connectionId: string }
let support: { id: string; connectionId: string }
let gmailShared: string
let gmailBobs: string
let gmailNotListed: string
const realFetch = globalThis.fetch
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** The member asking: Ada (owner) or Bob (a regular member). */
const as = (who: 0 | 1) => ({
  ...scope,
  userId: users[who]!,
  memberId: members[who]!,
  role: who === 0 ? ('owner' as const) : ('member' as const),
})

before(async () => {
  if (skip) return
  // Gmail is not called: its mail is in Brigade, kept as its inbox reader reads it.
  globalThis.fetch = (async (input: string | URL | Request) => {
    throw new Error(`unexpected request ${String(input)}`)
  }) as typeof fetch

  await prisma.organization.create({ data: { id: org, name: 'Inbox test', slug: org } })
  for (const [i, user] of users.entries()) {
    await prisma.user.create({
      data: { id: user, name: i ? 'Bob' : 'Ada', email: `${user}@acme.test` },
    })
    await prisma.member.create({
      data: { id: members[i]!, organizationId: org, userId: user, role: i ? 'member' : 'owner' },
    })
  }
  const workspace = await prisma.workspace.create({
    data: { organizationId: org, name: 'Inbox test' },
  })
  scope = { organizationId: org, workspaceId: workspace.id }
  const db = scoped(scope)
  riley = await prisma.teammate.create({ data: { ...scope, name: 'Riley' } })
  cody = await prisma.teammate.create({ data: { ...scope, name: 'Cody' } })
  projectId = (await prisma.project.create({ data: { ...scope, name: 'Lovarank' } })).id
  const app = await db.app.create({
    data: { key: 'email', createdByMemberId: members[0] } as never,
  })
  const account = (label: string) =>
    db.connection.create({
      data: {
        appId: app.id,
        kind: 'email',
        label,
        externalAccount: label,
        createdByMemberId: members[0],
      } as never,
    })
  const a = await account('riley')
  const s = await account('support')
  const agentRow = await db.mailAddress.create({
    data: {
      name: `riley-inbox-${id}`,
      kind: 'agent',
      teammateId: riley.id,
      connectionId: a.id,
      createdByMemberId: members[0],
    } as never,
  })
  const supportRow = await db.mailAddress.create({
    data: {
      name: `support-inbox-${id}`,
      kind: 'inbox',
      projectId,
      connectionId: s.id,
      createdByMemberId: members[0],
    } as never,
  })
  agent = { id: agentRow.id, connectionId: a.id }
  support = { id: supportRow.id, connectionId: s.id }
  await db.grant.create({
    data: { teammateId: riley.id, connectionId: a.id, scope: 'read_write' } as never,
  })
  await db.grant.create({
    data: { teammateId: cody.id, connectionId: s.id, scope: 'read_write' } as never,
  })
  const gmailApp = await db.app.create({
    data: { key: 'gmail', createdByMemberId: members[0] } as never,
  })
  const gmail = async (
    reach: 'mine' | 'workspace',
    owner: string,
    address: string,
    inInbox = true,
  ) =>
    (
      await db.connection.create({
        data: {
          appId: gmailApp.id,
          kind: 'gmail',
          label: address,
          externalAccount: address,
          reach,
          inbox: inInbox,
          createdByMemberId: owner,
          vaultSecretId: await sealSecret(db, scope, {
            accessToken: 'token',
            refreshToken: 'refresh',
            expiresAt: Date.now() + 3600_000,
          }),
        } as never,
      })
    ).id
  gmailShared = await gmail('workspace', members[0]!, `support-${id}@acme.test`)
  gmailBobs = await gmail('mine', members[1]!, `bob-${id}@acme.test`)
  gmailNotListed = await gmail('workspace', members[0]!, `ada-${id}@acme.test`, false)
  // Its latest mail, as the reader keeps it (src/mail/gmail-inbox.ts); the others' never is.
  const { keepGmail } = await import('../src/mail/gmail-inbox.js')
  for (const connectionId of [gmailShared, gmailBobs, gmailNotListed]) {
    const connection = await prisma.connection.findUniqueOrThrow({ where: { id: connectionId } })
    await keepGmail(
      connection,
      {
        id: 'g1',
        threadId: 'gt1',
        from: 'Client <client@outside.test>',
        to: connection.externalAccount ?? '',
        subject: 'Refund',
        date: new Date(Date.now() - 60_000).toUTCString(),
        snippet: 'Can I get a refund?',
        labels: ['INBOX'],
        cc: undefined,
        body: 'Can I get a refund?',
        attachments: [],
        automatic: false,
      },
      { route: 'box' },
    )
  }
})

after(async () => {
  globalThis.fetch = realFetch
  if (skip) return
  await prisma.mailAddress.deleteMany({ where: { organizationId: org } })
  await prisma.organization.deleteMany({ where: { id: org } })
  await prisma.user.deleteMany({ where: { id: { in: users } } })
  await prisma.$disconnect()
})

let n = 0
/** A received mail in a box, as the webhook and delivery leave it. */
const mail = (box: { id: string }, data: Record<string, unknown> = {}) =>
  prisma.mailMessage.create({
    data: {
      ...scope,
      addressId: box.id,
      box: `${box.id}:${(data.projectId as string | undefined) ?? '-'}`,
      direction: 'in',
      status: 'done',
      route: 'box',
      conversationId: `conv-${id}-${++n}`,
      fromAddress: 'client@outside.test',
      fromName: 'Client',
      subject: `Mail ${n}`,
      text: `Hello ${n}`,
      receivedAt: new Date(Date.now() - n * 1000),
      ...data,
    } as never,
  })

const thread = (teammateId: string, extra: Record<string, unknown> = {}) =>
  prisma.session.create({
    data: {
      ...scope,
      teammateId,
      startedByMemberId: members[0]!,
      computerId: computerFor,
      title: `Thread ${++n}`,
      status: 'idle',
      ...extra,
    } as never,
  })
let computerFor: string

// No database needed: what the thread's first message holds.
test('a long conversation handed over stays a card: oldest mails go, then the end of the words', () => {
  const event = (payload: unknown) =>
    triggerEventText({
      trigger: INBOX_HANDOFF,
      definition: 'An email a person handed over from the Inbox',
      source: 'riley@x.test',
      type: 'email',
      id: 'm1',
      received: '2026-10-25T15:43:19.606Z',
      payload,
    })
  const mail = {
    provider: 'email',
    id: 'm1',
    from: 'Client <client@x.test>',
    to: 'riley@x.test',
    subject: 'Re: Order',
    date: '2026-10-25T15:43:19.606Z',
    labels: [],
    inboxItem: 'mail:m1',
  }
  const earlier = (n: number, size: number) =>
    Array.from({ length: n }, (_, i) => ({
      from: 'client@x.test',
      date: `d${i}`,
      body: 'x'.repeat(size),
    }))
  // An earlier mail of 40,000 characters: it goes, the latest stays.
  const one = inbox.withinCap({ ...mail, body: 'Hello', earlier: earlier(2, 40_000) })
  const read = handedEmail(`Note\n\nHow\n\n${event(one)}`)
  assert.equal(read?.email.body, 'Hello')
  assert.equal(read?.item, 'mail:m1')
  assert.equal((one as { earlierLeftOut?: number }).earlierLeftOut, 2)
  // Those that fit stay, the newest.
  const some = inbox.withinCap({ ...mail, body: 'Hi', earlier: earlier(10, 8_000) }) as {
    earlier: { date: string }[]
  }
  assert.ok(some.earlier.length > 0 && some.earlier.length < 10)
  assert.equal(some.earlier.at(-1)?.date, 'd9')
  // A latest mail past the cap: cut, still a card.
  const long = inbox.withinCap({ ...mail, body: '"quoted"\n'.repeat(10_000), earlier: [] })
  const cut = handedEmail(`Note\n\nHow\n\n${event(long)}`)
  assert.ok(cut?.email.body.endsWith('[cut]'))
  // A short one is left as it was.
  assert.deepEqual(inbox.withinCap({ ...mail, body: 'Hi', earlier: [] }), { ...mail, body: 'Hi' })
})

describe('the Inbox', { skip }, () => {
  before(async () => {
    computerFor = (
      await prisma.computer.create({
        data: { ...scope, kind: 'member_machine', memberId: members[0]!, name: 'Laptop' },
      })
    ).id
  })

  test('every source in one list, with what waits and what a thread took', async () => {
    const db = scoped(scope)
    const waiting = await mail(agent)
    const ruled = await thread(cody.id, { projectId })
    const taken = await mail(support, { route: 'rule', sessionId: ruled.id })
    const all = await inbox.listInbox(db, as(0), { status: 'all' })
    const byId = new Map(all.items.map((i) => [i.id, i]))
    assert.equal(byId.get(`mail:${waiting.id}`)?.status, 'waiting')
    assert.equal(byId.get(`mail:${taken.id}`)?.status, 'handled')
    assert.equal(byId.get(`mail:${taken.id}`)?.thread?.id, ruled.id)
    assert.equal(byId.get(`mail:${taken.id}`)?.project?.id, projectId)
    // Gmail's latest, read live, beside Brigade's own.
    const kept = await prisma.mailMessage.findFirstOrThrow({ where: { connectionId: gmailShared } })
    const g = byId.get(`mail:${kept.id}`)
    assert.equal(g?.subject, 'Refund')
    assert.equal(g?.from, 'client@outside.test')
    assert.equal(g?.status, 'waiting')
    // Waiting is the default view; the sidebar counts what waits in Brigade's mail.
    const shown = await inbox.listInbox(db, as(0), { status: 'waiting' })
    assert.ok(shown.items.some((i) => i.id === `mail:${waiting.id}`))
    assert.ok(!shown.items.some((i) => i.id === `mail:${taken.id}`))
    assert.ok((await inbox.waitingCount(db, as(0))) >= 1)
  })

  test('filters: by source, agent, project and words', async () => {
    const db = scoped(scope)
    const lovarank = await mail(support, { subject: 'Lovarank invoice' })
    const mine = await mail(agent, { subject: 'For Riley' })
    const onlySupport = await inbox.listInbox(db, as(0), {
      status: 'all',
      source: `email:${support.id}`,
    })
    assert.ok(onlySupport.items.every((i) => i.source.id === `email:${support.id}`))
    const rileys = await inbox.listInbox(db, as(0), { status: 'all', teammateId: riley.id })
    assert.ok(rileys.items.some((i) => i.id === `mail:${mine.id}`))
    assert.ok(!rileys.items.some((i) => i.id === `mail:${lovarank.id}`))
    const project = await inbox.listInbox(db, as(0), { status: 'all', projectId })
    assert.ok(project.items.some((i) => i.id === `mail:${lovarank.id}`))
    assert.ok(!project.items.some((i) => i.id === `mail:${mine.id}`))
    const words = await inbox.listInbox(db, as(0), { status: 'all', q: 'invoice', source: 'email' })
    assert.deepEqual(
      words.items.map((i) => i.id),
      [`mail:${lovarank.id}`],
    )
  })

  test('a conversation is one row: its latest mail in front, matched by any of its mails', async () => {
    const db = scoped(scope)
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000)
    const first = await mail(support, {
      subject: `Order 77 ${id}`,
      text: 'Where is order 77?',
      receivedAt: at(30),
    })
    const conversation = { box: first.box, conversationId: first.conversationId }
    const answer = await prisma.mailMessage.create({
      data: {
        ...scope,
        ...conversation,
        addressId: support.id,
        direction: 'out',
        status: 'sent',
        fromAddress: `support-inbox-${id}@mails.brigade.lol`,
        fromName: 'Cody',
        to: ['client@outside.test'],
        subject: `Re: Order 77 ${id}`,
        text: 'It ships tomorrow.',
        receivedAt: at(20),
      } as never,
    })
    // A mail cancelled before it left is not part of it.
    await prisma.mailMessage.create({
      data: {
        ...scope,
        ...conversation,
        addressId: support.id,
        direction: 'out',
        status: 'cancelled',
        fromAddress: `support-inbox-${id}@mails.brigade.lol`,
        subject: 'Draft',
        receivedAt: at(15),
      } as never,
    })
    const reply = await mail(support, {
      ...conversation,
      subject: `Re: Order 77 ${id}`,
      text: 'Thanks!',
      receivedAt: at(10),
    })
    const list = (q?: string, status: 'all' | 'waiting' = 'all') =>
      inbox
        .listInbox(db, as(0), { status, source: `email:${support.id}`, ...(q ? { q } : {}) })
        .then((r) => r.items.filter((i) => i.subject.includes(`Order 77 ${id}`)))
    const rows = await list()
    assert.deepEqual(
      rows.map((i) => [i.id, i.count, i.snippet]),
      [[`mail:${reply.id}`, 3, 'Thanks!']],
    )
    // Found by its first mail's words; shown by its latest.
    assert.deepEqual(
      (await list('Where is order 77')).map((i) => i.id),
      [`mail:${reply.id}`],
    )
    // Any of its mails opens it whole, oldest first, received and sent.
    const detail = await inbox.readItem(db, as(0), `mail:${first.id}`)
    assert.equal(detail.id, `mail:${reply.id}`)
    assert.deepEqual(
      detail.messages.map((m) => [m.id, m.direction, m.sent]),
      [
        [`mail:${first.id}`, 'in', null],
        [`mail:${answer.id}`, 'out', 'sent'],
        [`mail:${reply.id}`, 'in', null],
      ],
    )
    // Done is the conversation's; its next mail makes it wait again.
    await inbox.setDone(db, as(0), `mail:${first.id}`, true)
    assert.equal((await inbox.readItem(db, as(0), `mail:${reply.id}`)).status, 'done')
    assert.deepEqual(await list(undefined, 'waiting'), [])
    const next = await mail(support, {
      ...conversation,
      subject: `Re: Order 77 ${id}`,
      receivedAt: at(1),
    })
    assert.deepEqual(
      (await list(undefined, 'waiting')).map((i) => [i.id, i.count]),
      [[`mail:${next.id}`, 4]],
    )
  })

  test('an unassigned mail says why, and an admin can add a rule on its mailbox from it', async () => {
    const db = scoped(scope)
    const stray = await mail(agent, { sender: 'unknown', subject: `Stray ${id}` })
    const forAda = await inbox.readItem(db, as(0), `mail:${stray.id}`)
    assert.equal(forAda.reason, 'From someone outside the workspace, and this mailbox has no rule.')
    assert.deepEqual(forAda.addRule, {
      connectionId: agent.connectionId,
      projectId: null,
      teammateId: riley.id,
    })
    // Rules are an owner's or admin's to add.
    assert.equal((await inbox.readItem(db, as(1), `mail:${stray.id}`)).addRule, null)
    const rule = await db.trigger.create({
      data: {
        connectionId: agent.connectionId,
        teammateId: riley.id,
        createdByMemberId: members[0]!,
        label: 'Answer',
        event: 'email_received',
      } as never,
    })
    assert.equal(
      (await inbox.readItem(db, as(0), `mail:${stray.id}`)).reason,
      'From someone outside the workspace, and none of this mailbox’s rules matched it.',
    )
    await db.trigger.delete({ where: { id: rule.id } })
    // A mail a thread took needs no reason.
    const ruled = await thread(riley.id)
    const taken = await mail(agent, { route: 'rule', sessionId: ruled.id })
    assert.equal((await inbox.readItem(db, as(0), `mail:${taken.id}`)).reason, null)
  })

  test('Gmail: all of a shared account put in the Inbox; of the others, what a thread took', async () => {
    // Nothing kept yet of Bob's own account or a shared one not in the Inbox: their mail went
    // nowhere (box), and it is not in Brigade at all.
    assert.equal(await prisma.mailMessage.count({ where: { connectionId: gmailBobs } }), 0)
    assert.equal(await prisma.mailMessage.count({ where: { connectionId: gmailNotListed } }), 0)
    const ids = async (who: 0 | 1) =>
      (await inbox.inboxSources(scoped(scope), as(who))).map((s) => s.id)
    assert.ok((await ids(0)).includes(`gmail:${gmailShared}`))
    assert.ok(!(await ids(1)).includes(`gmail:${gmailBobs}`))
    assert.ok(!(await ids(0)).includes(`gmail:${gmailNotListed}`))

    // A playbook's rule takes a mail of each: kept, the rest of the mailbox still not.
    const { keepGmail } = await import('../src/mail/gmail-inbox.js')
    const ruled = await thread(riley.id)
    const mailOf = (n: string, address: string) => ({
      id: `taken-${n}-${id}`,
      threadId: `taken-${n}-conv-${id}`,
      from: 'Customer <customer@outside.test>',
      to: address,
      subject: `Support ${n}`,
      date: new Date().toUTCString(),
      snippet: 'Help',
      labels: ['INBOX'],
      cc: undefined,
      body: 'Help',
      attachments: [],
      automatic: false,
    })
    for (const [n, connectionId] of [
      ['bob', gmailBobs],
      ['shared', gmailNotListed],
    ] as const) {
      const connection = await prisma.connection.findUniqueOrThrow({ where: { id: connectionId } })
      await keepGmail(connection, mailOf(n, connection.externalAccount!), {
        route: 'rule',
        sessionId: ruled.id,
      })
      await keepGmail(
        connection,
        { ...mailOf(`${n}-personal`, connection.externalAccount!) },
        {
          route: 'box',
        },
      )
      assert.equal(await prisma.mailMessage.count({ where: { connectionId } }), 1)
    }
    // Bob's own account shows to Bob alone; the shared one to everyone, its taken mail only.
    assert.ok((await ids(1)).includes(`gmail:${gmailBobs}`))
    assert.ok(!(await ids(0)).includes(`gmail:${gmailBobs}`))
    assert.ok((await ids(0)).includes(`gmail:${gmailNotListed}`))
    const subjects = async (who: 0 | 1, source: string) =>
      (await inbox.listInbox(scoped(scope), as(who), { status: 'all', source })).items.map(
        (i) => i.subject,
      )
    assert.deepEqual(await subjects(1, `gmail:${gmailBobs}`), ['Support bob'])
    assert.deepEqual(await subjects(0, `gmail:${gmailBobs}`), [])
    assert.deepEqual(await subjects(1, `gmail:${gmailNotListed}`), ['Support shared'])
    const bobs = await prisma.mailMessage.findFirstOrThrow({ where: { connectionId: gmailBobs } })
    await assert.rejects(inbox.readItem(scoped(scope), as(0), `mail:${bobs.id}`), /No such item/)
    assert.equal(
      (await inbox.readItem(scoped(scope), as(1), `mail:${bobs.id}`)).thread?.id,
      ruled.id,
    )
  })

  test('paging: the waiting view finds what waits under newer handled mail', async () => {
    const db = scoped(scope)
    const old = await mail(agent, {
      subject: 'Old and waiting',
      receivedAt: new Date(Date.now() - 86_400_000),
    })
    const ruled = await thread(riley.id)
    for (let i = 0; i < 55; i++)
      await mail(agent, { route: 'rule', sessionId: ruled.id, subject: `Handled ${i}` })
    const waiting = await inbox.listInbox(db, as(0), {
      status: 'waiting',
      source: `email:${agent.id}`,
    })
    assert.ok(waiting.items.some((i) => i.id === `mail:${old.id}`))
    assert.ok(waiting.items.every((i) => i.status === 'waiting'))
    // Pages of handled mail: 50, then the rest.
    const first = await inbox.listInbox(db, as(0), {
      status: 'handled',
      source: `email:${agent.id}`,
    })
    assert.equal(first.items.length, 50)
    assert.ok(first.next)
    const second = await inbox.listInbox(db, as(0), {
      status: 'handled',
      source: `email:${agent.id}`,
      before: inbox.parseCursor(first.next!)!,
    })
    assert.ok(second.items.length >= 5)
    assert.ok(!second.items.some((i) => first.items.some((f) => f.id === i.id)))
  })

  test('a sign-up’s mail is its thread’s: others see that it came, not what it says', async () => {
    const db = scoped(scope)
    const signup = await thread(riley.id)
    const alias = await db.mailAlias.create({
      data: {
        local: `riley-inbox-${id}.0abc12`,
        addressId: agent.id,
        sessionId: signup.id,
        teammateId: riley.id,
        waitUntil: new Date(Date.now() - 1000),
      } as never,
    })
    const code = await mail(agent, {
      aliasId: alias.id,
      fromAddress: `codes-${id}@service.test`,
      subject: 'Your code is 482913',
      text: 'Code 482913',
    })
    const search = (who: 0 | 1, q: string) =>
      inbox
        .listInbox(db, as(who), { status: 'all', source: `email:${agent.id}`, q })
        .then((r) => r.items.find((i) => i.id === `mail:${code.id}`))
    const forBob = await search(1, `codes-${id}`)
    assert.equal(forBob?.hidden, true)
    assert.doesNotMatch(forBob!.subject + forBob!.snippet, /482913/)
    // Its words are not searched for him either: a match would give the code away digit by digit.
    assert.equal(await search(1, '4829'), undefined)
    assert.equal((await search(0, '4829'))?.hidden, false)
    const detail = await inbox.readItem(db, as(1), `mail:${code.id}`)
    assert.equal(detail.messages.at(-1)!.text, '')
    await assert.rejects(
      inbox.handItem(db, as(1), `mail:${code.id}`, { teammateId: riley.id }),
      /sign-up/,
    )
    // Its thread's starter (and admins) read it.
    assert.match(
      (await inbox.readItem(db, as(0), `mail:${code.id}`)).messages.at(-1)!.text,
      /482913/,
    )
  })

  test('done, and not done again', async () => {
    const db = scoped(scope)
    const m = await mail(agent)
    const count = await inbox.waitingCount(db, as(0))
    await inbox.setDone(db, as(1), `mail:${m.id}`, true)
    assert.equal((await inbox.readItem(db, as(0), `mail:${m.id}`)).status, 'done')
    assert.equal(await inbox.waitingCount(db, as(0)), count - 1)
    await inbox.setDone(db, as(1), `mail:${m.id}`, false)
    assert.equal((await inbox.readItem(db, as(0), `mail:${m.id}`)).status, 'waiting')
  })

  test('hand to a teammate: only one given the mailbox; the conversation stays with its thread', async () => {
    const db = scoped(scope)
    const m = await mail(support, { messageId: `<hand-${id}@x.test>` })
    const detail = await inbox.readItem(db, as(0), `mail:${m.id}`)
    assert.deepEqual(
      detail.handTo.map((t) => t.name),
      ['Cody'],
    )
    await assert.rejects(
      inbox.handItem(db, as(0), `mail:${m.id}`, { teammateId: riley.id }),
      /no access/,
    )
    // Ada's computer is a laptop, offline here: nothing is left behind.
    await prisma.account.create({
      data: {
        ...scope,
        memberId: members[0]!,
        computerId: computerFor,
        provider: 'claude_code',
        label: 'Claude',
        status: 'ready',
      },
    })
    const sessions = await prisma.session.count({ where: { ...scope } })
    await assert.rejects(
      inbox.handItem(db, as(0), `mail:${m.id}`, { teammateId: cody.id }),
      /offline/,
    )
    assert.equal(await prisma.session.count({ where: { ...scope } }), sessions)
    assert.equal(
      (await prisma.mailMessage.findUniqueOrThrow({ where: { id: m.id } })).sessionId,
      null,
    )
  })
})

describe('handing over', { skip }, () => {
  test('the thread starts with the mail, and the mail and its conversation stay with it', async () => {
    const db = scoped(scope)
    // A cloud computer: what is sent waits for it to start, as in production.
    const cloud = await prisma.computer.create({
      data: { ...scope, kind: 'cloud', name: 'Cloud', status: 'stopped' },
    })
    await prisma.account.create({
      data: {
        ...scope,
        memberId: members[0]!,
        computerId: cloud.id,
        provider: 'claude_code',
        label: 'Claude',
        status: 'ready',
      },
    })
    const m = await mail(support, {
      subject: 'Please refund me',
      messageId: `<handed-${id}@x.test>`,
      text: `Ask @[Riley](teammate:${riley.id}) and use @[Key](credential:key-${id})`,
    })
    // Its mailbox is the project's: a thread elsewhere could not read or answer it.
    await assert.rejects(
      inbox.handItem(db, as(0), `mail:${m.id}`, { teammateId: cody.id, projectId: null }),
      /project/,
    )
    const { threadId } = await inbox.handItem(db, as(0), `mail:${m.id}`, {
      teammateId: cody.id,
      note: 'Check the order first',
    })
    // The mail's mentions are words: they summon nobody and grant nothing.
    assert.deepEqual(
      (await prisma.threadTeammate.findMany({ where: { sessionId: threadId } })).map(
        (t) => t.teammateId,
      ),
      [cody.id],
    )
    const session = await prisma.session.findUniqueOrThrow({ where: { id: threadId } })
    assert.equal(session.teammateId, cody.id)
    assert.equal(session.startedByMemberId, members[0])
    assert.equal(session.projectId, projectId)
    // Out of the sidebar until someone takes part or it needs a person: the Inbox follows it.
    assert.equal(session.quiet, true)
    assert.equal(session.surfacedAt, null)
    const row = await prisma.mailMessage.findUniqueOrThrow({ where: { id: m.id } })
    assert.equal(row.sessionId, threadId)
    assert.equal(row.route, 'handed')
    const item = await inbox.readItem(db, as(1), `mail:${m.id}`)
    assert.equal(item.status, 'handled')
    assert.equal(item.thread?.id, threadId)
    // The customer's answer in that conversation goes to the thread it was handed to.
    const { processMail } = await import('../src/mail/inbound.js')
    const answer = await prisma.mailMessage.create({
      data: {
        ...scope,
        addressId: support.id,
        box: `${support.id}:-`,
        direction: 'in',
        status: 'pending',
        conversationId: row.conversationId,
        inReplyTo: row.messageId,
        fromAddress: 'client@outside.test',
        subject: 'Re: Please refund me',
        text: 'Order 4821',
        sender: 'contact',
      } as never,
    })
    await processMail(answer.id)
    const delivered = await prisma.mailMessage.findUniqueOrThrow({ where: { id: answer.id } })
    assert.equal(delivered.route, 'conversation')
    assert.equal(delivered.sessionId, threadId)

    // Handed again, from its first mail: the conversation moves to the new thread.
    const again = await inbox.handItem(db, as(0), `mail:${m.id}`, { teammateId: cody.id })
    assert.notEqual(again.threadId, threadId)
    const next = await prisma.mailMessage.create({
      data: {
        ...scope,
        addressId: support.id,
        box: `${support.id}:-`,
        direction: 'in',
        status: 'pending',
        conversationId: row.conversationId,
        fromAddress: 'client@outside.test',
        subject: 'Re: Please refund me',
        text: 'Any news?',
        sender: 'contact',
      } as never,
    })
    await processMail(next.id)
    assert.equal(
      (await prisma.mailMessage.findUniqueOrThrow({ where: { id: next.id } })).sessionId,
      again.threadId,
    )
    await prisma.computer.delete({ where: { id: cloud.id } })
  })
})

describe('a hand-over again, pages and the reader’s retries', { skip }, () => {
  before(async () => {
    const cloud = await prisma.computer.create({
      data: { ...scope, kind: 'cloud', name: 'Review cloud', status: 'stopped' },
    })
    await prisma.account.create({
      data: {
        ...scope,
        memberId: members[0]!,
        computerId: cloud.id,
        provider: 'claude_code',
        label: 'Claude',
        status: 'ready',
      },
    })
    await scoped(scope).grant.create({
      data: { teammateId: cody.id, connectionId: gmailShared, scope: 'read_write' } as never,
    })
  })

  test('JSON serialization does not revive a newline-containing email mention', async () => {
    const db = scoped(scope)
    // A real newline in each label: written out as JSON, it becomes \n, which a mention allows.
    const m = await mail(support, {
      text: `Please help @[Other\n](teammate:${riley.id}) and @[Key\n](credential:test-key)`,
    })
    assert.ok(m.text.includes('\n'))
    const { threadId } = await inbox.handItem(db, as(0), `mail:${m.id}`, { teammateId: cody.id })
    const joined = await db.threadTeammate.findMany({ where: { sessionId: threadId } })
    assert.deepEqual(
      joined.map((t) => t.teammateId).sort(),
      [cody.id],
      'unmention is bypassed by a newline that JSON.stringify escapes',
    )
  })

  test('re-handing Gmail replaces the previous conversation recipient', async () => {
    const db = scoped(scope)
    globalThis.fetch = (async () => json({ historyId: '100' })) as typeof fetch
    const m = await db.mailMessage.findFirstOrThrow({
      where: { connectionId: gmailShared, sourceId: 'g1' },
    })
    const first = await inbox.handItem(db, as(0), `mail:${m.id}`, { teammateId: cody.id })
    const second = await inbox.handItem(db, as(0), `mail:${m.id}`, { teammateId: cody.id })
    const connection = await db.connection.findFirstOrThrow({ where: { id: gmailShared } })
    const { wakeOnReply } = await import('../src/replies.js')
    const taken = await wakeOnReply(connection, {
      id: `gmail-review-followup-${id}`,
      threadId: m.conversationId,
      from: 'Client <client@outside.test>',
      to: connection.externalAccount ?? '',
      subject: 'Re: Refund',
      date: new Date().toUTCString(),
      snippet: 'Any news?',
      labels: ['INBOX'],
      cc: undefined,
      body: 'Any news?',
      attachments: [],
      automatic: false,
    })
    const wakes = await db.wakeup.findMany({
      where: {
        sessionId: { in: [first.threadId, second.threadId] },
        sourceId: `gmail:gmail-review-followup-${id}`,
      },
    })
    assert.deepEqual(
      wakes.map((w) => w.sessionId),
      [second.threadId],
      `reply was offered to ${taken} threads`,
    )
  })

  test('paging retains Gmail messages with equal Date headers at the page boundary', async () => {
    const db = scoped(scope)
    const at = new Date('2026-10-25T12:00:00.000Z')
    for (let i = 0; i < 49; i++)
      await mail(agent, {
        subject: 'same-second-review',
        receivedAt: new Date(at.getTime() + 60000 + i * 1000),
      })
    const connection = await db.connection.findFirstOrThrow({ where: { id: gmailShared } })
    const { keepGmail } = await import('../src/mail/gmail-inbox.js')
    for (let i = 0; i < 2; i++)
      await keepGmail(
        connection,
        {
          id: `review-boundary-${id}-${i}`,
          threadId: `review-boundary-conv-${id}-${i}`,
          from: 'Client <client@outside.test>',
          to: connection.externalAccount ?? '',
          subject: 'same-second-review',
          date: at.toUTCString(),
          snippet: 'Hello',
          labels: ['INBOX'],
          cc: undefined,
          body: 'Hello',
          attachments: [],
          automatic: false,
        },
        { route: 'box' },
      )
    const first = await inbox.listInbox(db, as(0), { status: 'all', q: 'same-second-review' })
    assert.equal(first.items.length, 50)
    assert.ok(first.next)
    const second = await inbox.listInbox(db, as(0), {
      status: 'all',
      q: 'same-second-review',
      before: inbox.parseCursor(first.next!)!,
    })
    assert.equal(
      first.items.length + second.items.length,
      51,
      'strict timestamp cursor skips the other Gmail message with the same Date header',
    )
  })

  test('Gmail reader retry remembers a rule delivery before the Inbox insert', async () => {
    const db = scoped(scope)
    const connection = await db.connection.findFirstOrThrow({ where: { id: gmailShared } })
    const tr = await db.trigger.create({
      data: {
        connectionId: gmailShared,
        teammateId: cody.id,
        createdByMemberId: members[0]!,
        label: 'Review support',
        event: 'email_received',
      } as never,
    })
    const { dispatch } = await import('../src/triggers.js')
    const payload = {
      id: `review-retry-${id}`,
      threadId: `review-retry-conv-${id}`,
      from: 'Client <client@outside.test>',
      to: connection.externalAccount ?? '',
      subject: 'Support request',
      date: new Date().toUTCString(),
      snippet: 'Help',
      labels: ['INBOX'],
      cc: undefined,
      body: 'Help',
      attachments: [],
      automatic: false,
    }
    // Delivery succeeded; simulate the process stopping before keepGmail/cursor save.
    const delivery = await dispatch(connection, { id: payload.id, type: 'email', payload })
    assert.ok(delivery.threadId, JSON.stringify(delivery))
    const sub = await db.subscription.findFirstOrThrow({ where: { connectionId: gmailShared } })
    await db.subscription.updateMany({ where: { id: sub.id }, data: { cursor: '100' } })
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      )
      if (url.pathname.endsWith('/history'))
        return json({
          historyId: '150',
          history: [
            {
              id: '150',
              messagesAdded: [
                { message: { id: payload.id, threadId: payload.threadId, labelIds: ['INBOX'] } },
              ],
            },
          ],
        })
      if (url.pathname.endsWith(`/messages/${payload.id}`))
        return json({
          id: payload.id,
          threadId: payload.threadId,
          labelIds: ['INBOX'],
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: payload.from },
              { name: 'To', value: payload.to },
              { name: 'Subject', value: payload.subject },
              { name: 'Date', value: payload.date },
            ],
            body: { data: Buffer.from(payload.body).toString('base64url') },
          },
        })
      return json({ historyId: '100' })
    }) as typeof fetch
    const { readInbox } = await import('../src/subscriptions/gmail.js')
    await readInbox(sub.id)
    const kept = await db.mailMessage.findFirstOrThrow({
      where: { connectionId: gmailShared, sourceId: payload.id },
    })
    assert.equal(
      kept.sessionId,
      delivery.threadId,
      `reader saved route ${kept.route} instead of the existing delivery`,
    )
  })
})

describe('hand-overs at once, and a thread deleted since', { skip }, () => {
  test('overlapping Gmail handovers retain one live recipient', async () => {
    const db = scoped(scope)
    const connection = await db.connection.findFirstOrThrow({ where: { id: gmailShared } })
    const { keepGmail } = await import('../src/mail/gmail-inbox.js')
    await keepGmail(
      connection,
      {
        id: `concurrent-review-${id}`,
        threadId: `concurrent-review-conv-${id}`,
        from: 'Client <client@outside.test>',
        to: connection.externalAccount ?? '',
        subject: 'Concurrent handover',
        date: new Date().toUTCString(),
        snippet: 'Help',
        labels: ['INBOX'],
        cc: undefined,
        body: 'Help',
        attachments: [],
        automatic: false,
      },
      { route: 'box' },
    )
    const m = await db.mailMessage.findFirstOrThrow({
      where: { connectionId: gmailShared, sourceId: `concurrent-review-${id}` },
    })
    globalThis.fetch = (async () => json({ historyId: '100' })) as typeof fetch
    let created = 0
    let release!: () => void
    const bothCreated = new Promise<void>((resolve) => {
      release = resolve
    })
    // Exercise the valid overlap where both INSERTs finish before either retirement UPDATE.
    const watches = new Proxy(db.replyWatch, {
      get(target, property) {
        if (property === 'create')
          return async (args: Parameters<typeof db.replyWatch.create>[0]) => {
            const result = await target.create(args)
            if (++created === 2) release()
            await bothCreated
            return result
          }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const racingDb = new Proxy(db, {
      get(target, property) {
        return property === 'replyWatch' ? watches : Reflect.get(target, property)
      },
    })
    const results = await Promise.all([
      inbox.handItem(racingDb, as(0), `mail:${m.id}`, { teammateId: cody.id }),
      inbox.handItem(racingDb, as(0), `mail:${m.id}`, { teammateId: cody.id }),
    ])
    assert.equal(results.length, 2)
    const active = await db.replyWatch.findMany({
      where: {
        connectionId: gmailShared,
        conversationKey: m.conversationId,
        until: { gt: new Date() },
      },
    })
    assert.equal(
      active.length,
      1,
      'both successful handovers ended each other’s new watch, leaving no recipient',
    )
  })

  test('retry after the recorded thread was deleted does not block the Gmail reader', async () => {
    const db = scoped(scope)
    const connection = await db.connection.findFirstOrThrow({ where: { id: gmailShared } })
    const { dispatch } = await import('../src/triggers.js')
    const payload = {
      id: `deleted-review-${id}`,
      threadId: `deleted-review-conv-${id}`,
      from: 'Client <client@outside.test>',
      to: connection.externalAccount ?? '',
      subject: 'Deleted support thread',
      date: new Date().toUTCString(),
      snippet: 'Help',
      labels: ['INBOX'],
      cc: undefined,
      body: 'Help',
      attachments: [],
      automatic: false,
    }
    const delivery = await dispatch(connection, { id: payload.id, type: 'email', payload })
    assert.ok(delivery.threadId, JSON.stringify(delivery))
    // The first message succeeded; a later failure kept the reader's cursor behind it.
    // A person deletes that delivered thread before the reader retries.
    await db.session.delete({ where: { id: delivery.threadId } })
    assert.equal(
      await db.auditEntry.count({
        where: { action: 'trigger.received', data: { path: ['eventId'], equals: payload.id } },
      }),
      1,
    )
    const sub = await db.subscription.findFirstOrThrow({ where: { connectionId: gmailShared } })
    await db.subscription.updateMany({ where: { id: sub.id }, data: { cursor: '100' } })
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      )
      if (url.pathname.endsWith('/history'))
        return json({
          historyId: '200',
          history: [
            {
              id: '200',
              messagesAdded: [
                { message: { id: payload.id, threadId: payload.threadId, labelIds: ['INBOX'] } },
              ],
            },
          ],
        })
      if (url.pathname.endsWith(`/messages/${payload.id}`))
        return json({
          id: payload.id,
          threadId: payload.threadId,
          labelIds: ['INBOX'],
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: payload.from },
              { name: 'To', value: payload.to },
              { name: 'Subject', value: payload.subject },
              { name: 'Date', value: payload.date },
            ],
            body: { data: Buffer.from(payload.body).toString('base64url') },
          },
        })
      return json({ historyId: '100' })
    }) as typeof fetch
    const { readInbox } = await import('../src/subscriptions/gmail.js')
    await assert.doesNotReject(
      readInbox(sub.id),
      'an audited id for a deleted thread must not poison the inbox cursor',
    )
    const after = await db.subscription.findFirstOrThrow({ where: { id: sub.id } })
    assert.equal(after.cursor, '200')
  })
})

describe('a hand-over takes the replies, on its project', { skip }, () => {
  test('Brigade handover retires a previous sender watch', async () => {
    const db = scoped(scope)
    const m = await mail(support, { messageId: `<review-brigade-watch-${id}@x.test>` })
    const first = await inbox.handItem(db, as(0), `mail:${m.id}`, { teammateId: cody.id })
    const { watchReplies } = await import('../src/replies.js')
    await watchReplies(db, scope, {
      session: { id: first.threadId, origin: 'member', status: 'idle' },
      teammateId: cody.id,
      connectionId: support.connectionId,
      conversationKey: m.conversationId,
      to: ['client@outside.test'],
      subject: m.subject,
    })
    const second = await inbox.handItem(db, as(0), `mail:${m.id}`, { teammateId: cody.id })
    const next = await mail(support, {
      direction: 'in',
      status: 'pending',
      conversationId: m.conversationId,
      fromAddress: 'client@outside.test',
      sender: 'contact',
      text: 'Next reply',
    })
    const { processMail } = await import('../src/mail/inbound.js')
    await processMail(next.id)
    const delivered = await db.mailMessage.findFirstOrThrow({ where: { id: next.id } })
    assert.equal(
      delivered.sessionId,
      second.threadId,
      `reply went to first=${delivered.sessionId === first.threadId}, route=${delivered.route}`,
    )
  })

  test('Gmail reader records the thread actually woken after handover', async () => {
    const db = scoped(scope)
    const connection = await db.connection.findFirstOrThrow({ where: { id: gmailShared } })
    const { keepGmail } = await import('../src/mail/gmail-inbox.js')
    const payload = {
      id: `review-wrong-owner-${id}`,
      threadId: `review-wrong-owner-conv-${id}`,
      from: 'client@outside.test',
      to: connection.externalAccount ?? '',
      subject: 'Owner regression',
      date: new Date().toUTCString(),
      snippet: 'Help',
      labels: ['INBOX'],
      cc: undefined,
      body: 'Help',
      attachments: [],
      automatic: false,
    }
    await keepGmail(connection, payload, { route: 'box' })
    const m = await db.mailMessage.findFirstOrThrow({ where: { sourceId: payload.id } })
    globalThis.fetch = (async () => json({ historyId: '100' })) as typeof fetch
    const first = await inbox.handItem(db, as(0), `mail:${m.id}`, { teammateId: cody.id })
    const second = await inbox.handItem(db, as(0), `mail:${m.id}`, { teammateId: cody.id })
    const sub = await db.subscription.findFirstOrThrow({ where: { connectionId: gmailShared } })
    await db.subscription.updateMany({ where: { id: sub.id }, data: { cursor: '100' } })
    const incomingId = `review-wrong-owner-reply-${id}`
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      )
      if (url.pathname.endsWith('/history'))
        return json({
          historyId: '250',
          history: [
            {
              id: '250',
              messagesAdded: [
                {
                  message: { id: incomingId, threadId: payload.threadId, labelIds: ['INBOX'] },
                },
              ],
            },
          ],
        })
      if (url.pathname.endsWith(`/messages/${incomingId}`))
        return json({
          id: incomingId,
          threadId: payload.threadId,
          labelIds: ['INBOX'],
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: payload.from },
              { name: 'To', value: payload.to },
              { name: 'Subject', value: payload.subject },
              { name: 'Date', value: payload.date },
            ],
            body: { data: Buffer.from(payload.body).toString('base64url') },
          },
        })
      return json({ historyId: '100' })
    }) as typeof fetch
    const { readInbox } = await import('../src/subscriptions/gmail.js')
    await readInbox(sub.id)
    const wakes = await db.wakeup.findMany({ where: { sourceId: `gmail:${incomingId}` } })
    assert.deepEqual(
      wakes.map((w) => w.sessionId),
      [second.threadId],
    )
    const saved = await db.mailMessage.findFirstOrThrow({ where: { sourceId: incomingId } })
    assert.equal(
      saved.sessionId,
      second.threadId,
      `recorded first=${saved.sessionId === first.threadId} although only second was woken`,
    )
  })

  test('Gmail handover rejects a project from another workspace', async () => {
    const db = scoped(scope)
    const foreignWorkspace = await prisma.workspace.create({
      data: { organizationId: org, name: 'Foreign' },
    })
    const foreignProject = await prisma.project.create({
      data: {
        organizationId: org,
        workspaceId: foreignWorkspace.id,
        name: 'Foreign project',
      },
    })
    const m = await db.mailMessage.findFirstOrThrow({
      where: { connectionId: gmailShared, sourceId: 'g1' },
    })
    globalThis.fetch = (async () => json({ historyId: '100' })) as typeof fetch
    await assert.rejects(
      inbox.handItem(db, as(0), `mail:${m.id}`, {
        teammateId: cody.id,
        projectId: foreignProject.id,
      }),
      /Project not found/,
    )
  })
})

describe('sent mail in a conversation', { skip }, () => {
  test('a sent reply must preserve sign-up mail privacy', async () => {
    const db = scoped(scope)
    const signup = await thread(riley.id)
    const alias = await db.mailAlias.create({
      data: {
        local: `review377-${id}.0abc12`,
        addressId: agent.id,
        sessionId: signup.id,
        teammateId: riley.id,
        waitUntil: new Date(Date.now() + 60000),
      } as never,
    })
    const code = await mail(agent, {
      aliasId: alias.id,
      subject: 'Your code is 482913',
      text: 'Code 482913',
      messageId: `<review377-signup-${id}@service.test>`,
    })
    const address = await db.mailAddress.findFirstOrThrow({
      where: { id: agent.id },
      include: { domain: true },
    })
    const { sendDraft } = await import('../src/mail/outbound.js')
    const beforeFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      assert.equal(String(input), 'https://api.resend.com/emails')
      return json({ id: `review377-out-${id}` })
    }) as typeof fetch
    let sent
    try {
      sent = await sendDraft(db, scope, {
        address,
        thread: signup,
        teammateId: riley.id,
        callId: randomUUID(),
        draft: {
          to: [code.fromAddress],
          subject: '',
          text: 'Please help me sign in.\n\nOn Sunday, Service wrote:\n> Code 482913',
          replyTo: code.id,
        },
      })
    } finally {
      globalThis.fetch = beforeFetch
    }
    const detail = await inbox.readItem(db, as(1), `mail:${code.id}`)
    const outgoing = detail.messages.find((m) => m.id === `mail:${sent.id}`)!
    assert.doesNotMatch(
      JSON.stringify(outgoing),
      /482913/,
      'another member can read the sign-up code via the newly included sent reply',
    )
    // Nor find it by the sent reply's words; its thread's starter does.
    const found = (who: 0 | 1) =>
      inbox
        .listInbox(db, as(who), { status: 'all', q: 'Please help me sign in' })
        .then((r) => r.items.some((i) => i.id === `mail:${code.id}`))
    assert.equal(await found(1), false)
    assert.equal(await found(0), true)
  })
  test('conversation search must find words in a sent reply', async () => {
    const db = scoped(scope)
    const first = await mail(support, { subject: `search-repro-${id}` })
    await db.mailMessage.create({
      data: {
        ...scope,
        addressId: support.id,
        box: first.box,
        conversationId: first.conversationId,
        direction: 'out',
        status: 'sent',
        fromAddress: 'support@mails.brigade.test',
        subject: 'Re: support',
        text: `tracking-reference-${id}`,
        receivedAt: new Date(),
      } as never,
    })
    const results = await inbox.listInbox(db, as(0), {
      status: 'all',
      q: `tracking-reference-${id}`,
    })
    assert.ok(
      results.items.some((m) => m.id === `mail:${first.id}`),
      'sent mail text is never searched',
    )
  })
})

describe('a sign-up’s conversation after its box time', { skip }, () => {
  test('its sign-up mail stays while the conversation does, so the replies stay its thread’s', async () => {
    const db = scoped(scope)
    const signup = await thread(riley.id)
    const alias = await db.mailAlias.create({
      data: {
        local: `retention-${id}.0abc12`,
        addressId: agent.id,
        sessionId: signup.id,
        teammateId: riley.id,
        waitUntil: new Date(Date.now() - 1000),
      } as never,
    })
    // A mail on an alias after its waiting window stays in the box, and its time is up.
    const code = await mail(agent, {
      aliasId: alias.id,
      subject: 'Your private sign-up code is 482913',
      text: 'Private sign-up code 482913',
      expiresAt: new Date(Date.now() - 1000),
      messageId: `<retention-${id}@service.test>`,
    })
    const address = await db.mailAddress.findFirstOrThrow({
      where: { id: agent.id },
      include: { domain: true },
    })
    const { sendDraft } = await import('../src/mail/outbound.js')
    const beforeFetch = globalThis.fetch
    globalThis.fetch = (async () => json({ id: `retention-out-${id}` })) as typeof fetch
    try {
      await sendDraft(db, scope, {
        address,
        thread: signup,
        teammateId: riley.id,
        callId: randomUUID(),
        draft: {
          to: [code.fromAddress],
          subject: '',
          text: 'Please help me sign in.\n\nOn Sunday, Service wrote:\n> Private sign-up code 482913',
          replyTo: code.id,
        },
      })
    } finally {
      globalThis.fetch = beforeFetch
    }
    // The service answers the agent's own address: the sending thread keeps it, without alias.
    const reply = await mail(agent, {
      box: code.box,
      conversationId: code.conversationId,
      subject: 'Re: Sign-in help',
      text: 'Try signing in again.',
      sessionId: signup.id,
      route: 'awaited',
      receivedAt: new Date(),
    })
    const { sweepMail } = await import('../src/mail/jobs.js')
    await sweepMail()
    assert.ok(await db.mailMessage.findFirst({ where: { id: code.id } }))
    const forBob = await inbox.readItem(db, as(1), `mail:${reply.id}`)
    assert.equal(forBob.hidden, true)
    assert.doesNotMatch(JSON.stringify(forBob.messages), /482913/)
    const found = await inbox.listInbox(db, as(1), { status: 'all', q: 'Please help me sign in' })
    assert.ok(!found.items.some((i) => i.id === `mail:${reply.id}`))
    // Its thread gone (and the mail it held with it), the sign-up mail goes at the next sweep.
    await prisma.session.delete({ where: { id: signup.id } })
    await sweepMail()
    assert.equal(await db.mailMessage.findFirst({ where: { id: code.id } }), null)
  })
})

describe('a received mail’s files', { skip }, () => {
  test('Brigade’s open from Resend’s link, never through the API; programs do not', async () => {
    const db = scoped(scope)
    const m = await mail(support, {
      resendId: `re-files-${id}`,
      attachments: [
        { id: 'f1', filename: 'invoice.pdf', contentType: 'application/pdf', size: 10 },
        { id: 'f2', filename: 'setup.exe', contentType: 'application/octet-stream', size: 10 },
      ],
    })
    const beforeFetch = globalThis.fetch
    const asked: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      asked.push(String(input))
      return json({
        id: 'f1',
        filename: 'invoice.pdf',
        download_url: 'https://resend.example/f1?signature',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      })
    }) as typeof fetch
    try {
      const detail = await inbox.readItem(db, as(0), `mail:${m.id}`)
      assert.deepEqual(
        detail.messages.at(-1)!.attachments.map((a) => a.id),
        ['f1', 'f2'],
      )
      assert.deepEqual(await inbox.openFile(db, as(0), `mail:${m.id}`, 'f1'), {
        link: 'https://resend.example/f1?signature',
      })
      assert.match(asked[0]!, new RegExp(`/emails/receiving/re-files-${id}/attachments/f1$`))
      await assert.rejects(inbox.openFile(db, as(0), `mail:${m.id}`, 'f2'), /program/)
      await assert.rejects(inbox.openFile(db, as(0), `mail:${m.id}`, 'f3'), /No such file/)
    } finally {
      globalThis.fetch = beforeFetch
    }
  })

  test('Gmail’s are copied to the bucket once, as they stream, then opened from it', async () => {
    const db = scoped(scope)
    const connection = await prisma.connection.findUniqueOrThrow({ where: { id: gmailShared } })
    const { keepGmail } = await import('../src/mail/gmail-inbox.js')
    const content = `Quarterly report ${id}\n`.repeat(50)
    const messageId = `g-files-${id}`
    await keepGmail(
      connection,
      {
        id: messageId,
        threadId: `gt-files-${id}`,
        from: 'Client <client@outside.test>',
        to: connection.externalAccount ?? '',
        subject: 'Report',
        date: new Date().toUTCString(),
        snippet: 'Report attached',
        labels: ['INBOX'],
        cc: undefined,
        body: 'Report attached',
        attachments: [
          { partId: '2', filename: 'report.txt', mimeType: 'text/plain', size: content.length },
          // Its size says more than comes: the copy fails, and nothing half-kept stays.
          { partId: '3', filename: 'short.txt', mimeType: 'text/plain', size: content.length + 5 },
        ],
        automatic: false,
      } as never,
      { route: 'box' },
    )
    const m = await db.mailMessage.findFirstOrThrow({ where: { sourceId: messageId } })
    const beforeFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls++
      const url = String(input)
      if (url.includes('?format=full'))
        return json({
          id: messageId,
          threadId: `gt-files-${id}`,
          payload: {
            mimeType: 'multipart/mixed',
            parts: [
              {
                partId: '1',
                mimeType: 'text/plain',
                body: { size: 15, data: 'UmVwb3J0IGF0dGFjaGVk' },
              },
              ...['2', '3'].map((partId) => ({
                partId,
                mimeType: 'text/plain',
                filename: partId === '2' ? 'report.txt' : 'short.txt',
                body: {
                  attachmentId: `att-${partId}`,
                  size: content.length + (partId === '3' ? 5 : 0),
                },
              })),
            ],
          },
        })
      if (url.includes('/attachments/att-'))
        return new Response(
          `{\n  "size": ${content.length},\n  "data": "${Buffer.from(content).toString('base64url')}"\n}`,
          { headers: { 'content-type': 'application/json' } },
        )
      throw new Error(`unexpected request ${url}`)
    }) as typeof fetch
    try {
      const opened = await inbox.openFile(db, as(0), `mail:${m.id}`, '2')
      assert.ok('attachment' in opened)
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: opened.attachment.id } })
      assert.equal(row.status, 'ready')
      assert.equal(row.size, content.length)
      assert.equal(row.sha256, createHash('sha256').update(content).digest('hex'))
      assert.match(row.text, /Quarterly report/)
      const { attachmentKey, getObject } = await import('../src/bucket.js')
      assert.equal(
        Buffer.from((await getObject(attachmentKey(scope, row.id)))!).toString(),
        content,
      )
      // Opened again: from the bucket, Gmail not asked.
      calls = 0
      const again = await inbox.openFile(db, as(0), `mail:${m.id}`, '2')
      assert.ok('attachment' in again && again.attachment.id === row.id)
      assert.equal(calls, 0)
      await assert.rejects(inbox.openFile(db, as(0), `mail:${m.id}`, '3'), /did not keep it/)
      assert.equal(
        await prisma.attachment.count({
          where: { externalRef: `gmail:${messageId}:3`, status: { not: 'blocked' } },
        }),
        0,
      )
    } finally {
      globalThis.fetch = beforeFetch
    }
  })
})

describe('taking a file in while another copy of it is under way', { skip }, () => {
  const file = (key: string, content: string, gate?: Promise<void>) => ({
    key,
    name: 'notes.txt',
    contentType: 'text/plain',
    size: content.length,
    download: async () => new TextEncoder().encode(content),
    open: async () => ({
      size: content.length,
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          await gate
          controller.enqueue(new TextEncoder().encode(content))
          controller.close()
        },
      }),
    }),
  })

  test('a second taker waits for the first copy and gets it, ready', async () => {
    const db = scoped(scope)
    const { ingestExternal } = await import('../src/attachments.js')
    const key = `test:concurrent-${id}`
    let open!: () => void
    const gate = new Promise<void>((resolve) => (open = resolve))
    const first = ingestExternal(db, scope, gmailShared, [file(key, 'hello', gate)], {
      fetch: globalThis.fetch,
    })
    // The first copy's row is there, pending, while its bytes wait.
    while (!(await prisma.attachment.findFirst({ where: { externalRef: key } })))
      await new Promise((resolve) => setTimeout(resolve, 20))
    const second = ingestExternal(db, scope, gmailShared, [file(key, 'hello')], {
      fetch: globalThis.fetch,
    })
    setTimeout(open, 300)
    const [[a], [b]] = await Promise.all([first, second])
    assert.equal(a, b)
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: a! } })
    assert.equal(row.status, 'ready')
  })

  test('a copy that stopped halfway is made again; a row stays until its bytes are gone', async () => {
    const db = scoped(scope)
    const { ingestExternal, sweepUploads } = await import('../src/attachments.js')
    const { attachmentKey } = await import('../src/bucket.js')
    const { env } = await import('../src/config.js')
    const { mkdir, rm } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const key = `test:stale-${id}`
    const stale = await db.attachment.create({
      data: {
        name: 'notes.txt',
        contentType: 'text/plain',
        size: 5,
        status: 'pending',
        source: 'connector',
        connectionId: gmailShared,
        externalRef: key,
        createdAt: new Date(Date.now() - 2 * 3600_000),
      } as never,
    })
    const [taken] = await ingestExternal(db, scope, gmailShared, [file(key, 'again')], {
      fetch: globalThis.fetch,
    })
    assert.notEqual(taken, stale.id)
    assert.equal(await prisma.attachment.findFirst({ where: { id: stale.id } }), null)
    assert.equal(
      (await prisma.attachment.findUniqueOrThrow({ where: { id: taken! } })).status,
      'ready',
    )
    // A stopped copy whose bytes cannot be deleted (here a folder in their place) keeps its row
    // for the next sweep, which removes it once they go.
    const stuck = await db.attachment.create({
      data: {
        name: 'notes.txt',
        contentType: 'text/plain',
        size: 5,
        status: 'pending',
        source: 'connector',
        connectionId: gmailShared,
        externalRef: `test:stuck-${id}`,
        createdAt: new Date(Date.now() - 2 * 3600_000),
      } as never,
    })
    const where = join(env.BUCKET_DIR, attachmentKey(scope, stuck.id))
    await mkdir(join(where, 'inside'), { recursive: true })
    await sweepUploads()
    assert.ok(await prisma.attachment.findFirst({ where: { id: stuck.id } }))
    await rm(where, { recursive: true, force: true })
    await sweepUploads()
    assert.equal(await prisma.attachment.findFirst({ where: { id: stuck.id } }), null)
  })
})

describe('what comes next: a reply to approve, a reply set for later', { skip }, () => {
  before(async () => {
    computerFor ??= (
      await prisma.computer.create({
        data: { ...scope, kind: 'member_machine', memberId: members[0]!, name: 'Laptop' },
      })
    ).id
  })

  /** Riley's email_send waiting for approval in its thread, answering `replyTo`. */
  const draft = (sessionId: string, replyTo: string, extra: Record<string, unknown> = {}) =>
    prisma.ticket.create({
      data: {
        ...scope,
        sessionId,
        type: 'approval',
        title: 'Riley: email send',
        payload: {
          connectionId: agent.connectionId,
          operation: 'email_send',
          target: 'email to client@outside.test',
          input: {
            to: ['client@outside.test'],
            subject: '',
            text: 'Here you go.',
            replyTo,
            ...extra,
          },
        },
      },
    })

  test('a reply to approve is To do for whoever may decide it, and with the teammate for others', async () => {
    const db = scoped(scope)
    // Ada started the thread; Bob is a member who did not.
    const asked = await thread(riley.id)
    // The newest, so on the first page whatever the earlier tests left.
    const received = await mail(agent, {
      route: 'conversation',
      sessionId: asked.id,
      receivedAt: new Date(),
    })
    const ticket = await draft(asked.id, received.id, { sendAt: '2026-11-02T09:00:00+01:00' })
    const item = `mail:${received.id}`
    const list = (who: 0 | 1, status: 'waiting' | 'handled') =>
      inbox.listInbox(db, as(who), { status }).then((r) => r.items.find((i) => i.id === item))

    const ada = await list(0, 'waiting')
    assert.deepEqual(ada?.next, {
      kind: 'draft',
      ticketId: ticket.id,
      teammate: { id: riley.id, name: 'Riley' },
    })
    assert.equal(await list(0, 'handled'), undefined)
    assert.equal(await list(1, 'waiting'), undefined)
    assert.equal((await list(1, 'handled'))?.next?.kind, 'draft')

    const forAda = await inbox.readItem(db, as(0), item)
    assert.equal(forAda.drafts.length, 1)
    assert.equal(forAda.drafts[0]!.canDecide, true)
    assert.equal(forAda.drafts[0]!.input.sendAt, '2026-11-02T09:00:00+01:00')
    assert.equal((await inbox.readItem(db, as(1), item)).drafts[0]!.canDecide, false)

    // Counted beside Inbox for Ada, until it is decided.
    const before = await inbox.waitingCount(db, as(0))
    await prisma.ticket.update({ where: { id: ticket.id }, data: { status: 'approved' } })
    assert.equal(await inbox.waitingCount(db, as(0)), before - 1)
    assert.equal((await list(0, 'handled'))?.next, null)
  })

  test('a draft answering another conversation, or another call, is not this one’s', async () => {
    const db = scoped(scope)
    const asked = await thread(riley.id)
    const here = await mail(agent, { route: 'conversation', sessionId: asked.id })
    const elsewhere = await mail(agent)
    await draft(asked.id, elsewhere.id)
    await prisma.ticket.create({
      data: {
        ...scope,
        sessionId: asked.id,
        type: 'approval',
        title: 'Riley: a payment',
        payload: { operation: 'stripe_refund', input: { replyTo: here.id } },
      },
    })
    const detail = await inbox.readItem(db, as(0), `mail:${here.id}`)
    assert.deepEqual(detail.drafts, [])
    assert.equal(detail.next, null)
  })

  test('a reply to approve leaves a handed-over thread out of the sidebar; any other ask brings it in', async () => {
    // Its hook surfaces a quiet thread when a ticket opens there.
    await import('../src/thread-archive.js')
    const db = scoped(scope)
    const handed = await thread(riley.id, { quiet: true })
    const received = await mail(agent, { route: 'handed', sessionId: handed.id })
    const surfaced = async () =>
      (await prisma.session.findUniqueOrThrow({ where: { id: handed.id } })).surfacedAt
    /** The hook runs after the write: waits for it to set surfacedAt, or not. */
    const settled = async (expected: boolean) => {
      for (let i = 0; i < 20 && Boolean(await surfaced()) !== expected; i++)
        await new Promise((r) => setTimeout(r, 50))
      return surfaced()
    }

    // As connector-calls.ts opens it: through the scoped client.
    await db.ticket.create({
      data: {
        sessionId: handed.id,
        type: 'approval',
        title: 'Riley: email send',
        payload: {
          connectionId: agent.connectionId,
          operation: 'email_send',
          input: { to: ['client@outside.test'], text: 'Got it.', replyTo: received.id },
        },
      } as never,
    })
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(await settled(false), null)
    // The Inbox shows it as the conversation's reply to approve.
    assert.equal((await inbox.readItem(db, as(0), `mail:${received.id}`)).drafts.length, 1)

    // A reply to a mail of another conversation is not the Inbox's to show here.
    await db.ticket.create({
      data: {
        sessionId: handed.id,
        type: 'approval',
        title: 'Riley: email send',
        payload: { operation: 'email_send', input: { replyTo: (await mail(agent)).id } },
      } as never,
    })
    assert.ok(await settled(true))
  })

  test('a reply set for later shows when it leaves, under Scheduled, and its thread may cancel it', async () => {
    const db = scoped(scope)
    const asked = await thread(riley.id)
    const received = await mail(agent, {
      route: 'conversation',
      sessionId: asked.id,
      receivedAt: new Date(),
    })
    const at = new Date(Date.now() + 3 * 86_400_000)
    const leaving = await prisma.mailMessage.create({
      data: {
        ...scope,
        addressId: agent.id,
        box: received.box,
        direction: 'out',
        status: 'scheduled',
        conversationId: received.conversationId,
        fromAddress: `riley-inbox-${id}@mails.brigade.test`,
        fromName: 'Riley',
        to: ['client@outside.test'],
        subject: 'Re: later',
        text: 'On Monday.',
        sessionId: asked.id,
        teammateId: riley.id,
        sendAt: at,
      } as never,
    })
    // One in its 30 seconds to cancel is not one set for later.
    const now = await mail(agent, { route: 'conversation', sessionId: asked.id })
    await prisma.mailMessage.create({
      data: {
        ...scope,
        addressId: agent.id,
        box: now.box,
        direction: 'out',
        status: 'scheduled',
        conversationId: now.conversationId,
        fromAddress: 'riley@x.test',
        to: ['client@outside.test'],
        sessionId: asked.id,
        sendAt: new Date(Date.now() + 20_000),
      } as never,
    })
    const scheduled = await inbox.listInbox(db, as(0), { status: 'scheduled' })
    const row = scheduled.items.find((i) => i.id === `mail:${received.id}`)
    assert.deepEqual(row?.next, {
      kind: 'scheduled',
      id: `mail:${leaving.id}`,
      at: at.toISOString(),
    })
    assert.ok(!scheduled.items.some((i) => i.id === `mail:${now.id}`))

    const message = (who: 0 | 1) =>
      inbox
        .readItem(db, as(who), `mail:${received.id}`)
        .then((d) => d.messages.find((m) => m.id === `mail:${leaving.id}`)!)
    assert.equal((await message(0)).sendAt, at.toISOString())
    assert.equal((await message(0)).canCancel, true)
    // Bob may not prompt Ada's thread, so may not cancel what it sends.
    assert.equal((await message(1)).canCancel, false)
  })
})
