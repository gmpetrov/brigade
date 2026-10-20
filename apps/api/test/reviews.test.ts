import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'

// Reviews in child threads (src/reviews.ts), against the API's development database
// (apps/api/.env), in an organization of its own removed at the end, with GitHub faked;
// skipped when no database answers:
// - where the teammate decides, the review it asks for when it opens a pull request starts in
//   a child thread of its thread, by another teammate on another model, and one it declines
//   keeps its reason; a project where reviews are manual starts none;
// - the pull request waits on a person only once its review is done, and again after the
//   author asks the reviewer to look again;
// - one review at a time; request_review only for the thread's own pull requests;
// - with nobody else, the author reviews its own in a fresh context;
// - a member's request for one opened outside Brigade gets a thread of its own;
// - closing a pull request stops its review;
// - the brief says whether the repository runs checks, and how the thread started.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
// A GitHub App of its own: its token and every call below go to the fake GitHub.
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

describe('reviews in child threads', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const installationId = 100_000 + Math.floor(Math.random() * 1_000_000)
  const repo = 'acme/web'
  const ids = {} as Record<
    | 'org'
    | 'workspace'
    | 'owner'
    | 'computer'
    | 'riley'
    | 'kai'
    | 'sam'
    | 'chief'
    | 'web'
    | 'quiet'
    | 'thread'
    | 'quietThread',
    string
  >
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }
  const realFetch = globalThis.fetch
  /** Pull requests GitHub knows, by number: open unless said. */
  const closed = new Set<number>()
  /** Whether the repository's pull requests have check runs. */
  let ci = false

  const pull = (number: number) => ({
    number,
    title: `Change ${number}`,
    html_url: `https://github.com/${repo}/pull/${number}`,
    state: closed.has(number) ? 'closed' : 'open',
    draft: false,
    merged_at: null,
    updated_at: new Date().toISOString(),
    user: { login: 'brigade-test[bot]', type: 'Bot' },
    head: { ref: `brigade/change-${number}`, sha: `sha${number}` },
    base: { ref: 'main' },
    body: 'What it changes.',
  })

  before(async () => {
    ids.org = `org-review-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Reviews', slug: `reviews-${suffix}` },
    })
    await prisma.user.create({
      data: { id: `owner-${suffix}`, name: 'Ada', email: `owner-${suffix}@test.local` },
    })
    ids.owner = `m-owner-${suffix}`
    await prisma.member.create({
      data: { id: ids.owner, organizationId: ids.org, userId: `owner-${suffix}`, role: 'owner' },
    })
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Reviews' } })
    ).id
    scope = { organizationId: ids.org, workspaceId: ids.workspace }
    db = scoped(scope)
    // A cloud computer: what is sent to it waits for its runner, and no provider wakes it here.
    ids.computer = (
      await db.computer.create({
        data: { kind: 'cloud', name: 'Test', status: 'running' } as never,
      })
    ).id
    for (const provider of ['claude_code', 'codex'] as const)
      await db.account.create({
        data: {
          memberId: ids.owner,
          computerId: ids.computer,
          provider,
          label: provider,
          status: 'ready',
        } as never,
      })
    const teammate = (data: object) => db.teammate.create({ data: data as never })
    ids.riley = (await teammate({ name: 'Riley' })).id
    ids.kai = (await teammate({ name: 'Kai', harness: 'codex' })).id
    ids.sam = (await teammate({ name: 'Sam' })).id
    ids.chief = (await teammate({ name: 'Chief', kind: 'chief' })).id
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
    // Sam only reads it: it cannot post a review.
    await db.grant.createMany({
      data: [
        { teammateId: ids.riley, connectionId: github.id, scope: 'read_write' },
        { teammateId: ids.kai, connectionId: github.id, scope: 'read_write' },
        { teammateId: ids.chief, connectionId: github.id, scope: 'read_write' },
        { teammateId: ids.sam, connectionId: github.id, scope: 'read' },
      ] as never,
    })
    ids.web = (await db.project.create({ data: { name: `Web ${suffix}` } as never })).id
    await db.projectRepository.create({
      data: { projectId: ids.web, repository: repo } as never,
    })
    ids.quiet = (
      await db.project.create({
        data: { name: `Quiet ${suffix}`, reviewPolicy: 'manual' } as never,
      })
    ).id
    const thread = async (projectId: string, ask: string) => {
      const session = await db.session.create({
        data: {
          teammateId: ids.riley,
          startedByMemberId: ids.owner,
          computerId: ids.computer,
          title: ask,
          projectId,
          status: 'idle',
          lastSeq: 1,
        } as never,
      })
      await db.threadTeammate.create({
        data: { sessionId: session.id, teammateId: ids.riley } as never,
      })
      await db.sessionEvent.create({
        data: {
          sessionId: session.id,
          seq: 1,
          type: 'message.user',
          data: { type: 'message.user', text: ask, memberId: ids.owner },
          at: new Date(),
        } as never,
      })
      return session.id
    }
    ids.thread = await thread(ids.web, 'The pricing cards stay white in dark mode: fix it.')
    ids.quietThread = await thread(ids.quiet, 'Rename the export button.')

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
      const pr = pathname.match(/^\/repos\/acme\/web\/pulls\/(\d+)$/)
      if (pr && method === 'GET') return Response.json(pull(Number(pr[1])))
      if (pathname.endsWith('/check-runs'))
        return Response.json({
          check_runs: ci
            ? [{ name: 'test', status: 'completed', conclusion: 'success', html_url: null }]
            : [],
        })
      if (pathname.endsWith('/status')) return Response.json({ statuses: [] })
      return Response.json({ message: 'Not Found' }, { status: 404 })
    }) as typeof fetch
  })

  after(async () => {
    globalThis.fetch = realFetch
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({ where: { id: `owner-${suffix}` } })
  })

  /** Riley opens a pull request in a thread, as its GitHub call tells Brigade; what it is told back. */
  async function open(sessionId: string, number: number, review?: object) {
    const { notePullRequestCall } = await import('../src/pull-requests.js')
    const { reviewOnCreate } = await import('../src/reviews.js')
    const input = {
      repository: repo,
      title: `Change ${number}`,
      head: `brigade/change-${number}`,
      ...(review ? { review } : {}),
    }
    const output = {
      number,
      title: `Change ${number}`,
      head: `brigade/change-${number}`,
      base: 'main',
    }
    const call = { sessionId, teammateId: ids.riley, input, output }
    await notePullRequestCall(db, scope, { ...call, operation: 'github_create_pull_request' })
    return (await reviewOnCreate(db, scope, call)) as
      | { review: { started: boolean; reviewer?: string; threadId?: string; note: string } }
      | undefined
  }

  const row = (number: number) =>
    db.pullRequest.findFirstOrThrow({
      where: { repository: repo, number },
      include: { reviewSession: true },
    })

  const waiting = async () => {
    const { needsAttention } = await import('../src/pull-requests.js')
    return (await needsAttention(db)).map((p) => p.number).sort()
  }

  test('where the teammate decides, the review it asks for starts in a child thread, on another model', async () => {
    const told = await open(ids.thread, 12, { wanted: true, reason: 'It changes every card' })
    assert.equal(told?.review.started, true, told?.review.note)
    assert.equal(told?.review.reviewer, 'Kai')
    const pr = await row(12)
    const child = pr.reviewSession!
    assert.equal(child.parentId, ids.thread)
    assert.equal(child.teammateId, ids.kai)
    assert.equal(child.awaited, true)
    assert.equal(child.title, 'Review #12: Change 12')
    // Its report wakes the author.
    assert.equal(child.parentTeammateId, ids.riley)
    const wait = child.awaitUntil!.getTime() - Date.now()
    assert.ok(wait > 2.9 * 3600_000 && wait <= 3 * 3600_000, `waits ${wait} ms`)
  })

  test('one it declines keeps its reason, and a project where reviews are manual starts none', async () => {
    const declined = await open(ids.thread, 13, { wanted: false, reason: 'A one-line copy fix' })
    assert.equal(declined?.review.started, false)
    const pr = await row(13)
    assert.equal(pr.reviewSessionId, null)
    assert.equal(pr.noReviewReason, 'A one-line copy fix')
    const { reviewOf } = await import('../src/pull-requests.js')
    assert.deepEqual(reviewOf({ ...pr, reviews: [], reviewSession: null }), {
      state: 'skipped',
      reason: 'A one-line copy fix',
    })

    const manual = await open(ids.quietThread, 14, { wanted: true, reason: 'Risky' })
    assert.equal(manual?.review.started, false)
    assert.match(manual!.review.note, /only when someone asks/)
    assert.equal((await row(14)).reviewSessionId, null)
    // Without a word on it, nothing is said.
    assert.equal(await open(ids.quietThread, 15), undefined)
  })

  test('the pull request waits on a person once its review is done, and again after a recheck', async () => {
    const before = await waiting()
    assert.ok(!before.includes(12), 'not while Kai reviews it')
    assert.ok(before.includes(13), 'one without a review waits at once')
    const child = (await row(12)).reviewSessionId!
    await db.session.updateMany({ where: { id: child }, data: { reportDeliveredAt: new Date() } })
    assert.ok((await waiting()).includes(12), 'its report reached the author')
    // The author asks the reviewer to look again (message_thread): it waits for it again.
    await db.session.updateMany({
      where: { id: child },
      data: { awaited: true, reportDeliveredAt: null },
    })
    assert.ok(!(await waiting()).includes(12))
  })

  test('one review at a time, and request_review only for the thread’s own pull requests', async () => {
    const { handleReviewCall } = await import('../src/reviews.js')
    const own = await db.session.findFirstOrThrow({ where: { id: ids.thread } })
    const again = (await handleReviewCall(
      db,
      scope,
      own,
      { id: ids.riley, name: 'Riley' },
      {
        name: 'request_review',
        repository: repo,
        number: 12,
      },
    )) as { error?: string }
    assert.match(again.error ?? '', /Kai is already reviewing it/)
    const other = await db.session.findFirstOrThrow({ where: { id: ids.quietThread } })
    const foreign = (await handleReviewCall(
      db,
      scope,
      other,
      { id: ids.riley, name: 'Riley' },
      {
        name: 'request_review',
        repository: repo,
        number: 13,
      },
    )) as { error?: string }
    assert.match(foreign.error ?? '', /a pull request this thread/)
    // The person asked for one in the thread: it starts, from there.
    const asked = (await handleReviewCall(
      db,
      scope,
      own,
      { id: ids.riley, name: 'Riley' },
      {
        name: 'request_review',
        repository: repo,
        number: 13,
      },
    )) as { reviewer?: string; error?: string }
    assert.equal(asked.reviewer, 'Kai', asked.error)
    assert.equal((await row(13)).noReviewReason, null)
  })

  test('with nobody else to review it, the author reviews its own in a fresh context', async () => {
    await db.teammate.updateMany({ where: { id: ids.kai }, data: { archivedAt: new Date() } })
    try {
      const told = await open(ids.thread, 16, { wanted: true, reason: 'A migration' })
      assert.equal(told?.review.reviewer, 'Riley', told?.review.note)
      assert.equal((await row(16)).reviewSession?.teammateId, ids.riley)
    } finally {
      await db.teammate.updateMany({ where: { id: ids.kai }, data: { archivedAt: null } })
    }
  })

  test('a member’s request for one opened outside Brigade gets a thread of its own', async () => {
    const { requestReview } = await import('../src/reviews.js')
    const { threadId } = await requestReview(
      { ...scope, userId: `owner-${suffix}`, memberId: ids.owner, role: 'owner' },
      repo,
      20,
      { reviewerId: ids.kai },
    )
    const pr = await row(20)
    assert.equal(pr.reviewSessionId, threadId)
    // Its thread becomes the pull request's: there it waits on a person, once reviewed.
    assert.equal(pr.sessionId, threadId)
    assert.equal(pr.reviewSession?.parentId, null)
    assert.equal(pr.requestedByMemberId, ids.owner)
    assert.ok(!(await waiting()).includes(20))
    await db.session.updateMany({ where: { id: threadId }, data: { status: 'idle' } })
    assert.ok((await waiting()).includes(20))
  })

  test('closing a pull request stops its review, and nothing waits for it', async () => {
    const { pullRequestEvent } = await import('../src/pull-requests.js')
    await open(ids.thread, 21, { wanted: true, reason: 'New permissions' })
    const child = (await row(21)).reviewSessionId!
    closed.add(21)
    await pullRequestEvent(scope, repo, pull(21) as never)
    const after = await db.session.findFirstOrThrow({ where: { id: child } })
    assert.equal(after.awaited, false)
    assert.ok(after.reportDeliveredAt)
    assert.equal((after.report as { status?: string } | null)?.status, 'cancelled')
    assert.equal((await row(21)).state, 'closed')
  })

  test('the brief says whether the repository runs checks, and how the thread started', async () => {
    const { reviewBrief } = await import('../src/reviews.js')
    const brief = (checks: string[], child = true, self = false) =>
      reviewBrief({
        repo,
        p: pull(30) as never,
        author: 'Riley',
        self,
        asked: 'Fix the cards\nin dark mode.',
        checks,
        child,
      })
    const withChecks = brief(['test', 'typecheck'])
    assert.match(withChecks, /runs checks on its pull requests \(test, typecheck\)/)
    assert.doesNotMatch(withChecks, /run its typecheck and tests/)
    assert.match(withChecks, /> Fix the cards\n> in dark mode\./)
    assert.match(withChecks, /`github_review_pull_request` once/)
    assert.match(withChecks, /`report` the verdict/)
    const without = brief([])
    assert.match(without, /No checks run on its pull requests/)
    assert.match(without, /run its typecheck and tests/)
    assert.match(brief([], false), /say the verdict and the problems in your reply/)
    assert.match(brief([], true, true), /You wrote it in another thread/)
    // A repository with checks: the review started says so in its brief.
    ci = true
    try {
      const told = await open(ids.thread, 31, { wanted: true, reason: 'Touches billing' })
      assert.equal(told?.review.started, true, told?.review.note)
      const audited = await prisma.auditEntry.findFirst({
        where: { action: 'pull_request.review_requested', targetId: (await row(31)).id },
      })
      assert.equal((audited?.data as { checks?: boolean } | undefined)?.checks, true)
    } finally {
      ci = false
    }
  })
})
