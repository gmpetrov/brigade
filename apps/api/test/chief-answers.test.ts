import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import { Hono } from 'hono'
import { sessionStub } from './session-stub.js'

// Chief for the person (docs/chief-answers.md): their rules reach the teammates working for them;
// their daily pass reads what waits on them, answers in their name what their rules settle, tries
// failed threads again and reports to Today; its answers reach the teammate in order with the
// person's word, and App writes made on them ask the person. Against the API's development database
// (apps/api/.env), in an organization of its own removed at the end; skipped when no database
// answers.
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
const chiefPass = await import('../src/chief-pass.js')
const chiefRules = await import('../src/chief-rules.js')
const contracts = await import('@brigade/contracts')

type Sent = { type: string; [key: string]: unknown }

const until = async (check: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 250; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${what}`)
}

describe('Chief for the person', { skip: !database && 'no database answers' }, () => {
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

  const setMember = (
    data: {
      chiefPass?: boolean
      chiefRules?: string | null
      chiefRulesRefused?: string[]
      timezone?: string | null
    },
    p: Person = 'ada',
  ) => prisma.member.update({ where: { id: member(p) }, data })

  /** Ada's rules, by which Chief answers her teammates' next steps. */
  const RULES = '- Admin work: go ahead on next steps of what I asked for'

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

  type Made = {
    pass: { id: string }
    child: {
      id: string
      startedByMemberId: string
      chiefPassId: string | null
      organizationId: string
      workspaceId: string
    }
    item: number
    decision?: { id: string }
  }

  /**
   * Ada's pass, at work on this card: its thread, quiet, where Chief answers it as item 1. Her
   * rules and pass on, as an answer needs them.
   */
  async function pending(
    sessionId: string,
    askSeq: number,
    replies = ['Build it', 'Not yet'],
  ): Promise<Made> {
    await setMember({ chiefPass: true, chiefRules: RULES })
    const childSessionId = `c${randomUUID().replace(/-/g, '').slice(0, 24)}`
    const pass = await db.chiefPass.create({
      data: {
        memberId: member('ada'),
        day: `day-${randomUUID().slice(0, 8)}`,
        sessionId: childSessionId,
        items: [
          {
            kind: 'question',
            n: 1,
            title: 'Admin page',
            sessionId,
            teammate: 'Riley',
            teammateId: riley,
            askSeq,
            options: replies.map((r) => ({ label: r, message: r })),
            question: 'The migration is ready. Shall I build the admin page too?',
            cardQuestion: null,
          },
        ],
      },
    } as never)
    const child = await db.session.create({
      data: {
        id: childSessionId,
        teammateId: chief,
        startedByMemberId: member('ada'),
        askedByMemberId: member('ada'),
        computerId: cloud,
        accountId: account,
        title: 'Chief’s pass',
        status: 'running',
        quiet: true,
        chiefPassId: pass.id,
      } as never,
    })
    await db.threadTeammate.create({ data: { sessionId: child.id, teammateId: chief } as never })
    return { pass, child, item: 1 }
  }

  /** Chief answers its pass's question in Ada's name (chief_answer): the answer, by its number. */
  const decide = async (
    made: Made,
    op: Partial<{ option: number; reason: string; rule: string; item: number }>,
  ) => {
    const output = (await chiefPass.handleChiefCall(
      db,
      scope,
      made.child,
      { id: chief, kind: 'chief' },
      {
        name: 'chief_answer',
        item: made.item,
        option: 1,
        reason: 'It serves this week’s launch, and it is a pull request.',
        rule: 'Admin work: go ahead on next steps of what I asked for',
        ...op,
      } as never,
    )) as { status?: string; decisionId?: string | null; error?: string }
    if (output.decisionId) made.decision = { id: output.decisionId }
    return output
  }

  /** Chief's latest answer in a thread, made or on its way. */
  const decisionOf = (sessionId: string) =>
    db.chiefDecision.findFirstOrThrow({ where: { sessionId }, orderBy: { createdAt: 'desc' } })

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

  test('rules reach the teammates working for their person, and nowhere else', async () => {
    const { specFor, loadThread } = await import('../src/thread-spec.js')
    const spec = async (id: string) => specFor(db, await loadThread(db, id))
    await setMember({ chiefRules: null, chiefPass: false })
    const id = await thread()
    // None: as before.
    let s = await spec(id)
    assert.equal(s.rules ?? null, null)
    assert.equal(s.chiefAnswers, false)
    await setMember({ chiefRules: `  ${RULES}  ` })
    s = await spec(id)
    assert.deepEqual(s.rules, { person: 'Ada', text: RULES })
    // With her pass on, her teammates are told what Chief's answers are, in her own threads.
    assert.equal(s.chiefAnswers, false)
    await setMember({ chiefPass: true })
    assert.equal((await spec(id)).chiefAnswers, true)
    // A thread Bob asks in too: whose rules would they be?
    await db.session.updateMany({ where: { id }, data: { askedByMemberId: '*' } })
    s = await spec(id)
    assert.equal(s.rules ?? null, null)
    assert.equal(s.chiefAnswers, false)
    // Bob's own thread: Ada's rules are not his.
    await db.session.updateMany({
      where: { id },
      data: { askedByMemberId: member('bob'), startedByMemberId: member('bob') },
    })
    assert.equal((await spec(id)).rules ?? null, null)
  })

  test('a person keeps their rules, turns their pass on in their timezone, and takes or refuses a proposed rule', async () => {
    await setMember({ chiefRules: null, chiefPass: false, chiefRulesRefused: [], timezone: null })
    const ada = { ...scope, memberId: member('ada') }
    let settings = await chiefRules.setChief(db, ada, {
      pass: true,
      rules: '- Go ahead on fixes',
      timezone: 'Europe/Paris',
    })
    assert.deepEqual(settings, {
      pass: true,
      rules: '- Go ahead on fixes',
      timezone: 'Europe/Paris',
      hour: contracts.CHIEF_PASS_HOUR,
    })
    await assert.rejects(
      chiefRules.setChief(db, ada, { timezone: 'Mars/Olympus' }),
      /Unknown timezone/,
    )
    settings = await chiefRules.decideRule(db, ada, {
      line: 'Copy changes: just do them',
      add: true,
    })
    assert.equal(settings.rules, '- Go ahead on fixes\n- Copy changes: just do them')
    // Taken twice, kept once.
    settings = await chiefRules.decideRule(db, ada, {
      line: 'copy changes:  just do them',
      add: true,
    })
    assert.equal(settings.rules, '- Go ahead on fixes\n- Copy changes: just do them')
    await chiefRules.decideRule(db, ada, { line: 'Never ask about tests', add: false })
    const row = await prisma.member.findUniqueOrThrow({ where: { id: member('ada') } })
    assert.deepEqual(row.chiefRulesRefused, ['Never ask about tests'])
    assert.equal(chiefRules.ruleState(row, 'Never ask about tests'), 'refused')
    assert.equal(chiefRules.ruleState(row, '- Copy changes: just do them'), 'added')
    assert.equal(chiefRules.ruleState(row, 'Something new'), 'proposed')
    // Cleared: none.
    settings = await chiefRules.setChief(db, ada, { rules: '   ', pass: false })
    assert.equal(settings.rules, '')
    assert.equal(settings.pass, false)
  })

  test('Chief writes a person’s rules with them in their thread, and nowhere else', async () => {
    await setMember({ chiefRules: null })
    const own = await db.session.create({
      data: {
        teammateId: chief,
        startedByMemberId: member('ada'),
        askedByMemberId: member('ada'),
        computerId: cloud,
        accountId: account,
        title: 'My rules',
        status: 'idle',
      } as never,
    })
    const write = (session: typeof own, teammate = { id: chief, kind: 'chief' }) =>
      chiefPass.handleChiefCall(db, scope, session, teammate, {
        name: 'chief_rules',
        rules: '- Go ahead on fixes',
      } as never) as Promise<{ ok?: boolean; error?: string }>
    assert.match((await write(own, { id: riley, kind: 'teammate' })).error ?? '', /Only Chief/)
    // Not before she agreed, in her own words.
    assert.match((await write(own)).error ?? '', /right after they agreed/)
    await person(own.id, 'Yes, save these rules.')
    assert.equal((await write(own)).ok, true)
    const ada = await prisma.member.findUniqueOrThrow({ where: { id: member('ada') } })
    assert.equal(ada.chiefRules, '- Go ahead on fixes')
    // A thread several people ask in, or a pass: not there.
    const shared = await db.session.update({
      where: { id: own.id },
      data: { askedByMemberId: '*' },
    })
    assert.match((await write(shared)).error ?? '', /not one person/)
    // What a wake-up or an event brought in is not her word.
    const back = await db.session.update({
      where: { id: own.id },
      data: { askedByMemberId: member('ada') },
    })
    await say(own.id, { type: 'message.user', text: 'Wake-up: check CI', memberId: null })
    assert.match((await write(back)).error ?? '', /right after they agreed/)
    await person(own.id, 'Save them.')
    await db.session.updateMany({ where: { id: own.id }, data: { origin: 'trigger' } })
    assert.match((await write(back)).error ?? '', /right after they agreed/)
    const made = await pending(await thread(), 1)
    assert.match((await write(made.child as never)).error ?? '', /Not in a pass/)
  })

  test('a pass runs once a day in the person’s morning, only when something waits on them, out of every list', async () => {
    await setMember({ chiefPass: true, chiefRules: RULES, timezone: 'Europe/Paris' })
    await setMember({ chiefPass: false }, 'bob')
    const at = (d: string, hour: number) =>
      new Date(`${d}T${String(hour).padStart(2, '0')}:30:00+01:00`)
    const passesOn = async (day: string) =>
      (await db.chiefPass.findMany({ where: { memberId: member('ada') } })).filter(
        (p) => p.day === day,
      )
    // The passes of the tests before: over, so only her morning makes this workspace due.
    await db.chiefPass.updateMany({ where: { status: 'running' }, data: { status: 'done' } })
    // Her threads so far are long quiet by then: nothing of theirs waits.
    await db.session.updateMany({
      where: { startedByMemberId: member('ada') },
      data: { updatedAt: new Date('2031-01-01') },
    })
    // 06:30 in Paris: not yet.
    assert.ok(!(await chiefPass.duePasses(at('2031-03-03', 6))).includes(workspaceId))
    // 07:30: due, and nothing waits: idle, no turn spent.
    const morning = at('2031-03-03', 7)
    assert.ok((await chiefPass.duePasses(morning)).includes(workspaceId))
    await chiefPass.runDuePasses(workspaceId, morning)
    let mine = await passesOn('2031-03-03')
    assert.equal(mine.length, 1)
    assert.equal(mine[0]!.status, 'idle')
    assert.equal(await db.session.count({ where: { id: mine[0]!.sessionId! } }), 0)
    // Once a day.
    await chiefPass.runDuePasses(workspaceId, at('2031-03-03', 11))
    assert.equal((await passesOn('2031-03-03')).length, 1)
    // The next day a question waits: Chief's thread starts with its brief, quiet.
    const id = await thread()
    const card = await asks(id)
    const next = at('2031-03-04', 8)
    await db.session.updateMany({ where: { id }, data: { updatedAt: next } })
    const conn = await runner()
    try {
      await chiefPass.runDuePasses(workspaceId, next)
      mine = await passesOn('2031-03-04')
      assert.equal(mine.length, 1)
      assert.equal(mine[0]!.status, 'running')
      const items = mine[0]!.items as { kind: string; sessionId: string; askSeq: number }[]
      assert.deepEqual(
        items.map((i) => [i.kind, i.sessionId, i.askSeq]),
        [['question', id, card]],
      )
      const passThread = await db.session.findFirstOrThrow({ where: { id: mine[0]!.sessionId! } })
      assert.equal(passThread.quiet, true)
      assert.equal(passThread.chiefPassId, mine[0]!.id)
      assert.equal(passThread.teammateId, chief)
      const ofPass = (m: Sent) =>
        m.type === 'thread.prompt' &&
        (m.thread as { sessionId: string }).sessionId === passThread.id
      await until(() => conn.sent.some(ofPass), 'the pass on the runner')
      const prompt = conn.sent.find(ofPass)!
      const brief = prompt.text as string
      assert.ok(contracts.isChiefPassBrief(brief))
      assert.match(brief, /## Ada's rules\n- Admin work: go ahead on next steps/)
      assert.match(brief, /1\. ".+": Riley \w+ ended its reply on a question\./)
      assert.match(brief, /Answers: 1\) Build it {2}2\) Not yet/)
      const spec = prompt.thread as { pass?: { id: string }; connectors: unknown[] }
      assert.deepEqual(spec.pass, { id: mine[0]!.id })
      assert.deepEqual(spec.connectors, [])
      // In no list.
      as = 'ada'
      const listed = (await (await app.request('/api/threads')).json()) as { id: string }[]
      assert.ok(!listed.some((t) => t.id === passThread.id))
    } finally {
      conn.close()
    }
  })

  test('what waits on the person: their open questions and failures, not Chief’s own, another’s, or one answered', async () => {
    await setMember({ chiefPass: true, chiefRules: RULES })
    // Hers, open.
    const open = await thread()
    const card = await asks(open)
    // Chief's own question: hers to answer.
    const own = await thread()
    await asks(own, ['Yes', 'No'], { teammateId: chief })
    // Answered by an earlier pass already.
    const done = await thread()
    const doneCard = await asks(done)
    await db.chiefDecision.create({
      data: {
        sessionId: done,
        memberId: member('ada'),
        teammateId: riley,
        askSeq: doneCard,
        options: [],
        status: 'answered',
      },
    } as never)
    // Bob asks in this one too.
    const shared = await thread()
    await asks(shared)
    await db.session.updateMany({ where: { id: shared }, data: { askedByMemberId: '*' } })
    // Failed on an error.
    const failed = await thread()
    await say(failed, { type: 'turn.started', teammateId: riley, accountId: account })
    await say(failed, { type: 'error', message: 'Request timed out' })
    await db.session.updateMany({ where: { id: failed }, data: { status: 'failed' } })
    const now = new Date()
    await db.session.updateMany({
      where: { id: { in: [open, own, done, shared, failed] } },
      data: { updatedAt: now },
    })
    const items = await chiefPass.passItems(db, member('ada'), new Date(now.getTime() + 1000))
    const of = (kind: string) => items.filter((i) => i.kind === kind).map((i) => i.sessionId)
    assert.ok(of('question').includes(open))
    assert.ok(!of('question').includes(own))
    assert.ok(!of('question').includes(done))
    assert.ok(!of('question').includes(shared))
    assert.ok(of('failed').includes(failed))
    const question = items.find((i) => i.sessionId === open)!
    assert.equal(question.kind === 'question' && question.askSeq, card)
    // Numbered from 1, in order.
    assert.deepEqual(
      items.map((i) => i.n),
      items.map((_, k) => k + 1),
    )
  })

  /** The card a thread's last turn ended on, by its seq. */
  async function cardOf(sessionId: string) {
    const ask = await chiefAnswers.openAsk(
      db,
      await db.session.findFirstOrThrow({ where: { id: sessionId } }),
    )
    return ask!.seq
  }

  /** Chief's call in its pass, as its tools send it. */
  const passCall = (made: Made, op: object) =>
    chiefPass.handleChiefCall(
      db,
      scope,
      made.child,
      { id: chief, kind: 'chief' },
      op as never,
    ) as Promise<{ ok?: boolean; error?: string; status?: string }>

  test('Chief answers only by the person’s rules, never a design, only questions of its brief, until it reports', async () => {
    const id = await thread()
    const made = await pending(id, await asks(id))
    const question = (options: object[]) => ({
      kind: 'question',
      n: 1,
      title: 'Admin page',
      sessionId: id,
      teammate: 'Riley',
      teammateId: riley,
      askSeq: 0,
      options,
      question: 'Which card?',
      cardQuestion: null,
    })
    const card = await cardOf(id)
    await db.chiefPass.updateMany({
      where: { id: made.pass.id },
      data: {
        items: [
          {
            ...question([
              { label: 'A · Bold', message: 'Go with A · Bold', design: true },
              { label: 'B · Calm', message: 'Go with B · Calm', design: true },
            ]),
            askSeq: card,
          },
          {
            kind: 'ticket',
            n: 2,
            title: 'Admin page',
            sessionId: id,
            ticket: 'Approve',
            type: 'approval',
          },
        ],
      },
    })
    // A design is theirs.
    assert.match((await decide(made, { option: 1 })).error ?? '', /design is theirs/)
    assert.match((await decide(made, { item: 2 })).error ?? '', /no question/)
    assert.match((await decide(made, { item: 9 })).error ?? '', /no question/)
    assert.match((await decide(made, { option: 3 })).error ?? '', /has 2 answers/)
    // With no rules, nothing in their name.
    await setMember({ chiefRules: null })
    await db.chiefPass.updateMany({
      where: { id: made.pass.id },
      data: {
        items: [
          {
            ...question([
              { label: 'Build it', message: 'Build it' },
              { label: 'Not yet', message: 'Not yet' },
            ]),
            askSeq: card,
          },
        ],
      },
    })
    assert.match((await decide(made, { option: 1 })).error ?? '', /no rules/)
    assert.equal(await db.chiefDecision.count({ where: { sessionId: id } }), 0)
    // Reported: over.
    await setMember({ chiefRules: RULES })
    assert.equal(
      (await passCall(made, { name: 'chief_report', decisions: [], notes: [], rules: [] })).ok,
      true,
    )
    assert.match((await decide(made, { option: 1 })).error ?? '', /pass is over/)
    // A thread that is no pass: not here.
    const plain = await db.session.findFirstOrThrow({ where: { id } })
    const output = (await chiefPass.handleChiefCall(
      db,
      scope,
      plain,
      { id: chief, kind: 'chief' },
      {
        name: 'chief_answer',
        item: 1,
        option: 1,
        reason: 'r',
        rule: 'r',
      } as never,
    )) as { error?: string }
    assert.match(output.error ?? '', /daily pass/)
  })

  test('a failed thread is tried again by the pass, and Today shows what it settled, left and proposes', async () => {
    await setMember({ chiefPass: true, chiefRules: RULES, chiefRulesRefused: [] })
    const failed = await thread()
    await say(failed, { type: 'turn.started', teammateId: riley, accountId: account })
    await say(failed, { type: 'error', message: 'Request timed out' })
    await db.session.updateMany({ where: { id: failed }, data: { status: 'failed' } })
    const id = await thread()
    const made = await pending(id, await asks(id))
    const first = (await db.chiefPass.findFirstOrThrow({ where: { id: made.pass.id } }))
      .items as object[]
    await db.chiefPass.updateMany({
      where: { id: made.pass.id },
      data: {
        items: [
          ...first,
          {
            kind: 'failed',
            n: 2,
            title: 'Rollout',
            sessionId: failed,
            teammate: 'Riley',
            error: 'Request timed out',
          },
          {
            kind: 'pull',
            n: 3,
            title: 'Rollout',
            sessionId: failed,
            pull: 'acme/web#7: Rollout',
            state: 'ready to merge',
          },
        ],
        createdAt: new Date(),
      },
    })
    const conn = await runner()
    try {
      assert.match(
        (await passCall(made, { name: 'chief_retry', item: 1, reason: 'r' })).error ?? '',
        /did not fail/,
      )
      assert.equal(
        (
          await passCall(made, {
            name: 'chief_retry',
            item: 2,
            reason: 'A timeout, likely passing.',
          })
        ).ok,
        true,
      )
      await until(
        () =>
          conn.sent.some(
            (m) =>
              m.type === 'thread.retry' && (m.thread as { sessionId: string }).sessionId === failed,
          ),
        'the retry on the runner',
      )
      assert.equal((await decide(made, { option: 1 })).status, 'answered')
      assert.match(
        (
          await passCall(made, {
            name: 'chief_report',
            decisions: [{ item: 9, recommendation: 'x' }],
            notes: [],
            rules: [],
          })
        ).error ?? '',
        /No item 9/,
      )
      assert.equal(
        (
          await passCall(made, {
            name: 'chief_report',
            decisions: [{ item: 3, recommendation: 'Merge it: reviewed and green.' }],
            notes: [{ item: 2, text: 'It timed out twice this week.' }],
            rules: [
              { line: 'Timeouts: try again once', why: 'You retried each of the last three.' },
            ],
          })
        ).ok,
        true,
      )
      const view = (await chiefPass.passView(db, member('ada')))!
      assert.equal(view.id, made.pass.id)
      assert.equal(view.status, 'done')
      assert.deepEqual(
        view.settled.map((s) => [s.kind, s.thread?.id, s.what, s.status]),
        [
          ['answered', id, 'Build it', 'answered'],
          ['retried', failed, 'Tried its turn again', null],
        ],
      )
      assert.equal(view.settled[0]!.rule, 'Admin work: go ahead on next steps of what I asked for')
      assert.deepEqual(
        view.decisions.map((d) => [d.kind, d.thread?.id, d.recommendation, d.option, d.open]),
        [['pull', failed, 'Merge it: reviewed and green.', null, false]],
      )
      assert.deepEqual(view.notes, [
        { thread: { id: failed, title: 'Rollout' }, text: 'It timed out twice this week.' },
      ])
      assert.deepEqual(view.rules, [
        {
          line: 'Timeouts: try again once',
          why: 'You retried each of the last three.',
          state: 'proposed',
        },
      ])
      await chiefRules.decideRule(
        db,
        { ...scope, memberId: member('ada') },
        {
          line: 'Timeouts: try again once',
          add: true,
        },
      )
      assert.equal((await chiefPass.passView(db, member('ada')))!.rules[0]!.state, 'added')
    } finally {
      conn.close()
    }
  })

  test('a question still open on Today carries Chief’s pick; one answered meanwhile does not', async () => {
    const id = await thread()
    const made = await pending(id, await asks(id))
    await db.chiefPass.updateMany({ where: { id: made.pass.id }, data: { createdAt: new Date() } })
    await passCall(made, {
      name: 'chief_report',
      decisions: [{ item: 1, recommendation: 'Build it: it is next.', option: 1 }],
      notes: [],
      rules: [],
    })
    let view = (await chiefPass.passView(db, member('ada')))!
    assert.deepEqual(view.decisions[0]!.option, { label: 'Build it', message: 'Build it' })
    assert.equal(view.decisions[0]!.open, true)
    await person(id, 'Not yet')
    view = (await chiefPass.passView(db, member('ada')))!
    assert.equal(view.decisions[0]!.open, false)
  })

  test('a pass that ends without reporting, or runs too long, is over: what it did stays', async () => {
    const id = await thread()
    const made = await pending(id, await asks(id))
    await chiefPass.notePassEvents(scope, { id: made.child.id, chiefPassId: made.pass.id }, [
      { event: { type: 'turn.completed' } },
    ])
    assert.equal(
      (await db.chiefPass.findFirstOrThrow({ where: { id: made.pass.id } })).status,
      'failed',
    )
    // Its thread, over: archived.
    assert.ok((await db.session.findFirstOrThrow({ where: { id: made.child.id } })).archivedAt)
    // One that never started after a restart: over once it ran too long.
    const stuck = await pending(id, 1)
    await db.chiefPass.updateMany({
      where: { id: stuck.pass.id },
      data: { createdAt: new Date(Date.now() - 31 * 60_000) },
    })
    assert.ok((await chiefPass.duePasses()).includes(workspaceId))
    await chiefPass.runDuePasses(workspaceId)
    assert.equal(
      (await db.chiefPass.findFirstOrThrow({ where: { id: stuck.pass.id } })).status,
      'failed',
    )
    assert.ok((await db.session.findFirstOrThrow({ where: { id: stuck.child.id } })).archivedAt)
  })

  test('an answer reaches the teammate in the person’s name, by their rule', async () => {
    const id = await thread()
    const made = await pending(id, await asks(id))
    const conn = await runner()
    try {
      assert.equal(
        (await decide(made, { option: 1, rule: 'Admin work: go ahead on next steps' })).status,
        'answered',
      )
      const wakeup = await db.wakeup.findFirstOrThrow({ where: { sessionId: id } })
      assert.equal(wakeup.kind, 'report')
      assert.equal(wakeup.teammateId, riley)
      assert.equal(wakeup.sourceId, `chief:${made.decision!.id}`)
      const answerHere = (m: Sent) =>
        m.type === 'thread.prompt' &&
        (m.thread as { sessionId?: string }).sessionId === id &&
        contracts.chiefAnswerNote(m.text as string) !== null
      await until(() => conn.sent.some(answerHere), 'the answer on the runner')
      const prompt = conn.sent.find(answerHere)!
      assert.equal(prompt.memberId, null)
      assert.deepEqual(contracts.chiefAnswerNote(prompt.text as string), {
        answer: 'Build it',
        reason: 'It serves this week’s launch, and it is a pull request.',
        basis: 'Admin work: go ahead on next steps',
        decisionId: made.decision!.id,
      })
      const decision = await row(made.decision!.id)
      assert.equal(decision.passId, made.pass.id)
      assert.equal(decision.childSessionId, null)
      // The same card again: as it stands, once.
      assert.equal((await decide(made, { option: 2 })).status, 'answered')
      assert.equal(await db.chiefDecision.count({ where: { sessionId: id } }), 1)
    } finally {
      conn.close()
    }
  })

  test('moot once the person answered first', async () => {
    const id = await thread()
    const late = await pending(id, await asks(id))
    await person(id, 'Not yet')
    assert.equal((await decide(late, { option: 1 })).status, 'superseded')
    assert.equal(await db.wakeup.count({ where: { sessionId: id } }), 0)
  })

  test('after three answers in a row, the question is the person’s', async () => {
    const id = await thread()
    const card = await asks(id)
    // Three answers of Chief's on questions since Ada last wrote.
    for (let i = 1; i <= contracts.CHIEF_ANSWERS_IN_A_ROW; i++)
      await db.chiefDecision.create({
        data: {
          sessionId: id,
          memberId: member('ada'),
          teammateId: riley,
          askSeq: card + 1000 + i,
          options: [],
          status: 'answered',
        },
      } as never)
    const fourth = await pending(id, card)
    assert.equal((await decide(fourth, { option: 1 })).status, 'escalated')
    assert.equal(await db.wakeup.count({ where: { sessionId: id } }), 0)
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
    await setMember({ chiefPass: true, chiefRules: RULES })
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
    assert.equal(await word(), (await row(made.decision!.id)).askSeq)
    // The early message's hook, run late: Chief's word after it stands.
    await chiefAnswers.noteChiefAnswered({ id, organizationId: org, workspaceId, parentId: null }, [
      {
        seq: early,
        event: { type: 'message.user', memberId: member('ada'), text: 'An early word.' },
      },
    ])
    assert.equal(await word(), (await row(made.decision!.id)).askSeq)
    // Ada wrote, then Chief's answer reached the teammate after her: it is on Chief's word from there.
    const said = await person(id, 'Wait.')
    const note = await say(id, {
      type: 'message.user',
      memberId: null,
      text: contracts.chiefAnswerMessage({
        decisionId: made.decision!.id,
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
            decisionId: made.decision!.id,
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
    await setMember({ chiefPass: true, chiefRules: RULES })
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
      assert.ok((await row(made.decision!.id)).sentAt)
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
      assert.equal((await row(made.decision!.id)).status, 'answered')
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
      assert.equal((await row(made.decision!.id)).status, 'superseded')
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

  test('the person’s word comes first, and an answer made while it was on its way never goes', async () => {
    await setMember({ chiefPass: true, chiefRules: RULES })
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
      assert.equal((await decisionOf(id)).status, 'answered')
      ada.release()
      const response = (await ada.done) as Response
      assert.equal(response.status, 200, await response.clone().text())
      assert.equal((await decisionOf(id)).status, 'superseded')
      chief.release()
      await chief.done
      assert.deepEqual(prompts(conn.sent, id), ['Not yet'])

      // Her word kept while the pass still reads: its answer then is moot, and makes nothing.
      const next = await pending(id, await asks(id))
      const res = await call('ada', `/${id}/messages`, { body: { text: 'Stop there' } })
      assert.equal(res.status, 200, await res.clone().text())
      await decide(next, { option: 1 })
      assert.equal((await row(next.decision!.id)).status, 'superseded')
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
      assert.equal((await row(made.decision!.id)).status, 'superseded')
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
    await setMember({ chiefPass: true, chiefRules: RULES })
    const id = await thread()
    const conn = await runner()
    try {
      // Ada writes as the turn ends on a question; her computer has not taken it when Chief answers.
      const response = await call('ada', `/${id}/messages`, { body: { text: 'Also add tests.' } })
      assert.equal(response.status, 200, await response.clone().text())
      const made = await pending(id, await asks(id))
      await decide(made, { option: 1 })
      assert.equal((await row(made.decision!.id)).status, 'superseded')
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
    await setMember({ chiefPass: true, chiefRules: RULES })
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
    assert.equal((await row(made.decision!.id)).status, 'superseded')
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
    assert.equal((await row(made.decision!.id)).status, 'answered')
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
      assert.equal((await row(made.decision!.id)).status, 'answered')
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
      assert.ok((await row(made.decision!.id)).sentAt)
      // Stopped once it was kept, before its wake-up was settled: tried again, it goes once.
      await db.wakeup.updateMany({
        where: { id: wakeup.id },
        data: { status: 'pending', firedAt: null },
      })
      await fireAgain(wakeup.id)
      assert.deepEqual(prompts(conn.sent, id), ['chief'])
      assert.equal((await db.wakeup.findFirstOrThrow({ where: { id: wakeup.id } })).status, 'fired')
      assert.equal((await row(made.decision!.id)).status, 'answered')
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
    await setMember({ chiefPass: true, chiefRules: RULES })
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
        assert.equal((await row(made.decision!.id)).status, 'superseded')
        // Fired anyway (a tick that read it before): it goes nowhere.
        await db.wakeup.updateMany({ where: { id: wakeup.id }, data: { status: 'pending' } })
        await db.chiefDecision.updateMany({
          where: { id: made.decision!.id },
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
    await setMember({ chiefPass: true, chiefRules: RULES })
    const id = await thread()
    const labels = ['Sequential processing', 'Concurrent processing']
    const card = await asks(id, labels, { choices: true })
    const made = await pending(id, card, labels)
    const response = await call('ada', `/${id}/choices/dismiss`, { body: { seq: card } })
    assert.equal(response.status, 200, await response.clone().text())
    // Its answer arriving after it: nothing goes.
    assert.equal((await decide(made, { option: 1 })).status, 'superseded')
    assert.equal(await db.wakeup.count({ where: { sessionId: id } }), 0)
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

  test('marked wrong: the teammate is told to stop', async () => {
    const id = await thread()
    const made = await pending(id, await asks(id))
    const conn = await runner()
    try {
      await decide(made, { option: 1 })
      // Bob may not, in Ada's name.
      assert.equal(
        (await call('bob', `/${id}/chief/${made.decision!.id}/wrong`, { body: {} })).status,
        403,
      )
      const res = await call('ada', `/${id}/chief/${made.decision!.id}/wrong`, { body: {} })
      assert.equal(res.status, 200, await res.clone().text())
      assert.equal((await row(made.decision!.id)).outcome, 'overruled')
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
        (await call('ada', `/${id}/chief/${made.decision!.id}/wrong`, { body: {} })).status,
        200,
      )
    } finally {
      conn.close()
    }
  })

  /** Another connection's transaction holding Ada's row, as a write of hers in progress does. */
  async function holdingAda(write?: string) {
    const { newPrismaClient } = await import('../src/db.js')
    const other = newPrismaClient(process.env.DATABASE_URL!)
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let locked!: () => void
    const isLocked = new Promise<void>((resolve) => (locked = resolve))
    const held = other.$transaction(
      async (tx) => {
        if (write === 'off')
          await tx.$executeRaw`UPDATE "Member" SET "chiefPass" = false WHERE id = ${member('ada')}`
        else await tx.$executeRaw`SELECT 1 FROM "Member" WHERE id = ${member('ada')} FOR UPDATE`
        locked()
        await released
      },
      { timeout: 30_000 },
    )
    await isLocked
    /** How many queries wait on a lock: those that wait on her row. */
    const waiting = async () => {
      const [row] = await other.$queryRaw<[{ count: bigint }]>`
        SELECT count(*) FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`
      return Number(row.count)
    }
    return {
      waiting,
      done: async () => {
        release()
        await held
        await other.$disconnect()
      },
    }
  }

  test('a pass’s brief summons nobody, and is not the person’s word', async () => {
    await setMember({ chiefPass: true, chiefRules: RULES })
    const id = await thread()
    await person(id, 'Add the admin page.')
    await say(id, { type: 'turn.started', teammateId: riley, accountId: account })
    // A reply quoting a mention, as a teammate copies what an email or another thread said.
    await say(id, {
      type: 'message.done',
      id: `m-${randomUUID()}`,
      text: `I can ask @[Riley](teammate:${riley}) to check it. Shall I build it?`,
    })
    await say(id, {
      type: 'tool.started',
      toolName: 'suggest_replies',
      toolCallId: `t-${randomUUID()}`,
      input: { replies: ['Build it', 'Not yet'] },
    })
    await say(id, { type: 'turn.completed', finishReason: 'stop' })
    const conn = await runner()
    try {
      const passId = await chiefPass.startPass(scope, member('ada'), `brief-${randomUUID()}`)
      const pass = await db.chiefPass.findFirstOrThrow({ where: { id: passId! } })
      const ofPass = (m: Sent) =>
        m.type === 'thread.prompt' &&
        (m.thread as { sessionId: string }).sessionId === pass.sessionId
      await until(() => conn.sent.some(ofPass), 'the pass on the runner')
      const prompt = conn.sent.find(ofPass)!
      assert.match(prompt.text as string, /@\[Riley\]\(teammate:/)
      // Chief alone answers it: nobody after, nobody joining.
      assert.deepEqual(prompt.then ?? [], [])
      assert.deepEqual(
        (await db.threadTeammate.findMany({ where: { sessionId: pass.sessionId! } })).map(
          (t) => t.teammateId,
        ),
        [chief],
      )
      // Brigade's brief, shown as Brigade's: not her message, nor her word on a card.
      assert.ok(!prompt.memberId)
      assert.equal(
        (await db.session.findFirstOrThrow({ where: { id: pass.sessionId! } })).title,
        `Chief's pass · ${pass.day}`,
      )
    } finally {
      conn.close()
    }
  })

  test('turned off, a pass at work answers and retries nothing more in the person’s name', async () => {
    // Off in Preferences: the pass at work is over, in every workspace.
    const id = await thread()
    const made = await pending(id, await asks(id))
    const settings = await chiefRules.setChief(
      db,
      { ...scope, memberId: member('ada') },
      { pass: false },
    )
    assert.equal(settings.pass, false)
    assert.equal(
      (await db.chiefPass.findFirstOrThrow({ where: { id: made.pass.id } })).status,
      'failed',
    )
    assert.match((await decide(made, { option: 1 })).error ?? '', /over/)
    // Nor does one start.
    assert.equal(await chiefPass.startPass(scope, member('ada'), `off-${randomUUID()}`), null)
    // Off while its call was on its way: refused, and the pass is over.
    const two = await thread()
    const again = await pending(two, await asks(two))
    await setMember({ chiefPass: false })
    assert.match(
      (await passCall(again, { name: 'chief_retry', item: 1, reason: 'It failed.' })).error ?? '',
      /turned it off/,
    )
    assert.equal(
      (await db.chiefPass.findFirstOrThrow({ where: { id: again.pass.id } })).status,
      'failed',
    )
    assert.equal(await db.chiefDecision.count({ where: { sessionId: { in: [id, two] } } }), 0)
    // Turned off as an answer is being kept: it waits for her row, then reads it is off.
    const three = await thread()
    const card = await asks(three)
    const third = await pending(three, card)
    const ada = await holdingAda('off')
    const answering = decide(third, { option: 1 })
    try {
      await until(async () => (await ada.waiting()) > 0, 'the answer waiting on her row')
    } finally {
      await ada.done()
    }
    assert.match((await answering).error ?? '', /turned it off/)
    assert.equal(
      (await db.chiefPass.findFirstOrThrow({ where: { id: third.pass.id } })).status,
      'failed',
    )
    assert.equal(await db.chiefDecision.count({ where: { sessionId: three } }), 0)
    assert.equal(await db.wakeup.count({ where: { sessionId: three } }), 0)
    assert.equal((await db.session.findFirstOrThrow({ where: { id: three } })).chiefWordSeq, null)
  })

  test('rules taken or refused at once on Today all stay', async () => {
    await setMember({ chiefRules: '- Existing rule', chiefRulesRefused: [] })
    const ada = await holdingAda()
    const decided = Promise.all(
      [
        { line: 'Small fixes: open a PR', add: true },
        { line: 'Anything visual: ask me', add: true },
        { line: 'Deploys: go ahead', add: false },
        { line: 'Emails: send them', add: false },
      ].map((input) => chiefRules.decideRule(db, { ...scope, memberId: member('ada') }, input)),
    )
    try {
      // Each waits for her row: none read it before the others wrote.
      await until(async () => (await ada.waiting()) >= 4, 'the four waiting on her row')
    } finally {
      await ada.done()
    }
    await decided
    const now = await prisma.member.findUniqueOrThrow({ where: { id: member('ada') } })
    assert.deepEqual(now.chiefRules!.split('\n').sort(), [
      '- Anything visual: ask me',
      '- Existing rule',
      '- Small fixes: open a PR',
    ])
    assert.deepEqual([...now.chiefRulesRefused].sort(), ['Deploys: go ahead', 'Emails: send them'])
  })

  test('an answer is kept with where it goes, or not at all; one #724 left unsettled is the pass’s', async () => {
    const id = await thread()
    const card = await asks(id)
    const made = await pending(id, card)
    const input = {
      sessionId: id,
      memberId: member('ada'),
      teammateId: riley,
      askSeq: card,
      options: [
        { label: 'Build it', message: 'Build it' },
        { label: 'Not yet', message: 'Not yet' },
      ],
      cardQuestion: null,
      optionIndex: 0,
      reason: 'It serves the launch.',
      rule: 'Admin work: go ahead on next steps of what I asked for',
      passId: made.pass.id,
    }
    // Cut off midway (its wake-up cannot be kept): nothing of it stays, the card is still open.
    await assert.rejects(chiefAnswers.answerInTheirName(scope, { ...input, teammateId: 'gone' }))
    assert.equal(await db.chiefDecision.count({ where: { sessionId: id } }), 0)
    assert.equal((await db.session.findFirstOrThrow({ where: { id } })).chiefWordSeq, null)
    // A decision left pending on the card (#724's still being made, or one cut off before this
    // change): listed, not shown as settled, and the pass's answer settles it.
    const left = await db.chiefDecision.create({
      data: {
        sessionId: id,
        memberId: member('ada'),
        teammateId: riley,
        askSeq: card,
        options: input.options,
        passId: made.pass.id,
        verdict: 'answer',
        optionIndex: 0,
      },
    } as never)
    const listed = async () =>
      (await chiefPass.passItems(db, member('ada'))).some(
        (i) => i.kind === 'question' && i.sessionId === id,
      )
    const settled = async () =>
      ((await chiefPass.passView(db, member('ada')))?.settled ?? []).map((s) => s.decisionId)
    assert.ok(await listed())
    assert.ok(!(await settled()).includes(left.id))
    assert.equal((await decide(made, { option: 1 })).status, 'answered')
    assert.ok((await settled()).includes(left.id))
    const answered = await row(left.id)
    assert.equal(answered.status, 'answered')
    assert.equal(answered.passId, made.pass.id)
    assert.equal(answered.basis, 'Admin work: go ahead on next steps of what I asked for')
    assert.equal(
      await db.wakeup.count({ where: { sessionId: id, sourceId: `chief:${left.id}` } }),
      1,
    )
    // Asked again: as it stands, sent once.
    const twice = await decide(made, { option: 2 })
    assert.equal(twice.status, 'answered')
    assert.equal(await db.wakeup.count({ where: { sessionId: id } }), 1)
    assert.ok(!(await listed()))
  })
})
