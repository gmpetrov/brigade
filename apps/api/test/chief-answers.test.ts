import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import { Hono } from 'hono'
import { sessionStub } from './session-stub.js'

// Chief answers for the person (src/chief-answers.ts, docs/chief-answers.md): a question a
// teammate ends on goes to Chief first, in a sub-thread of its own; its decision shows as a
// suggestion, or reaches the teammate in the person's name for the kinds they let it; their own
// answers measure it; App writes made on its word ask them. Against the API's development
// database (apps/api/.env), in an organization of its own removed at the end; skipped when no
// database answers.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
// The parked list's bytes, in a folder of the test's own.
process.env.BUCKET_DIR = mkdtempSync(join(tmpdir(), 'chief-answers-'))

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

const chiefAnswers = await import('../src/chief-answers.js')
const contracts = await import('@brigade/contracts')

type Sent = { type: string; [key: string]: unknown }

const until = async (check: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 250; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${what}`)
}

describe('Chief answers for the person', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const org = `org-chief-${suffix}`
  const people = ['ada', 'bob'] as const
  type Person = (typeof people)[number]
  const member = (p: Person) => `m-chief-${p}-${suffix}`
  const user = (p: Person) => `u-chief-${p}-${suffix}`
  let workspaceId: string
  let scope: { organizationId: string; workspaceId: string }
  let db: ReturnType<typeof scoped>
  let cloud: string
  let account: string
  let riley: string
  let chief: string
  let app: Hono
  let as: Person = 'ada'
  let restore: () => void

  before(async () => {
    const { auth } = await import('../src/auth.js')
    const { threads } = await import('../src/routes/threads.js')
    await prisma.organization.create({ data: { id: org, name: 'Chief', slug: org } })
    for (const p of people) {
      await prisma.user.create({
        data: { id: user(p), name: p === 'ada' ? 'Ada' : 'Bob', email: `${user(p)}@test.local` },
      })
      await prisma.member.create({
        data: {
          id: member(p),
          organizationId: org,
          userId: user(p),
          role: p === 'ada' ? 'owner' : 'member',
        },
      })
    }
    workspaceId = (await prisma.workspace.create({ data: { organizationId: org, name: 'Chief' } }))
      .id
    scope = { organizationId: org, workspaceId }
    db = scoped(scope)
    cloud = (
      await db.computer.create({
        data: { kind: 'cloud', name: 'Cloud computer', status: 'running' },
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
    chief = (await db.teammate.create({ data: { name: 'Chief', kind: 'chief' } } as never)).id
    const getSession = auth.api.getSession
    ;(auth.api as { getSession: unknown }).getSession = sessionStub(() => ({
      user: { id: user(as) },
      session: {
        id: `s-chief-${suffix}`,
        activeOrganizationId: org,
        activeWorkspaceId: workspaceId,
      },
    }))
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

  const setMember = (data: { chiefAnswers?: boolean; chiefAuto?: string[] }, p: Person = 'ada') =>
    prisma.member.update({ where: { id: member(p) }, data })

  /** A thread Ada started with Riley on the cloud computer: her request. */
  async function thread() {
    const session = await db.session.create({
      data: {
        teammateId: riley,
        startedByMemberId: member('ada'),
        computerId: cloud,
        accountId: account,
        askedByMemberId: member('ada'),
        title: `Admin page ${randomUUID().slice(0, 4)}`,
        status: 'idle',
      } as never,
    })
    await db.threadTeammate.create({ data: { sessionId: session.id, teammateId: riley } as never })
    return session.id
  }

  /** An event of the thread, after the others: its seq. */
  async function say(sessionId: string, event: Record<string, unknown>) {
    const last = await db.sessionEvent.findFirst({
      where: { sessionId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    })
    const seq = (last?.seq ?? 0) + 1
    await db.sessionEvent.create({
      data: {
        sessionId,
        seq,
        type: event.type as string,
        at: new Date(),
        data: { at: new Date().toISOString(), ...event },
      },
    } as never)
    return seq
  }

  const person = (sessionId: string, text: string, p: Person = 'ada') =>
    say(sessionId, { type: 'message.user', text, memberId: member(p) })

  /** Ada asked; Riley's turn ended on these buttons, or a choices card: the card's seq. */
  async function asks(
    sessionId: string,
    replies: string[] = ['Build it', 'Not yet'],
    options: { teammateId?: string; choices?: boolean } = {},
  ) {
    await person(sessionId, 'Add the migration for the admin page.')
    await say(sessionId, {
      type: 'turn.started',
      teammateId: options.teammateId ?? riley,
      accountId: account,
    })
    await say(sessionId, {
      type: 'message.done',
      id: `m-${randomUUID()}`,
      text: 'The migration is ready. Shall I build the admin page too?',
    })
    const toolCallId = `t-${randomUUID()}`
    const card = await say(
      sessionId,
      options.choices
        ? {
            type: 'tool.started',
            toolCallId,
            toolName: 'offer_choices',
            input: {
              question: 'Which layout?',
              options: replies.map((label, i) => ({ id: `o${i}`, label })),
            },
          }
        : { type: 'tool.started', toolCallId, toolName: 'suggest_replies', input: { replies } },
    )
    await say(sessionId, {
      type: 'tool.finished',
      toolCallId,
      toolName: 'x',
      output: {},
      isError: false,
    })
    await say(sessionId, { type: 'turn.completed', finishReason: 'stop' })
    return card
  }

  const ended = (id: string) =>
    chiefAnswers.noteChiefAsks({ id, organizationId: org, workspaceId }, true)

  /** A decision Chief is making on the thread's question, with its decision thread, made here. */
  async function pending(sessionId: string, askSeq: number, replies = ['Build it', 'Not yet']) {
    const childSessionId = `c${randomUUID().replace(/-/g, '').slice(0, 24)}`
    const decision = await db.chiefDecision.create({
      data: {
        sessionId,
        memberId: member('ada'),
        teammateId: riley,
        askSeq,
        options: replies.map((r) => ({ label: r, message: r })),
        childSessionId,
      },
    } as never)
    const child = await db.session.create({
      data: {
        id: childSessionId,
        teammateId: chief,
        startedByMemberId: member('ada'),
        computerId: cloud,
        accountId: account,
        title: 'Chief’s decision',
        status: 'running',
        origin: 'child',
        parentId: sessionId,
        parentTeammateId: riley,
        chiefDecisionId: decision.id,
      } as never,
    })
    await db.threadTeammate.create({ data: { sessionId: child.id, teammateId: chief } as never })
    return { decision, child }
  }

  const decide = async (
    made: Awaited<ReturnType<typeof pending>>,
    op: Partial<{
      verdict: string
      option: number
      kind: string
      reason: string
      basis: string
      parked: string
    }>,
  ) =>
    (await chiefAnswers.handleChiefCall(db, scope, made.child, { id: chief, kind: 'chief' }, {
      name: 'chief_decide',
      verdict: 'answer',
      kind: 'next_step',
      reason: 'It serves this week’s launch, and it is a pull request.',
      ...op,
    } as never)) as { status?: string; recorded?: boolean; error?: string }

  const row = (id: string) => db.chiefDecision.findFirstOrThrow({ where: { id } })

  /** The cloud computer's runner, connected: what it is sent. */
  let runnerId: string | undefined
  async function runner() {
    const { runnerSocket } = await import('../src/hub.js')
    runnerId ??= (
      await db.runner.create({
        data: { computerId: cloud, tokenHash: `hash-${randomUUID()}` },
      } as never)
    ).id
    const handle = runnerSocket({
      id: runnerId,
      computerId: cloud,
      organizationId: org,
      workspaceId,
    })
    const sent: Sent[] = []
    const ws = { send: (raw: string) => sent.push(JSON.parse(raw)), close: () => {} }
    // Its hello, done once what waited for it was sent (flushQueue).
    const hello = Promise.resolve(
      handle.onMessage(
        JSON.stringify({
          type: 'hello',
          protocolVersion: 99,
          version: '0.0.0',
          platform: 'linux-x64',
        }),
        ws as never,
      ),
    )
    await until(() => sent.some((m) => m.type === 'welcome'), 'the welcome')
    return { sent, hello, close: () => handle.onClose() }
  }

  const call = (p: Person, path: string, init: { method?: string; body?: unknown } = {}) => {
    as = p
    return app.request(`/api/threads${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json' },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    })
  }

  test('off, nothing starts; on, Chief reads the question in a decision thread with no App', async () => {
    const { loadThread, specFor } = await import('../src/thread-spec.js')
    const id = await thread()
    const card = await asks(id)
    await setMember({ chiefAnswers: false })
    await ended(id)
    assert.equal(await db.chiefDecision.count({ where: { sessionId: id } }), 0)
    // Off, the spec says nothing of it either.
    assert.equal(
      (await specFor(db, await loadThread(db, id), { teammate: undefined })).chiefAnswers,
      false,
    )

    await setMember({ chiefAnswers: true })
    const conn = await runner()
    try {
      await ended(id)
      const decision = await db.chiefDecision.findFirstOrThrow({ where: { sessionId: id } })
      assert.equal(decision.askSeq, card)
      assert.equal(decision.teammateId, riley)
      assert.equal(decision.memberId, member('ada'))
      assert.deepEqual(decision.options, [
        { label: 'Build it', message: 'Build it' },
        { label: 'Not yet', message: 'Not yet' },
      ])
      await until(
        () =>
          conn.sent.some(
            (m) =>
              m.type === 'thread.prompt' &&
              (m.thread as { decision?: { id: string } })?.decision?.id === decision.id,
          ),
        "Chief's decision thread on the runner",
      )
      const prompt = conn.sent.find(
        (m) => m.type === 'thread.prompt' && (m.thread as { decision?: unknown }).decision,
      )!
      assert.match(prompt.text as string, /^Decide for the person: /)
      assert.match(prompt.text as string, /## The answers it offers\n1\. Build it\n2\. Not yet/)
      assert.match(prompt.text as string, /Add the migration for the admin page\./)
      assert.equal(prompt.memberId, null)
      // Its thread: a sub-thread of Chief's, shown as the decision, with no App and nobody to bring in.
      const child = await loadThread(db, decision.childSessionId)
      assert.equal(child.parentId, id)
      assert.equal(child.teammateId, chief)
      assert.equal(child.chiefDecisionId, decision.id)
      const spec = await specFor(db, child)
      assert.deepEqual(spec.connectors, [])
      assert.deepEqual(spec.roster, [])
      assert.equal(spec.decision?.id, decision.id)
      assert.equal(spec.git, undefined)
      // The teammate's own spec, now: it is told what Chief's answers are.
      assert.equal((await specFor(db, await loadThread(db, id))).chiefAnswers, true)
      // The same end noted again: one decision.
      await ended(id)
      assert.equal(await db.chiefDecision.count({ where: { sessionId: id } }), 1)
      // The thread shows it on its question, not among its sub-threads.
      const view = (await (await call('ada', `/${id}`)).json()) as {
        children: { id: string }[]
        chiefDecisions: { id: string; status: string; askSeq: number }[]
      }
      assert.deepEqual(view.children, [])
      assert.deepEqual(
        view.chiefDecisions.map((d) => [d.id, d.status, d.askSeq]),
        [[decision.id, 'pending', card]],
      )
    } finally {
      conn.close()
    }
  })

  test('no decision for Chief’s own question, one already answered, or a thread another asks in', async () => {
    await setMember({ chiefAnswers: true })
    const own = await thread()
    await db.threadTeammate.create({ data: { sessionId: own, teammateId: chief } as never })
    await asks(own, ['Yes', 'No'], { teammateId: chief })
    await ended(own)
    const answered = await thread()
    await asks(answered)
    await person(answered, 'Build it')
    await ended(answered)
    const shared = await thread()
    await asks(shared)
    await db.session.updateMany({ where: { id: shared }, data: { askedByMemberId: '*' } })
    await ended(shared)
    assert.equal(
      await db.chiefDecision.count({ where: { sessionId: { in: [own, answered, shared] } } }),
      0,
    )
  })

  test('its pick shows as a suggestion, and the person’s own pick measures it', async () => {
    await setMember({ chiefAnswers: true, chiefAuto: [] })
    const id = await thread()
    const card = await asks(id)
    const made = await pending(id, card)
    assert.equal(
      (await decide(made, { option: 1, basis: 'This week: the launch.' })).status,
      'suggested',
    )
    const d = await row(made.decision.id)
    assert.equal(d.verdict, 'answer')
    assert.equal(d.kind, 'next_step')
    assert.equal(d.optionIndex, 0)
    // Nothing reached the teammate.
    assert.equal(await db.wakeup.count({ where: { sessionId: id } }), 0)
    // Deciding twice changes nothing.
    assert.equal((await decide(made, { option: 2 })).recorded, false)
    const views = await chiefAnswers.threadDecisions(db, id)
    assert.equal(views[0]!.option?.label, 'Build it')
    assert.equal(views[0]!.basis, 'This week: the launch.')
    // Ada takes it.
    const seq = await person(id, 'Build it')
    await chiefAnswers.noteChiefAnswered({ id, organizationId: org, workspaceId, parentId: null }, [
      { seq, event: { type: 'message.user', memberId: member('ada'), text: 'Build it' } },
    ])
    assert.equal((await row(made.decision.id)).outcome, 'agreed')

    // Another question, another pick: not agreed.
    const next = await asks(id)
    const other = await pending(id, next)
    await decide(other, { option: 1 })
    const then = await person(id, 'Not yet')
    await chiefAnswers.noteChiefAnswered({ id, organizationId: org, workspaceId, parentId: null }, [
      { seq: then, event: { type: 'message.user', memberId: member('ada'), text: 'Not yet' } },
    ])
    assert.equal((await row(other.decision.id)).outcome, 'disagreed')
  })

  test('a choice it would pick is taken by the same click', async () => {
    await setMember({ chiefAnswers: true, chiefAuto: [] })
    const id = await thread()
    const card = await asks(id, ['A · Bold', 'B · Calm'], { choices: true })
    const made = await pending(id, card, [])
    await db.chiefDecision.updateMany({
      where: { id: made.decision.id },
      data: {
        options: ['A · Bold', 'B · Calm'].map((label) => ({
          label,
          message: contracts.choiceMessage({ label }),
        })),
      },
    })
    await decide(made, { option: 2, kind: 'approach' })
    const seq = await person(id, 'Go with B · Calm')
    await chiefAnswers.noteChiefAnswered({ id, organizationId: org, workspaceId, parentId: null }, [
      { seq, event: { type: 'message.user', memberId: member('ada'), text: 'Go with B · Calm' } },
    ])
    assert.equal((await row(made.decision.id)).outcome, 'agreed')
  })

  test('left to the person, or moot once they answered first', async () => {
    await setMember({ chiefAnswers: true, chiefAuto: ['next_step'] })
    const id = await thread()
    const made = await pending(id, await asks(id))
    assert.equal(
      (
        await decide(made, {
          verdict: 'escalate',
          option: 2,
          kind: 'taste',
          reason: 'It is the look.',
        })
      ).status,
      'escalated',
    )
    assert.equal((await row(made.decision.id)).optionIndex, 1)
    assert.equal(await db.wakeup.count({ where: { sessionId: id } }), 0)

    const late = await pending(id, await asks(id))
    await person(id, 'Not yet')
    assert.equal((await decide(late, { option: 1 })).status, 'superseded')
    assert.equal(await db.wakeup.count({ where: { sessionId: id } }), 0)
    // Answering needs an answer.
    const third = await pending(id, await asks(id))
    assert.match((await decide(third, { option: 3 })).error ?? '', /option is 1 to 2/)
    assert.match((await decide(third, { option: undefined })).error ?? '', /Give option/)
  })

  test('for a kind it may answer alone, the answer reaches the teammate in the person’s name', async () => {
    await setMember({ chiefAnswers: true, chiefAuto: ['next_step'] })
    const id = await thread()
    const made = await pending(id, await asks(id))
    const conn = await runner()
    try {
      assert.equal(
        (await decide(made, { option: 1, basis: 'This week: the launch.' })).status,
        'answered',
      )
      const wakeup = await db.wakeup.findFirstOrThrow({ where: { sessionId: id } })
      assert.equal(wakeup.kind, 'report')
      assert.equal(wakeup.teammateId, riley)
      assert.equal(wakeup.sourceId, `chief:${made.decision.id}`)
      await until(
        () =>
          conn.sent.some(
            (m) =>
              m.type === 'thread.prompt' && contracts.chiefAnswerNote(m.text as string) !== null,
          ),
        'the answer on the runner',
      )
      const prompt = conn.sent.find(
        (m) => m.type === 'thread.prompt' && contracts.chiefAnswerNote(m.text as string),
      )!
      assert.equal(prompt.memberId, null)
      assert.deepEqual(contracts.chiefAnswerNote(prompt.text as string), {
        answer: 'Build it',
        reason: 'It serves this week’s launch, and it is a pull request.',
        basis: 'This week: the launch.',
        decisionId: made.decision.id,
      })
    } finally {
      conn.close()
    }
  })

  test('a parked proposal goes to the person’s list once answered', async () => {
    await setMember({ chiefAnswers: true, chiefAuto: ['priority'] })
    const id = await thread()
    const made = await pending(id, await asks(id))
    const conn = await runner()
    try {
      assert.equal(
        (
          await decide(made, {
            verdict: 'park',
            option: 2,
            kind: 'priority',
            parked: 'An admin page',
          })
        ).status,
        'answered',
      )
    } finally {
      conn.close()
    }
    const list = await db.document.findFirst({
      where: { kind: 'library', path: contracts.PARKED_PATH, deletedAt: null },
    })
    assert.ok(list, 'chief/parked.md made')
    const items = await db.listItem.findMany({ where: { documentId: list!.id } })
    assert.equal(items.length, 1)
    assert.match(items[0]!.text, /^An admin page \(from “Admin page/)
  })

  test('after three answers in a row, the question is the person’s', async () => {
    await setMember({ chiefAnswers: true, chiefAuto: ['next_step'] })
    const id = await thread()
    const card = await asks(id)
    // Three answers of Chief's on questions since Ada last wrote.
    for (let i = 1; i <= contracts.CHIEF_ANSWERS_IN_A_ROW; i++) {
      const made = await pending(id, card + 1000 + i)
      await db.chiefDecision.updateMany({
        where: { id: made.decision.id },
        data: { status: 'answered' },
      })
    }
    const fourth = await pending(id, card + 2000)
    assert.equal((await decide(fourth, { option: 1 })).status, 'suggested')
    // Nor does a new decision start.
    const before = await db.chiefDecision.count({ where: { sessionId: id } })
    await ended(id)
    assert.equal(await db.chiefDecision.count({ where: { sessionId: id } }), before)
  })

  test('nine of ten picks taken: one ticket offers to let it answer that kind alone, the person’s to decide', async () => {
    await setMember({ chiefAnswers: true, chiefAuto: [] })
    const id = await thread()
    for (let i = 0; i < contracts.CHIEF_PROMOTION.decisions; i++) {
      const made = await pending(id, await asks(id))
      await decide(made, { option: 1, kind: 'approach' })
      const text = i === 3 ? 'Not yet' : 'Build it'
      const seq = await person(id, text)
      await chiefAnswers.noteChiefAnswered(
        { id, organizationId: org, workspaceId, parentId: null },
        [{ seq, event: { type: 'message.user', memberId: member('ada'), text } }],
      )
    }
    const offers = await db.ticket.findMany({
      where: { sessionId: id, type: 'approval', status: 'open' },
    })
    assert.equal(offers.length, 1)
    assert.deepEqual((offers[0]!.payload as { chiefPromotion: unknown }).chiefPromotion, {
      memberId: member('ada'),
      kind: 'approach',
      agreed: 9,
      decided: 10,
    })
    const { resolveTicket } = await import('../src/decide.js')
    const as = (p: Person) => ({
      ...scope,
      userId: user(p),
      memberId: member(p),
      role: p === 'ada' ? 'owner' : 'member',
    })
    await assert.rejects(resolveTicket(as('bob') as never, offers[0]!.id, { approved: true }), {
      status: 403,
    })
    await resolveTicket(as('ada') as never, offers[0]!.id, { approved: true })
    const ada = await prisma.member.findUniqueOrThrow({ where: { id: member('ada') } })
    assert.deepEqual(ada.chiefAuto, ['approach'])
    assert.equal(
      (await db.ticket.findFirstOrThrow({ where: { id: offers[0]!.id } })).status,
      'approved',
    )
  })

  /** A Gmail account Riley may write to, its writes allowed without asking. */
  async function gmailFor(teammateId: string) {
    // The workspace's Gmail App: one per workspace.
    const gmailApp =
      (await db.app.findFirst({ where: { key: 'gmail' } })) ??
      (await db.app.create({ data: { key: 'gmail', createdByMemberId: member('ada') } } as never))
    const gmail = await db.connection.create({
      data: {
        appId: gmailApp.id,
        kind: 'gmail',
        label: `team-${randomUUID().slice(0, 4)}@example.com`,
        status: 'active',
        createdByMemberId: member('ada'),
      },
    } as never)
    await db.grant.create({
      data: { teammateId, connectionId: gmail.id, scope: 'read_write' },
    } as never)
    return gmail.id
  }

  /** A write of Riley's in a thread: the approval tickets it opened there. */
  async function labels(sessionId: string, connectionId: string) {
    const { handleConnectorCall } = await import('../src/connector-calls.js')
    await handleConnectorCall(
      { computerId: cloud, organizationId: org, workspaceId },
      {
        type: 'connector.call',
        callId: `call-${randomUUID()}`,
        sessionId,
        teammateId: riley,
        connectionId,
        operation: 'gmail_modify_labels',
        input: { messageId: 'm1', addLabelIds: ['STARRED'] },
      },
      () => {},
    )
    return db.ticket.findMany({ where: { sessionId, type: 'approval', status: 'open' } })
  }

  /** Chief answered in the thread, in Ada's name: its work goes on Chief's word. */
  async function answered(id: string) {
    await setMember({ chiefAnswers: true, chiefAuto: ['next_step'] })
    const made = await pending(id, await asks(id))
    const conn = await runner()
    try {
      assert.equal((await decide(made, { option: 1 })).status, 'answered')
    } finally {
      conn.close()
    }
    return made
  }

  const answer = (id: string, text: string) =>
    person(id, text).then((seq) =>
      chiefAnswers.noteChiefAnswered({ id, organizationId: org, workspaceId, parentId: null }, [
        { seq, event: { type: 'message.user', memberId: member('ada'), text } },
      ]),
    )

  test('App writes made on Chief’s word ask the person, whatever comes in meanwhile, until they write', async () => {
    const id = await thread()
    const gmail = await gmailFor(riley)
    // Riley's access lets it write: it goes ahead (and fails here, with no Google token).
    await person(id, 'Star the mail from Acme.')
    assert.equal((await labels(id, gmail)).length, 0)

    await answered(id)
    const session = await db.session.findFirstOrThrow({ where: { id } })
    assert.ok(chiefAnswers.onChiefsWord(session))
    // Brigade's notes meanwhile, as many as they come (reports, wake-ups): still Chief's word.
    for (let i = 0; i < 55; i++)
      await say(id, { type: 'message.user', memberId: null, text: `A sub-thread's report ${i}` })
    const tickets = await labels(id, gmail)
    assert.equal(tickets.length, 1)
    assert.match(
      (tickets[0]!.payload as { reason: string }).reason,
      /acts on Chief's answer in your name/,
    )
    // Opening a pull request stays as its access says; merging does not.
    assert.ok(chiefAnswers.UNDOABLE_WRITES.has('github_create_pull_request'))
    assert.ok(!chiefAnswers.UNDOABLE_WRITES.has('github_merge_pull_request'))

    // Ada writes: her word again.
    await answer(id, 'Go on.')
    assert.equal(
      chiefAnswers.onChiefsWord(await db.session.findFirstOrThrow({ where: { id } })),
      false,
    )
  })

  test('work handed on from Chief’s word goes on it too: a sub-thread, a thread, a message', async () => {
    const { loadThread } = await import('../src/thread-spec.js')
    const { handleChildCall } = await import('../src/children.js')
    const id = await thread()
    const gmail = await gmailFor(riley)
    await answered(id)
    const conn = await runner()
    try {
      const parent = await loadThread(db, id)
      const started = (await handleChildCall(db, scope, parent, parent.teammate, {
        name: 'start_child',
        title: 'Process the mailbox',
        instructions: 'Star the mail from Acme.',
        wait: true,
      })) as { threadId?: string; error?: string }
      assert.ok(started.threadId, JSON.stringify(started))
      const child = await db.session.findFirstOrThrow({ where: { id: started.threadId } })
      assert.ok(chiefAnswers.onChiefsWord(child))
      // Its write asks, though no Chief answer is in its own events.
      assert.equal((await labels(child.id, gmail)).length, 1)

      // A message to a sub-thread started before carries it there too.
      await db.session.updateMany({ where: { id: child.id }, data: { chiefWordSeq: null } })
      const { messageChild } = await import('../src/children.js')
      const sent = await messageChild(
        db,
        scope,
        await db.session.findFirstOrThrow({ where: { id } }),
        { id: riley, name: 'Riley' },
        child.id,
        'Archive them too.',
      )
      assert.ok('ok' in sent, JSON.stringify(sent))
      assert.ok(
        chiefAnswers.onChiefsWord(await db.session.findFirstOrThrow({ where: { id: child.id } })),
      )

      // A thread it starts for a teammate (start_thread): its work goes on Chief's word too.
      const { startThreadFrom } = await import('../src/started-threads.js')
      const handed = (await startThreadFrom(db, scope, parent, parent.teammate, {
        name: 'start_thread',
        title: 'Archive the old mail',
        brief: 'Everything before 2024.',
        teammate: riley,
      })) as { threadId?: string; error?: string }
      assert.ok(handed.threadId, JSON.stringify(handed))
      assert.ok(
        chiefAnswers.onChiefsWord(
          await db.session.findFirstOrThrow({ where: { id: handed.threadId } }),
        ),
      )
    } finally {
      conn.close()
    }
  })

  test('a thread started on a person’s word goes on Chief’s once written in from it', async () => {
    const { loadThread } = await import('../src/thread-spec.js')
    const { messageThread, startThreadFrom } = await import('../src/started-threads.js')
    const conn = await runner()
    try {
      // Started from a thread of Ada's own word: not on Chief's.
      const plain = await thread()
      await person(plain, 'Hand the docs to Riley.')
      const from = await loadThread(db, plain)
      const handed = (await startThreadFrom(db, scope, from, from.teammate, {
        name: 'start_thread',
        title: `Tidy the docs ${randomUUID().slice(0, 4)}`,
        brief: 'Every page of the guide.',
        teammate: riley,
      })) as { threadId?: string; error?: string }
      assert.ok(handed.threadId, JSON.stringify(handed))
      const started = () => db.session.findFirstOrThrow({ where: { id: handed.threadId } })
      assert.equal(chiefAnswers.onChiefsWord(await started()), false)
      await db.session.updateMany({ where: { id: handed.threadId }, data: { status: 'idle' } })
      // Chief answers in the thread that started it, which then writes there: on Chief's word now.
      await answered(plain)
      const sent = await messageThread(db, scope, await loadThread(db, plain), from.teammate, {
        threadId: handed.threadId!,
        text: 'The FAQ too.',
      })
      assert.ok('ok' in sent, JSON.stringify(sent))
      assert.ok(chiefAnswers.onChiefsWord(await started()))
    } finally {
      conn.close()
    }
  })

  test('only a person’s message after Chief’s word lifts it, whatever order the hooks run in', async () => {
    const id = await thread()
    const early = await person(id, 'An early word.')
    const made = await answered(id)
    const word = async () => (await db.session.findFirstOrThrow({ where: { id } })).chiefWordSeq
    assert.equal(await word(), made.decision.askSeq)
    // The early message's hook, run late: Chief's word after it stands.
    await chiefAnswers.noteChiefAnswered({ id, organizationId: org, workspaceId, parentId: null }, [
      {
        seq: early,
        event: { type: 'message.user', memberId: member('ada'), text: 'An early word.' },
      },
    ])
    assert.equal(await word(), made.decision.askSeq)
    // Ada wrote, then Chief's answer reached the teammate after her: it is on Chief's word from there.
    const said = await person(id, 'Wait.')
    const note = await say(id, {
      type: 'message.user',
      memberId: null,
      text: contracts.chiefAnswerMessage({
        decisionId: made.decision.id,
        answer: 'Build it',
        reason: 'r',
      }),
    })
    // The note's hook first, then hers: hers comes before it, and lifts nothing.
    await chiefAnswers.noteChiefAnswered({ id, organizationId: org, workspaceId, parentId: null }, [
      {
        seq: note,
        event: {
          type: 'message.user',
          memberId: null,
          text: contracts.chiefAnswerMessage({
            decisionId: made.decision.id,
            answer: 'Build it',
            reason: 'r',
          }),
        },
      },
    ])
    await chiefAnswers.noteChiefAnswered({ id, organizationId: org, workspaceId, parentId: null }, [
      { seq: said, event: { type: 'message.user', memberId: member('ada'), text: 'Wait.' } },
    ])
    assert.equal(await word(), note)
    // Her word after it lifts it.
    await answer(id, 'Go on.')
    assert.equal(await word(), null)
  })

  /** Chief answered on its own while Ada's computer was away: its wake-up waits, nothing kept. */
  async function answeredAway() {
    await setMember({ chiefAnswers: true, chiefAuto: ['next_step'] })
    const id = await thread()
    const made = await pending(id, await asks(id))
    // Her Mac, not the cloud computer, which would keep the answer for when it starts.
    await db.computer.updateMany({ where: { id: cloud }, data: { kind: 'member_machine' } })
    try {
      assert.equal((await decide(made, { option: 1 })).status, 'answered')
    } finally {
      await db.computer.updateMany({ where: { id: cloud }, data: { kind: 'cloud' } })
    }
    const wakeup = await db.wakeup.findFirstOrThrow({ where: { sessionId: id } })
    assert.equal(wakeup.status, 'pending')
    return { id, made, wakeup }
  }

  /**
   * Run `operation` with a database client whose `model.method` waits, from its first call on,
   * until released: a step held midway, as under load. Its other queries, and everyone else's,
   * go on.
   */
  async function holding(model: string, method: string, operation: () => Promise<unknown>) {
    const { newPrismaClient, withPrismaClient } = await import('../src/db.js')
    const base = newPrismaClient(process.env.DATABASE_URL!)
    let reached!: () => void
    let release!: () => void
    let isHeld = false
    const atStep = new Promise<void>(
      (resolve) =>
        (reached = () => {
          isHeld = true
          resolve()
        }),
    )
    const held = new Promise<void>((resolve) => (release = resolve))
    const wrap = (delegate: object) =>
      new Proxy(delegate, {
        get(target, key) {
          const value = Reflect.get(target, key, target)
          if (key !== method || typeof value !== 'function') return value
          return async (...args: unknown[]) => {
            reached()
            await held
            return value.apply(target, args)
          }
        },
      })
    const client = new Proxy(base, {
      get(target, key) {
        if (key === model) return wrap(Reflect.get(target, key, target))
        if (key === '$extends')
          return (...args: unknown[]) =>
            new Proxy((target.$extends as (...a: unknown[]) => object)(...args), {
              get(inner, k) {
                const value = Reflect.get(inner, k, inner)
                return k === model ? wrap(value) : value
              },
            })
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const done = withPrismaClient(client as never, operation)
    await Promise.race([atStep, done])
    return {
      release,
      done,
      /** It reached the step, and waits there until released. */
      held: () => isHeld,
      close: async () => {
        release()
        await done.catch(() => {})
        await base.$disconnect()
      },
    }
  }

  /** What the thread's computer was sent, in order: Chief's answers as 'chief'. */
  const prompts = (sent: Sent[], id: string) =>
    sent
      .filter(
        (m) =>
          (m.thread as { sessionId?: string } | undefined)?.sessionId === id &&
          (m.type === 'thread.prompt' || m.type === 'thread.handback'),
      )
      .map((m) =>
        m.type === 'thread.handback'
          ? `handback: ${m.note as string}`
          : contracts.chiefAnswerNote(m.text as string)
            ? 'chief'
            : (m.text as string),
      )

  const fireAgain = async (wakeupId: string) => {
    const { fireNow } = await import('../src/wakeups.js')
    await fireNow(wakeupId)
  }

  test('an answer of Chief’s on its way to the computer goes before the person’s word, which waits for it', async () => {
    const { id, made, wakeup } = await answeredAway()
    const conn = await runner()
    // Its wake-up fires again: the answer is kept, then held on its way to the computer.
    const fire = await holding('runnerCommand', 'updateManyAndReturn', () => fireAgain(wakeup.id))
    try {
      assert.ok((await row(made.decision.id)).sentAt)
      let through = false
      const ada = call('ada', `/${id}/messages`, { body: { text: 'Not yet' } }).then((r) => {
        through = true
        return r
      })
      await new Promise((resolve) => setTimeout(resolve, 400))
      assert.equal(through, false)
      assert.deepEqual(prompts(conn.sent, id), [])
      fire.release()
      const response = await ada
      assert.equal(response.status, 200, await response.clone().text())
      await fire.done
      assert.deepEqual(prompts(conn.sent, id), ['chief', 'Not yet'])
      assert.equal((await row(made.decision.id)).status, 'answered')
    } finally {
      await fire.close()
      conn.close()
    }
  })

  test('an answer not kept when the person writes never goes, however long its wake-up takes', async () => {
    const { id, made, wakeup } = await answeredAway()
    const conn = await runner()
    // Its wake-up fires again, and is held before the answer is kept (making the thread's spec).
    const fire = await holding('account', 'findMany', () => fireAgain(wakeup.id))
    try {
      const started = Date.now()
      const response = await call('ada', `/${id}/messages`, { body: { text: 'Not yet' } })
      assert.equal(response.status, 200, await response.clone().text())
      // Hers waits for nothing.
      assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`)
      assert.equal((await row(made.decision.id)).status, 'superseded')
      fire.release()
      await fire.done
      assert.deepEqual(prompts(conn.sent, id), ['Not yet'])
      assert.equal(
        (await db.wakeup.findFirstOrThrow({ where: { id: wakeup.id } })).status,
        'cancelled',
      )
      assert.equal(await db.runnerCommand.count({ where: { id: `wakeup:${wakeup.id}` } }), 0)
    } finally {
      await fire.close()
      conn.close()
    }
  })

  test('the person’s word settles a decision being made, and an answer made while it was on its way', async () => {
    await setMember({ chiefAnswers: true, chiefAuto: ['next_step'] })
    const id = await thread()
    const made = await pending(id, await asks(id))
    const conn = await runner()
    // Ada writes while Chief decides: her prompt is held before it is kept…
    const ada = await holding('account', 'findMany', () =>
      call('ada', `/${id}/messages`, { body: { text: 'Not yet' } }),
    )
    // …while Chief answers, its answer held before it is kept too.
    const chief = await holding('account', 'findMany', () => decide(made, { option: 1 }))
    try {
      assert.equal((await row(made.decision.id)).status, 'answered')
      ada.release()
      const response = (await ada.done) as Response
      assert.equal(response.status, 200, await response.clone().text())
      assert.equal((await row(made.decision.id)).status, 'superseded')
      chief.release()
      await chief.done
      assert.deepEqual(prompts(conn.sent, id), ['Not yet'])

      // Her word kept while Chief still decides: the decision is moot, and makes nothing.
      const next = await pending(id, await asks(id))
      const res = await call('ada', `/${id}/messages`, { body: { text: 'Stop there' } })
      assert.equal(res.status, 200, await res.clone().text())
      assert.equal((await row(next.decision.id)).status, 'superseded')
      assert.equal((await decide(next, { option: 1 })).recorded, false)
      assert.equal(await db.wakeup.count({ where: { sourceId: `chief:${next.decision.id}` } }), 0)
      assert.deepEqual(prompts(conn.sent, id), ['Not yet', 'Stop there'])
    } finally {
      await ada.close()
      await chief.close()
      conn.close()
    }
  })

  test('taking the thread in hand, and handing it back, come before an answer not kept yet, which never goes', async () => {
    const { id, made, wakeup } = await answeredAway()
    const conn = await runner()
    const fire = await holding('account', 'findMany', () => fireAgain(wakeup.id))
    try {
      const takeover = await call('ada', `/${id}/takeover`, { body: { interrupt: true } })
      assert.equal(takeover.status, 200, await takeover.clone().text())
      assert.equal((await row(made.decision.id)).status, 'superseded')
      const back = await call('ada', `/${id}/handback`, { body: { note: 'Not yet' } })
      assert.equal(back.status, 200, await back.clone().text())
      fire.release()
      await fire.done
      assert.deepEqual(prompts(conn.sent, id), ['handback: Not yet'])
    } finally {
      await fire.close()
      conn.close()
    }
  })

  test('a word of the person’s the computer has not taken yet comes first: an answer decided meanwhile never goes', async () => {
    await setMember({ chiefAnswers: true, chiefAuto: ['next_step'] })
    const id = await thread()
    const conn = await runner()
    try {
      // Ada writes as the turn ends on a question; her computer has not taken it when Chief answers.
      const response = await call('ada', `/${id}/messages`, { body: { text: 'Also add tests.' } })
      assert.equal(response.status, 200, await response.clone().text())
      const made = await pending(id, await asks(id))
      await decide(made, { option: 1 })
      assert.equal((await row(made.decision.id)).status, 'superseded')
      assert.deepEqual(prompts(conn.sent, id), ['Also add tests.'])
      // Taken: the next answer goes.
      await db.runnerCommand.updateMany({
        where: { sessionId: id, status: 'pending' },
        data: { status: 'acked' },
      })
      const next = await pending(id, await asks(id))
      assert.equal((await decide(next, { option: 1 })).status, 'answered')
      assert.deepEqual(prompts(conn.sent, id), ['Also add tests.', 'chief'])
    } finally {
      conn.close()
    }
  })

  test('an answer kept while the computer was away, and not sent, is withdrawn by the person’s word', async () => {
    await setMember({ chiefAnswers: true, chiefAuto: ['next_step'] })
    const id = await thread()
    const made = await pending(id, await asks(id))
    // The cloud computer is away (stopped, say): the answer is kept for when it is back.
    assert.equal((await decide(made, { option: 1 })).status, 'answered')
    const wakeup = await db.wakeup.findFirstOrThrow({ where: { sessionId: id } })
    const kept = await db.runnerCommand.findFirstOrThrow({ where: { id: `wakeup:${wakeup.id}` } })
    assert.equal(kept.status, 'pending')
    const response = await call('ada', `/${id}/messages`, { body: { text: 'Not yet' } })
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal(
      (await db.runnerCommand.findFirstOrThrow({ where: { id: kept.id } })).status,
      'expired',
    )
    assert.equal((await row(made.decision.id)).status, 'superseded')
    // Back, it gets her word alone.
    const conn = await runner()
    try {
      await until(() => prompts(conn.sent, id).length > 0, 'her message')
      assert.deepEqual(prompts(conn.sent, id), ['Not yet'])
    } finally {
      conn.close()
    }
  })

  test('an answer sent before the person’s word comes before it again on a computer that lost both', async () => {
    const { id, made, wakeup } = await answeredAway()
    const first = await runner()
    try {
      await fireAgain(wakeup.id)
      assert.deepEqual(prompts(first.sent, id), ['chief'])
    } finally {
      // Gone before it said it took it.
      first.close()
    }
    const response = await call('ada', `/${id}/messages`, { body: { text: 'Not yet' } })
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal((await row(made.decision.id)).status, 'answered')
    const back = await runner()
    try {
      await until(() => prompts(back.sent, id).length > 1, 'both')
      assert.deepEqual(prompts(back.sent, id), ['chief', 'Not yet'])
    } finally {
      back.close()
    }
  })

  test('a computer back gets an answer sent before the person’s word first, whatever replays it', async () => {
    const { id, made, wakeup } = await answeredAway()
    const first = await runner()
    try {
      await first.hello
      await fireAgain(wakeup.id)
      assert.deepEqual(prompts(first.sent, id), ['chief'])
    } finally {
      // Gone before it said it took it.
      first.close()
    }
    // Back: its replay of what waits is held at its first read, after its welcome…
    let back: Awaited<ReturnType<typeof runner>> | undefined
    const flush = await holding('runnerCommand', 'findMany', async () => {
      back = await runner()
      await back.hello
    })
    // …and so is the minute's resend of what was sent a while ago.
    await db.runnerCommand.updateMany({
      where: { id: `wakeup:${wakeup.id}` },
      data: { sentAt: new Date(Date.now() - 10 * 60_000) },
    })
    const { resendCommands } = await import('../src/runner-commands.js')
    const resend = await holding('runnerCommand', 'findMany', () =>
      resendCommands(Date.now(), workspaceId),
    )
    try {
      await until(() => !!back, 'the runner back')
      assert.ok(flush.held() && resend.held())
      const response = await call('ada', `/${id}/messages`, { body: { text: 'Not yet' } })
      assert.equal(response.status, 200, await response.clone().text())
      resend.release()
      await resend.done
      flush.release()
      await flush.done
      // Each command as the runner takes it: once, the first time it comes.
      const seen = new Set<string>()
      const taken = back!.sent.filter((m) => {
        const commandId = m.commandId as string | undefined
        if (!commandId) return true
        if (seen.has(commandId)) return false
        seen.add(commandId)
        return true
      })
      assert.deepEqual(prompts(taken, id), ['chief', 'Not yet'])
      assert.equal((await row(made.decision.id)).status, 'answered')
    } finally {
      await resend.close()
      await flush.close()
      back?.close()
    }
  })

  test('a wake-up cut off midway is tried again, and its answer reaches the thread once', async () => {
    // Stopped before its answer was kept: nothing holds it, the next try sends it.
    const { id, made, wakeup } = await answeredAway()
    const conn = await runner()
    try {
      await fireAgain(wakeup.id)
      assert.deepEqual(prompts(conn.sent, id), ['chief'])
      assert.ok((await row(made.decision.id)).sentAt)
      // Stopped once it was kept, before its wake-up was settled: tried again, it goes once.
      await db.wakeup.updateMany({
        where: { id: wakeup.id },
        data: { status: 'pending', firedAt: null },
      })
      await fireAgain(wakeup.id)
      assert.deepEqual(prompts(conn.sent, id), ['chief'])
      assert.equal((await db.wakeup.findFirstOrThrow({ where: { id: wakeup.id } })).status, 'fired')
      assert.equal((await row(made.decision.id)).status, 'answered')
    } finally {
      conn.close()
    }
  })

  test('on Chief’s word no routine is set up, and a credential that goes without asking asks', async () => {
    const { handleScheduleCall } = await import('../src/schedules.js')
    const { handleCredentialRequest } = await import('../src/credentials.js')
    const { sealSecret } = await import('../src/vault.js')
    const id = await thread()
    await answered(id)
    const replies: { ok: boolean; error?: string }[] = []
    await handleScheduleCall(
      { computerId: cloud, organizationId: org, workspaceId } as never,
      {
        type: 'schedule.call',
        callId: `call-${randomUUID()}`,
        sessionId: id,
        teammateId: riley,
        operation: {
          name: 'create',
          title: 'Daily mail',
          instructions: 'Send the digest.',
          cron: '0 9 * * *',
          timezone: 'Europe/Paris',
        },
      } as never,
      (m) => void replies.push(m as never),
    )
    assert.equal(replies[0]?.ok, false)
    assert.match(replies[0]?.error ?? '', /a routine waits for them/)
    assert.equal(await db.schedule.count({ where: { teammateId: riley } }), 0)

    const credential = await db.credential.create({
      data: {
        kind: 'api_key',
        name: 'Deploy key',
        vaultSecretId: await sealSecret(db, scope, { apiKey: 'secret-value' }),
        createdByMemberId: member('ada'),
      },
    } as never)
    await db.credentialGrant.create({
      data: { credentialId: credential.id, teammateId: riley, withoutAsking: true },
    } as never)
    const use = async (sessionId: string) => {
      const out: { ok?: boolean }[] = []
      await handleCredentialRequest(
        { computerId: cloud, organizationId: org, workspaceId },
        {
          type: 'credential.request',
          callId: `call-${randomUUID()}`,
          sessionId,
          teammateId: riley,
          action: 'release',
          credentialId: credential.id,
          use: 'env',
        },
        (m) => void out.push(m as never),
      )
      return out
    }
    // On Chief's word: it asks Ada, and nothing is released meanwhile.
    assert.ok(!(await use(id)).some((m) => m.ok === true))
    const asked = await db.ticket.findMany({
      where: { sessionId: id, type: 'approval', status: 'open' },
    })
    assert.equal(asked.length, 1)
    assert.match((asked[0]!.payload as { reason: string }).reason, /acts on Chief's answer/)
    // In a thread of Ada's own word, as its grant says: no ticket.
    const plain = await thread()
    await person(plain, 'Deploy it.')
    assert.equal((await use(plain))[0]?.ok, true)
    assert.equal(await db.ticket.count({ where: { sessionId: plain } }), 0)
  })

  test('an answer the person overtook while its computer was offline never goes', async () => {
    await setMember({ chiefAnswers: true, chiefAuto: ['next_step'] })
    const id = await thread()
    const made = await pending(id, await asks(id))
    // Offline: Ada's Mac, not the cloud computer, which would start.
    await db.computer.updateMany({ where: { id: cloud }, data: { kind: 'member_machine' } })
    try {
      assert.equal((await decide(made, { option: 1 })).status, 'answered')
      const wakeup = await db.wakeup.findFirstOrThrow({ where: { sessionId: id } })
      assert.equal(wakeup.status, 'pending')
      const conn = await runner()
      try {
        await answer(id, 'Not yet')
        assert.equal(
          (await db.wakeup.findFirstOrThrow({ where: { id: wakeup.id } })).status,
          'cancelled',
        )
        assert.equal((await row(made.decision.id)).status, 'superseded')
        // Fired anyway (a tick that read it before): it goes nowhere.
        await db.wakeup.updateMany({ where: { id: wakeup.id }, data: { status: 'pending' } })
        await db.chiefDecision.updateMany({
          where: { id: made.decision.id },
          data: { status: 'answered' },
        })
        const { fireNow } = await import('../src/wakeups.js')
        await fireNow(wakeup.id)
        assert.equal(
          conn.sent.filter(
            (m) =>
              m.type === 'thread.prompt' &&
              (m.thread as { sessionId?: string }).sessionId === id &&
              contracts.chiefAnswerNote(m.text as string),
          ).length,
          0,
        )
        assert.equal(
          (await db.wakeup.findFirstOrThrow({ where: { id: wakeup.id } })).status,
          'cancelled',
        )
      } finally {
        conn.close()
      }
    } finally {
      await db.computer.updateMany({ where: { id: cloud }, data: { kind: 'cloud' } })
    }
  })

  test('a card the person dismissed is not answered', async () => {
    await setMember({ chiefAnswers: true, chiefAuto: ['approach'] })
    const id = await thread()
    const labels = ['Sequential processing', 'Concurrent processing']
    const card = await asks(id, labels, { choices: true })
    const made = await pending(id, card, labels)
    await db.chiefDecision.updateMany({
      where: { id: made.decision.id },
      data: {
        options: labels.map((label) => ({ label, message: contracts.choiceMessage({ label }) })),
      },
    })
    const response = await call('ada', `/${id}/choices/dismiss`, { body: { seq: card } })
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal((await row(made.decision.id)).status, 'superseded')
    // Its decision arriving after it: nothing goes.
    await db.chiefDecision.updateMany({
      where: { id: made.decision.id },
      data: { status: 'pending' },
    })
    assert.equal((await decide(made, { option: 1, kind: 'approach' })).status, 'superseded')
    assert.equal(await db.wakeup.count({ where: { sessionId: id } }), 0)
  })

  test('the brief has the card’s question and its options’ descriptions, and no mandate Chief may not read', async () => {
    await setMember({ chiefAnswers: true, chiefAuto: [] })
    const { saveLibraryFile } = await import('../src/library.js')
    await saveLibraryFile(
      db,
      scope,
      { type: 'member', id: member('ada') },
      {
        path: contracts.MANDATE_PATH,
        bytes: new TextEncoder().encode('# Mandate\n\nThis week: MANDATE_SENTINEL_724\n'),
      },
    )
    const prompts = async () => {
      const id = await thread()
      await person(id, 'Prepare the rollout.')
      await say(id, { type: 'turn.started', teammateId: riley, accountId: account })
      await say(id, {
        type: 'message.done',
        id: `m-${randomUUID()}`,
        text: 'Here are the two routes.',
      })
      await say(id, {
        type: 'tool.started',
        toolCallId: `c-${randomUUID()}`,
        toolName: 'offer_choices',
        input: {
          question: 'Where should I deploy the release?',
          options: [
            { id: 'a', label: 'Route A', description: 'Deploy to production now' },
            { id: 'b', label: 'Route B', description: 'Deploy to staging only' },
          ],
        },
      })
      await say(id, { type: 'turn.completed', finishReason: 'stop' })
      const conn = await runner()
      try {
        await ended(id)
        await until(
          () =>
            conn.sent.some(
              (m) =>
                m.type === 'thread.prompt' &&
                (m.thread as { parent?: { id: string } }).parent?.id === id,
            ),
          'the decision thread',
        )
        return conn.sent.find(
          (m) =>
            m.type === 'thread.prompt' &&
            (m.thread as { parent?: { id: string } }).parent?.id === id,
        )!.text as string
      } finally {
        conn.close()
      }
    }
    const open = await prompts()
    assert.match(open, /## The question\nWhere should I deploy the release\?/)
    assert.match(open, /1\. Route A: Deploy to production now\n2\. Route B: Deploy to staging only/)
    assert.match(open, /MANDATE_SENTINEL_724/)
    // A person closes chief/ to Chief: its mandate stays out of the brief.
    const folder = await db.libraryFolder.create({
      data: { path: 'chief', restricted: true },
    } as never)
    try {
      const closed = await prompts()
      assert.ok(!closed.includes('MANDATE_SENTINEL_724'))
      assert.match(closed, /\(None yet:/)
    } finally {
      await db.libraryFolder.deleteMany({ where: { id: folder.id } })
    }
  })

  test('lists made at once by several calls keep every line, with nothing held open meanwhile', async () => {
    const { addListLine } = await import('../src/lists.js')
    const { documentText } = await import('../src/library.js')
    const path = `chief/many-${randomUUID().slice(0, 6)}.md`
    const actor = { type: 'teammate' as const, id: chief }
    await Promise.all(
      ['One', 'Two', 'Three', 'Four'].map((text) =>
        addListLine(db, scope, actor, { path, header: '# Parked\n', text }),
      ),
    )
    const file = await db.document.findFirstOrThrow({
      where: { path, kind: 'library', deletedAt: null },
    })
    const text = await documentText(scope, file)
    for (const line of ['One', 'Two', 'Three', 'Four']) assert.match(text, new RegExp(line))
  })

  test('two first lines of a list made at once both stay', async () => {
    const { addListLine } = await import('../src/lists.js')
    const { documentText } = await import('../src/library.js')
    const path = `chief/race-${randomUUID().slice(0, 6)}.md`
    let announce!: () => void
    let release!: () => void
    const reached = new Promise<void>((r) => (announce = r))
    const held = new Promise<void>((r) => (release = r))
    let first = true
    // The first call stops right after seeing no file, while the second makes it and adds its line.
    const slow = new Proxy(db, {
      get(target, key) {
        if (key !== 'document') return Reflect.get(target, key)
        return new Proxy(db.document, {
          get(doc, method) {
            if (method !== 'findFirst') return Reflect.get(doc, method)
            return async (...args: unknown[]) => {
              const found = await (doc.findFirst as (...a: unknown[]) => Promise<unknown>)(...args)
              if (first) {
                first = false
                assert.equal(found, null)
                announce()
                await held
              }
              return found
            }
          },
        })
      },
    })
    const actor = { type: 'teammate' as const, id: chief }
    const a = addListLine(slow, scope, actor, {
      path,
      header: '# Parked\n',
      text: 'First proposal',
    })
    await reached
    try {
      await addListLine(db, scope, actor, { path, header: '# Parked\n', text: 'Second proposal' })
    } finally {
      release()
    }
    await a
    const file = await db.document.findFirstOrThrow({
      where: { path, kind: 'library', deletedAt: null },
    })
    const text = await documentText(scope, file)
    assert.match(text, /First proposal/)
    assert.match(text, /Second proposal/)
  })

  test('marked wrong: the teammate is told, and the kind goes back to suggestions', async () => {
    await setMember({ chiefAnswers: true, chiefAuto: ['next_step', 'approach'] })
    const id = await thread()
    const made = await pending(id, await asks(id))
    const conn = await runner()
    try {
      await decide(made, { option: 1 })
      // Bob may not, in Ada's name.
      assert.equal(
        (await call('bob', `/${id}/chief/${made.decision.id}/wrong`, { body: {} })).status,
        403,
      )
      const res = await call('ada', `/${id}/chief/${made.decision.id}/wrong`, { body: {} })
      assert.equal(res.status, 200, await res.clone().text())
      assert.equal((await row(made.decision.id)).outcome, 'overruled')
      const ada = await prisma.member.findUniqueOrThrow({ where: { id: member('ada') } })
      assert.deepEqual(ada.chiefAuto, ['approach'])
      await until(
        () =>
          conn.sent.some(
            (m) =>
              m.type === 'thread.prompt' && contracts.chiefOverruledNote(m.text as string) !== null,
          ),
        'the overrule on the runner',
      )
      // Marked once: twice is the same.
      assert.equal(
        (await call('ada', `/${id}/chief/${made.decision.id}/wrong`, { body: {} })).status,
        200,
      )
      // Its suggestions before count no more toward offering it again.
      const trust = await chiefAnswers.trustOf(db, member('ada'), 'next_step')
      assert.equal(trust.decided, 0)
    } finally {
      conn.close()
    }
  })

  test('its decision thread reports nothing: a decision not made fails, and nothing wakes the thread', async () => {
    const { noteChildEvents } = await import('../src/children.js')
    await setMember({ chiefAnswers: true, chiefAuto: [] })
    const id = await thread()
    const made = await pending(id, await asks(id))
    await noteChildEvents({ ...made.child, organizationId: org, workspaceId }, [
      { event: { type: 'turn.completed', at: new Date().toISOString() } },
    ])
    assert.equal((await row(made.decision.id)).status, 'failed')
    const child = await db.session.findFirstOrThrow({ where: { id: made.child.id } })
    assert.ok(child.reportDeliveredAt)
    assert.equal((child.report as { status: string }).status, 'nothing')
    assert.equal(await db.wakeup.count({ where: { sessionId: id } }), 0)
  })
})
