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
// - one review at a time, even asked for twice at once or past a claim that ran out;
//   request_review only for the thread's own pull requests;
// - a task whose pull request is in review stays in Doing until the review is done, and a
//   review at work past its wait still keeps it out of Needs you;
// - a reviewer posts only through an account it may use there (not another member's own);
//   with nobody else, the author reviews its own in a fresh context;
// - a member's request for one opened outside Brigade gets a thread of its own;
// - closing a pull request stops its review;
// - past its last look, the author can neither ask the reviewer again nor start a fresh review:
//   only a person has it read again;
// - the brief says whether the repository runs checks (a release workflow is none, nor one
//   whose filters leave the pull request out), and how the thread started;
// - a merge's status keeps the loop's column, for the API running before a deploy;
// - a pull request a child thread opens is reviewed in a child of that child, whose report wakes
//   it; the child reports to its parent only once the review is done (not while it runs, nor
//   before the turn its report brings), and its parent's wait outlasts the review's;
// - the parent may ask for the review of its child's pull request: it runs under the child, and
//   the parent waits for the child again, with a deadline even for one it did not wait for;
//   closing it lets the child it held report;
// - no review starts below a child's review: a teammate there is told so, and a person's ask
//   runs in a thread of its own;
// - such a review sits under the thread at the top: archived with it, and a ticket there brings
//   it back and keeps it from being done.
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
    | 'quietThread'
    | 'bob'
    | 'lee',
    string
  >
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }
  /** A thread of Riley's in a project, that started with a request (and is a task's, given one). */
  let thread: (projectId: string, ask: string) => Promise<string>
  const realFetch = globalThis.fetch
  /** Pull requests GitHub knows, by number: open unless said. */
  const closed = new Set<number>()
  /** Whether the repository's pull requests have check runs. */
  let ci = false
  /** The repository's workflow files, by name. */
  let workflows: Record<string, string> = {}
  /** A head whose checks GitHub is slow to list. */
  let slowSha = ''

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
    // Bob's own GitHub account, which only Bob's threads may use: Lee's only one.
    await prisma.user.create({
      data: { id: `bob-${suffix}`, name: 'Bob', email: `bob-${suffix}@test.local` },
    })
    ids.bob = `m-bob-${suffix}`
    await prisma.member.create({
      data: { id: ids.bob, organizationId: ids.org, userId: `bob-${suffix}`, role: 'member' },
    })
    ids.lee = (await teammate({ name: 'Lee', harness: 'codex' })).id
    const bobs = await db.connection.create({
      data: {
        appId: app.id,
        kind: 'github',
        label: "Bob's GitHub",
        reach: 'mine',
        createdByMemberId: ids.bob,
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
        { teammateId: ids.lee, connectionId: bobs.id, scope: 'read_write' },
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
    thread = async (projectId: string, ask: string) => {
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
      // A slow GitHub for one head: what lets a claim run out meanwhile in a test.
      if (pathname.endsWith(`/commits/${slowSha}/check-runs`))
        await new Promise((resolve) => setTimeout(resolve, 800))
      if (pathname.endsWith('/check-runs'))
        return Response.json({
          check_runs: ci
            ? [{ name: 'test', status: 'completed', conclusion: 'success', html_url: null }]
            : [],
        })
      if (pathname.endsWith('/status')) return Response.json({ statuses: [] })
      if (pathname === '/repos/acme/web/contents/.github/workflows')
        return Object.keys(workflows).length
          ? Response.json(
              Object.keys(workflows).map((name) => ({
                name,
                path: `.github/workflows/${name}`,
                type: 'file',
              })),
            )
          : Response.json({ message: 'Not Found' }, { status: 404 })
      const workflow = pathname.match(/^\/repos\/acme\/web\/contents\/\.github\/workflows\/(.+)$/)
      if (workflow && workflows[workflow[1]!])
        return Response.json({
          content: Buffer.from(workflows[workflow[1]!]!).toString('base64'),
          encoding: 'base64',
        })
      return Response.json({ message: 'Not Found' }, { status: 404 })
    }) as typeof fetch
  })

  after(async () => {
    globalThis.fetch = realFetch
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({ where: { id: { in: [`owner-${suffix}`, `bob-${suffix}`] } } })
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

  test('a reviewer posts only through an account it may use there; with nobody else, the author reviews its own', async () => {
    // Without Kai, only Lee is on another model, and its GitHub is Bob's own: not in Ada's thread.
    await db.teammate.updateMany({ where: { id: ids.kai }, data: { archivedAt: new Date() } })
    try {
      const told = await open(ids.thread, 16, { wanted: true, reason: 'A migration' })
      assert.equal(told?.review.reviewer, 'Riley', told?.review.note)
      assert.equal((await row(16)).reviewSession?.teammateId, ids.riley)
      // Asked for by name, it says why not.
      const { startReview } = await import('../src/reviews.js')
      await assert.rejects(
        startReview(db, scope, {
          repo,
          number: 17,
          reviewer: 'Lee',
          by: { kind: 'member', memberId: ids.owner },
        }),
        /Lee cannot post a review on acme\/web/,
      )
    } finally {
      await db.teammate.updateMany({ where: { id: ids.kai }, data: { archivedAt: null } })
    }
  })

  test('two requests at once start one review', async () => {
    await open(ids.thread, 18)
    const { startReview } = await import('../src/reviews.js')
    const ask = () =>
      startReview(db, scope, { repo, number: 18, by: { kind: 'member', memberId: ids.owner } })
    const results = await Promise.allSettled([ask(), ask(), ask()])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    for (const r of results)
      if (r.status === 'rejected')
        assert.match(String((r.reason as Error).message), /starting|already reviewing/)
    const started = await db.session.count({
      where: { parentId: ids.thread, title: 'Review #18: Change 18' },
    })
    assert.equal(started, 1)
    // The claim is let go: once that review is done, another may start.
    assert.equal((await row(18)).reviewClaimedAt, null)
  })

  test('a pull request whose thread failed before it was done waits with its thread, not on its own', async () => {
    const designThread = await thread(ids.web, 'Design options')
    await open(designThread, 23, { wanted: true, reason: 'Several files' })
    const child = (await row(23)).reviewSessionId!
    await db.session.updateMany({ where: { id: child }, data: { reportDeliveredAt: new Date() } })
    // Fixing what the review found, its turn stopped on an error: the thread waits on a person
    // (src/failed.ts), once, and its pull request does not count apart from it.
    await db.session.updateMany({ where: { id: designThread }, data: { status: 'failed' } })
    assert.ok(!(await waiting()).includes(23))
    // It went on and stopped: the pull request is the person's.
    await db.session.updateMany({ where: { id: designThread }, data: { status: 'idle' } })
    assert.ok((await waiting()).includes(23))
  })

  test('a review at work past its wait still keeps the pull request out of Needs you', async () => {
    await open(ids.thread, 22, { wanted: true, reason: 'Concurrency' })
    const child = (await row(22)).reviewSessionId!
    // The thread stopped waiting for it, and was told so; the reviewer goes on.
    await db.session.updateMany({
      where: { id: child },
      data: { awaited: false, status: 'running' },
    })
    assert.ok(!(await waiting()).includes(22))
    await db.session.updateMany({ where: { id: child }, data: { status: 'idle' } })
    assert.ok((await waiting()).includes(22))
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

  test('once its pull request is merged, its reviewer is not asked to look at another one in the same thread', async () => {
    const { messageChild } = await import('../src/children.js')
    await open(ids.thread, 22, { wanted: true, reason: 'New permissions' })
    const child = (await row(22)).reviewSessionId!
    await db.session.updateMany({ where: { id: child }, data: { reportDeliveredAt: new Date() } })
    await db.pullRequest.updateMany({
      where: { repository: repo, number: 22 },
      data: { state: 'merged' },
    })
    const told = await messageChild(
      db,
      scope,
      { id: ids.thread, title: 'Thread' },
      { id: ids.riley, name: 'Riley' },
      child,
      'The fixes are in #23, can you look?',
    )
    assert.ok('error' in told)
    assert.match(told.error, /#22, which is merged.*request_review/)
    // Nothing waits for it: the new pull request is not shown as in review by this thread.
    const after = await db.session.findFirstOrThrow({ where: { id: child } })
    assert.ok(after.reportDeliveredAt)
  })

  test('a review takes its last look, then only a person has it read again', async () => {
    const { messageChild } = await import('../src/children.js')
    const { handleReviewCall, requestReview } = await import('../src/reviews.js')
    const { REVIEW_LOOKS } = await import('@brigade/contracts')
    await open(ids.thread, 24, { wanted: true, reason: 'New permissions' })
    const pr = await row(24)
    const child = pr.reviewSessionId!
    const look = () =>
      db.pullRequestReview.create({
        data: {
          pullRequestId: pr.id,
          teammateId: ids.kai,
          sessionId: child,
          verdict: 'request_changes',
          body: 'Still a race',
          sha: 'abc',
          round: 1,
        } as never,
      })
    const ask = () =>
      messageChild(
        db,
        scope,
        { id: ids.thread, title: 'Thread' },
        { id: ids.riley, name: 'Riley' },
        child,
        'Fixed, can you look again?',
      )
    for (let i = 1; i < REVIEW_LOOKS; i++) await look()
    const before = await ask()
    assert.ok(!('error' in before) || !/looks/.test(before.error), 'one look is left')
    await look()
    const past = await ask()
    assert.ok('error' in past)
    assert.match(past.error, new RegExp(`took their ${REVIEW_LOOKS} looks.*Review again`))
    // Nor does the author start a fresh one on its own once that one is done.
    await db.session.updateMany({
      where: { id: child },
      data: { reportDeliveredAt: new Date(), awaited: false, status: 'idle' },
    })
    const own = await db.session.findFirstOrThrow({ where: { id: ids.thread } })
    const again = (await handleReviewCall(
      db,
      scope,
      own,
      { id: ids.riley, name: 'Riley' },
      { name: 'request_review', repository: repo, number: 24 },
    )) as { error?: string }
    assert.match(again.error ?? '', /took their \d+ looks/)
    // The person does, with Review again.
    const { threadId } = await requestReview(
      { ...scope, userId: `owner-${suffix}`, memberId: ids.owner, role: 'owner' },
      repo,
      24,
      { reviewerId: ids.kai },
    )
    assert.notEqual(threadId, child)
  })

  test('a fresh review the author starts goes on counting where its last one stopped', async () => {
    const { messageChild } = await import('../src/children.js')
    const { handleReviewCall } = await import('../src/reviews.js')
    const { REVIEW_LOOKS } = await import('@brigade/contracts')
    await open(ids.thread, 25, { wanted: true, reason: 'New permissions' })
    const pr = await row(25)
    const first = pr.reviewSessionId!
    const look = (sessionId: string) =>
      db.pullRequestReview.create({
        data: {
          pullRequestId: pr.id,
          teammateId: ids.kai,
          sessionId,
          verdict: 'request_changes',
          body: 'Still a race',
          sha: 'abc',
          round: 1,
        } as never,
      })
    const ask = (child: string) =>
      messageChild(
        db,
        scope,
        { id: ids.thread, title: 'Thread' },
        { id: ids.riley, name: 'Riley' },
        child,
        'Fixed, can you look again?',
      )
    for (let i = 1; i < REVIEW_LOOKS; i++) await look(first)
    // One look left, the author starts a fresh review rather than asking this one again.
    await db.session.updateMany({
      where: { id: first },
      data: { reportDeliveredAt: new Date(), awaited: false, status: 'idle' },
    })
    const own = await db.session.findFirstOrThrow({ where: { id: ids.thread } })
    const fresh = (await handleReviewCall(
      db,
      scope,
      own,
      { id: ids.riley, name: 'Riley' },
      { name: 'request_review', repository: repo, number: 25 },
    )) as { threadId?: string; error?: string }
    assert.ok(fresh.threadId, fresh.error)
    await look(fresh.threadId)
    // The fresh one took the last look: neither it nor the old one is asked again.
    for (const child of [fresh.threadId, first]) {
      const past = await ask(child)
      assert.ok('error' in past)
      assert.match(past.error, new RegExp(`took their ${REVIEW_LOOKS} looks`))
    }
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
    // What a review started finds: checks reported on its head, or a workflow that runs on it.
    const found = async (number: number) => {
      const told = await open(ids.thread, number, { wanted: true, reason: 'Touches billing' })
      assert.equal(told?.review.started, true, told?.review.note)
      const audited = await prisma.auditEntry.findFirst({
        where: { action: 'pull_request.review_requested', targetId: (await row(number)).id },
      })
      return (audited?.data as { checks?: boolean } | undefined)?.checks
    }
    ci = true
    try {
      assert.equal(await found(31), true)
    } finally {
      ci = false
    }
    // Only a release on tags, as in this very repository: no checks on its pull requests.
    workflows = { 'desktop-release.yml': "on:\n  push:\n    tags: ['desktop-v*']\njobs: {}\n" }
    assert.equal(await found(32), false)
    workflows = {
      'desktop-release.yml': workflows['desktop-release.yml']!,
      'ci.yml': 'on: [pull_request]\njobs: {}\n',
    }
    assert.equal(await found(33), true)
    workflows = {}
  })

  test('a workflow counts when it runs on the pull request: on pull_request into its base, or a push to its branch', async () => {
    const { workflowRunsOn } = await import('../src/reviews.js')
    const change = { head: 'brigade/riley-fix', base: 'main', files: ['src/a.ts'] }
    const runs = (yaml: string, files: string[] | null = change.files) =>
      workflowRunsOn(yaml, { ...change, files })
    assert.equal(runs('on: pull_request\n'), true)
    assert.equal(runs('on:\n  pull_request_target:\n    types: [opened]\n'), true)
    assert.equal(runs('on: [push, workflow_dispatch]\n'), true)
    assert.equal(runs('not: [valid'), false)
    // pull_request's filters are on the branch it goes into.
    assert.equal(runs('on:\n  pull_request:\n    branches: [main]\n'), true)
    assert.equal(runs('on:\n  pull_request:\n    branches: [release]\n'), false)
    assert.equal(runs('on:\n  pull_request:\n    branches-ignore: [main]\n'), false)
    assert.equal(runs('on:\n  pull_request:\n    types: [labeled]\n'), false)
    // push's, on its branch; in order, the last pattern matching decides.
    assert.equal(runs("on:\n  push:\n    branches: ['brigade/**']\n"), true)
    assert.equal(runs('on:\n  push:\n    branches: [main]\n'), false)
    assert.equal(runs("on:\n  push:\n    branches: ['**', '!brigade/**']\n"), false)
    assert.equal(runs("on:\n  push:\n    branches: ['!brigade/**', '**']\n"), true)
    assert.equal(runs("on:\n  push:\n    branches-ignore: ['brigade/*']\n"), false)
    assert.equal(runs("on:\n  push:\n    tags: ['desktop-v*']\n"), false)
    assert.equal(runs("on:\n  push:\n    tags: ['v*']\n    branches: ['**']\n"), true)
    assert.equal(runs("on:\n  schedule:\n    - cron: '0 8 * * 1'\n"), false)
    assert.equal(runs('on: release\n'), false)
    // paths, on its files; unknown files (too many to list) do not leave it out.
    assert.equal(runs('on:\n  push:\n    paths: [src/**]\n'), true)
    assert.equal(runs('on:\n  push:\n    paths: [docs/**]\n'), false)
    assert.equal(runs('on:\n  push:\n    paths: [docs/**]\n', null), true)
    assert.equal(runs("on:\n  pull_request:\n    paths: ['**', '!src/**']\n"), false)
    assert.equal(runs('on:\n  pull_request:\n    paths-ignore: [src/**]\n'), false)
    assert.equal(
      runs('on:\n  pull_request:\n    paths-ignore: [src/**]\n', ['src/a.ts', 'README.md']),
      true,
    )
  })

  test('a claim to start a review is taken over only once it has run out, and let go only by its holder', async () => {
    const { claimReview, releaseReview } = await import('../src/reviews.js')
    await open(ids.thread, 50)
    const { id } = await row(50)
    const old = new Date(Date.now() - 6 * 60_000)
    assert.deepEqual(await claimReview(db, id, old), old)
    // A crash left it: a new request takes it over.
    const now = new Date()
    assert.deepEqual(await claimReview(db, id, now), now)
    assert.equal(await claimReview(db, id), null)
    // The old holder letting go leaves the new claim be.
    await releaseReview(db, id, old)
    assert.deepEqual((await row(50)).reviewClaimedAt, now)
    await releaseReview(db, id, now)
    assert.equal((await row(50)).reviewClaimedAt, null)
  })

  test('a request whose claim was taken over meanwhile stops its review, and the other one stands', async () => {
    const { startReview } = await import('../src/reviews.js')
    await open(ids.thread, 51)
    slowSha = 'sha51'
    try {
      const slow = startReview(db, scope, {
        repo,
        number: 51,
        by: { kind: 'member', memberId: ids.owner },
      })
      // While it starts, its claim is taken over, as by a request after it ran out.
      await new Promise((resolve) => setTimeout(resolve, 300))
      const other = new Date()
      await db.pullRequest.updateMany({
        where: { repository: repo, number: 51 },
        data: { reviewClaimedAt: other },
      })
      await assert.rejects(slow, /Another review of it started meanwhile/)
      const pr = await row(51)
      assert.equal(pr.reviewSessionId, null)
      assert.deepEqual(pr.reviewClaimedAt, other)
      const stopped = await db.session.findFirstOrThrow({
        where: { parentId: ids.thread, title: 'Review #51: Change 51' },
      })
      assert.equal(stopped.awaited, false)
      assert.ok(stopped.archivedAt)
      assert.equal((stopped.report as { status?: string } | null)?.status, 'cancelled')
    } finally {
      slowSha = ''
    }
  })

  /** A child thread of Riley's under `parentId`, which waits for it (start_child). */
  const childOf = async (parentId: string, ask: string) => {
    // What waited for the computer went, as its runner would take it: no runner answers here,
    // and what may wait for one is capped (src/runner-commands.ts).
    await prisma.runnerCommand.deleteMany({ where: { computerId: ids.computer } })
    const session = await db.session.create({
      data: {
        teammateId: ids.riley,
        startedByMemberId: ids.owner,
        computerId: ids.computer,
        title: ask,
        projectId: ids.web,
        status: 'idle',
        lastSeq: 1,
        parentId,
        parentTeammateId: ids.riley,
        origin: 'child',
        awaited: true,
        awaitUntil: new Date(Date.now() + 30 * 60_000),
      } as never,
    })
    await db.threadTeammate.create({
      data: { sessionId: session.id, teammateId: ids.riley } as never,
    })
    // Its first message is its parent's teammate's, not a person's.
    await db.sessionEvent.create({
      data: {
        sessionId: session.id,
        seq: 1,
        type: 'message.user',
        data: { type: 'message.user', text: ask },
        at: new Date(),
      } as never,
    })
    return session.id
  }

  /** The thread's next event, as its runner stores it; when. */
  const event = async (sessionId: string, type: string, data: object) => {
    const last = await db.sessionEvent.findFirst({
      where: { sessionId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    })
    const seq = (last?.seq ?? 0) + 1
    const at = new Date(Date.now() + 1)
    await db.sessionEvent.create({
      data: { sessionId, seq, type, data: { type, ...data }, at } as never,
    })
    await db.session.updateMany({ where: { id: sessionId }, data: { lastSeq: seq } })
    return at.toISOString()
  }

  /** What Brigade hears of a child thread's events (src/hub.ts). */
  const note = async (sessionId: string, events: { type: string; at: string }[]) => {
    const { noteChildEvents } = await import('../src/children.js')
    const s = await db.session.findFirstOrThrow({ where: { id: sessionId } })
    await noteChildEvents(
      { id: s.id, organizationId: ids.org, workspaceId: ids.workspace, parentId: s.parentId },
      events.map((event) => ({ event })),
    )
  }

  /** A turn of a child thread ends on `text`. */
  const turnEnds = async (sessionId: string, text: string) => {
    await event(sessionId, 'message.done', { text })
    await note(sessionId, [{ type: 'turn.completed', at: new Date().toISOString() }])
  }

  /** The reports that woke a thread. */
  const reportsTo = (sessionId: string) =>
    db.wakeup.findMany({ where: { sessionId, kind: 'report' }, orderBy: { createdAt: 'asc' } })

  const reportOf = async (sessionId: string) => {
    const s = await db.session.findFirstOrThrow({ where: { id: sessionId } })
    return {
      summary: (s.report as { summary?: string } | null)?.summary ?? null,
      delivered: !!s.reportDeliveredAt,
      awaited: s.awaited,
      awaitUntil: s.awaitUntil,
    }
  }

  test('a pull request a child thread opens is reviewed under it, and it reports once the review is done', async () => {
    const { deliverReport, handleChildCall } = await import('../src/children.js')
    const parent = await thread(ids.web, 'Large files on the machine.')
    const child = await childOf(parent, 'Send files up to 2 GB.')
    const told = await open(child, 901, { wanted: true, reason: 'Streams on both sides' })
    assert.equal(told?.review.started, true, told?.review.note)
    assert.match(told!.review.note, /End your turn now, without reporting/)
    const review = (await row(901)).reviewSession!
    assert.equal(review.parentId, child)
    assert.equal(review.teammateId, ids.kai)
    assert.equal(review.awaited, true)
    // Its report wakes the author, in the child.
    assert.equal(review.parentTeammateId, ids.riley)
    // The parent waits for the child past the review's own wait.
    const held = await reportOf(child)
    assert.ok(held.awaitUntil!.getTime() > review.awaitUntil!.getTime(), 'the parent outwaits it')

    // Its turn ends while the review runs: nothing reaches the parent, and it may not report.
    await turnEnds(child, 'Opened #901: Kai reviews it.')
    assert.deepEqual(
      { ...(await reportOf(child)), awaitUntil: null },
      { summary: null, delivered: false, awaited: true, awaitUntil: null },
    )
    assert.equal((await reportsTo(parent)).length, 0)
    const session = await db.session.findFirstOrThrow({ where: { id: child } })
    const refused = (await handleChildCall(
      db,
      scope,
      session as never,
      { id: ids.riley, name: 'Riley' },
      { name: 'report', status: 'report', summary: 'Done.' },
    )) as { error?: string }
    assert.match(refused.error ?? '', /#901 is still in review by Kai: do not report yet/)

    // Kai reports: the child is woken, not the parent.
    await db.session.updateMany({
      where: { id: review.id },
      data: {
        report: {
          status: 'report',
          summary: 'Approve: nothing blocks.',
          at: new Date().toISOString(),
        },
      } as never,
    })
    await deliverReport(scope, review.id)
    const woken = await reportsTo(child)
    assert.equal(woken.length, 1)
    assert.equal(woken[0]!.teammateId, ids.riley)
    assert.match(woken[0]!.note, /Approve: nothing blocks/)
    assert.equal((await reportsTo(parent)).length, 0)

    // A turn that ends before that report shows in the child (it waits behind it) still sends nothing.
    await turnEnds(child, 'Still checking the benchmark.')
    assert.equal((await reportOf(child)).delivered, false)
    assert.equal((await reportsTo(parent)).length, 0)

    // The turn the review's report brings ends: the child reports, once, to its parent.
    await db.wakeup.updateMany({
      where: { id: woken[0]!.id },
      data: { status: 'fired', firedAt: new Date() },
    })
    const at = await event(child, 'message.user', {
      text: woken[0]!.note,
      messageId: `wakeup-${woken[0]!.id}`,
    })
    await note(child, [{ type: 'message.user', at }])
    await turnEnds(child, 'Kai approved #901: ready to merge.')
    const done = await reportOf(child)
    assert.equal(done.summary, 'Kai approved #901: ready to merge.')
    assert.equal(done.delivered, true)
    const parentWoken = await reportsTo(parent)
    assert.equal(parentWoken.length, 1)
    assert.match(parentWoken[0]!.note, /Kai approved #901/)
  })

  test('the parent may ask for the review of its child’s pull request: it runs under the child, which it waits for again', async () => {
    const { handleReviewCall } = await import('../src/reviews.js')
    const parent = await thread(ids.web, 'Two exports.')
    const child = await childOf(parent, 'Fix the CSV export.')
    await open(child, 902, { wanted: false, reason: 'One line' })
    await turnEnds(child, 'Opened #902, with no review: one line.')
    assert.equal((await reportOf(child)).delivered, true)
    const riley = { id: ids.riley, name: 'Riley' }
    const ask = { name: 'request_review' as const, repository: repo, number: 902 }
    // Another thread may not.
    const foreign = (await handleReviewCall(db, scope, { id: ids.quietThread }, riley, ask)) as {
      error?: string
    }
    assert.match(foreign.error ?? '', /a pull request this thread/)
    const asked = (await handleReviewCall(db, scope, { id: parent }, riley, ask)) as {
      reviewer?: string
      note?: string
      error?: string
    }
    assert.equal(asked.reviewer, 'Kai', asked.error)
    assert.match(asked.note ?? '', /That child is woken with its report/)
    const review = (await row(902)).reviewSession!
    assert.equal(review.parentId, child)
    // The parent waits for the child again: its old report no longer stands.
    const again = await reportOf(child)
    assert.deepEqual(
      { summary: again.summary, delivered: again.delivered, awaited: again.awaited },
      { summary: null, delivered: false, awaited: true },
    )
    assert.ok(again.awaitUntil!.getTime() > review.awaitUntil!.getTime())
  })

  test('the parent asking for the review of a child it did not wait for waits for it, with a deadline', async () => {
    const { handleReviewCall } = await import('../src/reviews.js')
    const parent = await thread(ids.web, 'Background fixes.')
    const child = await childOf(parent, 'Fix the logo in the background.')
    // Started with wait false (start_child): nothing waits for it, and it has no deadline.
    await db.session.updateMany({
      where: { id: child },
      data: { awaited: false, awaitUntil: null },
    })
    await open(child, 906, { wanted: false, reason: 'An image' })
    const asked = (await handleReviewCall(
      db,
      scope,
      { id: parent },
      { id: ids.riley, name: 'Riley' },
      { name: 'request_review', repository: repo, number: 906 },
    )) as { reviewer?: string; error?: string }
    assert.equal(asked.reviewer, 'Kai', asked.error)
    const review = (await row(906)).reviewSession!
    const after = await reportOf(child)
    assert.equal(after.awaited, true)
    assert.ok(after.awaitUntil, 'the sweep settles it if the review or the child stalls')
    assert.ok(after.awaitUntil!.getTime() > review.awaitUntil!.getTime())
  })

  test('no review starts below a child’s review: a teammate there is told so, a person’s ask runs apart', async () => {
    const { handleReviewCall, requestReview } = await import('../src/reviews.js')
    const parent = await thread(ids.web, 'Deep work.')
    const child = await childOf(parent, 'Fix the sync.')
    const below = await childOf(child, 'Review #900: Fix the sync')
    const told = await open(below, 907, { wanted: true, reason: 'A follow-up fix' })
    assert.equal(told?.review.started, false)
    assert.match(told!.review.note, /under a child thread: Brigade starts no review below it/)
    assert.equal((await row(907)).reviewSessionId, null)
    // Asked for by itself, or by the child above it: refused alike.
    for (const id of [below, child]) {
      const asked = (await handleReviewCall(
        db,
        scope,
        { id },
        { id: ids.riley, name: 'Riley' },
        { name: 'request_review', repository: repo, number: 907 },
      )) as { error?: string }
      assert.match(asked.error ?? '', /starts no review below it/)
    }
    // A person asks on its page: it runs in a thread of its own, out of the tree.
    const { threadId } = await requestReview(
      { ...scope, userId: `owner-${suffix}`, memberId: ids.owner, role: 'owner' },
      repo,
      907,
      { reviewerId: ids.kai },
    )
    const pr = await row(907)
    assert.equal(pr.reviewSessionId, threadId)
    assert.equal(pr.reviewSession?.parentId, null)
    assert.equal(pr.sessionId, below, 'the pull request stays where it was opened')
  })

  test('closing its pull request stops the review, and the child it held reports', async () => {
    const { pullRequestEvent } = await import('../src/pull-requests.js')
    const parent = await thread(ids.web, 'Imports.')
    const child = await childOf(parent, 'Fix the import.')
    await open(child, 903, { wanted: true, reason: 'Data' })
    await turnEnds(child, 'Opened #903, in review.')
    assert.equal((await reportsTo(parent)).length, 0)
    closed.add(903)
    await pullRequestEvent(scope, repo, pull(903) as never)
    const after = await reportOf(child)
    assert.equal(after.summary, 'Opened #903, in review.')
    assert.equal(after.delivered, true)
    assert.equal((await reportsTo(parent)).length, 1)
  })

  test('a child’s review sits under the thread at the top: archived with it, and a ticket there brings it back', async () => {
    const { setThreadArchived } = await import('../src/thread-archive.js')
    const { openWork } = await import('../src/thread-done.js')
    const { rootIdOf } = await import('../src/thread-root.js')
    const parent = await thread(ids.web, 'Uploads.')
    const child = await childOf(parent, 'Resume uploads.')
    await open(child, 904, { wanted: true, reason: 'Resumable state' })
    const review = (await row(904)).reviewSessionId!
    assert.equal(await rootIdOf(db, review), parent)
    assert.equal(await rootIdOf(db, child), parent)
    assert.equal(await rootIdOf(db, parent), parent)
    await setThreadArchived(scope, parent, true)
    const archived = await db.session.findFirstOrThrow({ where: { id: review } })
    assert.ok(archived.archivedAt, 'archived with the thread at the top')
    await db.ticket.create({
      data: { sessionId: review, type: 'question', title: 'Which branch?' },
    } as never)
    // Brought back as the ticket is written, in the background.
    for (let i = 0; i < 50; i++) {
      if (!(await db.session.findFirstOrThrow({ where: { id: parent } })).archivedAt) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal((await db.session.findFirstOrThrow({ where: { id: parent } })).archivedAt, null)
    // Its teammate is told it waits on a person, before it says the work is done.
    const work = await openWork(db, parent)
    assert.ok(
      work.some((line) =>
        /The question “Which branch\?” in the child thread “Review #904/.test(line),
      ),
      work.join('\n'),
    )
  })

  test('a merge’s status keeps the loop’s column, which the API running before a deploy reads too', async () => {
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_name = 'PullRequest'`
    const names = columns.map((c) => c.column_name)
    for (const name of ['reviewStatus', 'reviewedSha']) assert.ok(names.includes(name), name)
    for (const name of ['autoMerge', 'reviewerTeammateId']) assert.ok(!names.includes(name), name)
    await open(ids.thread, 60)
    const { id } = await row(60)
    await prisma.$executeRaw`
      update "PullRequest" set "reviewStatus" = 'merging', "reviewedSha" = 'resolved-head'
      where id = ${id}`
    const moved = await row(60)
    assert.equal(moved.mergeStatus, 'merging')
    assert.equal(moved.resolveFromSha, 'resolved-head')
  })
})
