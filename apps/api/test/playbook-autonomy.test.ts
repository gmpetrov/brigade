import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import type { PlaybookActionSpec, PlaybookManifest } from '@brigade/contracts'

// The rules alone need nothing. The flows through the database (a write in a run, a proposal,
// a flag, a level changed) run on the API's development database (apps/api/.env), each in a
// workspace of its own removed at the end, and are skipped when none answers.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { argumentOf, levelProblem, mergeRefusal, numbersOf, promotionDue, pullChecks, verdict } =
  await import('../src/playbook-autonomy.js')

const action = (change: Partial<PlaybookActionSpec> = {}): PlaybookActionSpec => ({
  key: 'reply',
  label: 'Reply to the customer',
  tools: ['gmail_send'],
  start: 'ask',
  ceiling: 'auto',
  conditions: ['case'],
  ...change,
})
const merge = action({
  key: 'merge',
  label: 'Merge a pull request',
  tools: ['github_merge_pull_request'],
  conditions: ['checks_passed'],
})

const never = async (): Promise<never> => {
  throw new Error('not read')
}
/** The verdict on a call to an action stored at `level`, with what limits it. */
const judge = (input: {
  action?: PlaybookActionSpec
  unlisted?: boolean
  level?: 'ask' | 'auto' | 'deny'
  conditions?: unknown
  limits?: unknown
  args?: unknown
  runCase?: string | null
  usage?: { count: number; sums: Record<string, number> }
  checks?: { passed: boolean; why: string }
}) =>
  verdict({
    playbook: 'Support',
    action: input.unlisted ? undefined : (input.action ?? action()),
    stored: {
      level: input.level ?? 'auto',
      conditions: input.conditions ?? {},
      limits: input.limits ?? {},
    },
    args: input.args ?? { to: ['jane@customer.test'], subject: 'Hi', body: 'Hello' },
    runCase: input.runCase ?? null,
    usage: input.usage ? async () => input.usage! : never,
    checks: input.checks ? async () => input.checks! : never,
  })

describe('a write in a playbook run', () => {
  test('a write no action lists asks, with why', async () => {
    const v = await judge({ unlisted: true })
    assert.equal(v.level, 'ask')
    assert.match(
      (v as { reason: string }).reason,
      /not one of the writes the playbook Support lists/,
    )
  })

  test('each level does what it says, and never above the ceiling', async () => {
    assert.deepEqual(await judge({ level: 'ask' }), { level: 'ask' })
    assert.equal((await judge({ level: 'deny' })).level, 'deny')
    assert.deepEqual(await judge({ level: 'auto' }), { level: 'auto' })
    // A template that lowered its ceiling since: stored on its own, it asks.
    assert.deepEqual(await judge({ level: 'auto', action: action({ ceiling: 'ask' }) }), {
      level: 'ask',
    })
  })

  test("on its own by case: only in runs of those cases, and not before the run's case is known", async () => {
    const conditions = { cases: ['documented_question'] }
    assert.deepEqual(await judge({ conditions, runCase: 'documented_question' }), { level: 'auto' })
    assert.deepEqual(await judge({ conditions, runCase: 'Documented_Question' }), { level: 'auto' })
    const other = await judge({ conditions, runCase: 'bug' })
    assert.equal(other.level, 'ask')
    assert.match(
      (other as { reason: string }).reason,
      /only for documented_question; this run is bug/,
    )
    const unsorted = await judge({ conditions, runCase: null })
    assert.match((unsorted as { reason: string }).reason, /has not said its case yet/)
  })

  test("on its own up to an argument's value, read from the real call", async () => {
    const refund = action({ key: 'refund', label: 'Refund', conditions: ['amount'] })
    const conditions = { max: { amount: 50 } }
    assert.equal((await judge({ action: refund, conditions, args: { amount: 50 } })).level, 'auto')
    const over = await judge({ action: refund, conditions, args: { amount: 51 } })
    assert.match((over as { reason: string }).reason, /only up to 50 \(amount\); this one is 51/)
    // Missing, or not a number: it asks.
    assert.equal((await judge({ action: refund, conditions, args: {} })).level, 'ask')
    assert.equal((await judge({ action: refund, conditions, args: { amount: '10' } })).level, 'ask')
    // Nested arguments by dotted path.
    assert.equal(
      (
        await judge({
          action: refund,
          conditions: { max: { 'refund.amount': 5 } },
          args: { refund: { amount: 4 } },
        })
      ).level,
      'auto',
    )
  })

  test('caps over 24 hours: past one it asks; usage is read only when there is one', async () => {
    assert.equal((await judge({ limits: {} })).level, 'auto') // `never` would throw if read
    const count = { count: 3 }
    assert.equal((await judge({ limits: count, usage: { count: 2, sums: {} } })).level, 'auto')
    const capped = await judge({ limits: count, usage: { count: 3, sums: {} } })
    assert.match(
      (capped as { reason: string }).reason,
      /at most 3 times in 24 hours, and that many were done already/,
    )
    const amount = { amount: { argument: 'amount', max: 100 } }
    assert.equal(
      (
        await judge({
          limits: amount,
          args: { amount: 20 },
          usage: { count: 4, sums: { amount: 80 } },
        })
      ).level,
      'auto',
    )
    const over = await judge({
      limits: amount,
      args: { amount: 30 },
      usage: { count: 4, sums: { amount: 80 } },
    })
    assert.match(
      (over as { reason: string }).reason,
      /up to 100 amount in 24 hours: 80 so far, and this one is 30/,
    )
  })

  test('a merge on its own waits for its checks, even with no condition stored', async () => {
    const passed = { passed: true, why: 'ci passed' }
    const pending = { passed: false, why: 'ci still running' }
    assert.deepEqual(await judge({ action: merge, checks: passed }), { level: 'auto' })
    const waiting = await judge({ action: merge, conditions: {}, checks: pending })
    assert.equal(waiting.level, 'ask')
    assert.match(
      (waiting as { reason: string }).reason,
      /every required check passed: ci still running/,
    )
  })

  test('stored conditions that do not read ask, rather than act', async () => {
    assert.equal((await judge({ conditions: { cases: 'bug' } })).level, 'ask')
    assert.equal((await judge({ limits: { count: -1 } })).level, 'ask')
  })

  test('arguments by path, and a call kept as its numbers only', () => {
    assert.equal(argumentOf({ a: { b: 2 } }, 'a.b'), 2)
    assert.equal(argumentOf({ a: [1] }, 'a.0'), undefined)
    assert.deepEqual(numbersOf({ amount: 5, to: ['x'], body: 'Hi', refund: { cents: 30 } }), {
      amount: 5,
      'refund.cents': 30,
    })
  })
})

/** A GitHub answering from a table of paths (query left out); anything else is a 404. */
const github = (routes: Record<string, unknown>) => async (url: string) => {
  const body = routes[new URL(url).pathname]
  return body === undefined
    ? Response.json({ message: 'Not Found' }, { status: 404 })
    : Response.json(body)
}
const pull = {
  state: 'open',
  head: { sha: 'abc' },
  base: { ref: 'main' },
  mergeable_state: 'clean',
}
const protectedMain = {
  protection: {
    required_status_checks: { enforcement_level: 'everyone', contexts: ['ci'], checks: [] },
  },
}
const run = (name: string, status: string, conclusion: string | null) => ({
  name,
  status,
  conclusion,
})
const repo = (checkRuns: unknown[], extra: Record<string, unknown> = {}) =>
  github({
    '/repos/acme/web/pulls/7': pull,
    '/repos/acme/web/branches/main': protectedMain,
    '/repos/acme/web/rules/branches/main': [],
    '/repos/acme/web/commits/abc/check-runs': { check_runs: checkRuns },
    '/repos/acme/web/commits/abc/status': { statuses: [] },
    ...extra,
  })

describe("a pull request's checks", () => {
  test('pass when every required check passed and nothing else is pending or failing', async () => {
    const checks = await pullChecks(
      repo([run('ci', 'completed', 'success'), run('lint', 'completed', 'skipped')]),
      'acme/web',
      7,
    )
    assert.deepEqual(checks, { passed: true, why: 'ci passed' })
  })

  test('do not pass while one runs, one failed, or a required one has not reported', async () => {
    const pending = await pullChecks(repo([run('ci', 'in_progress', null)]), 'acme/web', 7)
    assert.deepEqual(pending, { passed: false, why: 'ci still running' })
    const failed = await pullChecks(
      repo([run('ci', 'completed', 'success'), run('e2e', 'completed', 'failure')]),
      'acme/web',
      7,
    )
    assert.deepEqual(failed, { passed: false, why: 'e2e failed' })
    const missing = await pullChecks(repo([run('lint', 'completed', 'success')]), 'acme/web', 7)
    assert.deepEqual(missing, { passed: false, why: 'ci not reported yet' })
  })

  test("do not pass on a branch that requires none; a ruleset's required checks count", async () => {
    const none = await pullChecks(
      repo([run('ci', 'completed', 'success')], {
        '/repos/acme/web/branches/main': { protected: false },
      }),
      'acme/web',
      7,
    )
    assert.equal(none.passed, false)
    assert.match(none.why, /requires no checks/)
    const ruleset = await pullChecks(
      repo([run('ci', 'completed', 'success'), run('build', 'completed', 'success')], {
        '/repos/acme/web/branches/main': { protected: false },
        '/repos/acme/web/rules/branches/main': [
          {
            type: 'required_status_checks',
            parameters: { required_status_checks: [{ context: 'build' }] },
          },
        ],
      }),
      'acme/web',
      7,
    )
    assert.deepEqual(ruleset, { passed: true, why: 'build passed' })
  })

  test("without the Checks permission, GitHub's own verdict on the pull request decides", async () => {
    const unreadable = (state: string) =>
      repo([], {
        '/repos/acme/web/pulls/7': { ...pull, mergeable_state: state },
        '/repos/acme/web/commits/abc/check-runs': undefined,
        '/repos/acme/web/commits/abc/status': undefined,
      })
    assert.deepEqual(await pullChecks(unreadable('clean'), 'acme/web', 7), {
      passed: true,
      why: 'GitHub says every check passed',
    })
    assert.deepEqual(await pullChecks(unreadable('blocked'), 'acme/web', 7), {
      passed: false,
      why: 'GitHub says it is blocked',
    })
    assert.deepEqual(await pullChecks(unreadable('unknown'), 'acme/web', 7), {
      passed: false,
      why: 'ci not reported yet',
    })
  })

  test("a merge on its own is refused on a repository that requires no checks, or whose checks can't be read", async () => {
    const withRepo = (branch: unknown) =>
      github({
        '/repos/acme/web': { default_branch: 'main' },
        '/repos/acme/web/branches/main': branch,
        '/repos/acme/web/rules/branches/main': [],
      })
    assert.equal(await mergeRefusal(withRepo(protectedMain), 'acme/web'), null)
    assert.match(
      (await mergeRefusal(withRepo({ protected: false }), 'acme/web')) ?? '',
      /requires no status checks on main/,
    )
    assert.match(
      (await mergeRefusal(github({}), 'acme/web')) ?? '',
      /could not read which checks acme\/web requires/,
    )
    assert.match((await mergeRefusal(null, 'acme/web')) ?? '', /No GitHub connection/)
    assert.match((await mergeRefusal(null, null)) ?? '', /repository setting has no answer/)
  })
})

describe('who changes a level, and how far', () => {
  const problem = (input: {
    action?: PlaybookActionSpec
    level: 'ask' | 'auto' | 'deny'
    conditions?: Record<string, unknown>
    role?: string
    owns?: boolean
  }) =>
    levelProblem({
      action: input.action ?? action(),
      update: { level: input.level, ...(input.conditions ? { conditions: input.conditions } : {}) },
      role: input.role ?? 'member',
      owns: input.owns ?? true,
    })

  test("the playbook's owner, an owner or an admin; no other member", () => {
    assert.equal(problem({ level: 'auto' }), null)
    assert.equal(problem({ level: 'auto', owns: false, role: 'admin' }), null)
    assert.equal(problem({ level: 'auto', owns: false, role: 'owner' }), null)
    assert.equal(problem({ level: 'deny', owns: false })?.status, 403)
  })

  test("never above the template's ceiling", () => {
    const capped = action({ ceiling: 'ask' })
    assert.deepEqual(problem({ action: capped, level: 'auto' }), {
      status: 400,
      message: 'Reply to the customer goes no further than Asks first in this playbook',
    })
    assert.equal(problem({ action: capped, level: 'deny' }), null)
  })

  test('a merge on its own is an owner or admin call', () => {
    assert.equal(problem({ action: merge, level: 'auto' })?.status, 403)
    assert.equal(problem({ action: merge, level: 'auto', role: 'admin' }), null)
    assert.equal(problem({ action: merge, level: 'ask' }), null)
  })

  test('only the conditions the template allows', () => {
    assert.equal(problem({ level: 'auto', conditions: { cases: ['bug'] } }), null)
    assert.equal(
      problem({ action: merge, level: 'auto', role: 'admin', conditions: { cases: ['bug'] } })
        ?.status,
      400,
    )
    assert.equal(problem({ level: 'auto', conditions: { checksPassed: true } })?.status, 400)
    assert.match(
      problem({ level: 'auto', conditions: { max: { amount: 5 } } })?.message ?? '',
      /cannot be limited by amount/,
    )
    const refund = action({ conditions: ['amount'] })
    assert.equal(
      problem({ action: refund, level: 'auto', conditions: { max: { amount: 5 } } }),
      null,
    )
  })
})

describe('proposing to act on its own', () => {
  const promotion = { decisions: 30, approvedRate: 0.95 }
  const at = (n: number) => new Date(Date.UTC(2026, 9, 1, 0, n))
  /** Newest first: `approved` approvals, then denials, the latest at minute `from`. */
  const decisions = (approved: number, denied: number, from = 100, bulk = 0) =>
    Array.from({ length: approved + denied }, (_, i) => ({
      approved: i < approved,
      at: at(from - i),
      bulk: i < bulk,
    }))
  const due = (list: ReturnType<typeof decisions>, change: Record<string, unknown> = {}) =>
    promotionDue({
      action: action(),
      level: 'ask',
      promotion,
      decisions: list,
      since: null,
      open: false,
      ...change,
    })

  test('at the threshold of the latest window, with the numbers', () => {
    assert.deepEqual(due(decisions(29, 1)), { approved: 29, decided: 30 })
    assert.equal(due(decisions(28, 2)), null)
    assert.equal(due(decisions(29, 0)), null) // not a whole window yet
    // Only the latest 30 count: older denials are past.
    assert.deepEqual(due([...decisions(30, 0), ...decisions(0, 10, 50)]), {
      approved: 30,
      decided: 30,
    })
  })

  test('decisions made in bulk do not count', () => {
    assert.equal(due(decisions(30, 0, 100, 5)), null)
    assert.deepEqual(due(decisions(35, 0, 100, 5)), { approved: 30, decided: 30 })
  })

  test('never while one is open, off asking, past its ceiling, or for a merge', () => {
    assert.equal(due(decisions(30, 0), { open: true }), null)
    assert.equal(due(decisions(30, 0), { level: 'auto' }), null)
    assert.equal(due(decisions(30, 0), { action: action({ ceiling: 'ask' }) }), null)
    assert.equal(due(decisions(30, 0), { action: merge }), null)
  })

  test('after a refusal, only a whole new window of decisions counts', () => {
    const list = decisions(40, 0)
    // Refused at minute 80: the 20 decisions since are not a window.
    assert.equal(due(list, { since: at(80) }), null)
    assert.deepEqual(due(list, { since: at(70) }), { approved: 30, decided: 30 })
  })
})

// ---------------------------------------------------------------------------
// Through the database
// ---------------------------------------------------------------------------

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

const MANIFEST = {
  id: 'brigade/test',
  name: 'Support',
  version: '1.0.0',
  description: 'Answers the inbox.',
  apps: [
    { kind: 'gmail', access: 'read_write' },
    { kind: 'github', access: 'read_write' },
  ],
  settings: [{ key: 'repo', type: 'repository' }],
  entries: [{ schedule: '0 8 * * 1', instructions: 'Review.' }],
  skills: [],
  actions: [
    { ...action(), conditions: ['case'] },
    {
      ...action({
        key: 'draft',
        label: 'Draft a reply',
        tools: ['gmail_create_draft'],
        ceiling: 'ask',
        conditions: [],
      }),
    },
    merge,
  ],
  limits: { runsPerDay: 100 },
  promotion: { decisions: 3, approvedRate: 0.95 },
  metrics: [],
} satisfies PlaybookManifest

describe('through the database', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<
    | 'org'
    | 'workspace'
    | 'owner'
    | 'other'
    | 'admin'
    | 'computer'
    | 'teammate'
    | 'gmail'
    | 'installation'
    | 'run'
    | 'session',
    string
  >
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }
  const as = (who: 'owner' | 'other' | 'admin') => ({
    ...scope,
    userId: `${who}-${suffix}`,
    memberId: ids[who],
    role: who === 'admin' ? ('admin' as const) : ('member' as const),
  })

  before(async () => {
    ids.org = `org-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Autonomy', slug: `autonomy-${suffix}` },
    })
    for (const who of ['owner', 'other', 'admin'] as const) {
      await prisma.user.create({
        data: { id: `${who}-${suffix}`, name: who, email: `${who}-${suffix}@test.local` },
      })
      ids[who] = `m-${who}-${suffix}`
      await prisma.member.create({
        data: {
          id: ids[who],
          organizationId: ids.org,
          userId: `${who}-${suffix}`,
          role: who === 'admin' ? 'admin' : 'member',
        },
      })
    }
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Autonomy' } })
    ).id
    scope = { organizationId: ids.org, workspaceId: ids.workspace }
    db = scoped(scope)
    ids.computer = (await db.computer.create({ data: { kind: 'cloud', name: 'Test' } as never })).id
    ids.teammate = (await db.teammate.create({ data: { name: 'Sam' } as never })).id
    const app = await db.app.create({
      data: { key: 'gmail', createdByMemberId: ids.owner } as never,
    })
    ids.gmail = (
      await db.connection.create({
        data: {
          appId: app.id,
          kind: 'gmail',
          label: 'Gmail',
          externalAccount: 'support@acme.test',
          createdByMemberId: ids.owner,
        } as never,
      })
    ).id
    await db.grant.create({
      data: { teammateId: ids.teammate, connectionId: ids.gmail, scope: 'read_write' } as never,
    })
    ids.installation = (
      await db.playbookInstallation.create({
        data: {
          playbookKey: MANIFEST.id,
          version: MANIFEST.version,
          manifest: MANIFEST,
          teammateId: ids.teammate,
          ownerMemberId: ids.owner,
          settings: { repo: 'acme/web' },
          status: 'active',
          createdByMemberId: ids.owner,
        } as never,
      })
    ).id
    await db.playbookAction.createMany({
      data: MANIFEST.actions.map((a) => ({
        installationId: ids.installation,
        key: a.key,
        level: a.start,
      })) as never,
    })
    ids.run = (
      await db.playbookRun.create({ data: { installationId: ids.installation } as never })
    ).id
    ids.session = (
      await db.session.create({
        data: {
          teammateId: ids.teammate,
          startedByMemberId: ids.owner,
          computerId: ids.computer,
          title: 'Mail from Jane',
          origin: 'trigger',
          playbookRunId: ids.run,
        } as never,
      })
    ).id
  })

  after(async () => {
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({
      where: { id: { in: ['owner', 'other', 'admin'].map((w) => `${w}-${suffix}`) } },
    })
    await prisma.$disconnect()
  })

  const setAction = (key: string, data: Record<string, unknown>) =>
    db.playbookAction.updateMany({
      where: { installationId: ids.installation, key },
      data: data as never,
    })

  /**
   * A write from the run's thread, as its runner sends it. One that asks is decided as `decide`
   * says; returns what the runner heard.
   */
  async function write(operation: string, input: unknown, decide?: { approved: boolean }) {
    const { handleConnectorCall, decideTicket } = await import('../src/connector-calls.js')
    const heard: {
      type: string
      ticketId?: string
      reason?: string
      ok?: boolean
      error?: string
    }[] = []
    let pending: (ticketId: string) => void = () => {}
    const asked = new Promise<string>((resolve) => (pending = resolve))
    const done = handleConnectorCall(
      { computerId: ids.computer, ...scope },
      {
        type: 'connector.call',
        callId: randomUUID(),
        sessionId: ids.session,
        connectionId: ids.gmail,
        operation,
        input,
      },
      (message) => {
        heard.push(message as never)
        if (message.type === 'connector.pending') pending(message.ticketId)
      },
    )
    const first = await Promise.race([asked, done.then(() => null)])
    if (first) {
      assert.ok(decide, `${operation} asked a person`)
      await decideTicket({ ...scope, memberId: ids.owner }, first, decide)
      await done
    }
    return heard
  }
  const mail = { to: ['jane@customer.test'], subject: 'Re: login', body: 'Here is how.' }
  const lastCall = () =>
    db.connectionCall.findFirst({
      where: { sessionId: ids.session },
      orderBy: { createdAt: 'desc' },
    })

  test('at ask, a write waits on a ticket carrying the playbook, its action and its run', async () => {
    const heard = await write('gmail_send', mail, { approved: true })
    const pending = heard.find((m) => m.type === 'connector.pending')!
    const ticket = await db.ticket.findFirst({ where: { id: pending.ticketId } })
    assert.deepEqual([ticket?.type, ticket?.status], ['approval', 'approved'])
    const payload = ticket?.payload as Record<string, unknown>
    assert.equal(payload.playbookInstallationId, ids.installation)
    assert.equal(payload.playbookActionKey, 'reply')
    assert.equal(payload.playbookRunId, ids.run)
    // It then ran, and failed for want of a credential: recorded against the action, with its ticket.
    const call = await lastCall()
    assert.deepEqual(
      [call?.result, call?.playbookActionKey, call?.ticketId],
      ['error', 'reply', ticket?.id],
    )
  })

  test('a write no action lists asks, even when the teammate may write freely', async () => {
    const heard = await write(
      'gmail_modify_labels',
      { messageId: 'm1', addLabelIds: ['STARRED'] },
      { approved: false },
    )
    const pending = heard.find((m) => m.type === 'connector.pending')!
    assert.match(pending.reason ?? '', /not one of the writes the playbook Support lists/)
    const payload = (await db.ticket.findFirst({ where: { id: pending.ticketId } }))
      ?.payload as Record<string, unknown>
    assert.equal(payload.playbookActionKey, null)
    assert.equal(heard.at(-1)?.ok, false)
  })

  test("on its own by case: it asks until the run's case is one of them, then acts without asking", async () => {
    await setAction('reply', { level: 'auto', conditions: { cases: ['documented_question'] } })
    const before = await write('gmail_send', mail, { approved: false })
    assert.match(
      before.find((m) => m.type === 'connector.pending')?.reason ?? '',
      /has not said its case yet/,
    )

    const { triageRun } = await import('../src/playbook-autonomy.js')
    await triageRun(
      db,
      scope,
      { id: ids.session, playbookRunId: ids.run },
      { id: ids.teammate },
      {
        name: 'playbook_triage',
        case: 'documented_question',
      },
    )
    const after = await write('gmail_send', mail)
    assert.equal(
      after.some((m) => m.type === 'connector.pending'),
      false,
    )
    const call = await lastCall()
    assert.deepEqual([call?.result, call?.ticketId], ['error', null])
  })

  test('past its cap over 24 hours, it asks; the level stays', async () => {
    await setAction('reply', { level: 'auto', conditions: {}, limits: { count: 2 } })
    for (let i = 0; i < 2; i++)
      await db.connectionCall.create({
        data: {
          sessionId: ids.session,
          connectionId: ids.gmail,
          teammateId: ids.teammate,
          operation: 'gmail_send',
          write: true,
          target: 'email to jane',
          result: 'ok',
          playbookActionKey: 'reply',
          input: {},
        } as never,
      })
    const heard = await write('gmail_send', mail, { approved: false })
    assert.match(
      heard.find((m) => m.type === 'connector.pending')?.reason ?? '',
      /at most 2 times in 24 hours/,
    )
    const row = await db.playbookAction.findFirst({
      where: { installationId: ids.installation, key: 'reply' },
    })
    assert.equal(row?.level, 'auto')
    await setAction('reply', { limits: {} })
  })

  test("a deny in the teammate's policy wins over on its own", async () => {
    await setAction('reply', { level: 'auto', conditions: {} })
    await db.teammate.updateMany({
      where: { id: ids.teammate },
      data: { permissionPolicy: { connectorWrites: 'deny' } },
    })
    const heard = await write('gmail_send', mail)
    assert.match(heard.at(-1)?.error ?? '', /may not make changes through connectors/)
    await db.teammate.updateMany({ where: { id: ids.teammate }, data: { permissionPolicy: {} } })
  })

  /** A decision people made on one of an action's approvals, `minutes` ago. */
  const decided = (key: string, approved: boolean, minutes: number, bulk = false) =>
    db.ticket.create({
      data: {
        sessionId: ids.session,
        type: 'approval',
        status: approved ? 'approved' : 'denied',
        title: 'Sam: gmail send',
        resolvedAt: new Date(Date.now() - minutes * 60_000),
        payload: {
          playbookInstallationId: ids.installation,
          playbookActionKey: key,
          playbookRunId: ids.run,
          ...(bulk ? { decidedInBulk: true } : {}),
        },
      } as never,
    })
  const promotions = () =>
    db.ticket.findMany({
      where: { payload: { path: ['playbookPromotion', 'actionKey'], equals: 'reply' } },
      orderBy: { createdAt: 'asc' },
    })

  test('proposed once at the threshold, not on decisions in bulk; a refusal waits a whole window', async () => {
    const { proposePromotion, decidePromotion } = await import('../src/playbook-autonomy.js')
    await db.ticket.deleteMany({
      where: { payload: { path: ['playbookActionKey'], equals: 'reply' } },
    })
    await setAction('reply', { level: 'ask', levelChangedAt: null })
    const propose = () =>
      proposePromotion(db, scope, {
        installationId: ids.installation,
        actionKey: 'reply',
        sessionId: ids.session,
      })

    // The window is 3 here: two approvals and one in bulk are not enough.
    await decided('reply', true, 30)
    await decided('reply', true, 29)
    await decided('reply', true, 28, true)
    assert.equal(await propose(), null)
    await decided('reply', true, 27)
    const first = await propose()
    assert.ok(first)
    assert.equal(await propose(), null) // one open at a time
    const [ticket] = await promotions()
    assert.deepEqual((ticket?.payload as { playbookPromotion: unknown }).playbookPromotion, {
      installationId: ids.installation,
      actionKey: 'reply',
      approved: 3,
      decided: 3,
      label: 'Reply to the customer',
      playbook: 'Support',
      ownerMemberId: ids.owner,
    })
    // Another member may not decide; its owner refuses.
    await assert.rejects(
      decidePromotion(db, as('other'), ticket!, true),
      /Only the playbook's owner/,
    )
    await decidePromotion(db, as('owner'), ticket!, false)
    assert.equal(await propose(), null)
    // Decided after the refusal (a minute from now, and later).
    await decided('reply', true, -1)
    await decided('reply', true, -2)
    assert.equal(await propose(), null) // two since the refusal
    await decided('reply', true, -3)
    assert.ok(await propose())

    // Approved: on its own from now on.
    const latest = (await promotions()).at(-1)!
    await decidePromotion(db, as('owner'), latest, true)
    const row = await db.playbookAction.findFirst({
      where: { installationId: ids.installation, key: 'reply' },
    })
    assert.deepEqual([row?.level, row?.levelChangedByMemberId], ['auto', ids.owner])
  })

  test('the sheet counts decisions without those in bulk, and lists calls on its own', async () => {
    const { getInstallation } = await import('../src/playbooks.js')
    const view = await getInstallation(db, ids.installation, {
      memberId: ids.other,
      role: 'member',
    })
    const reply = view.actions.find((a) => a.key === 'reply')!
    assert.deepEqual([reply.approved, reply.denied, reply.window], [3, 0, 3])
    assert.equal(reply.canChange, false)
    assert.equal(reply.autoToday, 2)
    assert.equal(view.autoCalls.length, 2)
    assert.equal(view.actions.find((a) => a.key === 'merge')?.needsChecks, true)
  })

  test("marking a call on its own as wrong sends its action back to asking; another member can't", async () => {
    const { flagCall } = await import('../src/playbook-autonomy.js')
    const call = await db.connectionCall.findFirst({
      where: { playbookActionKey: 'reply', result: 'ok', ticketId: null },
    })
    await assert.rejects(
      flagCall(db, as('other'), ids.installation, call!.id),
      /only they or an owner or admin/,
    )
    // A call a person approved is not one done on its own.
    const approved = await db.connectionCall.findFirst({ where: { ticketId: { not: null } } })
    await assert.rejects(
      flagCall(db, as('owner'), ids.installation, approved!.id),
      /no call on its own/,
    )
    await flagCall(db, as('owner'), ids.installation, call!.id)
    const row = await db.playbookAction.findFirst({
      where: { installationId: ids.installation, key: 'reply' },
    })
    assert.deepEqual([row?.level, row?.demotedReason], ['ask', 'flagged'])
    // The call log is append-only: the mark is an audit entry, and the sheet shows it.
    const { getInstallation } = await import('../src/playbooks.js')
    const view = await getInstallation(db, ids.installation, {
      memberId: ids.owner,
      role: 'member',
    })
    assert.equal(view.autoCalls.find((c) => c.id === call!.id)?.flagged, true)
    assert.equal(view.actions.find((a) => a.key === 'reply')?.demotedReason, 'flagged')
    // Marked once: again changes nothing.
    await flagCall(db, as('owner'), ids.installation, call!.id)
  })

  test("changing a level: who may, the ceiling, and a merge's required checks", async () => {
    const { changeAction } = await import('../src/playbook-autonomy.js')
    const change = (
      who: 'owner' | 'other' | 'admin',
      key: string,
      level: 'ask' | 'auto' | 'deny',
      branch?: unknown,
    ) =>
      changeAction(db, as(who), ids.installation, key, { level }, async () =>
        github({
          '/repos/acme/web': { default_branch: 'main' },
          '/repos/acme/web/branches/main': branch ?? { protected: false },
          '/repos/acme/web/rules/branches/main': [],
        }),
      )
    await assert.rejects(change('other', 'reply', 'auto'), /only they or an owner or admin/)
    await assert.rejects(change('owner', 'draft', 'auto'), /goes no further than Asks first/)
    await change('owner', 'reply', 'auto')
    await assert.rejects(change('owner', 'merge', 'auto', protectedMain), /Only an owner or admin/)
    await assert.rejects(change('admin', 'merge', 'auto'), /requires no status checks on main/)
    await change('admin', 'merge', 'auto', protectedMain)
    const merged = await db.playbookAction.findFirst({
      where: { installationId: ids.installation, key: 'merge' },
    })
    assert.deepEqual([merged?.level, merged?.conditions], ['auto', { checksPassed: true }])
  })
})
