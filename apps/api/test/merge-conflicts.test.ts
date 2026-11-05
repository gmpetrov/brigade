import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'

// A merge that conflicts (src/pull-requests.ts), against the API's development database
// (apps/api/.env), in an organization of its own removed at the end, with GitHub faked; skipped
// when no database answers:
// - what a pull request itself adds and removes, read from GitHub's compare: the same lines
//   around other context are the same change; one it cannot read whole is not known;
// - Auto-merge sends a pull request that conflicts back to its author, rather than leaving it to
//   a person, and it is not in Needs you meanwhile;
// - once the author pushed, an approval its resolution kept (the same lines added and removed)
//   holds for the new head, and it merges; one it changed has the reviewer look first, and it
//   merges once the reviewer approves that head, not before nor when it asks for changes; one
//   GitHub cannot compare is looked at too;
// - nothing pushed, or conflicts again past three turns, stop it with a ticket;
// - a person's Resolve conflicts keeps what it did with no review, and waits for its
//   reviewer's look at a resolution that changed what it approved, merging once approved and
//   stopping when it asks for changes;
// - a look its reviews have no looks left for stops it with a ticket.
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

/** A file as GitHub's compare lists it. */
type Change = {
  filename: string
  status: string
  changes: number
  patch?: string
  sha?: string
  previous_filename?: string
}

/** A modified file whose patch adds `added` among `context`, at line `at`. */
const modified = (filename: string, context: string[], added: string[], at = 1): Change => ({
  filename,
  status: 'modified',
  changes: added.length,
  patch: [
    `@@ -${at},${context.length} +${at},${context.length + added.length} @@`,
    ...context.slice(0, 1).map((l) => ` ${l}`),
    ...added.map((l) => `+${l}`),
    ...context.slice(1).map((l) => ` ${l}`),
  ].join('\n'),
})

const until = async (check: () => Promise<boolean>, what: string) => {
  for (let i = 0; i < 250; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${what}`)
}

describe('what a pull request itself changes', () => {
  /** GitHub answering a compare with these files, or with this status. */
  const gh = (files: Change[] | number) => ({
    fetch: async () =>
      typeof files === 'number'
        ? Response.json({ message: 'Server Error' }, { status: files })
        : Response.json({ files, commits: [] }),
  })

  test('the same lines added and removed, among other lines and places, are the same change', async () => {
    const { ownChanges, changedFiles } = await import('../src/pull-requests.js')
    const before = await ownChanges(
      gh([modified('a.ts', ['x', 'y'], ['add()'], 3)]),
      'o/r',
      'main',
      's1',
    )
    // Its base added a line where it adds its own, and moved everything down: the same change.
    const after = await ownChanges(
      gh([modified('a.ts', ['x', 'base()', 'y'], ['add()'], 9)]),
      'o/r',
      'main',
      's2',
    )
    assert.deepEqual(changedFiles(before, after), [])
    const other = await ownChanges(
      gh([modified('a.ts', ['x', 'y'], ['add(1)'])]),
      'o/r',
      'main',
      's3',
    )
    assert.deepEqual(changedFiles(before, other), ['a.ts'])
    // A file it no longer changes, or a new one, are changes too.
    const more = await ownChanges(
      gh([modified('a.ts', ['x', 'y'], ['add()']), modified('b.ts', ['z'], ['b()'])]),
      'o/r',
      'main',
      's4',
    )
    assert.deepEqual(changedFiles(before, more), ['b.ts'])
    assert.deepEqual(changedFiles(more, before), ['b.ts'])
  })

  test('a file GitHub shows no patch for is known only when it is new, by its contents', async () => {
    const { ownChanges, changedFiles } = await import('../src/pull-requests.js')
    const image = (sha: string): Change => ({
      filename: 'logo.png',
      status: 'added',
      changes: 0,
      sha,
    })
    const big = (sha: string): Change => ({
      filename: 'big.json',
      status: 'added',
      changes: 9000,
      sha,
    })
    const a = await ownChanges(gh([image('i1'), big('b1')]), 'o/r', 'main', 's1')
    assert.deepEqual(
      changedFiles(a, await ownChanges(gh([image('i1'), big('b1')]), 'o/r', 'main', 's2')),
      [],
    )
    assert.deepEqual(
      changedFiles(a, await ownChanges(gh([image('i1'), big('b2')]), 'o/r', 'main', 's3')),
      ['big.json'],
    )
    // A changed file it shows no patch for, not a new one: not known.
    const changed = { filename: 'big.json', status: 'modified', changes: 9000, sha: 'b3' }
    assert.equal(await ownChanges(gh([changed]), 'o/r', 'main', 's4'), null)
    // A file renamed with no change: known by its old name.
    const renamed = { filename: 'b.ts', previous_filename: 'a.ts', status: 'renamed', changes: 0 }
    const moved = await ownChanges(gh([renamed]), 'o/r', 'main', 's5')
    assert.deepEqual(changedFiles(moved, await ownChanges(gh([renamed]), 'o/r', 'main', 's6')), [])
    assert.deepEqual(
      changedFiles(
        moved,
        await ownChanges(gh([{ ...renamed, previous_filename: 'c.ts' }]), 'o/r', 'main', 's7'),
      ),
      ['b.ts'],
    )
  })

  test('as many files as GitHub lists at most are not known whole', async () => {
    const { ownChanges, changedFiles } = await import('../src/pull-requests.js')
    const files = Array.from({ length: 300 }, (_, i) => modified(`f${i}.ts`, ['x'], ['y']))
    const many = await ownChanges(gh(files), 'o/r', 'main', 's1')
    assert.equal(many, null)
    assert.equal(changedFiles(many, many), null)
    await assert.rejects(ownChanges(gh(500), 'o/r', 'main', 's2'))
  })
})

describe('a merge that conflicts', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const installationId = 100_000 + Math.floor(Math.random() * 1_000_000)
  const repo = 'acme/conflicts'
  const ids = {} as Record<
    'org' | 'workspace' | 'owner' | 'admin' | 'computer' | 'riley' | 'kai',
    string
  >
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }
  const realFetch = globalThis.fetch
  /** Each pull request's head on GitHub, sha<number> unless said. */
  const heads = new Map<number, string>()
  /** Pull requests that conflict with main on GitHub. */
  const dirty = new Set<number>()
  /** Pull requests merged on GitHub. */
  const merged = new Set<number>()
  /** What a pull request changes at a commit, as GitHub's compare of main with it lists it. */
  const changes = new Map<string, Change[]>()
  /** Commits GitHub fails to compare. */
  const unreadable = new Set<string>()

  const pull = (number: number) => ({
    number,
    title: `Change ${number}`,
    html_url: `https://github.com/${repo}/pull/${number}`,
    state: merged.has(number) ? 'closed' : 'open',
    draft: false,
    merged_at: merged.has(number) ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
    user: { login: 'brigade-test[bot]', type: 'Bot' },
    head: { ref: `brigade/change-${number}`, sha: heads.get(number) ?? `sha${number}` },
    base: { ref: 'main' },
    mergeable: true,
    mergeable_state: dirty.has(number) ? 'dirty' : 'clean',
  })

  before(async () => {
    if (!database) return
    ids.org = `org-conflicts-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Conflicts', slug: `conflicts-${suffix}` },
    })
    for (const [who, role] of [
      ['owner', 'owner'],
      ['admin', 'admin'],
    ] as const) {
      await prisma.user.create({
        data: { id: `${who}-${suffix}`, name: who, email: `${who}-${suffix}@test.local` },
      })
      ids[who] = `m-${who}-${suffix}`
      await prisma.member.create({
        data: { id: ids[who], organizationId: ids.org, userId: `${who}-${suffix}`, role },
      })
    }
    // The owner merges on their own; the admin merges when they ask.
    await prisma.member.update({ where: { id: ids.owner }, data: { autoMerge: true } })
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Conflicts' } })
    ).id
    scope = { organizationId: ids.org, workspaceId: ids.workspace }
    db = scoped(scope)
    // A cloud computer: what is sent to it waits for its runner.
    ids.computer = (
      await db.computer.create({
        data: { kind: 'cloud', name: 'Test', status: 'running' } as never,
      })
    ).id
    for (const memberId of [ids.owner, ids.admin])
      for (const provider of ['claude_code', 'codex'] as const)
        await db.account.create({
          data: {
            memberId,
            computerId: ids.computer,
            provider,
            label: provider,
            status: 'ready',
          } as never,
        })
    ids.riley = (await db.teammate.create({ data: { name: 'Riley' } as never })).id
    ids.kai = (await db.teammate.create({ data: { name: 'Kai', harness: 'codex' } as never })).id
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
    await db.grant.createMany({
      data: [
        { teammateId: ids.riley, connectionId: github.id, scope: 'read_write' },
        { teammateId: ids.kai, connectionId: github.id, scope: 'read_write' },
      ] as never,
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
      const pr = pathname.match(/^\/repos\/acme\/conflicts\/pulls\/(\d+)$/)
      if (pr && method === 'GET') return Response.json(pull(Number(pr[1])))
      const merge = pathname.match(/^\/repos\/acme\/conflicts\/pulls\/(\d+)\/merge$/)
      if (merge && method === 'PUT') {
        merged.add(Number(merge[1]))
        return Response.json({ merged: true })
      }
      const compare = pathname.match(/^\/repos\/acme\/conflicts\/compare\/main\.\.\.(.+)$/)
      if (compare) {
        const sha = decodeURIComponent(compare[1]!)
        if (unreadable.has(sha)) return Response.json({ message: 'Server Error' }, { status: 500 })
        return Response.json({ files: changes.get(sha) ?? [], commits: [] })
      }
      if (pathname.endsWith('/check-runs'))
        return Response.json({
          check_runs: [
            { name: 'test', status: 'completed', conclusion: 'success', html_url: null },
          ],
        })
      if (pathname.endsWith('/status')) return Response.json({ statuses: [] })
      return Response.json({ message: 'Not Found' }, { status: 404 })
    }) as typeof fetch
  })

  after(async () => {
    globalThis.fetch = realFetch
    if (!database) return
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({
      where: { id: { in: [`owner-${suffix}`, `admin-${suffix}`] } },
    })
  })

  /** A thread of Riley's, started by a member, where it opened pull request #number. */
  async function opened(number: number, memberId = ids.owner) {
    // No runner takes what earlier tests sent: past a few, Brigade sends a computer no more.
    await prisma.runnerCommand.deleteMany({ where: { computerId: ids.computer } })
    const session = await db.session.create({
      data: {
        teammateId: ids.riley,
        startedByMemberId: memberId,
        computerId: ids.computer,
        title: `Change ${number}`,
        status: 'idle',
        lastSeq: 0,
      } as never,
    })
    await db.threadTeammate.create({
      data: { sessionId: session.id, teammateId: ids.riley } as never,
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

  /**
   * Kai reviewed pull request #number in a child of its thread, and approved `sha`: its report
   * reached the thread. The review's thread.
   */
  async function approved(number: number, thread: string, sha: string) {
    const review = await db.session.create({
      data: {
        teammateId: ids.kai,
        startedByMemberId: ids.owner,
        computerId: ids.computer,
        title: `Review #${number}`,
        status: 'idle',
        parentId: thread,
        parentTeammateId: ids.riley,
        origin: 'child',
        awaited: false,
        reportDeliveredAt: new Date(),
        report: { status: 'done', summary: 'Approved', at: new Date().toISOString() },
        lastSeq: 0,
      } as never,
    })
    await db.threadTeammate.create({ data: { sessionId: review.id, teammateId: ids.kai } as never })
    const pr = await row(number)
    await db.pullRequest.updateMany({ where: { id: pr.id }, data: { reviewSessionId: review.id } })
    await verdict(number, review.id, 'approve', sha)
    return review.id
  }

  /** Kai's verdict on #number at `sha`, in its review's thread. */
  async function verdict(
    number: number,
    review: string,
    verdict: 'approve' | 'request_changes',
    sha: string,
  ) {
    const pr = await row(number)
    await db.pullRequestReview.create({
      data: {
        pullRequestId: pr.id,
        teammateId: ids.kai,
        sessionId: review,
        verdict,
        body: verdict,
        sha,
        round: (await db.pullRequestReview.count({ where: { pullRequestId: pr.id } })) + 1,
        // After any verdict made in the same millisecond.
        createdAt: new Date(Date.now() + 1000),
      } as never,
    })
  }

  /** The review reported its verdict back to the thread, and its turn ended. */
  async function reported(review: string) {
    await db.session.updateMany({
      where: { id: review },
      data: { status: 'idle', awaited: false, reportDeliveredAt: new Date() },
    })
  }

  /**
   * Its teammate's turn ended in the thread, as the hub tells Brigade (noteTurnsEnded): a
   * resolution it was asked for goes on, then whatever it readied for Auto-merge.
   */
  async function turnEnded(sessionId: string, teammateId = ids.riley) {
    const { autoMergeTurnEnded, resolveTurnEnded } = await import('../src/pull-requests.js')
    await db.session.updateMany({ where: { id: sessionId }, data: { status: 'idle' } })
    await resolveTurnEnded(scope, sessionId, teammateId)
    await autoMergeTurnEnded(scope, sessionId)
  }

  const row = (number: number) =>
    db.pullRequest.findFirstOrThrow({ where: { repository: repo, number } })

  const waiting = async () => {
    const { needsAttention } = await import('../src/pull-requests.js')
    return (await needsAttention(db)).map((p) => p.number)
  }

  /** What Brigade asked in a thread, newest first. */
  const prompts = async (sessionId: string) =>
    (
      await prisma.runnerCommand.findMany({
        where: { sessionId, type: 'thread.prompt' },
        orderBy: { createdAt: 'desc' },
      })
    ).map((c) => (c.message as { text: string }).text)

  /** The thread's open tickets' titles. */
  const tickets = async (sessionId: string) =>
    (await db.ticket.findMany({ where: { sessionId, status: 'open' } })).map((t) => t.title)

  /** Riley pushed `sha` to #number, which no longer conflicts, changing `files` as said. */
  function pushed(
    number: number,
    sha: string,
    files: Change[],
    options: { conflicts?: boolean } = {},
  ) {
    heads.set(number, sha)
    changes.set(sha, files)
    if (options.conflicts) dirty.add(number)
    else dirty.delete(number)
  }

  const asOpened = [modified('src/a.ts', ['one', 'two'], ['fix()'])]
  /** The same lines, its base having added its own beside them: the resolution kept them. */
  const kept = [modified('src/a.ts', ['one', 'base()', 'two'], ['fix()'], 4)]
  /** The resolution rewrote the line it adds. */
  const rewritten = [modified('src/a.ts', ['one', 'base()', 'two'], ['fix(base)'], 4)]

  test('Auto-merge sends a pull request that conflicts back to its author, out of Needs you', async () => {
    const thread = await opened(1)
    pushed(1, 'a1', asOpened, { conflicts: true })
    await approved(1, thread, 'a1')
    await turnEnded(thread)
    const pr = await row(1)
    assert.equal(pr.mergeStatus, 'resolving')
    assert.ok(pr.autoMergeAt, 'still an auto-merge')
    assert.equal(pr.round, 1)
    assert.equal(pr.resolveFromSha, 'a1')
    assert.ok(!merged.has(1))
    const [ask] = await prompts(thread)
    assert.match(
      ask ?? '',
      /^Pull request #1 "Change 1" in acme\/conflicts conflicts with `main`, and Auto-merge merges it once that is resolved/,
    )
    assert.match(ask ?? '', /Riley, fetch `main` and merge it into `brigade\/change-1`/)
    const { resolveConflictsNote } = await import('@brigade/contracts')
    assert.equal(resolveConflictsNote(ask!)?.number, 1, 'the thread shows it as a note')
    assert.ok(!(await waiting()).includes(1), 'nobody needs to do anything')
  })

  test('a resolution that kept what the review approved merges, the approval holding for it', async () => {
    const thread = (await row(1)).sessionId!
    pushed(1, 'a2', kept)
    await turnEnded(thread)
    await until(async () => merged.has(1), '#1 merged')
    await until(async () => (await row(1)).state === 'merged', '#1 recorded as merged')
    const pr = await row(1)
    assert.equal(pr.approvalCarriedTo, 'a2')
    const entry = await prisma.auditEntry.findFirst({
      where: { action: 'pull_request.resolution_checked', targetId: pr.id },
    })
    assert.equal((entry?.data as { approvalKept?: boolean }).approvalKept, true)
    const merge = () =>
      prisma.auditEntry.findFirst({ where: { action: 'pull_request.merged', targetId: pr.id } })
    await until(async () => !!(await merge()), 'its merge audited')
    assert.equal(((await merge())?.data as { auto?: boolean }).auto, true)
  })

  test('the review shows its approval kept for a head that resolved conflicts without changing it', async () => {
    const { reviewOf } = await import('../src/pull-requests.js')
    const { reviewInclude } = await import('../src/pull-requests.js')
    const pr = await db.pullRequest.findFirstOrThrow({
      where: { repository: repo, number: 1 },
      include: reviewInclude,
    })
    const now = reviewOf(pr, 'a2')
    assert.equal(now?.state, 'approved')
    assert.ok(now && 'changed' in now && now.changed === false && now.kept === true)
    const later = reviewOf(pr, 'a3')
    assert.ok(later && 'changed' in later && later.changed === true && !later.kept)
  })

  test('a resolution that changed what it adds has its reviewer look first, then merges once approved', async () => {
    const thread = await opened(2)
    pushed(2, 'b1', asOpened, { conflicts: true })
    const review = await approved(2, thread, 'b1')
    await turnEnded(thread)
    assert.equal((await row(2)).mergeStatus, 'resolving')

    pushed(2, 'b2', rewritten)
    await turnEnded(thread)
    let pr = await row(2)
    assert.equal(pr.mergeStatus, 'none', 'back to waiting on its review')
    assert.equal(pr.autoMergeAt, null)
    assert.equal(pr.approvalCarriedTo, null)
    assert.ok(!merged.has(2), 'not before its reviewer looked')
    const child = await db.session.findFirstOrThrow({ where: { id: review } })
    assert.equal(child.awaited, true, 'the thread waits for the look')
    assert.equal(child.reportDeliveredAt, null)
    const [look] = await prompts(review)
    assert.match(look ?? '', /To get #2 merged, Riley resolved its conflicts with `main`/)
    assert.match(
      look ?? '',
      /changed lines the pull request itself adds or removes since you approved `b1`: in `src\/a\.ts`/,
    )
    assert.match(look ?? '', /new verdict on its head `b2`/)
    assert.ok(!(await waiting()).includes(2), 'in review: nobody needs to do anything yet')
    const entry = await prisma.auditEntry.findFirst({
      where: { action: 'pull_request.resolution_checked', targetId: pr.id },
    })
    assert.deepEqual((entry?.data as { files?: string[] }).files, ['src/a.ts'])

    // Its turn ending while the look is under way merges nothing.
    await turnEnded(thread)
    assert.ok(!merged.has(2))

    // Kai approves the head it looked at: the next turn to end merges it.
    await verdict(2, review, 'approve', 'b2')
    await reported(review)
    await turnEnded(review, ids.kai)
    await until(async () => merged.has(2), '#2 merged')
    pr = await row(2)
    assert.equal(pr.approvalCarriedTo, null)
  })

  test('a look that asks for changes leaves it to the author and a person, unmerged', async () => {
    const thread = await opened(3)
    pushed(3, 'c1', asOpened, { conflicts: true })
    const review = await approved(3, thread, 'c1')
    await turnEnded(thread)
    pushed(3, 'c2', rewritten)
    await turnEnded(thread)
    assert.equal((await row(3)).mergeStatus, 'none')
    await verdict(3, review, 'request_changes', 'c2')
    await reported(review)
    await turnEnded(review, ids.kai)
    await turnEnded(thread)
    assert.ok(!merged.has(3))
    assert.equal((await row(3)).mergeStatus, 'none')
    assert.ok((await waiting()).includes(3), 'its review is done: it waits on a person')
  })

  test('what GitHub cannot compare is looked at too', async () => {
    const thread = await opened(4)
    pushed(4, 'd1', asOpened, { conflicts: true })
    const review = await approved(4, thread, 'd1')
    await turnEnded(thread)
    pushed(4, 'd2', kept)
    unreadable.add('d2')
    await turnEnded(thread)
    assert.ok(!merged.has(4))
    assert.equal((await db.session.findFirstOrThrow({ where: { id: review } })).awaited, true)
    const [look] = await prompts(review)
    assert.match(look ?? '', /Brigade could not tell whether what it pushed changed lines/)
  })

  test('nothing pushed stops it with a ticket for a person', async () => {
    const thread = await opened(5)
    pushed(5, 'e1', asOpened, { conflicts: true })
    await turnEnded(thread)
    assert.equal((await row(5)).mergeStatus, 'resolving')
    // Its turn ends with the same head: it said why in its reply.
    await turnEnded(thread)
    const pr = await row(5)
    assert.equal(pr.mergeStatus, 'stuck')
    assert.equal(pr.autoMergeAt, null)
    assert.deepEqual(await tickets(thread), [
      `${repo}#5: Nothing was pushed to resolve the conflicts: read the reply in the thread`,
    ])
    assert.ok((await waiting()).includes(5))
  })

  test('conflicts again after three turns stop it with a ticket', async () => {
    const thread = await opened(6)
    pushed(6, 'f1', asOpened, { conflicts: true })
    await turnEnded(thread)
    for (const [round, sha] of [
      [2, 'f2'],
      [3, 'f3'],
    ] as const) {
      // Its base moved on meanwhile: it conflicts again.
      pushed(6, sha, asOpened, { conflicts: true })
      await turnEnded(thread)
      await until(async () => (await row(6)).round === round, `round ${round}`)
      assert.equal((await row(6)).mergeStatus, 'resolving')
    }
    pushed(6, 'f4', asOpened, { conflicts: true })
    await turnEnded(thread)
    await until(async () => (await tickets(thread)).length > 0, 'a ticket')
    assert.equal((await row(6)).mergeStatus, 'stuck')
    assert.deepEqual(await tickets(thread), [`${repo}#6: it conflicts with \`main\``])
    assert.ok(!merged.has(6))
  })

  /** An admin asks for #number's conflicts to be resolved, then merged (Resolve conflicts). */
  async function resolve(number: number) {
    const { resolveConflicts } = await import('../src/pull-requests.js')
    await resolveConflicts(
      { ...scope, userId: `admin-${suffix}`, memberId: ids.admin, role: 'admin' },
      repo,
      number,
      'squash',
    )
  }

  test("a person's Resolve conflicts with no review merges once pushed, as before", async () => {
    const thread = await opened(7, ids.admin)
    pushed(7, 'g1', asOpened, { conflicts: true })
    await resolve(7)
    const [ask] = await prompts(thread)
    assert.match(ask ?? '', /and a person asked to merge it once that is resolved/)
    pushed(7, 'g2', rewritten)
    await turnEnded(thread)
    await until(async () => merged.has(7), '#7 merged')
  })

  test("a person's Resolve conflicts waits for the look at a resolution that changed what was approved", async () => {
    const { advanceMerges } = await import('../src/pull-requests.js')
    const thread = await opened(8, ids.admin)
    pushed(8, 'h1', asOpened, { conflicts: true })
    const review = await approved(8, thread, 'h1')
    await resolve(8)
    pushed(8, 'h2', rewritten)
    await turnEnded(thread)
    await until(async () => (await row(8)).note === "Waiting for Kai's review", 'waiting for Kai')
    let pr = await row(8)
    assert.equal(pr.mergeStatus, 'merging')
    assert.equal(pr.autoMergeAt, null)
    await advanceMerges(ids.workspace)
    assert.ok(!merged.has(8), 'not while Kai looks')
    assert.equal((await row(8)).mergeStatus, 'merging')

    await verdict(8, review, 'approve', 'h2')
    await reported(review)
    await advanceMerges(ids.workspace)
    assert.ok(merged.has(8), 'merged once Kai approved its head')
    pr = await row(8)
    assert.equal(pr.state, 'merged')
  })

  test("a person's Resolve conflicts stops when the look asks for changes", async () => {
    const { advanceMerges } = await import('../src/pull-requests.js')
    const thread = await opened(9, ids.admin)
    pushed(9, 'i1', asOpened, { conflicts: true })
    const review = await approved(9, thread, 'i1')
    await resolve(9)
    pushed(9, 'i2', rewritten)
    await turnEnded(thread)
    await until(async () => (await row(9)).note === "Waiting for Kai's review", 'waiting for Kai')
    await verdict(9, review, 'request_changes', 'i2')
    await reported(review)
    await advanceMerges(ids.workspace)
    assert.ok(!merged.has(9))
    assert.equal((await row(9)).mergeStatus, 'stuck')
    assert.deepEqual(await tickets(thread), [`${repo}#9: Kai asked for changes`])
  })

  test("a person's merge waits while the author works on what the look asked, then stops unless it is looked at again", async () => {
    const { advanceMerges } = await import('../src/pull-requests.js')
    const thread = await opened(12, ids.admin)
    pushed(12, 'l1', asOpened, { conflicts: true })
    const review = await approved(12, thread, 'l1')
    await resolve(12)
    pushed(12, 'l2', rewritten)
    await turnEnded(thread)
    await until(async () => (await row(12)).note === "Waiting for Kai's review", 'waiting for Kai')
    await verdict(12, review, 'request_changes', 'l2')
    await reported(review)
    // Its report woke the author, which pushes a fix and has yet to ask Kai to look at it.
    await db.session.updateMany({ where: { id: thread }, data: { status: 'running' } })
    pushed(12, 'l3', [modified('src/a.ts', ['one', 'base()', 'two'], ['fix(base, 2)'], 4)])
    await advanceMerges(ids.workspace)
    assert.ok(!merged.has(12), 'not the fix nobody looked at')
    assert.equal((await row(12)).mergeStatus, 'merging')
    assert.match((await row(12)).note ?? '', /^Waiting for its thread to finish/)
    // Its turn ended without asking Kai again: a person decides.
    await db.session.updateMany({ where: { id: thread }, data: { status: 'idle' } })
    await advanceMerges(ids.workspace)
    assert.ok(!merged.has(12))
    assert.equal((await row(12)).mergeStatus, 'stuck')
    assert.deepEqual(await tickets(thread), [
      `${repo}#12: Commits came after Kai's review: have it reviewed again, or merge it as it is`,
    ])
  })

  test("changes asked for before a person's Resolve conflicts are merged past, as before", async () => {
    const thread = await opened(13, ids.admin)
    pushed(13, 'm1', asOpened, { conflicts: true })
    const review = await approved(13, thread, 'm1')
    const pr = await row(13)
    // Kai approved, then asked for changes, both before the person asked to merge it.
    await db.pullRequestReview.updateMany({
      where: { pullRequestId: pr.id },
      data: { createdAt: new Date(Date.now() - 60_000) },
    })
    await db.pullRequestReview.create({
      data: {
        pullRequestId: pr.id,
        teammateId: ids.kai,
        sessionId: review,
        verdict: 'request_changes',
        body: 'Rename it',
        sha: 'm1',
        round: 2,
        createdAt: new Date(Date.now() - 30_000),
      } as never,
    })
    await resolve(13)
    pushed(13, 'm2', rewritten)
    await turnEnded(thread)
    await until(async () => merged.has(13), '#13 merged')
  })

  test("a person's Resolve conflicts that kept what was approved merges right away", async () => {
    const thread = await opened(10, ids.admin)
    pushed(10, 'j1', asOpened, { conflicts: true })
    await approved(10, thread, 'j1')
    await resolve(10)
    pushed(10, 'j2', kept)
    await turnEnded(thread)
    await until(async () => merged.has(10), '#10 merged')
    assert.equal((await row(10)).approvalCarriedTo, 'j2')
  })

  test('a look its reviews have no looks left for stops it with a ticket', async () => {
    const { REVIEW_LOOKS } = await import('@brigade/contracts')
    const thread = await opened(11)
    pushed(11, 'k1', asOpened, { conflicts: true })
    const review = await approved(11, thread, 'k1')
    for (let i = 1; i < REVIEW_LOOKS; i++) await verdict(11, review, 'approve', 'k1')
    await turnEnded(thread)
    pushed(11, 'k2', rewritten)
    await turnEnded(thread)
    const pr = await row(11)
    assert.equal(pr.mergeStatus, 'stuck')
    assert.ok(!merged.has(11))
    const [ticket] = await tickets(thread)
    assert.equal(
      ticket,
      `${repo}#11: Kai approved it before what was pushed to merge it, and could not be asked to ` +
        `look at that (its reviews took their ${REVIEW_LOOKS} looks): have it reviewed again, or ` +
        'merge it as it is',
    )
  })
})
