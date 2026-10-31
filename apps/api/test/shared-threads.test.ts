import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import { Hono } from 'hono'

// Who writes in a thread (src/account-sharing.ts, mayWrite): one on the cloud computer runs on
// the workspace's accounts, so every member but a viewer writes in it, answers it and steers it;
// one on a member's own computer stays theirs. A member's own App account still answers only
// what they asked for, and a removed member's threads stay with the team. Against the API's
// development database (apps/api/.env), in an organization of its own removed at the end;
// skipped when no database answers.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

type Sent = { type: string; [key: string]: unknown }

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${what}`)
}

describe('threads others write in', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const people = ['ada', 'bob', 'cat', 'vic'] as const
  type Person = (typeof people)[number]
  const roles: Record<Person, string> = { ada: 'owner', bob: 'member', cat: 'admin', vic: 'viewer' }
  const member = (p: Person) => `m-shared-${p}-${suffix}`
  const user = (p: Person) => `u-shared-${p}-${suffix}`
  const org = `org-shared-${suffix}`
  let workspaceId: string
  let db: ReturnType<typeof scoped>
  let cloud: string
  let adaMac: string
  let riley: string
  let account: string
  let app: Hono
  let as: Person = 'ada'
  let restore: () => void

  before(async () => {
    const { auth } = await import('../src/auth.js')
    const { threads } = await import('../src/routes/threads.js')
    await prisma.organization.create({ data: { id: org, name: 'Shared', slug: org } })
    for (const p of people) {
      await prisma.user.create({ data: { id: user(p), name: p, email: `${user(p)}@test.local` } })
      await prisma.member.create({
        data: { id: member(p), organizationId: org, userId: user(p), role: roles[p] },
      })
    }
    workspaceId = (await prisma.workspace.create({ data: { organizationId: org, name: 'Shared' } }))
      .id
    db = scoped({ organizationId: org, workspaceId })
    cloud = (
      await db.computer.create({
        data: { kind: 'cloud', name: 'Cloud computer', status: 'running' },
      } as never)
    ).id
    adaMac = (
      await db.computer.create({
        data: { kind: 'member_machine', memberId: member('ada'), name: 'Ada’s Mac' },
      } as never)
    ).id
    account = (
      await db.account.create({
        data: {
          memberId: member('ada'),
          computerId: cloud,
          provider: 'claude_code',
          label: 'Claude',
          status: 'ready',
          isDefault: true,
        },
      } as never)
    ).id
    riley = (await db.teammate.create({ data: { name: `Riley ${suffix}` } } as never)).id
    const getSession = auth.api.getSession
    ;(auth.api as { getSession: unknown }).getSession = async () => ({
      user: { id: user(as) },
      session: {
        id: `s-shared-${suffix}`,
        activeOrganizationId: org,
        activeWorkspaceId: workspaceId,
      },
    })
    restore = () => ((auth.api as { getSession: unknown }).getSession = getSession)
    app = new Hono().route('/api/threads', threads)
    app.onError((error, c) =>
      'status' in error
        ? c.json({ error: error.message }, (error as { status: 400 }).status)
        : c.json({ error: String(error) }, 500),
    )
  })

  after(async () => {
    restore?.()
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } })
    await prisma.member.deleteMany({ where: { organizationId: org } })
    await prisma.organization.deleteMany({ where: { id: org } })
    await prisma.user.deleteMany({ where: { id: { in: people.map(user) } } })
  })

  /** A thread `p` started on a computer. */
  async function thread(p: Person, computerId: string, title = 'Launch notes') {
    const session = await db.session.create({
      data: {
        teammateId: riley,
        startedByMemberId: member(p),
        computerId,
        accountId: computerId === cloud ? account : null,
        // As startThread makes a person's thread: their request.
        askedByMemberId: member(p),
        title,
        status: 'idle',
      } as never,
    })
    await db.threadTeammate.create({ data: { sessionId: session.id, teammateId: riley } as never })
    return session.id
  }

  /** The workspace's Gmail App: one per workspace. */
  let gmailAppId: string | undefined
  const gmailAppOnce = async () => ({
    id: (gmailAppId ??= (
      await db.app.create({ data: { key: 'gmail', createdByMemberId: member('ada') } } as never)
    ).id),
  })

  /** A thread from before Session.askedByMemberId was kept. */
  const legacy = async (id: string) => {
    await db.session.updateMany({ where: { id }, data: { askedByMemberId: null } })
    return id
  }

  /** The cloud computer's runner, connected: what it is sent. */
  let runnerId: string | undefined
  async function runner() {
    const { runnerSocket } = await import('../src/hub.js')
    runnerId ??= (
      await db.runner.create({
        data: { computerId: cloud, tokenHash: `hash-${randomUUID()}` },
      } as never)
    ).id
    const row = { id: runnerId }
    const handle = runnerSocket({ id: row.id, computerId: cloud, organizationId: org, workspaceId })
    const sent: Sent[] = []
    const ws = { send: (raw: string) => sent.push(JSON.parse(raw)), close: () => {} }
    handle.onMessage(
      JSON.stringify({
        type: 'hello',
        protocolVersion: 99,
        version: '0.0.0',
        platform: 'linux-x64',
      }),
      ws as never,
    )
    await until(() => sent.some((m) => m.type === 'welcome'), 'the welcome')
    return { sent, close: () => handle.onClose() }
  }

  const call = (p: Person, path: string, init: { method?: string; body?: unknown } = {}) => {
    as = p
    return app.request(`/api/threads${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json' },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    })
  }
  const view = async (p: Person, id: string) =>
    (await (await call(p, `/${id}`)).json()) as { mayPrompt: boolean; othersMayPrompt: boolean }

  test('on the cloud computer every member but a viewer writes; on a Mac, its starter', async () => {
    const shared = await thread('ada', cloud)
    const own = await thread('ada', adaMac)
    assert.equal((await view('bob', shared)).mayPrompt, true)
    assert.equal((await view('bob', shared)).othersMayPrompt, true)
    assert.equal((await view('vic', shared)).mayPrompt, false)
    assert.equal((await view('bob', own)).mayPrompt, false)
    assert.equal((await view('bob', own)).othersMayPrompt, false)
    assert.equal((await view('ada', own)).mayPrompt, true)
    // Its list says so too: who may write renames and archives it.
    as = 'bob'
    const listed = (await (await call('bob', '')).json()) as {
      id: string
      othersMayPrompt: boolean
    }[]
    assert.equal(listed.find((t) => t.id === shared)?.othersMayPrompt, true)
    assert.equal(listed.find((t) => t.id === own)?.othersMayPrompt, false)
  })

  test('another member’s message reaches the teammate, in their name', async () => {
    const shared = await thread('ada', cloud)
    const own = await thread('ada', adaMac)
    const conn = await runner()
    try {
      const sent = await call('bob', `/${shared}/messages`, { body: { text: 'Add the pricing' } })
      assert.equal(sent.status, 200, await sent.clone().text())
      await until(
        () =>
          conn.sent.some(
            (m) =>
              m.type === 'thread.prompt' &&
              m.text === 'Add the pricing' &&
              m.memberId === member('bob'),
          ),
        'the message on the runner',
      )
      // Ada's Mac: hers alone.
      const refused = await call('bob', `/${own}/messages`, { body: { text: 'And here?' } })
      assert.equal(refused.status, 403)
      // Renaming follows who may write; deleting stays its starter's or an admin's.
      assert.equal(
        (await call('bob', `/${shared}/archive`, { body: {} })).status,
        200,
        'archived by bob',
      )
      assert.equal((await call('bob', `/${shared}`, { method: 'DELETE' })).status, 403)
    } finally {
      conn.close()
    }
  })

  test('another member answers the teammate’s question in a shared thread', async () => {
    const { answerQuestion } = await import('../src/decide.js')
    const ask = async (computerId: string) => {
      const id = await thread('ada', computerId)
      const ticket = await db.ticket.create({
        data: {
          sessionId: id,
          type: 'question',
          title: 'Riley asks',
          payload: { source: 'harness', questionId: `q-${randomUUID()}`, questions: [] },
        } as never,
      })
      return ticket.id
    }
    const scope = (p: Person) => ({
      organizationId: org,
      workspaceId,
      userId: user(p),
      memberId: member(p),
      role: roles[p] as 'member',
    })
    const conn = await runner()
    try {
      const shared = await ask(cloud)
      assert.deepEqual(await answerQuestion(scope('bob'), shared, { action: 'declined' }), {
        ok: true,
        live: true,
      })
      await assert.rejects(
        answerQuestion(scope('bob'), await ask(adaMac), { action: 'declined' }),
        {
          status: 403,
        },
      )
      await assert.rejects(answerQuestion(scope('vic'), await ask(cloud), { action: 'declined' }), {
        status: 403,
      })
    } finally {
      conn.close()
    }
  })

  test('a write on a member’s own App account is theirs or an admin’s to allow', async () => {
    const { resolveTicket } = await import('../src/decide.js')
    const id = await thread('ada', cloud)
    const gmailApp = await gmailAppOnce()
    const gmail = await db.connection.create({
      data: {
        appId: gmailApp.id,
        kind: 'gmail',
        label: 'ada@example.com',
        reach: 'mine',
        createdByMemberId: member('ada'),
        status: 'active',
      },
    } as never)
    const approval = await db.ticket.create({
      data: {
        sessionId: id,
        type: 'approval',
        title: 'Riley: send an email',
        payload: { connectionId: gmail.id, operation: 'send', input: {} },
      } as never,
    })
    const scope = (p: Person) => ({
      organizationId: org,
      workspaceId,
      userId: user(p),
      memberId: member(p),
      role: roles[p] as 'member',
    })
    await assert.rejects(resolveTicket(scope('bob'), approval.id, { approved: false }), {
      status: 403,
      message: /another member’s own/,
    })
    // Its owner decides: past the check (denied, so nothing is sent).
    const decided = await resolveTicket(scope('ada'), approval.id, { approved: false }).catch(
      (error: { status?: number }) => error,
    )
    assert.notEqual((decided as { status?: number }).status, 403)
  })

  test('a thread from before: whose request it is, from what people wrote in it', async () => {
    const { askedBy } = await import('../src/thread-spec.js')
    const id = await legacy(await thread('ada', cloud))
    const said = (memberId: string | null, seq: number) =>
      db.sessionEvent.create({
        data: {
          sessionId: id,
          seq,
          type: 'message.user',
          at: new Date(),
          data: { type: 'message.user', text: 'hi', memberId },
        },
      } as never)
    assert.equal(await askedBy(db, id), null)
    await said(member('ada'), 1)
    assert.equal(await askedBy(db, id), member('ada'))
    await said(member('bob'), 2)
    // Brigade's own words after it (a child's report): still Bob's request.
    await said(null, 3)
    assert.equal(await askedBy(db, id), member('bob'))
  })

  test('a thread from before: its starter’s own App is refused for another member’s request', async () => {
    const { handleConnectorCall } = await import('../src/connector-calls.js')
    const id = await legacy(await thread('ada', cloud))
    const gmailApp = await gmailAppOnce()
    const gmail = await db.connection.create({
      data: {
        appId: gmailApp.id,
        kind: 'gmail',
        label: 'ada@example.com',
        reach: 'mine',
        createdByMemberId: member('ada'),
        status: 'active',
      },
    } as never)
    await db.grant.create({
      data: { teammateId: riley, connectionId: gmail.id, scope: 'read' },
    } as never)
    let seq = 0
    const asks = (memberId: string) =>
      db.sessionEvent.create({
        data: {
          sessionId: id,
          seq: ++seq,
          type: 'message.user',
          at: new Date(),
          data: { type: 'message.user', text: 'Any news?', memberId },
        },
      } as never)
    const search = async () => {
      const replies: { error?: string }[] = []
      await handleConnectorCall(
        { computerId: cloud, organizationId: org, workspaceId },
        {
          type: 'connector.call',
          callId: `call-${randomUUID()}`,
          sessionId: id,
          teammateId: riley,
          connectionId: gmail.id,
          operation: 'gmail_search',
          input: { query: 'is:unread' },
        },
        (message) => void replies.push(message as { error?: string }),
      )
      return replies[0]?.error ?? ''
    }
    await asks(member('bob'))
    assert.match(await search(), /they alone ask/)
    // Ada asking: past this check (it fails further on, with no token to call Gmail with).
    await asks(member('ada'))
    assert.doesNotMatch(await search(), /they alone ask/)
  })

  const privateGmail = async () => {
    const gmailApp = await gmailAppOnce()
    const connection = await db.connection.create({
      data: {
        appId: gmailApp.id,
        kind: 'gmail',
        label: 'private-ada@example.com',
        reach: 'mine',
        createdByMemberId: member('ada'),
        status: 'active',
      },
    } as never)
    await db.grant.create({
      data: { teammateId: riley, connectionId: connection.id, scope: 'read' },
    } as never)
    return connection.id
  }
  const searchPrivate = async (id: string, connectionId: string) => {
    const { handleConnectorCall } = await import('../src/connector-calls.js')
    const replies: { ok: boolean; error?: string }[] = []
    await handleConnectorCall(
      { computerId: cloud, organizationId: org, workspaceId },
      {
        type: 'connector.call',
        callId: randomUUID(),
        sessionId: id,
        teammateId: riley,
        connectionId,
        operation: 'gmail_search',
        input: { query: 'is:unread' },
      },
      (m) => void replies.push(m as never),
    )
    return replies[0]?.error ?? ''
  }
  const say = (id: string, seq: number, type: string, memberId: string | null) =>
    db.sessionEvent.create({
      data: {
        sessionId: id,
        seq,
        type,
        at: new Date(),
        data: { type, memberId, text: 'Read the inbox', questionId: 'q' },
      },
    } as never)

  test('a thread from before: answering the teammate is asking it too', async () => {
    const id = await legacy(await thread('ada', cloud))
    const connectionId = await privateGmail()
    await say(id, 1, 'message.user', member('ada'))
    assert.doesNotMatch(await searchPrivate(id, connectionId), /they alone ask/)
    let seq = 1
    for (const type of ['question.answered', 'ticket.answered', 'approval.resolved']) {
      await say(id, ++seq, type, member('bob'))
      assert.match(await searchPrivate(id, connectionId), /they alone ask/, type)
      await say(id, ++seq, 'message.user', member('ada'))
    }
  })

  test('once another member takes part, the starter’s own Apps stay out, and of what it passes on', async () => {
    const id = await thread('ada', cloud)
    const connectionId = await privateGmail()
    const { handleChildCall, messageChild } = await import('../src/children.js')
    const { loadThread, askedBy, SEVERAL_ASKERS } = await import('../src/thread-spec.js')
    const startChild = async () => {
      const result = (await handleChildCall(
        db,
        { organizationId: org, workspaceId },
        await loadThread(db, id),
        { id: riley, name: 'Riley' },
        { name: 'start_child', title: 'Read the inbox', instructions: 'Read it', wait: false },
      )) as { threadId?: string }
      assert.ok(result.threadId, JSON.stringify(result))
      return result.threadId
    }
    const conn = await runner()
    try {
      // Ada's alone: her Gmail answers, in the thread and in a child it starts.
      assert.doesNotMatch(await searchPrivate(id, connectionId), /they alone ask/)
      const hers = await startChild()
      assert.equal(await askedBy(db, hers), member('ada'))
      assert.doesNotMatch(await searchPrivate(hers, connectionId), /they alone ask/)
      // Bob asks too: no longer, whatever Ada writes after (queued behind his turn, say).
      const asked = await call('bob', `/${id}/messages`, { body: { text: 'Read the inbox' } })
      assert.equal(asked.status, 200, await asked.clone().text())
      assert.equal(
        (await call('ada', `/${id}/messages`, { body: { text: 'Unrelated' } })).status,
        200,
      )
      assert.equal(await askedBy(db, id), SEVERAL_ASKERS)
      assert.match(await searchPrivate(id, connectionId), /they alone ask/)
      // The child started before keeps working for Ada alone; a new one does not.
      assert.doesNotMatch(await searchPrivate(hers, connectionId), /they alone ask/)
      assert.match(await searchPrivate(await startChild(), connectionId), /they alone ask/)
      // What the parent passes on now (message_thread) brings the others in.
      const passed = await messageChild(
        db,
        { organizationId: org, workspaceId },
        { id, title: 'Launch notes' },
        { id: riley, name: 'Riley' },
        hers,
        'Check the inbox',
      )
      assert.ok('ok' in passed, JSON.stringify(passed))
      assert.match(await searchPrivate(hers, connectionId), /they alone ask/)
    } finally {
      conn.close()
    }
  })

  test('an answer to the teammate is taking part', async () => {
    const { answerQuestion } = await import('../src/decide.js')
    const { askedBy, SEVERAL_ASKERS } = await import('../src/thread-spec.js')
    const id = await thread('ada', cloud)
    const ask = () =>
      db.ticket.create({
        data: {
          sessionId: id,
          type: 'question',
          title: 'Riley asks',
          payload: {
            source: 'harness',
            questionId: `q-${randomUUID()}`,
            questions: [{ id: 'q', question: 'Which inbox?', options: [{ id: 'a', label: 'A' }] }],
          },
        } as never,
      })
    const scope = {
      organizationId: org,
      workspaceId,
      userId: user('bob'),
      memberId: member('bob'),
      role: 'member' as const,
    }
    const conn = await runner()
    try {
      // Declining asks for nothing.
      await answerQuestion(scope, (await ask()).id, { action: 'declined' })
      assert.equal(await askedBy(db, id), member('ada'))
      await answerQuestion(scope, (await ask()).id, {
        action: 'answered',
        answers: { q: { optionIds: ['a'] } },
      } as never)
      assert.equal(await askedBy(db, id), SEVERAL_ASKERS)
    } finally {
      conn.close()
    }
  })

  test('two members taking part at once in a thread from before both count', async () => {
    const { noteAsker, askedBy, SEVERAL_ASKERS } = await import('../src/thread-spec.js')
    for (const order of [
      ['ada', 'bob'],
      ['bob', 'ada'],
      ['ada', 'bob'],
      ['bob', 'ada'],
    ] as const) {
      const id = await legacy(await thread('ada', cloud))
      await say(id, 1, 'message.user', member('ada'))
      // Both wait on the row, held from another connection, then go at once.
      let both!: Promise<unknown>
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${id} FOR UPDATE`
        both = Promise.all(order.map((p) => noteAsker(db, id, member(p))))
        await new Promise((resolve) => setTimeout(resolve, 300))
      })
      await both
      assert.equal(await askedBy(db, id), SEVERAL_ASKERS)
    }
  })

  test('a decline with a note is taking part; a bare one is not', async () => {
    const { answerQuestion, answerTicket } = await import('../src/decide.js')
    const { askedBy, SEVERAL_ASKERS } = await import('../src/thread-spec.js')
    const scope = {
      organizationId: org,
      workspaceId,
      userId: user('bob'),
      memberId: member('bob'),
      role: 'member' as const,
    }
    const conn = await runner()
    try {
      for (const type of ['question', 'request'] as const)
        for (const note of [undefined, 'Instead, search her inbox.']) {
          const id = await thread('ada', cloud)
          const ticket = await db.ticket.create({
            data: {
              sessionId: id,
              type,
              title: 'Which inbox?',
              payload:
                type === 'question'
                  ? { source: 'harness', questionId: randomUUID(), questions: [] }
                  : { source: 'harness', requestId: randomUUID(), asks: [] },
            },
          } as never)
          const answer = { action: 'declined' as const, ...(note ? { note } : {}) }
          if (type === 'question') await answerQuestion(scope, ticket.id, answer)
          else await answerTicket(scope, ticket.id, answer)
          assert.equal(
            await askedBy(db, id),
            note ? SEVERAL_ASKERS : member('ada'),
            `${type}, ${note ? 'with' : 'without'} a note`,
          )
        }
    } finally {
      conn.close()
    }
  })

  test('another member’s queued message is theirs to change; anyone steers it', async () => {
    const id = await thread('ada', cloud)
    const messageId = `msg-${suffix}`
    await db.sessionEvent.create({
      data: {
        sessionId: id,
        seq: 1,
        type: 'message.queued',
        at: new Date(),
        data: { type: 'message.queued', messageId, text: 'Ship it', memberId: member('ada') },
      },
    } as never)
    const edit = await call('bob', `/${id}/messages/${messageId}`, {
      body: { action: 'edit', text: 'Wait' },
    })
    assert.equal(edit.status, 403)
    assert.match(((await edit.json()) as { error: string }).error, /only they can change it/)
  })

  test('settling a thread from before needs no second connection from a full pool', async () => {
    const { newPrismaClient, withPrismaClient } = await import('../src/db.js')
    const { noteAsker } = await import('../src/thread-spec.js')
    const id = await legacy(await thread('ada', cloud))
    await say(id, 1, 'message.user', member('ada'))
    const url = new URL(process.env.DATABASE_URL!)
    const name = `review-note-${suffix}`
    url.searchParams.set('application_name', name)
    const limited = newPrismaClient(url.toString(), { max: 3 })
    let results!: Promise<PromiseSettledResult<unknown>[]>
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${id} FOR UPDATE`
        results = withPrismaClient(limited, () => {
          const limitedDb = scoped({ organizationId: org, workspaceId })
          return Promise.allSettled(
            ['ada', 'bob', 'ada'].map((p) => noteAsker(limitedDb, id, member(p as Person))),
          )
        })
        let waiting = 0
        for (let i = 0; i < 150; i++) {
          const rows = await tx.$queryRaw<
            { n: bigint }[]
          >`SELECT count(*) as n FROM pg_stat_activity WHERE application_name = ${name} AND wait_event_type = 'Lock'`
          waiting = Number(rows[0]?.n)
          if (waiting === 3) break
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        assert.equal(waiting, 3, 'all three transaction connections wait on the same row')
      })
      const settled = await results
      assert.deepEqual(
        settled.map((r) => r.status),
        ['fulfilled', 'fulfilled', 'fulfilled'],
      )
    } finally {
      await results?.catch(() => {})
      await limited.$disconnect()
    }
  })

  test('a removed member’s threads stay with the team, but those on their own computer', async () => {
    const { removeMember } = await import('../src/member-remove.js')
    const mac = (
      await db.computer.create({
        data: { kind: 'member_machine', memberId: member('bob'), name: 'Bob’s Mac' },
      } as never)
    ).id
    const kept = await thread('bob', cloud, 'Pricing page')
    const gone = await thread('bob', mac, 'On his Mac')
    // A child of the one on his Mac, moved to the cloud computer: kept, on its own.
    const child = await thread('bob', cloud, 'Child on the cloud computer')
    await db.session.updateMany({ where: { id: child }, data: { parentId: gone, origin: 'child' } })
    await removeMember(
      user('bob'),
      { id: member('bob'), role: 'member', organizationId: org, organization: { name: 'Shared' } },
      { actor: { type: 'member', id: member('cat') }, reason: 'removed', handTo: member('cat') },
    )
    const row = await db.session.findFirst({ where: { id: kept } })
    assert.equal(row?.startedByMemberId, member('cat'))
    assert.equal(await db.session.count({ where: { id: gone } }), 0)
    const orphan = await db.session.findFirst({ where: { id: child } })
    assert.equal(orphan?.startedByMemberId, member('cat'))
    assert.equal(orphan?.parentId, null)
  })
})
