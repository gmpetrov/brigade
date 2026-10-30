import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'

// Auto-merge (src/pull-requests.ts), against the API's development database (apps/api/.env),
// in an organization of its own removed at the end, with GitHub faked; skipped when no database
// answers:
// - off by default: a ready pull request waits on a person;
// - on, a teammate's turn ending with its pull request ready merges it: no review under way,
//   asked for changes or behind its head, checks passed;
// - not while its thread is at work, nor for a member who may not merge;
// - checks still running: it merges once they pass; failed, it waits on a person again, with no
//   ticket and nothing sent to the author; failed already, it is not set merging at all;
// - a merge under way gives up when its thread goes back to work, or when what it would merge is
//   no longer the head its review approved;
// - checks GitHub fails to list are never taken for none: not set merging, and a merge under way
//   waits; without the Checks permission it never merges on its own.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
process.env.GITHUB_APP_ID = '1'
process.env.GITHUB_APP_SLUG = 'brigade-test'
process.env.GITHUB_APP_PRIVATE_KEY = privateKey

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

type Checks = 'success' | 'pending' | 'failure'

describe('auto-merge', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const installationId = 100_000 + Math.floor(Math.random() * 1_000_000)
  const repo = 'acme/auto'
  const ids = {} as Record<
    'org' | 'workspace' | 'owner' | 'bob' | 'computer' | 'riley' | 'kai',
    string
  >
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }
  const realFetch = globalThis.fetch
  /** Each pull request's checks on GitHub, success unless said. */
  const checks = new Map<number, Checks>()
  /** Pull requests merged on GitHub. */
  const merged = new Set<number>()

  const pull = (number: number) => ({
    number,
    title: `Change ${number}`,
    html_url: `https://github.com/${repo}/pull/${number}`,
    state: merged.has(number) ? 'closed' : 'open',
    draft: false,
    merged_at: merged.has(number) ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
    user: { login: 'brigade-test[bot]', type: 'Bot' },
    head: { ref: `brigade/change-${number}`, sha: `sha${number}` },
    base: { ref: 'main' },
    mergeable: true,
    mergeable_state: checks.get(number) === 'pending' ? 'unstable' : 'clean',
  })

  before(async () => {
    ids.org = `org-auto-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Auto', slug: `auto-${suffix}` },
    })
    for (const [who, role] of [
      ['owner', 'owner'],
      ['bob', 'member'],
    ] as const) {
      await prisma.user.create({
        data: { id: `${who}-${suffix}`, name: who, email: `${who}-${suffix}@test.local` },
      })
      ids[who] = `m-${who}-${suffix}`
      await prisma.member.create({
        data: { id: ids[who], organizationId: ids.org, userId: `${who}-${suffix}`, role },
      })
    }
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Auto' } })
    ).id
    scope = { organizationId: ids.org, workspaceId: ids.workspace }
    db = scoped(scope)
    ids.computer = (
      await db.computer.create({
        data: { kind: 'cloud', name: 'Test', status: 'running' } as never,
      })
    ).id
    ids.riley = (await db.teammate.create({ data: { name: 'Riley' } as never })).id
    ids.kai = (await db.teammate.create({ data: { name: 'Kai' } as never })).id
    const app = await db.app.create({
      data: { key: 'github', createdByMemberId: ids.owner } as never,
    })
    const { sealSecret } = await import('../src/vault.js')
    const github = await db.connection.create({
      data: {
        appId: app.id,
        kind: 'github',
        label: 'GitHub',
        createdByMemberId: ids.owner,
        vaultSecretId: await sealSecret(db, scope, { installationId }),
      } as never,
    })
    await db.grant.create({
      data: { teammateId: ids.riley, connectionId: github.id, scope: 'read_write' } as never,
    })

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const { pathname } = new URL(String(url))
      const method = init?.method ?? 'GET'
      if (pathname.endsWith('/access_tokens'))
        return Response.json({
          token: 'installation-token',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        })
      if (pathname === '/installation/repositories')
        return Response.json({ repositories: [{ full_name: repo, private: true }] })
      const pr = pathname.match(/^\/repos\/acme\/auto\/pulls\/(\d+)$/)
      if (pr && method === 'GET') return Response.json(pull(Number(pr[1])))
      const merge = pathname.match(/^\/repos\/acme\/auto\/pulls\/(\d+)\/merge$/)
      if (merge && method === 'PUT') {
        merged.add(Number(merge[1]))
        return Response.json({ merged: true })
      }
      const runs = pathname.match(/^\/repos\/acme\/auto\/commits\/sha(\d+)\/check-runs$/)
      if (runs) {
        const state = checks.get(Number(runs[1])) ?? 'success'
        return Response.json({
          check_runs: [
            {
              name: 'test',
              status: state === 'pending' ? 'in_progress' : 'completed',
              conclusion: state === 'pending' ? null : state,
              html_url: null,
            },
          ],
        })
      }
      if (pathname.endsWith('/status')) return Response.json({ statuses: [] })
      return Response.json({ message: 'Not Found' }, { status: 404 })
    }) as typeof fetch
  })

  after(async () => {
    globalThis.fetch = realFetch
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({
      where: { id: { in: [`owner-${suffix}`, `bob-${suffix}`] } },
    })
  })

  const autoMerge = (memberId: string, on: boolean) =>
    prisma.member.update({ where: { id: memberId }, data: { autoMerge: on } })

  /** A thread of Riley's, started by a member, where it opened pull request #number. */
  async function opened(number: number, memberId = ids.owner, status = 'idle') {
    const session = await db.session.create({
      data: {
        teammateId: ids.riley,
        startedByMemberId: memberId,
        computerId: ids.computer,
        title: `Change ${number}`,
        status,
        lastSeq: 0,
      } as never,
    })
    const { notePullRequestCall } = await import('../src/pull-requests.js')
    await notePullRequestCall(db, scope, {
      sessionId: session.id,
      teammateId: ids.riley,
      operation: 'github_create_pull_request',
      input: { repository: repo, title: `Change ${number}`, head: `brigade/change-${number}` },
      output: { number, title: `Change ${number}`, head: `brigade/change-${number}`, base: 'main' },
    })
    return session.id
  }

  /** Its teammate's turn ended in the thread: what the hub does then. */
  async function turnEnded(sessionId: string) {
    const { autoMergeTurnEnded } = await import('../src/pull-requests.js')
    await autoMergeTurnEnded(scope, sessionId)
  }

  const row = (number: number) =>
    db.pullRequest.findFirstOrThrow({ where: { repository: repo, number } })

  test('off by default: a ready pull request waits on a person', async () => {
    assert.equal(
      (await prisma.member.findUniqueOrThrow({ where: { id: ids.owner } })).autoMerge,
      false,
    )
    const thread = await opened(1)
    await turnEnded(thread)
    assert.equal((await row(1)).state, 'open')
    assert.ok(!merged.has(1))
  })

  test('on, a ready pull request merges once its teammate is done', async () => {
    await autoMerge(ids.owner, true)
    const thread = await opened(2)
    await turnEnded(thread)
    const pr = await row(2)
    assert.equal(pr.state, 'merged')
    assert.equal(pr.mergeStatus, 'none')
    assert.equal(pr.autoMergeAt, null)
    assert.ok(merged.has(2))
    const entry = await prisma.auditEntry.findFirst({
      where: { action: 'pull_request.merged', targetId: pr.id },
    })
    assert.equal((entry?.data as { auto?: boolean }).auto, true)
  })

  test('not while its thread is at work, nor for a member who may not merge', async () => {
    const busy = await opened(3, ids.owner, 'running')
    await turnEnded(busy)
    assert.equal((await row(3)).mergeStatus, 'none')
    assert.ok(!merged.has(3))
    // Its next turn ends with the thread at rest: now it merges.
    await db.session.updateMany({ where: { id: busy }, data: { status: 'idle' } })
    await turnEnded(busy)
    assert.ok(merged.has(3))

    await autoMerge(ids.bob, true)
    const bobs = await opened(4, ids.bob)
    await turnEnded(bobs)
    assert.ok(!merged.has(4), 'Bob is a member: only owners and admins merge')
  })

  test('not while a review is under way, asked for changes or did not read its head', async () => {
    const thread = await opened(5)
    const pr = await row(5)
    const review = await db.session.create({
      data: {
        teammateId: ids.kai,
        startedByMemberId: ids.owner,
        computerId: ids.computer,
        title: 'Review #5',
        status: 'running',
        parentId: thread,
        awaited: true,
        lastSeq: 0,
      } as never,
    })
    await db.pullRequest.updateMany({ where: { id: pr.id }, data: { reviewSessionId: review.id } })
    await turnEnded(thread)
    assert.ok(!merged.has(5), 'Kai is reviewing it')

    await db.session.updateMany({
      where: { id: review.id },
      data: { status: 'idle', reportDeliveredAt: new Date() },
    })
    const verdict = (verdict: 'approve' | 'request_changes', sha: string, round: number) =>
      db.pullRequestReview.create({
        data: {
          pullRequestId: pr.id,
          teammateId: ids.kai,
          sessionId: review.id,
          verdict,
          body: verdict,
          sha,
          round,
          createdAt: new Date(Date.now() + round * 1000),
        } as never,
      })
    await verdict('request_changes', 'sha5', 1)
    await turnEnded(thread)
    assert.ok(!merged.has(5), 'Kai asked for changes')

    await verdict('approve', 'old-sha', 2)
    await turnEnded(review.id)
    assert.ok(!merged.has(5), 'commits came after the approval')

    await verdict('approve', 'sha5', 3)
    await turnEnded(review.id)
    assert.ok(merged.has(5), 'approved at its head')
  })

  test('checks still running: it merges once they pass', async () => {
    checks.set(6, 'pending')
    const thread = await opened(6)
    await turnEnded(thread)
    let pr = await row(6)
    assert.equal(pr.mergeStatus, 'merging')
    assert.ok(pr.autoMergeAt)
    assert.match(pr.note ?? '', /Waiting for checks: test/)
    const { needsAttention, advanceMerges } = await import('../src/pull-requests.js')
    assert.ok(!(await needsAttention(db)).some((p) => p.number === 6), 'Brigade merges it')
    checks.set(6, 'success')
    await advanceMerges(ids.workspace)
    pr = await row(6)
    assert.equal(pr.state, 'merged')
  })

  test('checks that fail leave it to a person, with no ticket and nothing sent back', async () => {
    checks.set(7, 'pending')
    const thread = await opened(7)
    await turnEnded(thread)
    assert.equal((await row(7)).mergeStatus, 'merging')
    checks.set(7, 'failure')
    const { needsAttention, advanceMerges } = await import('../src/pull-requests.js')
    await advanceMerges(ids.workspace)
    const pr = await row(7)
    assert.equal(pr.mergeStatus, 'none')
    assert.equal(pr.autoMergeAt, null)
    assert.equal(pr.round, 0, 'not sent back to its author')
    assert.equal(await db.ticket.count({ where: { sessionId: thread } }), 0)
    assert.ok(
      (await needsAttention(db)).some((p) => p.number === 7),
      'waits on a person again',
    )
    assert.ok(!merged.has(7))
    // Failed already: not set merging at all.
    await turnEnded(thread)
    assert.equal((await row(7)).mergeStatus, 'none')
  })

  test('a merge under way gives up when its thread goes back to work', async () => {
    checks.set(8, 'pending')
    const thread = await opened(8)
    await turnEnded(thread)
    assert.equal((await row(8)).mergeStatus, 'merging')
    await db.session.updateMany({ where: { id: thread }, data: { status: 'running' } })
    checks.set(8, 'success')
    const { advanceMerges } = await import('../src/pull-requests.js')
    await advanceMerges(ids.workspace)
    assert.equal((await row(8)).mergeStatus, 'none')
    assert.ok(!merged.has(8))
  })

  /** GitHub, changed for one test: `change` answers first, or passes to the fake above. */
  async function withGitHub(
    change: (pathname: string, method: string) => Response | Promise<Response> | undefined,
    run: () => Promise<void>,
  ) {
    const fake = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) =>
      (await change(new URL(String(url)).pathname, init?.method ?? 'GET')) ??
      fake(url, init)) as typeof fetch
    try {
      await run()
    } finally {
      globalThis.fetch = fake
    }
  }

  test('a head pushed after the approval while checks ran is not merged', async () => {
    checks.set(9, 'pending')
    const thread = await opened(9)
    const pr = await row(9)
    await db.pullRequestReview.create({
      data: {
        pullRequestId: pr.id,
        teammateId: ids.kai,
        sessionId: thread,
        verdict: 'approve',
        body: 'approve',
        sha: 'sha9',
        round: 1,
      } as never,
    })
    await turnEnded(thread)
    assert.equal((await row(9)).mergeStatus, 'merging')
    checks.set(9, 'success')
    const { advanceMerges } = await import('../src/pull-requests.js')
    await withGitHub(
      (pathname, method) =>
        pathname === '/repos/acme/auto/pulls/9' && method === 'GET'
          ? Response.json({ ...pull(9), head: { ref: 'brigade/change-9', sha: 'sha9-new' } })
          : undefined,
      () => advanceMerges(ids.workspace),
    )
    assert.ok(!merged.has(9), 'its approval read sha9')
    assert.equal((await row(9)).mergeStatus, 'none')
  })

  test('checks GitHub fails to list are never taken for none', async () => {
    const down = (pathname: string) =>
      /\/(check-runs|status)$/.test(pathname)
        ? Response.json({ message: 'Server Error' }, { status: 502 })
        : undefined
    const thread = await opened(10)
    await withGitHub(down, () => turnEnded(thread))
    assert.equal((await row(10)).mergeStatus, 'none', 'not set merging')
    assert.ok(!merged.has(10))

    checks.set(11, 'pending')
    const other = await opened(11)
    await turnEnded(other)
    assert.equal((await row(11)).mergeStatus, 'merging')
    checks.set(11, 'success')
    const { advanceMerges } = await import('../src/pull-requests.js')
    await withGitHub(down, () => advanceMerges(ids.workspace))
    assert.ok(!merged.has(11))
    assert.equal((await row(11)).mergeStatus, 'merging', 'it tries again next minute')
    await advanceMerges(ids.workspace)
    assert.ok(merged.has(11), 'GitHub answers again: merged')
  })

  test('without the Checks permission, it cannot tell and leaves it to a person', async () => {
    const noChecks = (pathname: string) =>
      pathname.endsWith('/check-runs')
        ? Response.json({ message: 'Resource not accessible by integration' }, { status: 403 })
        : undefined
    const thread = await opened(12)
    await withGitHub(noChecks, () => turnEnded(thread))
    assert.equal((await row(12)).mergeStatus, 'none', 'not set merging')
    assert.ok(!merged.has(12))

    // Lost meanwhile, under way: it gives up at once rather than wait two hours.
    checks.set(14, 'pending')
    const other = await opened(14)
    await turnEnded(other)
    assert.equal((await row(14)).mergeStatus, 'merging')
    checks.set(14, 'success')
    const { advanceMerges } = await import('../src/pull-requests.js')
    await withGitHub(noChecks, () => advanceMerges(ids.workspace))
    assert.equal((await row(14)).mergeStatus, 'none')
    assert.ok(!merged.has(14))
  })

  test('another 403 on check runs, such as a rate limit, is not a missing permission', async () => {
    const thread = await opened(13)
    await withGitHub(
      (pathname) =>
        pathname.endsWith('/check-runs')
          ? Response.json(
              { message: 'You have exceeded a secondary rate limit. Please wait a few minutes.' },
              { status: 403 },
            )
          : undefined,
      () => turnEnded(thread),
    )
    assert.equal((await row(13)).mergeStatus, 'none')
    assert.ok(!merged.has(13))
  })
})
