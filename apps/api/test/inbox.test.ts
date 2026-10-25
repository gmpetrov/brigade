import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import pg from 'pg'

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
    assert.ok((await inbox.waitingCount(db)) >= 1)
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

  test('Gmail shows only when shared and put in the Inbox; a member’s own never does', async () => {
    const sources = await inbox.inboxSources(scoped(scope))
    assert.ok(sources.some((s) => s.id === `gmail:${gmailShared}`))
    assert.ok(!sources.some((s) => s.id === `gmail:${gmailBobs}`))
    assert.ok(!sources.some((s) => s.id === `gmail:${gmailNotListed}`))
    // The reader keeps only an account in the Inbox: the others' mail is not in Brigade at all.
    assert.equal(await prisma.mailMessage.count({ where: { connectionId: gmailBobs } }), 0)
    assert.equal(await prisma.mailMessage.count({ where: { connectionId: gmailNotListed } }), 0)
    const all = await inbox.listInbox(scoped(scope), as(1), { status: 'all', source: 'gmail' })
    assert.deepEqual([...new Set(all.items.map((i) => i.source.id))], [`gmail:${gmailShared}`])
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
      before: new Date(first.next!),
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
    assert.equal(detail.text, '')
    await assert.rejects(
      inbox.handItem(db, as(1), `mail:${code.id}`, { teammateId: riley.id }),
      /sign-up/,
    )
    // Its thread's starter (and admins) read it.
    assert.match((await inbox.readItem(db, as(0), `mail:${code.id}`)).text, /482913/)
  })

  test('done, and not done again', async () => {
    const db = scoped(scope)
    const m = await mail(agent)
    const count = await inbox.waitingCount(db)
    await inbox.setDone(db, as(1), `mail:${m.id}`, true)
    assert.equal((await inbox.readItem(db, as(0), `mail:${m.id}`)).status, 'done')
    assert.equal(await inbox.waitingCount(db), count - 1)
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
