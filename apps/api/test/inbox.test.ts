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
    await client.query('select 1 from "InboxState" limit 1')
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
  // Gmail, as the Inbox reads an account: its latest messages, then each one's metadata.
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    if (url.host !== 'gmail.googleapis.com') throw new Error(`unexpected request ${url}`)
    const path = url.pathname.replace('/gmail/v1/users/me', '')
    if (path === '/messages') return json({ messages: [{ id: 'g1' }] })
    if (path === '/messages/g1')
      return json({
        id: 'g1',
        threadId: 'gt1',
        internalDate: String(Date.now() - 60_000),
        snippet: 'Can I get a refund?',
        payload: {
          headers: [
            { name: 'From', value: 'Client <client@outside.test>' },
            { name: 'Subject', value: 'Refund' },
          ],
          mimeType: 'text/plain',
          body: { data: Buffer.from('Can I get a refund?').toString('base64url') },
        },
      })
    throw new Error(`unexpected request ${url}`)
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
  const gmail = async (reach: 'mine' | 'workspace', owner: string, address: string) =>
    (
      await db.connection.create({
        data: {
          appId: gmailApp.id,
          kind: 'gmail',
          label: address,
          externalAccount: address,
          reach,
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
    assert.equal(byId.get(`email:${waiting.id}`)?.status, 'waiting')
    assert.equal(byId.get(`email:${taken.id}`)?.status, 'handled')
    assert.equal(byId.get(`email:${taken.id}`)?.thread?.id, ruled.id)
    assert.equal(byId.get(`email:${taken.id}`)?.project?.id, projectId)
    // Gmail's latest, read live, beside Brigade's own.
    const g = byId.get(`gmail:${gmailShared}:g1`)
    assert.equal(g?.subject, 'Refund')
    assert.equal(g?.from, 'client@outside.test')
    assert.equal(g?.status, 'waiting')
    // Waiting is the default view; the sidebar counts what waits in Brigade's mail.
    const shown = await inbox.listInbox(db, as(0), { status: 'waiting' })
    assert.ok(shown.items.some((i) => i.id === `email:${waiting.id}`))
    assert.ok(!shown.items.some((i) => i.id === `email:${taken.id}`))
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
    assert.ok(rileys.items.some((i) => i.id === `email:${mine.id}`))
    assert.ok(!rileys.items.some((i) => i.id === `email:${lovarank.id}`))
    const project = await inbox.listInbox(db, as(0), { status: 'all', projectId })
    assert.ok(project.items.some((i) => i.id === `email:${lovarank.id}`))
    assert.ok(!project.items.some((i) => i.id === `email:${mine.id}`))
    const words = await inbox.listInbox(db, as(0), { status: 'all', q: 'invoice', source: 'email' })
    assert.deepEqual(
      words.items.map((i) => i.id),
      [`email:${lovarank.id}`],
    )
  })

  test('a member’s own Gmail is theirs alone', async () => {
    const ada = await inbox.inboxSources(scoped(scope), as(0))
    const bob = await inbox.inboxSources(scoped(scope), as(1))
    assert.ok(!ada.some((s) => s.id === `gmail:${gmailBobs}`))
    assert.ok(bob.some((s) => s.id === `gmail:${gmailBobs}`))
    assert.ok(
      ada.some((s) => s.id === `gmail:${gmailShared}`) &&
        bob.some((s) => s.id === `gmail:${gmailShared}`),
    )
    await assert.rejects(
      inbox.readItem(scoped(scope), as(0), `gmail:${gmailBobs}:g1`),
      /No such item/,
    )
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
      subject: 'Your code is 482913',
      text: 'Code 482913',
    })
    const forBob = (
      await inbox.listInbox(db, as(1), { status: 'all', source: `email:${agent.id}` })
    ).items.find((i) => i.id === `email:${code.id}`)
    assert.equal(forBob?.hidden, true)
    assert.doesNotMatch(forBob!.subject + forBob!.snippet, /482913/)
    const detail = await inbox.readItem(db, as(1), `email:${code.id}`)
    assert.equal(detail.text, '')
    await assert.rejects(
      inbox.handItem(db, as(1), `email:${code.id}`, { teammateId: riley.id }),
      /sign-up/,
    )
    // Its thread's starter (and admins) read it.
    assert.match((await inbox.readItem(db, as(0), `email:${code.id}`)).text, /482913/)
  })

  test('done, and not done again', async () => {
    const db = scoped(scope)
    const m = await mail(agent)
    const count = await inbox.waitingCount(db)
    await inbox.setDone(db, as(1), `email:${m.id}`, true)
    assert.equal((await inbox.readItem(db, as(0), `email:${m.id}`)).status, 'done')
    assert.equal(await inbox.waitingCount(db), count - 1)
    await inbox.setDone(db, as(1), `email:${m.id}`, false)
    assert.equal((await inbox.readItem(db, as(0), `email:${m.id}`)).status, 'waiting')
  })

  test('hand to a teammate: only one given the mailbox; the conversation stays with its thread', async () => {
    const db = scoped(scope)
    const m = await mail(support, { messageId: `<hand-${id}@x.test>` })
    const detail = await inbox.readItem(db, as(0), `email:${m.id}`)
    assert.deepEqual(
      detail.handTo.map((t) => t.name),
      ['Cody'],
    )
    await assert.rejects(
      inbox.handItem(db, as(0), `email:${m.id}`, { teammateId: riley.id }),
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
      inbox.handItem(db, as(0), `email:${m.id}`, { teammateId: cody.id }),
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
    })
    const { threadId } = await inbox.handItem(db, as(0), `email:${m.id}`, {
      teammateId: cody.id,
      note: 'Check the order first',
    })
    const session = await prisma.session.findUniqueOrThrow({ where: { id: threadId } })
    assert.equal(session.teammateId, cody.id)
    assert.equal(session.startedByMemberId, members[0])
    assert.equal(session.projectId, projectId)
    const row = await prisma.mailMessage.findUniqueOrThrow({ where: { id: m.id } })
    assert.equal(row.sessionId, threadId)
    assert.equal(row.route, 'handed')
    const item = await inbox.readItem(db, as(1), `email:${m.id}`)
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
    await prisma.computer.delete({ where: { id: cloud.id } })
  })
})
