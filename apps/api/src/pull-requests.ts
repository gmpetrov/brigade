// Pull requests and the review loop. GitHub keeps the code and the pull
// request; Brigade keeps who wrote it, who reviews it and where the loop stands
// (PullRequest), and drives it. A review request prompts the reviewer in the
// thread that opened the pull request; its verdict (github_review_pull_request)
// goes to the author when its turn ends; the author's next turn goes back to the
// reviewer; an approval merges once GitHub allows it. Teammates never merge: a
// person does, or an owner or admin arms the loop to.
import type {
  CheckRun,
  DiffFile,
  MergeMethod,
  PullRequestDetail,
  PullRequestList,
  PullRequestSummary,
  PullRequestTracking,
  TeammateReview,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit, type Actor } from './audit.js'
import { GITHUB_API, githubHeaders, installationToken } from './connectors/github-app.js'
import { ConnectorError, json } from './connectors/types.js'
import { prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { teammateGitHub, workspaceGitHub } from './git.js'
import type { WorkspaceScope } from './scope.js'
import { loadThread } from './thread-spec.js'
import { joinThread, promptThread, startThread } from './work.js'

/** Reviews in one loop before it stops and asks a person. */
export const MAX_ROUNDS = 3
/** Diffs shown per pull request; GitHub lists at most 3000 files. */
const FILES_MAX = 300

type GhPull = {
  number: number
  title: string
  html_url: string
  state: 'open' | 'closed'
  draft?: boolean
  merged_at: string | null
  updated_at: string
  user: { login: string; type?: string } | null
  head: { ref: string; sha: string }
  base: { ref: string }
  body?: string | null
  mergeable?: boolean | null
  mergeable_state?: string
  additions?: number
  deletions?: number
  changed_files?: number
  commits?: number
}

type GitHub = { fetch: (path: string, init?: RequestInit) => Promise<Response> }

const repoPath = (repo: string) => `/repos/${repo.split('/').map(encodeURIComponent).join('/')}`
const key = (repo: string, number: number) => `${repo}#${number}`

/** The workspace's GitHub, for a repository one of its connections reaches. */
async function github(db: ScopedDb, scope: Scope, repo: string): Promise<GitHub> {
  const found = await workspaceGitHub(db, scope, repo)
  if (!found)
    throw new HTTPException(404, {
      message: `No GitHub connection of this workspace reaches ${repo}`,
    })
  return {
    fetch: async (path, init = {}) =>
      fetch(`${GITHUB_API}${path}`, {
        ...init,
        headers: {
          ...githubHeaders,
          authorization: `Bearer ${await installationToken(found.installationId)}`,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
      }),
  }
}

async function call<T>(gh: GitHub, path: string, init?: RequestInit) {
  try {
    return await json<T>(await gh.fetch(path, init))
  } catch (error) {
    if (error instanceof ConnectorError)
      throw new HTTPException(502, { message: `GitHub: ${error.message}` })
    throw error
  }
}

const pullOf = (gh: GitHub, repo: string, number: number) =>
  call<GhPull>(gh, `${repoPath(repo)}/pulls/${number}`)

const stateOf = (p: GhPull) => (p.merged_at ? 'merged' : p.state)

// ---------------------------------------------------------------------------
// What the dashboard reads
// ---------------------------------------------------------------------------

const rowInclude = {
  authorTeammate: { select: { id: true, name: true } },
  reviewerTeammate: { select: { id: true, name: true } },
} as const
type Row = NonNullable<Awaited<ReturnType<typeof findRow>>>

const findRow = (db: ScopedDb, repo: string, number: number) =>
  db.pullRequest.findFirst({ where: { repository: repo, number }, include: rowInclude })

function tracking(row: Row | undefined): PullRequestTracking | null {
  if (!row) return null
  return {
    reviewStatus: row.reviewStatus,
    autoMerge: row.autoMerge,
    round: row.round,
    maxRounds: MAX_ROUNDS,
    note: row.note,
    sessionId: row.sessionId,
    author: row.authorTeammate,
    reviewer: row.reviewerTeammate,
  }
}

function summary(repo: string, p: GhPull, row: Row | undefined): PullRequestSummary {
  return {
    repository: repo,
    number: p.number,
    title: p.title,
    url: p.html_url,
    author: p.user?.login ?? null,
    draft: Boolean(p.draft),
    state: stateOf(p),
    head: p.head.ref,
    base: p.base.ref,
    updatedAt: p.updated_at,
    tracking: tracking(row),
  }
}

/** Keep Brigade's copy of what GitHub says in step. */
async function sync(db: ScopedDb, row: Row | undefined, p: GhPull) {
  if (!row) return
  const state = stateOf(p)
  if (
    row.title === p.title &&
    row.state === state &&
    row.headRef === p.head.ref &&
    row.baseRef === p.base.ref
  )
    return
  const closed = state !== 'open'
  await db.pullRequest.updateMany({
    where: { id: row.id },
    data: {
      title: p.title,
      headRef: p.head.ref,
      baseRef: p.base.ref,
      state,
      ...(p.merged_at ? { mergedAt: new Date(p.merged_at) } : {}),
      // A pull request closed on GitHub ends its loop.
      ...(closed && row.reviewStatus !== 'none' && row.reviewStatus !== 'approved'
        ? { reviewStatus: 'none', note: null }
        : {}),
      ...(closed ? { autoMerge: false } : {}),
    },
  })
}

/**
 * A teammate's pull request opened before Brigade tracked them: its branch is
 * in the call log of the thread that opened it.
 */
async function adopt(db: ScopedDb, repo: string, p: GhPull): Promise<Row | undefined> {
  if (!p.head.ref.startsWith('brigade/')) return undefined
  const opened = await db.connectionCall.findFirst({
    where: {
      operation: 'github_create_pull_request',
      result: 'ok',
      target: {
        startsWith: `pull request ${p.head.ref} → `,
        endsWith: ` in ${repo}`,
        mode: 'insensitive',
      },
    },
    orderBy: { createdAt: 'desc' },
  })
  if (!opened) return undefined
  await db.pullRequest
    .create({
      data: {
        repository: repo,
        number: p.number,
        title: p.title,
        headRef: p.head.ref,
        baseRef: p.base.ref,
        state: stateOf(p),
        sessionId: opened.sessionId,
        authorTeammateId: opened.teammateId,
      } as never,
    })
    .catch(() => undefined) // Another request adopted it first.
  return (await findRow(db, repo, p.number)) ?? undefined
}

/**
 * Pull requests of every repository where a teammate opened one, newest
 * activity first. Those opened before Brigade tracked them are found in the call log.
 */
export async function listPulls(
  db: ScopedDb,
  scope: Scope,
  state: 'open' | 'closed',
): Promise<PullRequestList> {
  const [rows, opened] = await Promise.all([
    db.pullRequest.findMany({ include: rowInclude }),
    db.connectionCall.findMany({
      where: { operation: 'github_create_pull_request', result: 'ok' },
      select: { target: true },
      distinct: ['target'],
    }),
  ])
  const fromLog = opened.flatMap((c) => {
    const repo = c.target.match(/ in ([\w.-]+\/[\w.-]+)$/)?.[1]
    return repo ? [repo.toLowerCase()] : []
  })
  const byKey = new Map(rows.map((r) => [key(r.repository, r.number), r]))
  const repositories = [...new Set([...rows.map((r) => r.repository), ...fromLog])].sort()
  const errors: PullRequestList['errors'] = []
  const pulls: PullRequestSummary[] = []
  await Promise.all(
    repositories.slice(0, 30).map(async (repo) => {
      try {
        const gh = await github(db, scope, repo)
        const list = await call<GhPull[]>(
          gh,
          `${repoPath(repo)}/pulls?state=${state}&sort=updated&direction=desc&per_page=50`,
        )
        for (const p of list) {
          const row = byKey.get(key(repo, p.number)) ?? (await adopt(db, repo, p))
          await sync(db, row, p)
          pulls.push(summary(repo, p, row))
        }
        // Closed on GitHub since last seen: no longer open, so the sidebar count drops.
        // Merged or closed is settled when the closed list syncs them.
        if (state === 'open' && list.length < 50) {
          const listed = new Set(list.map((p) => p.number))
          const gone = rows.filter(
            (r) => r.repository === repo && r.state === 'open' && !listed.has(r.number),
          )
          if (gone.length)
            await db.pullRequest.updateMany({
              where: { id: { in: gone.map((r) => r.id) } },
              data: { state: 'closed' },
            })
        }
      } catch (error) {
        errors.push({
          repository: repo,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }),
  )
  pulls.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return { pulls, repositories, errors }
}

/** Pull requests waiting on a person: approved but not set to merge, or stopped. */
export const needsAttention = (db: ScopedDb) =>
  db.pullRequest.count({
    where: {
      state: 'open',
      OR: [
        { reviewStatus: { in: ['stuck', 'changes_requested'] } },
        { reviewStatus: 'approved', autoMerge: false },
      ],
    },
  })

/** Open pull requests, as last seen on GitHub. */
export const openCount = (db: ScopedDb) => db.pullRequest.count({ where: { state: 'open' } })

function checkStatus(status: string, conclusion: string | null): CheckRun['status'] {
  if (status !== 'completed') return 'pending'
  if (conclusion === 'success') return 'success'
  if (conclusion === 'neutral' || conclusion === 'skipped' || conclusion === 'stale')
    return 'neutral'
  return 'failure'
}

/** Check runs and commit statuses on a commit. Without the Checks permission, statuses only. */
async function checksOf(gh: GitHub, repo: string, sha: string): Promise<CheckRun[]> {
  const [runs, statuses] = await Promise.all([
    gh
      .fetch(`${repoPath(repo)}/commits/${sha}/check-runs?per_page=100`)
      .then((r) =>
        json<{
          check_runs: {
            name: string
            status: string
            conclusion: string | null
            html_url: string | null
          }[]
        }>(r),
      )
      .catch(() => ({ check_runs: [] })),
    gh
      .fetch(`${repoPath(repo)}/commits/${sha}/status`)
      .then((r) =>
        json<{ statuses: { context: string; state: string; target_url: string | null }[] }>(r),
      )
      .catch(() => ({ statuses: [] })),
  ])
  return [
    ...runs.check_runs.map((r) => ({
      name: r.name,
      status: checkStatus(r.status, r.conclusion),
      url: r.html_url,
    })),
    ...statuses.statuses.map((s) => ({
      name: s.context,
      status: (s.state === 'success'
        ? 'success'
        : s.state === 'pending'
          ? 'pending'
          : 'failure') as CheckRun['status'],
      url: s.target_url,
    })),
  ]
}

export async function pullDetail(
  db: ScopedDb,
  scope: Scope,
  repo: string,
  number: number,
): Promise<PullRequestDetail> {
  const gh = await github(db, scope, repo)
  const path = `${repoPath(repo)}/pulls/${number}`
  type GhFile = {
    filename: string
    previous_filename?: string
    status: string
    additions: number
    deletions: number
    patch?: string
  }
  const filesPage = (page: number) => call<GhFile[]>(gh, `${path}/files?per_page=100&page=${page}`)
  const [p, files, githubReviews, tracked] = await Promise.all([
    pullOf(gh, repo, number),
    filesPage(1),
    call<
      { user: { login: string } | null; state: string; body: string; submitted_at: string | null }[]
    >(gh, `${path}/reviews?per_page=100`),
    findRow(db, repo, number),
  ])
  for (let page = 2; files.length === (page - 1) * 100 && page <= FILES_MAX / 100; page++)
    files.push(...(await filesPage(page)))
  const [checks, row] = await Promise.all([
    checksOf(gh, repo, p.head.sha),
    tracked ? Promise.resolve(tracked) : adopt(db, repo, p),
  ])
  await sync(db, row ?? undefined, p)
  const reviews = row
    ? await db.pullRequestReview.findMany({
        where: { pullRequestId: row.id },
        include: { teammate: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'asc' },
      })
    : []
  return {
    ...summary(repo, p, row ?? undefined),
    body: p.body ?? null,
    headSha: p.head.sha,
    mergeable: p.mergeable ?? null,
    mergeableState: p.mergeable_state ?? 'unknown',
    additions: p.additions ?? 0,
    deletions: p.deletions ?? 0,
    changedFiles: p.changed_files ?? files.length,
    commits: p.commits ?? 0,
    files: files.map((f): DiffFile => ({
      path: f.filename,
      previousPath: f.previous_filename ?? null,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch ?? null,
    })),
    filesCut: (p.changed_files ?? 0) > files.length,
    checks,
    reviews: reviews.map((r): TeammateReview => ({
      id: r.id,
      teammate: r.teammate,
      verdict: r.verdict,
      body: r.body,
      comments: r.comments as TeammateReview['comments'],
      sha: r.sha,
      round: r.round,
      url: r.url,
      createdAt: r.createdAt.toISOString(),
    })),
    // Teammates' reviews are listed above; on GitHub they are the app's comments.
    githubReviews: githubReviews
      .filter((r) => !r.user?.login.endsWith('[bot]'))
      .map((r) => ({
        author: r.user?.login ?? null,
        state: r.state.toLowerCase(),
        body: r.body,
        at: r.submitted_at,
      })),
  }
}

// ---------------------------------------------------------------------------
// What teammates' connector calls tell Brigade
// ---------------------------------------------------------------------------

/** A teammate opened a pull request, or reviewed one. Called after the GitHub call succeeded. */
export async function notePullRequestCall(
  db: ScopedDb,
  call: {
    sessionId: string
    teammateId: string
    operation: string
    input: Record<string, unknown>
    output: unknown
  },
) {
  const repo = String(call.input.repository).toLowerCase()
  if (call.operation === 'github_create_pull_request') {
    const out = call.output as { number: number; title: string; head: string; base: string }
    const existing = await db.pullRequest.findFirst({
      where: { repository: repo, number: out.number },
    })
    if (existing) return
    await db.pullRequest.create({
      data: {
        repository: repo,
        number: out.number,
        title: out.title,
        headRef: out.head,
        baseRef: out.base,
        sessionId: call.sessionId,
        authorTeammateId: call.teammateId,
      } as never,
    })
    return
  }
  if (call.operation === 'github_review_pull_request') {
    const number = Number(call.input.number)
    const out = call.output as { url: string; sha: string }
    const row =
      (await db.pullRequest.findFirst({ where: { repository: repo, number } })) ??
      (await db.pullRequest.create({
        data: { repository: repo, number, title: `#${number}`, headRef: '', baseRef: '' } as never,
      }))
    await db.pullRequestReview.create({
      data: {
        pullRequestId: row.id,
        teammateId: call.teammateId,
        sessionId: call.sessionId,
        verdict: call.input.verdict as 'approve' | 'request_changes',
        body: String(call.input.body),
        comments: (call.input.comments ?? []) as never,
        sha: out.sha,
        round: row.round,
        url: out.url,
      } as never,
    })
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

type LoopRow = NonNullable<Awaited<ReturnType<ScopedDb['pullRequest']['findFirst']>>>

const ref = (row: { repository: string; number: number }) => `${row.repository}#${row.number}`

const closeTickets = (db: ScopedDb, pullRequestId: string) =>
  db.ticket.updateMany({
    where: { status: 'open', payload: { path: ['pullRequestId'], equals: pullRequestId } },
    data: { status: 'resolved', resolvedAt: new Date() },
  })

/** A ticket for the member who asked for the review, once per reason. */
async function ticketFor(db: ScopedDb, row: LoopRow, note: string) {
  const open = await db.ticket.count({
    where: {
      status: 'open',
      title: `${ref(row)}: ${note}`,
      payload: { path: ['pullRequestId'], equals: row.id },
    },
  })
  if (open) return
  await db.ticket.create({
    data: {
      sessionId: row.sessionId,
      type: 'question',
      title: `${ref(row)}: ${note}`.slice(0, 300),
      payload: {
        pullRequestId: row.id,
        pullRequest: { repository: row.repository, number: row.number },
        ...(row.requestedByMemberId ? { memberId: row.requestedByMemberId } : {}),
      },
    } as never,
  })
}

/** The loop stops here; a person decides what next. */
async function stop(db: ScopedDb, scope: Scope, row: LoopRow, note: string) {
  await db.pullRequest.updateMany({ where: { id: row.id }, data: { reviewStatus: 'stuck', note } })
  await ticketFor(db, row, note)
  await audit({
    ...scope,
    actor: { type: 'system', id: 'brigade' },
    action: 'pull_request.loop_stopped',
    target: { type: 'pull_request', id: row.id },
    data: { repository: row.repository, number: row.number, note },
  })
}

/** Move the loop on only from the state it was read in, so two events never both act. */
async function claim(
  db: ScopedDb,
  row: LoopRow,
  data: Parameters<ScopedDb['pullRequest']['updateMany']>[0]['data'],
) {
  const { count } = await db.pullRequest.updateMany({
    where: { id: row.id, reviewStatus: row.reviewStatus, round: row.round },
    data,
  })
  return count === 1
}

/** Prompt one teammate in the loop's thread. Anything but a sent prompt stops the loop. */
async function nudge(
  db: ScopedDb,
  scope: Scope,
  row: LoopRow,
  teammate: { id: string; name: string },
  text: string,
) {
  try {
    const thread = await loadThread(db, row.sessionId!)
    if (thread.controlledByMemberId)
      return stop(db, scope, row, 'A person took over the thread; ask for a review again after')
    const outcome = await promptThread(db, scope, thread, {
      text,
      memberId: null,
      teammateIds: [teammate.id],
    })
    // paused: a cap ticket holds the prompt and sends it when allowed.
    if (outcome === 'offline')
      await stop(db, scope, row, `Could not reach ${teammate.name}: the computer is offline`)
  } catch (error) {
    await stop(
      db,
      scope,
      row,
      `Could not prompt ${teammate.name}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function reviewPrompt(
  row: LoopRow,
  p: GhPull,
  author: string | null,
  reviewer: string,
  autoMerge: boolean,
) {
  return [
    `${reviewer}, please review pull request #${p.number} "${p.title}" in ${row.repository} ` +
      `(\`${p.head.ref}\` into \`${p.base.ref}\`)${author ? `, written by ${author}` : ''}: ${p.html_url}`,
    '',
    'Read it with `github_get_pull_request`, and whatever else you need to judge it: the files at the ' +
      'branch with `github_read_file`, or a checkout of the branch to run its tests. Look for bugs, ' +
      'missing tests, security problems and anything that does not do what the description says. ' +
      'Leave out style a formatter would fix.',
    '',
    'Then call `github_review_pull_request` once, with verdict "approve" or "request_changes", a ' +
      'summary, and line comments for specific problems. ' +
      (author
        ? `Brigade sends a request for changes to ${author} and brings its answer back to you. `
        : '') +
      (autoMerge ? 'Approving merges it once GitHub allows it. ' : '') +
      'Do not mention other teammates in your reply.',
  ].join('\n')
}

function fixPrompt(
  row: LoopRow,
  review: { body: string; comments: unknown },
  reviewer: string,
  author: string,
) {
  const comments = (review.comments ?? []) as { path: string; line: number; body: string }[]
  return [
    `${reviewer} asked for changes on pull request #${row.number} in ${row.repository} ` +
      `(round ${row.round} of ${MAX_ROUNDS}):`,
    '',
    review.body,
    ...(comments.length
      ? ['', 'Line comments:', ...comments.map((c) => `- \`${c.path}:${c.line}\`: ${c.body}`)]
      : []),
    '',
    `${author}, make the changes on \`${row.headRef}\`, then commit and push them: the pull request ` +
      'follows the branch. Where you disagree, say why in your reply instead. When you are done, ' +
      `Brigade asks ${reviewer} to look again. Do not mention other teammates in your reply.`,
  ].join('\n')
}

/**
 * A member asks a teammate to review a pull request. It runs in the thread
 * that opened it, so the author keeps its context and fixes what the reviewer
 * finds; a pull request from outside Brigade gets a thread of its own.
 */
export async function requestReview(
  scope: WorkspaceScope,
  repo: string,
  number: number,
  input: { reviewerId: string; autoMerge: boolean },
) {
  const db = scoped(scope)
  const admin = scope.role === 'owner' || scope.role === 'admin'
  if (input.autoMerge && !admin)
    throw new HTTPException(403, {
      message: 'Only an owner or admin can merge, or set it to merge',
    })
  const gh = await github(db, scope, repo)
  const p = await pullOf(gh, repo, number)
  if (stateOf(p) !== 'open')
    throw new HTTPException(409, { message: 'This pull request is closed' })
  const reviewer = await db.teammate.findFirst({
    where: { id: input.reviewerId, archivedAt: null },
  })
  if (!reviewer) throw new HTTPException(404, { message: 'Teammate not found' })
  const access = await teammateGitHub(db, scope, reviewer.id, repo)
  if (!access?.write)
    throw new HTTPException(409, {
      message: access
        ? `${reviewer.name} has read-only access to ${repo}; reviewing posts on GitHub, so it needs read and write.`
        : `${reviewer.name} has no GitHub connection that reaches ${repo}. Grant it one on its page.`,
    })

  let row =
    (await db.pullRequest.findFirst({ where: { repository: repo, number } })) ??
    (await db.pullRequest.create({
      data: {
        repository: repo,
        number,
        title: p.title,
        headRef: p.head.ref,
        baseRef: p.base.ref,
      } as never,
    }))
  if (row.reviewStatus === 'reviewing' || row.reviewStatus === 'fixing')
    throw new HTTPException(409, { message: 'This pull request is already in review' })
  if (row.authorTeammateId === reviewer.id)
    throw new HTTPException(400, {
      message: `${reviewer.name} wrote this pull request. Pick another teammate to review it.`,
    })

  const author = row.authorTeammateId
    ? await db.teammate.findFirst({ where: { id: row.authorTeammateId } })
    : null
  const text = reviewPrompt(row, p, author?.name ?? null, reviewer.name, input.autoMerge)
  const loop = {
    reviewerTeammateId: reviewer.id,
    reviewStatus: 'reviewing' as const,
    autoMerge: input.autoMerge,
    requestedByMemberId: scope.memberId,
    round: 1,
    reviewedSha: null,
    note: null,
    title: p.title,
    headRef: p.head.ref,
    baseRef: p.base.ref,
  }

  if (row.sessionId) {
    const thread = await loadThread(db, row.sessionId)
    if (thread.startedByMemberId !== scope.memberId && !thread.othersMayPrompt)
      throw new HTTPException(403, {
        message:
          "This pull request's thread runs on another member's subscription. They can ask for the review, or let others prompt in the thread.",
      })
    if (thread.controlledByMemberId)
      throw new HTTPException(409, {
        message: 'A person has control of the thread that opened it. Hand it back first.',
      })
    await joinThread(db, thread.id, [reviewer.id])
    await db.pullRequest.updateMany({ where: { id: row.id }, data: loop })
    const outcome = await promptThread(db, scope, await loadThread(db, thread.id), {
      text,
      memberId: scope.memberId,
      teammateIds: [reviewer.id],
    }).catch(async (error: unknown) => {
      await db.pullRequest.updateMany({ where: { id: row.id }, data: { reviewStatus: 'none' } })
      throw error
    })
    if (outcome === 'offline') {
      await db.pullRequest.updateMany({ where: { id: row.id }, data: { reviewStatus: 'none' } })
      throw new HTTPException(409, {
        message: 'The computer of that thread is offline. Start its runner and try again.',
      })
    }
  } else {
    // The workspace computer, or else the member's own machine.
    const computer =
      (await db.computer.findFirst({ where: { kind: 'cloud', status: { not: 'destroyed' } } })) ??
      (await db.computer.findFirst({
        where: { kind: 'member_machine', memberId: scope.memberId },
        orderBy: { updatedAt: 'desc' },
      }))
    if (!computer) throw new HTTPException(409, { message: 'The workspace has no computer' })
    await db.pullRequest.updateMany({ where: { id: row.id }, data: loop })
    const { thread } = await startThread(db, scope, {
      teammate: reviewer,
      computer,
      memberId: scope.memberId,
      title: `Review ${repo}#${number}: ${p.title}`,
      text,
    }).catch(async (error: unknown) => {
      await db.pullRequest.updateMany({ where: { id: row.id }, data: { reviewStatus: 'none' } })
      throw error
    })
    await db.pullRequest.updateMany({ where: { id: row.id }, data: { sessionId: thread.id } })
  }
  await closeTickets(db, row.id)
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'pull_request.review_requested',
    target: { type: 'pull_request', id: row.id },
    data: { repository: repo, number, reviewerId: reviewer.id, autoMerge: input.autoMerge },
  })
  row = (await db.pullRequest.findFirst({ where: { id: row.id } }))!
  return { sessionId: row.sessionId }
}

/** Stop the loop where it is. The thread's teammates finish the turn they are in. */
export async function stopLoop(scope: WorkspaceScope, repo: string, number: number) {
  const db = scoped(scope)
  const row = await db.pullRequest.findFirst({ where: { repository: repo, number } })
  if (!row) throw new HTTPException(404, { message: 'Brigade is not reviewing this pull request' })
  const admin = scope.role === 'owner' || scope.role === 'admin'
  if (!admin && row.requestedByMemberId !== scope.memberId)
    throw new HTTPException(403, {
      message: 'Only the member who asked for the review, or an admin, can stop it',
    })
  await db.pullRequest.updateMany({
    where: { id: row.id },
    data: { reviewStatus: 'none', autoMerge: false, note: null },
  })
  await closeTickets(db, row.id)
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'pull_request.loop_stopped',
    target: { type: 'pull_request', id: row.id },
    data: { repository: repo, number },
  })
}

/** A teammate's turn ended in a thread: if it was its move in a review loop, the loop moves on. */
export async function reviewTurnEnded(scope: Scope, sessionId: string, teammateId: string) {
  const db = scoped(scope)
  const rows = await db.pullRequest.findMany({
    where: { sessionId, state: 'open', reviewStatus: { in: ['reviewing', 'fixing'] } },
  })
  for (const row of rows) {
    try {
      if (row.reviewStatus === 'reviewing' && row.reviewerTeammateId === teammateId)
        await reviewerDone(db, scope, row)
      else if (row.reviewStatus === 'fixing' && row.authorTeammateId === teammateId)
        await authorDone(db, scope, row)
    } catch (error) {
      // Never left waiting on a move nobody makes.
      await stop(
        db,
        scope,
        row,
        `The review could not go on: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

async function reviewerDone(db: ScopedDb, scope: Scope, row: LoopRow) {
  const [review, reviewer, author] = await Promise.all([
    db.pullRequestReview.findFirst({
      where: { pullRequestId: row.id, teammateId: row.reviewerTeammateId, round: row.round },
      orderBy: { createdAt: 'desc' },
    }),
    db.teammate.findFirst({ where: { id: row.reviewerTeammateId! } }),
    row.authorTeammateId ? db.teammate.findFirst({ where: { id: row.authorTeammateId } }) : null,
  ])
  const reviewerName = reviewer?.name ?? 'The reviewer'
  if (!review)
    return stop(db, scope, row, `${reviewerName} finished its turn without submitting a review`)

  if (review.verdict === 'approve') {
    if (
      !(await claim(db, row, {
        reviewStatus: 'approved',
        reviewedSha: review.sha,
        note: row.autoMerge ? 'Merging once GitHub allows it' : null,
      }))
    )
      return
    if (row.autoMerge) void advanceMerge(scope, row.id).catch(console.error)
    return
  }
  if (!author) {
    await claim(db, row, { reviewStatus: 'changes_requested', reviewedSha: review.sha })
    return
  }
  if (row.round >= MAX_ROUNDS)
    return stop(db, scope, row, `Not approved after ${MAX_ROUNDS} rounds of review`)
  if (!(await claim(db, row, { reviewStatus: 'fixing', reviewedSha: review.sha }))) return
  await nudge(db, scope, row, author, fixPrompt(row, review, reviewerName, author.name))
}

async function authorDone(db: ScopedDb, scope: Scope, row: LoopRow) {
  const reviewer = await db.teammate.findFirst({ where: { id: row.reviewerTeammateId! } })
  const author = await db.teammate.findFirst({ where: { id: row.authorTeammateId! } })
  if (!reviewer || reviewer.archivedAt)
    return stop(db, scope, row, 'The reviewing teammate is gone')
  const gh = await github(db, scope, row.repository)
  const p = await pullOf(gh, row.repository, row.number)
  if (stateOf(p) !== 'open') {
    await claim(db, row, { reviewStatus: 'none', state: stateOf(p), note: null })
    return
  }
  if (!(await claim(db, row, { reviewStatus: 'reviewing', round: row.round + 1, note: null })))
    return
  const moved = p.head.sha !== row.reviewedSha
  const text = [
    `${author?.name ?? 'The author'} answered your review of pull request #${row.number} in ` +
      `${row.repository} (round ${row.round + 1} of ${MAX_ROUNDS}). ` +
      (moved && row.reviewedSha
        ? `What changed since you reviewed it: ${p.html_url.replace(/\/pull\/\d+$/, '')}/compare/${row.reviewedSha}...${p.head.sha}`
        : moved
          ? 'It pushed new commits.'
          : 'It pushed no new commits: read its reply.'),
    '',
    `${reviewer.name}, review it again and call \`github_review_pull_request\` once with your verdict. ` +
      'Do not mention other teammates in your reply.',
  ].join('\n')
  await nudge(db, scope, { ...row, round: row.round + 1 }, reviewer, text)
}

/** Back to the author before merging (failed checks, conflicts), or a stop when it cannot. */
async function sendBack(db: ScopedDb, scope: Scope, row: LoopRow, note: string, ask: string) {
  const author = row.authorTeammateId
    ? await db.teammate.findFirst({ where: { id: row.authorTeammateId, archivedAt: null } })
    : null
  if (!author || !row.sessionId || row.round >= MAX_ROUNDS) return stop(db, scope, row, note)
  if (!(await claim(db, row, { reviewStatus: 'fixing', note }))) return
  await nudge(
    db,
    scope,
    row,
    author,
    [
      `Pull request #${row.number} in ${row.repository} was approved, but cannot merge yet: ${note}.`,
      '',
      `${author.name}, ${ask} Push to \`${row.headRef}\`. When you are done, the reviewer looks at ` +
        'what changed. Do not mention other teammates in your reply.',
    ].join('\n'),
  )
}

/** Waiting on GitHub, with a reason for the dashboard. GitHub refusing it also tells a person, once. */
async function waiting(db: ScopedDb, row: LoopRow, note: string, ticket = false) {
  if (row.note !== note) await db.pullRequest.updateMany({ where: { id: row.id }, data: { note } })
  if (ticket) await ticketFor(db, row, note)
}

/**
 * Merge an approved pull request armed to merge, as soon as GitHub allows it.
 * Checked when the approval comes in and every minute after.
 */
async function advanceMerge(scope: Scope, id: string) {
  const db = scoped(scope)
  const row = await db.pullRequest.findFirst({ where: { id } })
  if (!row || row.reviewStatus !== 'approved' || !row.autoMerge || row.state !== 'open') return
  const gh = await github(db, scope, row.repository)
  const p = await pullOf(gh, row.repository, row.number)
  if (stateOf(p) !== 'open') {
    await db.pullRequest.updateMany({
      where: { id: row.id },
      data: { state: stateOf(p), autoMerge: false, note: null },
    })
    return
  }
  if (row.reviewedSha && p.head.sha !== row.reviewedSha) {
    // The base merged into the branch (GitHub's "Update branch") changes nothing reviewed.
    const head = await call<{ parents: { sha: string }[] }>(
      gh,
      `${repoPath(row.repository)}/commits/${p.head.sha}`,
    )
    if (head.parents.length !== 2 || head.parents[0]!.sha !== row.reviewedSha)
      return stop(db, scope, row, 'New commits since the approval: ask for a review again')
    await db.pullRequest.updateMany({ where: { id: row.id }, data: { reviewedSha: p.head.sha } })
  }
  if (p.draft) return waiting(db, row, 'A draft: mark it ready for review on GitHub to merge', true)
  if (p.mergeable == null) return // GitHub is still working it out.
  if (p.mergeable_state === 'dirty')
    return sendBack(
      db,
      scope,
      row,
      `it conflicts with \`${p.base.ref}\``,
      `merge \`${p.base.ref}\` into your branch and resolve the conflicts.`,
    )
  const checks = await checksOf(gh, row.repository, p.head.sha)
  const failed = checks.filter((c) => c.status === 'failure')
  if (failed.length)
    return sendBack(
      db,
      scope,
      row,
      `checks failed (${failed.map((c) => c.name).join(', ')})`,
      `find out why these checks fail and fix it:\n${failed.map((c) => `- ${c.name}${c.url ? `: ${c.url}` : ''}`).join('\n')}\n`,
    )
  const pending = checks.filter((c) => c.status === 'pending')
  if (pending.length)
    return waiting(db, row, `Waiting for checks: ${pending.map((c) => c.name).join(', ')}`)
  if (p.mergeable_state === 'behind') {
    await gh.fetch(`${repoPath(row.repository)}/pulls/${row.number}/update-branch`, {
      method: 'PUT',
      body: JSON.stringify({ expected_head_sha: p.head.sha }),
    })
    return waiting(db, row, `Bringing the branch up to date with \`${p.base.ref}\``)
  }
  if (p.mergeable_state === 'blocked')
    return waiting(
      db,
      row,
      'GitHub requires an approving review or another rule before merging. Approve it on GitHub, or let the Brigade app bypass the rule',
      true,
    )
  const merged = await mergeOnGitHub(gh, row.repository, p, 'squash')
  if ('refused' in merged)
    return waiting(db, row, `GitHub refused the merge: ${merged.refused}`, true)
  await recordMerge(db, scope, row, { type: 'system', id: 'brigade' }, 'squash', {
    requestedBy: row.requestedByMemberId,
  })
}

async function mergeOnGitHub(gh: GitHub, repo: string, p: GhPull, method: MergeMethod) {
  const response = await gh.fetch(`${repoPath(repo)}/pulls/${p.number}/merge`, {
    method: 'PUT',
    body: JSON.stringify({ merge_method: method, sha: p.head.sha }),
  })
  if (response.ok) return { merged: true as const }
  const body = (await response.json().catch(() => ({}))) as { message?: string }
  return { refused: body.message ?? `status ${response.status}` }
}

async function recordMerge(
  db: ScopedDb,
  scope: Scope,
  row: { id: string; repository: string; number: number },
  actor: Actor,
  method: MergeMethod,
  data: Record<string, unknown> = {},
) {
  await db.pullRequest.updateMany({
    where: { id: row.id },
    data: { state: 'merged', mergedAt: new Date(), autoMerge: false, note: null },
  })
  await closeTickets(db, row.id)
  await audit({
    ...scope,
    actor,
    action: 'pull_request.merged',
    target: { type: 'pull_request', id: row.id },
    data: { repository: row.repository, number: row.number, method, ...data } as never,
  })
}

/** An owner or admin merges now. */
export async function mergeNow(
  scope: WorkspaceScope,
  repo: string,
  number: number,
  method: MergeMethod,
) {
  const db = scoped(scope)
  if (scope.role !== 'owner' && scope.role !== 'admin')
    throw new HTTPException(403, { message: 'Only an owner or admin can merge' })
  const gh = await github(db, scope, repo)
  const p = await pullOf(gh, repo, number)
  if (stateOf(p) !== 'open')
    throw new HTTPException(409, { message: 'This pull request is closed' })
  const merged = await mergeOnGitHub(gh, repo, p, method)
  if ('refused' in merged)
    throw new HTTPException(409, { message: `GitHub refused the merge: ${merged.refused}` })
  const row =
    (await db.pullRequest.findFirst({ where: { repository: repo, number } })) ??
    (await db.pullRequest.create({
      data: {
        repository: repo,
        number,
        title: p.title,
        headRef: p.head.ref,
        baseRef: p.base.ref,
      } as never,
    }))
  await recordMerge(db, scope, row, { type: 'member', id: scope.memberId }, method)
}

let watching = false

/** Every minute: merge approved pull requests that are armed to, once GitHub allows it. */
export function watchMerges() {
  setInterval(() => {
    if (watching) return
    watching = true
    void (async () => {
      const rows = await prisma.pullRequest.findMany({
        where: { reviewStatus: 'approved', autoMerge: true, state: 'open' },
        select: { id: true, organizationId: true, workspaceId: true },
      })
      for (const r of rows)
        await advanceMerge(
          { organizationId: r.organizationId, workspaceId: r.workspaceId },
          r.id,
        ).catch((error) => console.warn(`merge check for ${r.id} failed: ${String(error)}`))
    })()
      .catch(console.error)
      .finally(() => (watching = false))
  }, 60_000).unref()
}
