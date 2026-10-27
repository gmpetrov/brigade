import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, beforeEach, describe, test } from 'node:test'
import pg from 'pg'

// Operators' alerts (src/ops/): the rules, without a database; raising and resolving, against
// the local database of apps/api/.env, on keys of its own that it removes at the end, with the
// webhook played by a fake fetch. Without a database to reach, those tests are skipped.
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
process.env.OPS_ALERT_WEBHOOK_URL = 'https://hooks.example.test/ops'
process.env.OPS_ALERT_WEBHOOK_SECRET = 'ops-webhook-secret'
delete process.env.OPS_ALERT_EMAILS

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select 1 from "OpsAlert" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { onRaise, REMIND_MS, FLAP_MS, raise, resolve, settle } = await import('../src/ops/alerts.js')
const checks = await import('../src/ops/checks.js')
const { judge, RULES, computerProblem, workerProblems, STUCK_MS, OFFLINE_MS } = checks
const { noteFailure, failuresOf, summary, clearFailures } = await import('../src/ops/failures.js')
const { sendNotice, noticeText } = await import('../src/ops/send.js')
const { diagnose, watchdog, STALLED_MS } = await import('../src/ops/watchdog.js')
const { prisma } = await import('../src/db.js')

const MIN = 60_000
const t0 = new Date('2026-10-26T12:00:00Z')
const at = (ms: number) => new Date(t0.getTime() + ms)

/** Fetch played by a list: each call kept, each answered by `answer`. */
const realFetch = globalThis.fetch
let posted: { url: string; headers: Record<string, string>; body: string }[] = []
let answer = () => new Response('ok')
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  posted.push({
    url: String(input),
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
    body: String(init?.body ?? ''),
  })
  return answer()
}) as typeof fetch
after(() => {
  globalThis.fetch = realFetch
})
beforeEach(() => {
  posted = []
  answer = () => new Response('ok')
  clearFailures()
})

describe('when operators are told', () => {
  const row = (o: Partial<Parameters<typeof onRaise>[0] & object> = {}) => ({
    key: 'api',
    severity: 'warning',
    firstAt: t0,
    notifiedAt: t0,
    notifiedSeverity: 'warning',
    resolvedAt: null,
    ...o,
  })

  test('a new problem is told at once', () => {
    assert.deepEqual(onRaise(null, 'warning', t0), {
      reopen: true,
      firstAt: t0,
      severity: 'warning',
      notify: 'firing',
    })
  })

  test('one that lasts is told again only every few hours', () => {
    assert.equal(onRaise(row(), 'warning', at(10 * MIN)).notify, null)
    assert.equal(onRaise(row(), 'warning', at(REMIND_MS)).notify, 'reminder')
  })

  test('one that was not sent yet is tried again on the next run', () => {
    assert.equal(onRaise(row({ notifiedAt: null }), 'warning', at(MIN)).notify, 'firing')
  })

  test('a warning turning critical is told at once; critical staying critical is not', () => {
    assert.equal(onRaise(row(), 'critical', at(MIN)).notify, 'firing')
    const told = row({ severity: 'critical', notifiedSeverity: 'critical' })
    assert.equal(onRaise(told, 'critical', at(MIN)).notify, null)
  })

  test('critical stays critical while it lasts, and is told until it is', () => {
    // Critical, told only as a warning (its escalation was not sent); the count fell since.
    const untold = row({ severity: 'critical' })
    assert.deepEqual(onRaise(untold, 'warning', at(MIN)), {
      reopen: false,
      firstAt: t0,
      severity: 'critical',
      notify: 'firing',
    })
    const told = row({ severity: 'critical', notifiedSeverity: 'critical' })
    assert.equal(onRaise(told, 'warning', at(MIN)).severity, 'critical')
  })

  test('back soon after it ended, it is the same problem; back later, a new one', () => {
    const ended = row({ resolvedAt: at(MIN) })
    assert.deepEqual(onRaise(ended, 'warning', at(5 * MIN)), {
      reopen: true,
      firstAt: t0,
      severity: 'warning',
      notify: 'reminder',
    })
    const later = at(MIN + FLAP_MS)
    assert.deepEqual(onRaise(ended, 'warning', later), {
      reopen: true,
      firstAt: later,
      severity: 'warning',
      notify: 'firing',
    })
  })
})

describe('rules over failures', () => {
  const api = RULES.find((r) => r.kind === 'api')!
  const turn = RULES.find((r) => r.kind === 'turn')!
  const now = t0.getTime()

  test('a few failed requests are not a problem; ten in five minutes are, fifty critical', () => {
    for (let i = 0; i < 9; i++) noteFailure('api', new Error('boom'), { at: now - i * 1000 })
    assert.equal(judge(api, failuresOf('api', 15 * MIN, now), now), 'keep')
    noteFailure('api', new Error('boom'), { at: now })
    const verdict = judge(api, failuresOf('api', 15 * MIN, now), now)
    assert.ok(typeof verdict === 'object')
    assert.equal(verdict.alert.severity, 'warning')
    assert.match(verdict.alert.detail!, /10× boom/)
    for (let i = 0; i < 40; i++) noteFailure('api', 'boom', { at: now })
    const worse = judge(api, failuresOf('api', 15 * MIN, now), now)
    assert.equal(typeof worse === 'object' && worse.alert.severity, 'critical')
  })

  test('over once none came for its quiet time, unless the count only just started', () => {
    noteFailure('api', 'boom', { at: now - 10 * MIN })
    assert.equal(judge(api, failuresOf('api', 15 * MIN, now), now), 'keep')
    assert.equal(judge(api, [], now), 'resolve')
    // The API restarted 5 minutes ago: what came before is forgotten, not over.
    assert.equal(judge(api, [], now, now - 5 * MIN), 'keep')
  })

  test("turns failing in one workspace are its own trouble; in several, Brigade's", () => {
    for (let i = 0; i < 10; i++)
      noteFailure('turn', 'API Error: 500', { at: now, workspaceId: 'w1' })
    assert.equal(judge(turn, failuresOf('turn', 30 * MIN, now), now), 'keep')
    noteFailure('turn', 'API Error: 500', { at: now, workspaceId: 'w2' })
    const verdict = judge(turn, failuresOf('turn', 30 * MIN, now), now)
    assert.ok(typeof verdict === 'object')
    assert.match(verdict.alert.detail!, /11 in the last 15 min in 2 workspaces/)
  })

  test('failures are grouped by kind, a prefix taking every job', () => {
    noteFailure('job:mail', new Error('timeout'), { at: now })
    noteFailure('job:schedules', 'x', { at: now })
    noteFailure('api', 'y', { at: now })
    assert.equal(failuresOf('job:', MIN, now).length, 2)
    assert.equal(failuresOf('job:mail', MIN, now).length, 1)
    assert.equal(summary(failuresOf('job:', MIN, now)), '1× job:mail: timeout\n1× job:schedules: x')
  })
})

describe('cloud computers', () => {
  const now = t0.getTime()
  const computer = (status: string, updatedAgo = 0) => ({
    id: 'c1',
    name: 'Cloud computer',
    status,
    updatedAt: new Date(now - updatedAgo),
    workspace: { name: 'Acme' },
  })

  test('in error: critical', () => {
    const problem = computerProblem(computer('error'), false, 0, now)
    assert.equal(problem?.severity, 'critical')
    assert.equal(problem?.key, 'computer:c1')
  })

  test('starting for too long without its runner: stuck', () => {
    assert.equal(computerProblem(computer('starting', STUCK_MS - MIN), false, 0, now), null)
    assert.match(
      computerProblem(computer('starting', STUCK_MS), false, 0, now)?.title ?? '',
      /stuck starting/,
    )
    assert.equal(computerProblem(computer('creating', STUCK_MS), true, 0, now), null)
  })

  test('running with no runner for minutes: warned', () => {
    assert.equal(computerProblem(computer('running'), false, OFFLINE_MS - 1, now), null)
    assert.equal(computerProblem(computer('running'), false, OFFLINE_MS, now)?.severity, 'warning')
    assert.equal(computerProblem(computer('running'), true, 0, now), null)
  })
})

test("Workers' failed invocations, by Worker, from a few", () => {
  const alerts = workerProblems([
    {
      sum: { requests: 3 },
      dimensions: { scriptName: 'brigade-api', status: 'scriptThrewException' },
    },
    { sum: { requests: 2 }, dimensions: { scriptName: 'brigade-api', status: 'exceededCpu' } },
    {
      sum: { requests: 4 },
      dimensions: { scriptName: 'brigade-collab', status: 'scriptThrewException' },
    },
  ])
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0]!.key, 'worker:brigade-api')
  assert.match(alerts[0]!.detail!, /5 failed invocations.*3 scriptThrewException, 2 exceededCpu/)
})

describe('sending', () => {
  const notice = {
    kind: 'firing' as const,
    key: 'api',
    severity: 'warning' as const,
    title: 'API requests failing (500)',
    detail: '10 in the last 5 min.',
    firstAt: t0,
    at: t0,
  }

  test('the webhook gets JSON, signed, with an id per notice and text for Slack', async () => {
    await sendNotice({ webhookUrl: 'https://hooks.example.test/x', webhookSecret: 's' }, notice)
    const [call] = posted
    const body = JSON.parse(call!.body)
    assert.equal(body.kind, 'firing')
    assert.equal(body.text, noticeText(notice))
    assert.match(body.id, /^brigade-ops:api:/)
    assert.equal(
      call!.headers['x-brigade-signature'],
      `sha256=${createHmac('sha256', 's').update(call!.body).digest('hex')}`,
    )
  })

  test('email through Resend; it throws only when no destination took it', async () => {
    const to = {
      webhookUrl: 'https://hooks.example.test/x',
      emails: ['ops@example.test'],
      resendKey: 're_x',
      from: 'Brigade alerts <alerts@mails.example.test>',
    }
    answer = () => new Response('down', { status: 500 })
    await assert.rejects(sendNotice(to, notice), /reached no destination/)
    let n = 0
    answer = () => (n++ === 0 ? new Response('down', { status: 500 }) : new Response('{}'))
    await sendNotice(to, notice)
    const mail = posted.find((p) => p.url === 'https://api.resend.com/emails')!
    assert.equal(JSON.parse(mail.body).subject, '[Brigade warning] API requests failing (500)')
    // Marked as a machine's, so a mailbox rule that skips automatic mail leaves it alone.
    assert.equal(JSON.parse(mail.body).headers['Auto-Submitted'], 'auto-generated')
  })
})

describe('the watchdog', () => {
  const now = t0.getTime()

  test('down when the object does not answer, or its checks stopped or never ran', () => {
    assert.match(diagnose(new Error('reset'), now) ?? '', /does not answer: reset/)
    assert.equal(diagnose({ upForMs: 60 * MIN, checksAt: now - MIN }, now), null)
    assert.match(
      diagnose({ upForMs: 60 * MIN, checksAt: now - STALLED_MS - 1 }, now) ?? '',
      /stopped/,
    )
    assert.equal(diagnose({ upForMs: MIN, checksAt: 0 }, now), null)
    assert.match(diagnose({ upForMs: STALLED_MS + 1, checksAt: 0 }, now) ?? '', /never succeeded/)
    assert.match(
      diagnose({ upForMs: 60 * MIN, checksAt: now - STALLED_MS - 1, error: 'db gone' }, now) ?? '',
      /Last failure: db gone/,
    )
  })

  test('checks that cannot reach the database do not count as run', async () => {
    const saved = { alerts: prisma.opsAlert.findMany, computers: prisma.computer.findMany }
    const down = async () => {
      throw new Error('database unavailable')
    }
    Object.assign(prisma.opsAlert, { findMany: down })
    Object.assign(prisma.computer, { findMany: down })
    try {
      const before = checks.lastChecksAt
      await checks.runChecks(now)
      assert.equal(checks.lastChecksAt, before)
      assert.match(checks.lastCheckError ?? '', /database unavailable/)
    } finally {
      Object.assign(prisma.opsAlert, { findMany: saved.alerts })
      Object.assign(prisma.computer, { findMany: saved.computers })
    }
  })

  test('tells once an hour while it lasts, then that it is back', async () => {
    const to = { webhookUrl: 'https://hooks.example.test/x' }
    await watchdog(to, 'down', now)
    await watchdog(to, 'down', now + MIN)
    assert.equal(posted.length, 1)
    await watchdog(to, 'down', now + 61 * MIN)
    assert.equal(posted.length, 2)
    await watchdog(to, null, now + 62 * MIN)
    await watchdog(to, null, now + 63 * MIN)
    assert.deepEqual(
      posted.map((p) => JSON.parse(p.body).kind),
      ['firing', 'firing', 'resolved'],
    )
  })
})

describe('restarts and reconnect storms', () => {
  test('a start with the version of the one before is a restart no deploy explains', async () => {
    const { noteStart, unexpectedRestarts, restartProblem, RESTARTS_ALERT } =
      await import('../src/ops/restarts.js')
    const now = t0.getTime()
    let starts = noteStart([], { at: now - 20 * MIN, version: 'v1' }).starts
    // A deploy: a new version, expected.
    const deploy = noteStart(starts, { at: now - 10 * MIN, version: 'v2' })
    assert.equal(deploy.unexpected, false)
    starts = deploy.starts
    // Reset with the same version, again and again (the 2026-10-27 incident).
    for (let i = 0; i < RESTARTS_ALERT; i++) {
      const reset = noteStart(starts, { at: now - (RESTARTS_ALERT - i) * 1000, version: 'v2' })
      assert.equal(reset.unexpected, true)
      starts = reset.starts
    }
    assert.equal(unexpectedRestarts(starts, now), RESTARTS_ALERT)
    assert.match(restartProblem(unexpectedRestarts(starts, now)) ?? '', /restarted 3 times/)
    assert.equal(restartProblem(RESTARTS_ALERT - 1), null)
    // Past the window, they no longer count.
    assert.equal(unexpectedRestarts(starts, now + 20 * MIN), 0)
    // Starts older than a day are forgotten.
    assert.equal(noteStart(starts, { at: now + 25 * 60 * MIN, version: 'v3' }).starts.length, 1)
  })

  test('the watchdog tells each problem on its own: down, and restarting', async () => {
    const { API_RESTARTING } = await import('../src/ops/watchdog.js')
    const to = { webhookUrl: 'https://hooks.example.test/x' }
    const now = t0.getTime() + 10 * 60 * MIN
    posted = []
    await watchdog(to, 'restarting', now, API_RESTARTING)
    await watchdog(to, 'down', now)
    await watchdog(to, 'restarting', now + MIN, API_RESTARTING)
    assert.deepEqual(
      posted.map((p) => [JSON.parse(p.body).key, JSON.parse(p.body).kind]),
      [
        ['api-restarting', 'firing'],
        ['api-down', 'firing'],
      ],
    )
    await watchdog(to, null, now + 2 * MIN, API_RESTARTING)
    await watchdog(to, null, now + 2 * MIN)
    assert.deepEqual(
      posted.slice(2).map((p) => [JSON.parse(p.body).key, JSON.parse(p.body).kind]),
      [
        ['api-restarting', 'resolved'],
        ['api-down', 'resolved'],
      ],
    )
  })

  test('a computer whose runner connects again and again is counted once a minute', async () => {
    const { localHub } = await import('../src/hub/memory-host.js')
    const { STORM_CONNECTS } = await import('../src/hub/workspace-hub.js')
    const hub = localHub('storm-workspace')
    const before = failuresOf('runner-reconnects', 60 * MIN).length
    const now = Date.now()
    for (let i = 0; i < STORM_CONNECTS - 1; i++) hub.noteConnect('storming', now + i * 1000)
    assert.equal(failuresOf('runner-reconnects', 60 * MIN).length, before)
    for (let i = 0; i < 5; i++) hub.noteConnect('storming', now + 10_000 + i)
    assert.equal(failuresOf('runner-reconnects', 60 * MIN).length, before + 1, 'once')
    // A computer that reconnects now and then is not counted.
    for (let i = 0; i < STORM_CONNECTS * 2; i++) hub.noteConnect('calm', now + i * 61_000)
    assert.equal(failuresOf('runner-reconnects', 60 * MIN).length, before + 1)
  })
})

describe('alerts in the database', { skip }, () => {
  const prefix = `test-ops-${Date.now()}:`
  after(async () => {
    await prisma.opsAlert.deleteMany({ where: { key: { startsWith: prefix } } })
  })
  const kinds = () => posted.map((p) => JSON.parse(p.body).kind as string)

  test('raised each minute, told once; resolved, told it is over', async () => {
    const key = `${prefix}a`
    await raise({ key, severity: 'warning', title: 'A' }, at(0))
    await raise({ key, severity: 'warning', title: 'A' }, at(MIN))
    await raise({ key, severity: 'warning', title: 'A' }, at(2 * MIN))
    assert.deepEqual(kinds(), ['firing'])
    await resolve(key, at(3 * MIN))
    await resolve(key, at(4 * MIN))
    assert.deepEqual(kinds(), ['firing', 'resolved'])
    const row = await prisma.opsAlert.findUniqueOrThrow({ where: { key } })
    assert.deepEqual(row.resolvedAt, at(3 * MIN))
  })

  test('a notice that could not be sent is sent on the next run', async () => {
    const key = `${prefix}b`
    answer = () => new Response('down', { status: 503 })
    await raise({ key, severity: 'critical', title: 'B' }, at(0))
    answer = () => new Response('ok')
    await raise({ key, severity: 'critical', title: 'B' }, at(MIN))
    await raise({ key, severity: 'critical', title: 'B' }, at(2 * MIN))
    assert.equal(posted.length, 2)
    assert.notEqual((await prisma.opsAlert.findUniqueOrThrow({ where: { key } })).notifiedAt, null)
  })

  test('a turn for the worse that could not be sent is sent on the next run', async () => {
    const key = `${prefix}d`
    await raise({ key, severity: 'warning', title: 'D' }, at(0))
    answer = () => new Response('down', { status: 503 })
    await raise({ key, severity: 'critical', title: 'D' }, at(MIN))
    // Critical meanwhile, for GET /health/ops, though operators were not told yet.
    const between = await prisma.opsAlert.findUniqueOrThrow({ where: { key } })
    assert.equal(between.severity, 'critical')
    answer = () => new Response('ok')
    // The count fell back under critical: the escalation is still owed, and sent.
    await raise({ key, severity: 'warning', title: 'D' }, at(2 * MIN))
    await raise({ key, severity: 'warning', title: 'D' }, at(3 * MIN))
    assert.equal(posted.length, 3)
    assert.equal(JSON.parse(posted[2]!.body).severity, 'critical')
    const row = await prisma.opsAlert.findUniqueOrThrow({ where: { key } })
    assert.equal(row.severity, 'critical')
    assert.equal(row.notifiedSeverity, 'critical')
  })

  test('an end that could not be told stays open and is told on the next run', async () => {
    const key = `${prefix}e`
    await raise({ key, severity: 'warning', title: 'E' }, at(0))
    answer = () => new Response('down', { status: 503 })
    await resolve(key, at(MIN))
    assert.equal((await prisma.opsAlert.findUniqueOrThrow({ where: { key } })).resolvedAt, null)
    answer = () => new Response('ok')
    await resolve(key, at(2 * MIN))
    await resolve(key, at(3 * MIN))
    assert.deepEqual(
      posted.map((p) => JSON.parse(p.body).kind),
      ['firing', 'resolved', 'resolved'],
    )
    const row = await prisma.opsAlert.findUniqueOrThrow({ where: { key } })
    assert.deepEqual(row.resolvedAt, at(2 * MIN))
  })

  test('critical stays critical while it lasts', async () => {
    const key = `${prefix}c`
    await raise({ key, severity: 'critical', title: 'C' }, at(0))
    await raise({ key, severity: 'warning', title: 'C' }, at(MIN))
    await raise({ key, severity: 'critical', title: 'C' }, at(2 * MIN))
    assert.deepEqual(kinds(), ['firing'])
  })

  test('settle resolves what a check no longer finds under its prefix', async () => {
    const group = `${prefix}computer:`
    await settle(
      group,
      [
        { key: `${group}1`, severity: 'critical', title: '1' },
        { key: `${group}2`, severity: 'critical', title: '2' },
      ],
      at(0),
    )
    await settle(group, [{ key: `${group}2`, severity: 'critical', title: '2' }], at(MIN))
    const open = await prisma.opsAlert.findMany({
      where: { key: { startsWith: group }, resolvedAt: null },
    })
    assert.deepEqual(
      open.map((r) => r.key),
      [`${group}2`],
    )
    assert.deepEqual(kinds(), ['firing', 'firing', 'resolved'])
  })
})
