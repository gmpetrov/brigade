import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, beforeEach, test } from 'node:test'
import pg from 'pg'

// Replies (src/replies.ts) against a real database, with Gmail's API played by a fake fetch:
// the local database of apps/api/.env, in an organization of its own that it removes at the
// end. Without a database to reach, it is skipped.
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

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select 1 from "ReplyWatch" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { AWAITED_REPLY, triggerEmail, triggerEvent, WAKEUPS_IN_A_ROW } =
  await import('@brigade/contracts')
const { prisma, scoped } = await import('../src/db.js')
const { automatic, stopWatching, wakeOnReply, watchReplies } = await import('../src/replies.js')
const { handleConnectorCall } = await import('../src/connector-calls.js')
const { readInbox } = await import('../src/subscriptions/gmail.js')
const { syncConnection } = await import('../src/subscriptions/index.js')
const { sealSecret } = await import('../src/vault.js')

const id = randomUUID().slice(0, 8)
const ids = { organization: `org-replies-${id}`, user: `user-replies-${id}` }
const member = `mem-replies-${id}`
let scope: { organizationId: string; workspaceId: string }
let teammateId: string
let computerId: string
let connection: Awaited<ReturnType<typeof prisma.connection.create>>

// Gmail, as the inbox reader asks it: the mailbox's history, then each message it reads; and
// as gmail_send sends, in the conversation `sendsIn`. onHistory runs while history is asked for.
type Fake = {
  history: unknown[]
  messages: Record<string, unknown>
  read: string[]
  sendsIn?: string
  onHistory?: () => Promise<unknown>
  /** Messages Gmail fails to give, for now. */
  failing?: Set<string>
}
let gmail: Fake
const realFetch = globalThis.fetch
const reply = (json: unknown, status = 200) =>
  new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } })

before(async () => {
  if (skip) return
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const path = url.pathname.replace('/gmail/v1/users/me', '')
    if (path === '/profile') return reply({ historyId: '100' })
    if (path === '/history') {
      await gmail.onHistory?.()
      return reply({ history: gmail.history, historyId: '200' })
    }
    if (path === '/messages/send')
      return reply({ id: `sent-${randomUUID()}`, threadId: gmail.sendsIn })
    const message = /^\/messages\/([^/]+)$/.exec(path)?.[1]
    if (message) {
      gmail.read.push(message)
      if (gmail.failing?.has(message)) return reply({ error: 'backendError' }, 503)
      return gmail.messages[message] ? reply(gmail.messages[message]) : reply({}, 404)
    }
    throw new Error(`unexpected request ${url}`)
  }) as typeof fetch

  await prisma.organization.create({
    data: { id: ids.organization, name: 'Replies test', slug: ids.organization },
  })
  await prisma.user.create({
    data: { id: ids.user, name: 'Georges', email: `${ids.user}@example.com` },
  })
  await prisma.member.create({
    data: { id: member, organizationId: ids.organization, userId: ids.user, role: 'owner' },
  })
  const workspace = await prisma.workspace.create({
    data: { organizationId: ids.organization, name: 'Replies test' },
  })
  scope = { organizationId: ids.organization, workspaceId: workspace.id }
  const db = scoped(scope)
  teammateId = (await prisma.teammate.create({ data: { ...scope, name: 'Riley' } })).id
  computerId = (
    await prisma.computer.create({
      data: { ...scope, kind: 'member_machine', memberId: member, name: 'Laptop' },
    })
  ).id
  const app = await db.app.create({ data: { key: 'gmail', createdByMemberId: member } as never })
  connection = await db.connection.create({
    data: {
      appId: app.id,
      kind: 'gmail',
      label: 'georges@acme.test',
      externalAccount: 'georges@acme.test',
      createdByMemberId: member,
      vaultSecretId: await sealSecret(db, scope, {
        accessToken: 'token',
        refreshToken: null,
        expiresAt: Date.now() + 3600_000,
      }),
    } as never,
  })
})

beforeEach(() => {
  gmail = { history: [], messages: {}, read: [] }
})

after(async () => {
  globalThis.fetch = realFetch
  if (skip) return
  await prisma.organization.deleteMany({ where: { id: ids.organization } })
  await prisma.user.deleteMany({ where: { id: ids.user } })
  await prisma.$disconnect()
})

let titles = 0
const thread = (origin: 'member' | 'child' | 'trigger' | 'schedule' = 'member') =>
  prisma.session.create({
    data: {
      ...scope,
      teammateId,
      startedByMemberId: member,
      computerId,
      title: `Thread ${++titles}`,
      status: 'idle',
      origin,
    },
  })

/** gmail_send's answer for a new conversation, watched from this thread. */
const send = async (session: Awaited<ReturnType<typeof thread>>, conversationKey: string) =>
  watchReplies(scoped(scope), scope, {
    session,
    teammateId,
    connectionId: connection.id,
    conversationKey,
    to: ['support@ascii.dev'],
    subject: 'Runner lost after restart',
  })

const email = (messageId: string, threadId: string, headers: Record<string, string> = {}) => ({
  id: messageId,
  threadId,
  labelIds: ['INBOX'],
  snippet: 'Thanks for the report',
  payload: {
    mimeType: 'text/plain',
    headers: Object.entries({
      From: 'Boat support <support@ascii.dev>',
      To: 'georges@acme.test',
      Subject: 'Re: Runner lost after restart',
      'Message-ID': `<${messageId}@ascii.dev>`,
      ...headers,
    }).map(([name, value]) => ({ name, value })),
    body: { data: Buffer.from('Use the ready file instead.').toString('base64url') },
  },
})

const replies = (sessionId: string) =>
  prisma.wakeup.findMany({ where: { sessionId, kind: 'reply' }, orderBy: { createdAt: 'asc' } })

test(
  'a reply in the conversation wakes the thread that sent the email, with the email, once',
  { skip },
  async () => {
    const t = await thread()
    assert.ok(await send(t, 'conv-a'))
    await syncConnection(scope, connection.id)
    const sub = await prisma.subscription.findFirstOrThrow({
      where: { connectionId: connection.id },
    })
    assert.equal(sub.mode, 'poll')

    // The reply, another conversation's email and the mailbox's own sent mail.
    gmail.history = [
      {
        id: '150',
        messagesAdded: [
          { message: { id: 'm-reply', threadId: 'conv-a', labelIds: ['INBOX'] } },
          { message: { id: 'm-other', threadId: 'conv-other', labelIds: ['INBOX'] } },
          { message: { id: 'm-sent', threadId: 'conv-a', labelIds: ['SENT', 'INBOX'] } },
        ],
      },
    ]
    gmail.messages['m-reply'] = email('m-reply', 'conv-a')
    gmail.messages['m-other'] = email('m-other', 'conv-other')
    await readInbox(sub.id)

    // Without triggers, the other conversation's email is not even read.
    assert.deepEqual(gmail.read, ['m-reply'])
    const woken = await replies(t.id)
    assert.equal(woken.length, 1)
    assert.equal(woken[0]!.teammateId, teammateId)
    const event = triggerEvent(woken[0]!.note)
    assert.equal(event?.trigger, AWAITED_REPLY)
    assert.equal(event?.source, 'georges@acme.test')
    assert.match(event!.summary, /support@ascii\.dev/)
    const mail = triggerEmail(event!)
    assert.equal(mail?.from, 'Boat support <support@ascii.dev>')
    assert.equal(mail?.body, 'Use the ready file instead.')

    // Read again (a read that failed later on): nobody is woken twice.
    await prisma.subscription.updateMany({ where: { id: sub.id }, data: { cursor: '100' } })
    await readInbox(sub.id)
    assert.equal((await replies(t.id)).length, 1)
  },
)

test('only threads a person started, and their children, wait on replies', { skip }, async () => {
  assert.ok(await send(await thread('child'), 'conv-child'))
  assert.equal(await send(await thread('trigger'), 'conv-trigger'), null)
  assert.equal(await send(await thread('schedule'), 'conv-schedule'), null)
})

test('another email in the conversation keeps the same watch, for longer', { skip }, async () => {
  const t = await thread()
  const first = await send(t, 'conv-b')
  const second = await send(t, 'conv-b')
  assert.equal(second?.id, first?.id)
  assert.ok(second!.until.getTime() >= first!.until.getTime())
  assert.equal(await prisma.replyWatch.count({ where: { sessionId: t.id } }), 1)
})

test('an out-of-office or acknowledgement wakes nobody', { skip }, () => {
  const headers = (h: Record<string, string>) =>
    Object.entries(h).map(([name, value]) => ({ name, value }))
  assert.equal(automatic(headers({ 'Auto-Submitted': 'auto-replied' })), true)
  assert.equal(automatic(headers({ 'auto-submitted': 'auto-generated' })), true)
  assert.equal(automatic(headers({ 'X-Autoreply': 'yes' })), true)
  assert.equal(automatic(headers({ Precedence: 'auto_reply' })), true)
  assert.equal(automatic(headers({ 'Auto-Submitted': 'no' })), false)
  assert.equal(automatic(headers({ From: 'support@ascii.dev' })), false)
  assert.equal(automatic(undefined), false)
})

test('a watch stopped or past its end wakes nobody', { skip }, async () => {
  const t = await thread()
  const watch = await send(t, 'conv-c')
  assert.ok(await stopWatching(scoped(scope), { ...scope, memberId: member }, t, watch!.id))
  const received = { ...emailPayload('m-c', 'conv-c') }
  assert.equal(await wakeOnReply(connection, received), 0)
  assert.equal((await replies(t.id)).length, 0)
  // Stopped already: nothing more to stop.
  assert.equal(
    await stopWatching(scoped(scope), { ...scope, memberId: member }, t, watch!.id),
    false,
  )
})

test('a thread woken too often with no word from a person stops waiting', { skip }, async () => {
  const t = await thread()
  const watch = await send(t, 'conv-d')
  for (let i = 0; i < WAKEUPS_IN_A_ROW; i++)
    await prisma.wakeup.create({
      data: {
        ...scope,
        sessionId: t.id,
        teammateId,
        note: 'Earlier reply',
        kind: 'reply',
        status: 'fired',
        firedAt: new Date(),
        wakeAt: new Date(),
      },
    })
  assert.equal(await wakeOnReply(connection, emailPayload('m-d', 'conv-d')), 0)
  const after = await prisma.replyWatch.findUniqueOrThrow({ where: { id: watch!.id } })
  assert.ok(after.until.getTime() <= Date.now())
})

/** The inbox's subscription, with a cursor from before the history the fake Gmail gives. */
async function subscribed() {
  await syncConnection(scope, connection.id)
  const sub = await prisma.subscription.findFirstOrThrow({ where: { connectionId: connection.id } })
  await prisma.subscription.updateMany({ where: { id: sub.id }, data: { cursor: '100' } })
  return sub
}

/** gmail_send as a teammate calls it from this thread; what it answered. */
async function gmailSend(t: Awaited<ReturnType<typeof thread>>, conversation: string) {
  gmail.sendsIn = conversation
  let answer: { ok: boolean; output?: unknown; error?: string } | undefined
  await handleConnectorCall(
    { computerId, ...scope },
    {
      type: 'connector.call',
      callId: randomUUID(),
      // The thread's own teammate.
      sessionId: t.id,
      connectionId: connection.id,
      operation: 'gmail_send',
      input: { to: ['support@ascii.dev'], subject: 'Runner lost', body: 'Details inside.' },
    } as never,
    (message) => {
      if (message.type === 'connector.result') answer = message
    },
  )
  return answer!
}

test(
  'sending again in a conversation whose wait ended reads the inbox again',
  { skip },
  async () => {
    await scoped(scope).grant.upsert({
      where: { teammateId_connectionId: { teammateId, connectionId: connection.id } },
      create: { teammateId, connectionId: connection.id, scope: 'read_write' } as never,
      update: { scope: 'read_write' },
    })
    const t = await thread()
    const first = await gmailSend(t, 'conv-e')
    assert.equal(first.ok, true, first.error)
    assert.match(String((first.output as { replies?: string }).replies), /wakes you/)
    assert.equal(await prisma.subscription.count({ where: { connectionId: connection.id } }), 1)

    // Its wait ends, and the minute tick drops the inbox nothing listens to any more.
    await prisma.replyWatch.updateMany({
      where: { connectionId: connection.id },
      data: { until: new Date() },
    })
    await syncConnection(scope, connection.id)
    assert.equal(await prisma.subscription.count({ where: { connectionId: connection.id } }), 0)

    const again = await gmailSend(t, 'conv-e')
    assert.equal(again.ok, true, again.error)
    assert.equal(await prisma.subscription.count({ where: { connectionId: connection.id } }), 1)
    assert.equal(await prisma.replyWatch.count({ where: { sessionId: t.id } }), 1)
  },
)

test('a wait started while the inbox is being read still gets its reply', { skip }, async () => {
  const t = await thread()
  const sub = await subscribed()
  gmail.onHistory = () => send(t, 'conv-f')
  gmail.history = [
    {
      id: '150',
      messagesAdded: [{ message: { id: 'm-f', threadId: 'conv-f', labelIds: ['INBOX'] } }],
    },
  ]
  gmail.messages['m-f'] = email('m-f', 'conv-f')
  await readInbox(sub.id)
  assert.equal((await replies(t.id)).length, 1)
})

test('a reply a thread waits on starts or continues no trigger thread', { skip }, async () => {
  const db = scoped(scope)
  const trigger = await db.trigger.create({
    data: {
      connectionId: connection.id,
      teammateId,
      label: 'Every email',
      event: 'email_received',
      createdByMemberId: member,
    } as never,
  })
  try {
    const t = await thread()
    await send(t, 'conv-g')
    const sub = await subscribed()
    gmail.history = [
      {
        id: '150',
        messagesAdded: [{ message: { id: 'm-g', threadId: 'conv-g', labelIds: ['INBOX'] } }],
      },
    ]
    gmail.messages['m-g'] = email('m-g', 'conv-g')
    await readInbox(sub.id)
    assert.equal((await replies(t.id)).length, 1)
    // Never offered to the trigger: no thread of its own, nor a ticket saying it could not start one.
    assert.equal(await prisma.session.count({ where: { triggerId: trigger.id } }), 0)
    assert.equal(
      await prisma.auditEntry.count({
        where: { action: 'trigger.received', targetId: trigger.id },
      }),
      0,
    )
    assert.equal(
      await prisma.ticket.count({
        where: { payload: { path: ['triggerId'], equals: trigger.id } },
      }),
      0,
    )
  } finally {
    await db.trigger.deleteMany({ where: { id: trigger.id } })
  }
})

test(
  'a reply read again after its thread stopped waiting still goes to no trigger',
  { skip },
  async () => {
    const db = scoped(scope)
    const trigger = await db.trigger.create({
      data: {
        connectionId: connection.id,
        teammateId,
        label: 'Every email',
        event: 'email_received',
        createdByMemberId: member,
      } as never,
    })
    try {
      const t = await thread()
      const watch = await send(t, 'conv-i')
      const sub = await subscribed()
      // The reply, then an email Gmail fails to give: the read stops and keeps its cursor.
      gmail.history = [
        {
          id: '150',
          messagesAdded: [
            { message: { id: 'm-i', threadId: 'conv-i', labelIds: ['INBOX'] } },
            { message: { id: 'm-i-next', threadId: 'conv-other', labelIds: ['INBOX'] } },
          ],
        },
      ]
      gmail.messages['m-i'] = email('m-i', 'conv-i')
      gmail.failing = new Set(['m-i-next'])
      await assert.rejects(readInbox(sub.id))
      assert.equal((await replies(t.id)).length, 1)

      // The thread stops waiting; the next read gives the reply again, and the other is gone.
      await stopWatching(db, { ...scope, memberId: member }, t, watch!.id)
      gmail.failing = new Set()
      await readInbox(sub.id)
      assert.equal((await replies(t.id)).length, 1)
      assert.equal(
        await prisma.auditEntry.count({
          where: { action: 'trigger.received', targetId: trigger.id },
        }),
        0,
      )
      assert.equal(
        await prisma.ticket.count({
          where: { payload: { path: ['triggerId'], equals: trigger.id } },
        }),
        0,
      )
    } finally {
      await db.trigger.deleteMany({ where: { id: trigger.id } })
    }
  },
)

test(
  'replies waiting for an offline computer count toward the limit in a row',
  { skip },
  async () => {
    const t = await thread()
    const watch = await send(t, 'conv-h')
    // No runner answers here: each reply stays pending, as on a sleeping Mac.
    for (let i = 0; i <= WAKEUPS_IN_A_ROW; i++)
      await wakeOnReply(connection, emailPayload(`m-h-${i}`, 'conv-h'))
    const queued = await replies(t.id)
    assert.equal(queued.length, WAKEUPS_IN_A_ROW)
    assert.ok(queued.every((w) => w.status === 'pending'))
    const after = await prisma.replyWatch.findUniqueOrThrow({ where: { id: watch!.id } })
    assert.ok(after.until.getTime() <= Date.now())
  },
)

test('an inbox nobody waits on any more is no longer read', { skip }, async () => {
  // Every watch of the earlier tests ended, and the connection has no trigger.
  await prisma.replyWatch.updateMany({
    where: { connectionId: connection.id },
    data: { until: new Date() },
  })
  await syncConnection(scope, connection.id)
  assert.equal(await prisma.subscription.count({ where: { connectionId: connection.id } }), 0)
})

/** An email as the inbox reader hands it over. */
function emailPayload(messageId: string, threadId: string) {
  return {
    id: messageId,
    threadId,
    from: 'support@ascii.dev',
    to: 'georges@acme.test',
    subject: 'Re: Runner lost after restart',
    date: undefined,
    snippet: '',
    labels: ['INBOX'],
    cc: undefined,
    body: 'Fixed.',
    attachments: [],
  }
}
