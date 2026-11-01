// Pull requests. GitHub keeps the code and the pull request; Brigade keeps who
// wrote it, its review and where a merge a person asked for stands (PullRequest).
// A review is a child thread of the thread that opened it (src/reviews.ts); its
// verdict (github_review_pull_request) is kept here. A person merges, or asks a
// teammate with write access to (github_merge_pull_request). A pull request that
// conflicts goes back to the teammate that wrote it to resolve, and merges once
// that is done. A member who turned Auto-merge on has Brigade merge what teammates open in
// their threads once it is ready (autoMerge).
import { mayWrite } from './account-sharing.js'
import {
  MergeMethod,
  type CheckRun,
  type DiffFile,
  type PullRequestDetail,
  type PullRequestList,
  type PullRequestState,
  type PullRequestSummary,
  type PullRequestTracking,
  type PullReview,
  type TeammateReview,
  resolveConflictsMessage,
  wakesParent,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { personOfThread, trackLater } from './analytics.js'
import { previewStates, stopThreadPreview } from './app-previews.js'
import { audit, type Actor } from './audit.js'
import { reportOf, reportSource } from './children.js'
import { GITHUB_API, githubHeaders, installationToken } from './connectors/github-app.js'
import { ConnectorError, json } from './connectors/types.js'
import { prisma, scoped, Prisma, type Scope, type ScopedDb } from './db.js'
import { linkPullItems, settleItemsOnMerge, type PullItems } from './lists.js'
import { teammateGitHub, workspaceGitHub } from './git.js'
import { projectOfRepository } from './projects.js'
import { REVIEW_DONE, REVIEW_THREAD, reviewUnderWay } from './review-state.js'
import { cancelReview, REVIEW_CLAIM_MS } from './reviews.js'
import type { WorkspaceScope } from './scope.js'
import { settleOnMerge } from './tasks.js'
import { reopenThread, wakeOnMerge } from './thread-done.js'
import { noteInThread, pullNote } from './thread-notes.js'
import { loadThread } from './thread-spec.js'
import { wakeupMessageId } from './wakeups.js'
import { promptThread, startThread } from './work.js'

/** The author's turns at resolving a merge's conflicts or failed checks before it stops and asks a person. */
const MAX_ROUNDS = 3
/** Diffs shown per pull request; GitHub lists at most 3000 files. */
const FILES_MAX = 300

export type GhPull = {
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
  /** False when GitHub cannot replay the branch's commits on its base (a merge that resolved conflicts). */
  rebaseable?: boolean | null
  additions?: number
  deletions?: number
  changed_files?: number
  commits?: number
}

export type GitHub = { fetch: (path: string, init?: RequestInit) => Promise<Response> }

export const repoPath = (repo: string) =>
  `/repos/${repo.split('/').map(encodeURIComponent).join('/')}`
const key = (repo: string, number: number) => `${repo}#${number}`

/** The workspace's GitHub, for a repository one of its connections reaches. */
export async function github(db: ScopedDb, scope: Scope, repo: string): Promise<GitHub> {
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

export const pullOf = (gh: GitHub, repo: string, number: number) =>
  call<GhPull>(gh, `${repoPath(repo)}/pulls/${number}`)

export const stateOf = (p: GhPull) => (p.merged_at ? 'merged' : p.state)

/** Brigade's row for a pull request, made when it has none yet (one opened outside Brigade). */
export async function trackedRow(db: ScopedDb, repo: string, p: GhPull) {
  const where = { repository: repo, number: p.number }
  const found = await db.pullRequest.findFirst({ where })
  if (found) return found
  try {
    return await db.pullRequest.create({
      data: { ...where, title: p.title, headRef: p.head.ref, baseRef: p.base.ref } as never,
    })
  } catch (error) {
    // Made by another request meanwhile: that one.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'))
      throw error
    return db.pullRequest.findFirstOrThrow({ where })
  }
}

// ---------------------------------------------------------------------------
// What the dashboard reads
// ---------------------------------------------------------------------------

/** What a pull request's review reads: its thread, its latest verdict and why it got none. */
export const reviewInclude = {
  reviewSession: { select: REVIEW_THREAD },
  reviews: {
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: {
      verdict: true,
      sha: true,
      sessionId: true,
      createdAt: true,
      teammate: { select: { id: true, name: true } },
    },
  },
} as const

type ReviewRow = Prisma.PullRequestGetPayload<{ include: typeof reviewInclude }>

/**
 * Its review as the dashboard shows it: under way, its latest verdict, or why the teammate
 * that opened it asked for none. headSha, when GitHub was asked: whether commits came after.
 */
export function reviewOf(
  row: Pick<ReviewRow, 'reviewSession' | 'reviews' | 'noReviewReason'>,
  headSha?: string,
): PullReview | null {
  const thread = row.reviewSession
  if (thread && reviewUnderWay(thread))
    return { state: 'reviewing', reviewer: thread.teammate, threadId: thread.id }
  const last = row.reviews[0]
  if (last)
    return {
      state: last.verdict === 'approve' ? 'approved' : 'changes_requested',
      reviewer: last.teammate,
      threadId: last.sessionId,
      at: last.createdAt.toISOString(),
      ...(headSha ? { changed: last.sha !== headSha } : {}),
    }
  return row.noReviewReason ? { state: 'skipped', reason: row.noReviewReason } : null
}

const rowInclude = {
  authorTeammate: { select: { id: true, name: true } },
  ...reviewInclude,
} as const
type Row = NonNullable<Awaited<ReturnType<typeof findRow>>>

const findRow = (db: ScopedDb, repo: string, number: number) =>
  db.pullRequest.findFirst({ where: { repository: repo, number }, include: rowInclude })

function tracking(row: Row | undefined, headSha?: string): PullRequestTracking | null {
  if (!row) return null
  return {
    mergeStatus: row.mergeStatus,
    autoMerge: row.mergeStatus === 'merging' && row.autoMergeAt !== null,
    note: row.note,
    sessionId: row.sessionId,
    author: row.authorTeammate,
    review: reviewOf(row, headSha),
    preview: null,
  }
}

/** Fill in where each pull request's thread's preview stands. */
async function withPreviews<T extends { tracking: PullRequestTracking | null }>(
  db: ScopedDb,
  pulls: T[],
) {
  const ids = pulls.flatMap((p) => (p.tracking?.sessionId ? [p.tracking.sessionId] : []))
  const states = await previewStates(db, ids)
  for (const p of pulls)
    if (p.tracking?.sessionId) p.tracking.preview = states.get(p.tracking.sessionId) ?? null
  return pulls
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
    tracking: tracking(row, p.head.sha),
  }
}

/** Keep Brigade's copy of what GitHub says in step. A merge can finish its thread's task. */
async function sync(db: ScopedDb, scope: Scope, row: Row | undefined, p: GhPull) {
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
      // A pull request closed on GitHub ends a merge under way.
      ...(closed && row.mergeStatus !== 'none'
        ? { mergeStatus: 'none', autoMergeAt: null, note: null }
        : {}),
    },
  })
  if (closed && row.state !== state && row.sessionId) {
    await settleOnMerge(scope, row.sessionId)
    await stopThreadPreview(db, row.sessionId, `Stopped: the pull request was ${state}`)
    await noteInThread(db, row.sessionId, await pullNote(row, state))
  }
  if (state === 'merged' && row.state !== state) {
    await settleItemsOnMerge(db, scope, row)
    // Its thread's teammate is woken, to declare the thread done or say what remains.
    await wakeOnMerge(scope, row).catch((error) =>
      console.warn(`pull request ${row.id}: its thread not woken: ${String(error)}`),
    )
  }
  // Closed without merging, it needs no verdict. A merged one's review goes on: what it finds
  // after the merge is still worth a follow-up.
  if (state === 'closed' && row.state !== state) await cancelReview(scope, row.id)
}

/**
 * GitHub's pull_request event, for the workspaces tracking that pull request,
 * and for those listing its repository when it is a new open one.
 */
export async function pullRequestEvent(scope: Scope, repo: string, p: GhPull) {
  const db = scoped(scope)
  repo = repo.toLowerCase()
  const row = await findRow(db, repo, p.number)
  if (row) return sync(db, scope, row, p)
  if (await db.pullRequest.findFirst({ where: { repository: repo }, select: { id: true } }))
    await adopt(db, repo, p)
}

/**
 * A pull request Brigade has not seen yet. A teammate's, opened before Brigade
 * tracked them, has its branch in the call log of the thread that opened it.
 * Another open one gets a row of its own, so the sidebar counts what the list shows.
 */
async function adopt(db: ScopedDb, repo: string, p: GhPull): Promise<Row | undefined> {
  const opened = p.head.ref.startsWith('brigade/')
    ? await db.connectionCall.findFirst({
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
    : null
  if (!opened && stateOf(p) !== 'open') return undefined
  await db.pullRequest
    .create({
      data: {
        repository: repo,
        number: p.number,
        title: p.title,
        headRef: p.head.ref,
        baseRef: p.base.ref,
        state: stateOf(p),
        ...(opened ? { sessionId: opened.sessionId, authorTeammateId: opened.teammateId } : {}),
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
          await sync(db, scope, row, p)
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
  return { pulls: await withPreviews(db, pulls), repositories, errors }
}

/**
 * Open pull requests waiting on a person: one a teammate opened (a person merges it), once
 * its review, if it has one under way, is done; or a merge that stopped. The sidebar, Home and
 * Pull requests all count these.
 */
export const waitingOnPerson = {
  state: 'open',
  OR: [
    {
      mergeStatus: 'none',
      sessionId: { not: null },
      OR: [{ reviewSessionId: null }, { reviewSession: { is: REVIEW_DONE } }],
    },
    { mergeStatus: 'stuck' },
  ],
} satisfies Prisma.PullRequestWhereInput

/**
 * A thread status while its teammate is at work, or stopped on an error before it was done:
 * its pull requests wait once it stops.
 */
const AT_WORK: Prisma.SessionWhereInput['status'] = { in: ['starting', 'running', 'failed'] }

/**
 * Waiting on a person now: not while the thread that opened it is still at work on
 * it (or failed at it), as in the sidebar and on Tasks, nor once that thread is archived. Home lists
 * these; notifications push and count them.
 */
export const waitingNow = {
  AND: [
    waitingOnPerson,
    { OR: [{ sessionId: null }, { session: { archivedAt: null, NOT: { status: AT_WORK } } }] },
  ],
} satisfies Prisma.PullRequestWhereInput

/**
 * Those waiting on a person now, newest first, with the thread that opened each and where its
 * review stands. `putAway`: threads the member put away for later (src/later.ts), whose pull
 * requests and their children's are left out. `startedBy`: only those of threads this member
 * started, for a member who may not merge (owners and admins see them all).
 */
export async function needsAttention(
  db: ScopedDb,
  putAway: string[] = [],
  options: { startedBy?: string } = {},
) {
  const where: Prisma.PullRequestWhereInput[] = [waitingNow]
  if (putAway.length)
    where.push({
      OR: [
        { sessionId: null },
        {
          sessionId: { notIn: putAway },
          session: { OR: [{ parentId: null }, { parentId: { notIn: putAway } }] },
        },
      ],
    })
  if (options.startedBy) where.push({ session: { startedByMemberId: options.startedBy } })
  const rows = await db.pullRequest.findMany({
    where: { AND: where },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    select: {
      repository: true,
      number: true,
      title: true,
      mergeStatus: true,
      noReviewReason: true,
      updatedAt: true,
      session: { select: { id: true, title: true } },
      authorTeammate: { select: { id: true, name: true } },
      ...reviewInclude,
    },
  })
  return rows.map(({ reviewSession, reviews, noReviewReason, ...row }) => ({
    ...row,
    review: reviewOf({ reviewSession, reviews, noReviewReason }),
  }))
}

/** Open pull requests, as last seen on GitHub. */
export const openCount = (db: ScopedDb) => db.pullRequest.count({ where: { state: 'open' } })

function checkStatus(status: string, conclusion: string | null): CheckRun['status'] {
  if (status !== 'completed') return 'pending'
  if (conclusion === 'success') return 'success'
  if (conclusion === 'neutral' || conclusion === 'skipped' || conclusion === 'stale')
    return 'neutral'
  return 'failure'
}

/** GitHub's answer to an app without a permission, such as reading check runs. */
const NO_PERMISSION = /^403: Resource not accessible by integration/

/**
 * Check runs and commit statuses on a commit. Without the Checks permission, statuses only.
 * strict: GitHub failing to say throws, a missing Checks permission too, rather than reading as
 * no checks: an auto-merge must never take checks it cannot see for checks that passed.
 */
export async function checksOf(
  gh: GitHub,
  repo: string,
  sha: string,
  options: { strict?: boolean } = {},
): Promise<CheckRun[]> {
  const lenient =
    <T>(empty: T) =>
    (error: unknown): T => {
      if (options.strict) throw error
      return empty
    }
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
      .catch(lenient({ check_runs: [] })),
    gh
      .fetch(`${repoPath(repo)}/commits/${sha}/status`)
      .then((r) =>
        json<{ statuses: { context: string; state: string; target_url: string | null }[] }>(r),
      )
      .catch(lenient({ statuses: [] })),
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

/**
 * One pull request's state, one GitHub call: what its card in a thread shows.
 * With `checks`, an open one's checks too (two more calls), for its row in a thread's outputs.
 */
export async function pullState(
  db: ScopedDb,
  scope: Scope,
  repo: string,
  number: number,
  options: { checks?: boolean } = {},
): Promise<PullRequestState> {
  const gh = await github(db, scope, repo)
  const [p, row] = await Promise.all([pullOf(gh, repo, number), findRow(db, repo, number)])
  const [checks] = await Promise.all([
    options.checks && stateOf(p) === 'open' ? checksOf(gh, repo, p.head.sha) : [],
    sync(db, scope, row ?? undefined, p),
  ])
  return {
    ...summary(repo, p, row ?? undefined),
    mergeable: p.mergeable ?? null,
    mergeableState: p.mergeable_state ?? 'unknown',
    mergedAt: p.merged_at,
    checks,
  }
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
  await sync(db, scope, row ?? undefined, p)
  const reviews = row
    ? await db.pullRequestReview.findMany({
        where: { pullRequestId: row.id },
        include: { teammate: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'asc' },
      })
    : []
  const [base] = await withPreviews(db, [summary(repo, p, row ?? undefined)])
  return {
    ...base!,
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

/** A teammate opened, reviewed or merged a pull request. Called after the GitHub call succeeded. */
export async function notePullRequestCall(
  db: ScopedDb,
  scope: Scope,
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
    // Product analytics: a teammate opened it, in the thread of the member it works for.
    trackLater(personOfThread(call.sessionId), 'pull_request_opened', scope, {
      feature: 'pull_requests',
      by: 'teammate',
    })
    // GitHub's webhook may have recorded it first, without its thread.
    if (existing) {
      if (!existing.sessionId && !existing.authorTeammateId) {
        const { count } = await db.pullRequest.updateMany({
          where: { id: existing.id, sessionId: null },
          data: { sessionId: call.sessionId, authorTeammateId: call.teammateId },
        })
        // Open in the thread now, as one made here would be: it is no longer done.
        if (count && existing.state === 'open') await reopenThread(scope, call.sessionId)
      }
    }
    const row =
      existing ??
      (await db.pullRequest.create({
        data: {
          repository: repo,
          number: out.number,
          title: out.title,
          headRef: out.head,
          baseRef: out.base,
          sessionId: call.sessionId,
          authorTeammateId: call.teammateId,
        } as never,
      }))
    // The list items it finishes, or works on (docs/lists.md).
    const items = call.input.items as PullItems | undefined
    if (items)
      await linkPullItems(db, row.id, call.sessionId, call.teammateId, items).catch((error) =>
        console.warn(`lists: items of pull request ${row.id} not kept: ${String(error)}`),
      )
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
        round: (await db.pullRequestReview.count({ where: { pullRequestId: row.id } })) + 1,
        url: out.url,
      } as never,
    })
    return
  }
  if (call.operation === 'github_merge_pull_request') {
    const number = Number(call.input.number)
    const out = call.output as { merged: boolean; method: MergeMethod; sha: string }
    if (!out.merged) return
    const row =
      (await db.pullRequest.findFirst({ where: { repository: repo, number } })) ??
      (await db.pullRequest.create({
        data: { repository: repo, number, title: `#${number}`, headRef: '', baseRef: '' } as never,
      }))
    await recordMerge(db, scope, row, { type: 'teammate', id: call.teammateId }, out.method, {
      sessionId: call.sessionId,
      sha: out.sha,
    })
  }
}

// ---------------------------------------------------------------------------
// A merge a person asked for
// ---------------------------------------------------------------------------

type MergeRow = NonNullable<Awaited<ReturnType<ScopedDb['pullRequest']['findFirst']>>>

const ref = (row: { repository: string; number: number }) => `${row.repository}#${row.number}`

const closeTickets = (db: ScopedDb, pullRequestId: string) =>
  db.ticket.updateMany({
    where: { status: 'open', payload: { path: ['pullRequestId'], equals: pullRequestId } },
    data: { status: 'resolved', resolvedAt: new Date() },
  })

/** A ticket for the member who asked to merge it, once per reason. */
async function ticketFor(db: ScopedDb, row: MergeRow, note: string) {
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

/** The merge stops here; a person decides what next. */
async function stop(db: ScopedDb, scope: Scope, row: MergeRow, note: string) {
  await db.pullRequest.updateMany({
    where: { id: row.id },
    data: { mergeStatus: 'stuck', autoMergeAt: null, note },
  })
  await ticketFor(db, row, note)
  await audit({
    ...scope,
    actor: { type: 'system', id: 'brigade' },
    action: 'pull_request.merge_stopped',
    target: { type: 'pull_request', id: row.id },
    data: { repository: row.repository, number: row.number, note },
  })
}

/** Move the merge on only from the state it was read in, so two events never both act. */
async function claim(
  db: ScopedDb,
  row: MergeRow,
  data: Parameters<ScopedDb['pullRequest']['updateMany']>[0]['data'],
) {
  const { count } = await db.pullRequest.updateMany({
    where: { id: row.id, mergeStatus: row.mergeStatus, round: row.round },
    data,
  })
  return count === 1
}

/** Prompt the author in the pull request's thread. Anything but a sent prompt stops the merge. */
async function nudge(
  db: ScopedDb,
  scope: Scope,
  row: MergeRow,
  teammate: { id: string; name: string },
  text: string,
) {
  try {
    const thread = await loadThread(db, row.sessionId!)
    if (thread.controlledByMemberId)
      return stop(db, scope, row, 'A person took over the thread; ask to merge it again after')
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

function previewPrompt(repo: string, p: GhPull, teammate: string) {
  return [
    `${teammate}, please start a preview of pull request #${p.number} "${p.title}" in ${repo} ` +
      `(branch \`${p.head.ref}\`), so I can try it: ${p.html_url}`,
    '',
    `Check out ${repo} and switch to \`${p.head.ref}\`. Then start it with \`start_preview({ repository: ` +
      `"${repo}" })\` if it has a saved preview; else set one up, check its pages and save it. ` +
      'Do not change the code: if it does not run, say what fails.',
  ].join('\n')
}

/**
 * A member previews a pull request that has no thread (opened outside
 * Brigade): a teammate checks out its branch in a new thread and starts its
 * preview there. That thread becomes the pull request's, as a review's does.
 * A pull request with a thread starts its preview there (threads' preview/start).
 */
export async function previewPull(
  scope: WorkspaceScope,
  repo: string,
  number: number,
  teammateId: string,
) {
  const db = scoped(scope)
  const gh = await github(db, scope, repo)
  const p = await pullOf(gh, repo, number)
  if (stateOf(p) !== 'open')
    throw new HTTPException(409, { message: 'This pull request is closed' })
  const teammate = await db.teammate.findFirst({ where: { id: teammateId, archivedAt: null } })
  if (!teammate) throw new HTTPException(404, { message: 'Teammate not found' })
  if (!(await teammateGitHub(db, scope, teammate.id, repo)))
    throw new HTTPException(409, {
      message: `${teammate.name} has no GitHub connection that reaches ${repo}. Grant it one on its page.`,
    })
  const row = await trackedRow(db, repo, p)
  if (row.sessionId)
    throw new HTTPException(409, { message: 'This pull request has a thread: preview it there' })
  const computer =
    (await db.computer.findFirst({ where: { kind: 'cloud', status: { not: 'destroyed' } } })) ??
    (await db.computer.findFirst({
      where: { kind: 'member_machine', memberId: scope.memberId },
      orderBy: { updatedAt: 'desc' },
    }))
  if (!computer) throw new HTTPException(409, { message: 'The workspace has no computer' })
  const { thread } = await startThread(db, scope, {
    teammate,
    computer,
    memberId: scope.memberId,
    title: `Preview ${repo}#${number}: ${p.title}`,
    text: previewPrompt(repo, p, teammate.name),
    projectId: await projectOfRepository(db, repo),
  })
  await db.pullRequest.updateMany({
    where: { id: row.id, sessionId: null },
    data: { sessionId: thread.id },
  })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'pull_request.preview_requested',
    target: { type: 'pull_request', id: row.id },
    data: { repository: repo, number, teammateId: teammate.id, sessionId: thread.id },
  })
  return { sessionId: thread.id }
}

/** Stop a merge where it is. The author finishes the turn it is in. */
export async function stopMerge(scope: WorkspaceScope, repo: string, number: number) {
  const db = scoped(scope)
  const row = await db.pullRequest.findFirst({ where: { repository: repo, number } })
  if (!row || row.mergeStatus === 'none')
    throw new HTTPException(404, { message: 'Brigade is not merging this pull request' })
  const admin = scope.role === 'owner' || scope.role === 'admin'
  if (!admin && row.requestedByMemberId !== scope.memberId)
    throw new HTTPException(403, {
      message: 'Only the member who asked to merge it, or an admin, can stop it',
    })
  await db.pullRequest.updateMany({
    where: { id: row.id },
    data: { mergeStatus: 'none', autoMergeAt: null, note: null },
  })
  await closeTickets(db, row.id)
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'pull_request.merge_stopped',
    target: { type: 'pull_request', id: row.id },
    data: { repository: repo, number },
  })
}

/** A teammate's turn ended in a thread: if it was resolving a pull request's conflicts there, it merges next. */
export async function resolveTurnEnded(scope: Scope, sessionId: string, teammateId: string) {
  const db = scoped(scope)
  const rows = await db.pullRequest.findMany({
    where: { sessionId, state: 'open', mergeStatus: 'resolving', authorTeammateId: teammateId },
  })
  for (const row of rows) {
    try {
      await resolverDone(db, scope, row)
    } catch (error) {
      // Never left waiting on a move nobody makes.
      await stop(
        db,
        scope,
        row,
        `The merge could not go on: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

/**
 * Back to the author before merging (failed checks, conflicts), or a stop when it cannot:
 * it comes back to merging when the author is done, each time a round.
 */
async function sendBack(
  db: ScopedDb,
  scope: Scope,
  row: MergeRow,
  head: string,
  note: string,
  ask: string,
) {
  const author = row.authorTeammateId
    ? await db.teammate.findFirst({ where: { id: row.authorTeammateId, archivedAt: null } })
    : null
  if (!author || !row.sessionId || row.round >= MAX_ROUNDS) return stop(db, scope, row, note)
  if (
    !(await claim(db, row, {
      mergeStatus: 'resolving',
      round: row.round + 1,
      resolveFromSha: head,
      note,
    }))
  )
    return
  await nudge(
    db,
    scope,
    { ...row, round: row.round + 1 },
    author,
    [
      `Pull request #${row.number} in ${row.repository} was set to merge, but cannot merge yet: ${note}.`,
      '',
      `${author.name}, ${ask} Push to \`${row.headRef}\`. ` +
        'When you are done, Brigade merges it once GitHub allows it. ' +
        'Do not mention other teammates in your reply.',
    ].join('\n'),
  )
}

/** Waiting on GitHub, with a reason for the dashboard. GitHub refusing it also tells a person, once. */
async function waiting(db: ScopedDb, row: MergeRow, note: string, ticket = false) {
  if (row.note !== note) await db.pullRequest.updateMany({ where: { id: row.id }, data: { note } })
  if (ticket) await ticketFor(db, row, note)
}

/**
 * The author's turn to resolve conflicts ended: now it merges, once GitHub allows it.
 * Nothing pushed means it could not, and said why in its reply: a person decides.
 * resolveFromSha holds the head it started from.
 */
async function resolverDone(db: ScopedDb, scope: Scope, row: MergeRow) {
  const gh = await github(db, scope, row.repository)
  const p = await pullOf(gh, row.repository, row.number)
  if (stateOf(p) !== 'open') {
    await claim(db, row, { mergeStatus: 'none', autoMergeAt: null, state: stateOf(p), note: null })
    return
  }
  if (p.head.sha === row.resolveFromSha)
    return stop(
      db,
      scope,
      row,
      'Nothing was pushed to resolve the conflicts: read the reply in the thread',
    )
  if (
    !(await claim(db, row, {
      mergeStatus: 'merging',
      resolveFromSha: p.head.sha,
      note: 'Merging once GitHub allows it',
    }))
  )
    return
  void advanceMerge(scope, row.id).catch(console.error)
}

/**
 * An owner or admin asks the teammate that wrote a conflicting pull request to
 * resolve its conflicts, in the thread that opened it; then it merges by itself.
 */
export async function resolveConflicts(
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
  if (p.mergeable_state !== 'dirty')
    throw new HTTPException(409, { message: 'This pull request has no conflicts' })
  const row = await db.pullRequest.findFirst({ where: { repository: repo, number } })
  const author = row?.authorTeammateId
    ? await db.teammate.findFirst({ where: { id: row.authorTeammateId, archivedAt: null } })
    : null
  if (!row?.sessionId || !author)
    throw new HTTPException(409, {
      message: 'No teammate wrote this pull request. Resolve its conflicts on GitHub.',
    })
  if (row.mergeStatus === 'resolving')
    throw new HTTPException(409, { message: 'A teammate is already working on it' })
  const thread = await loadThread(db, row.sessionId)
  if (!mayWrite(thread, scope))
    throw new HTTPException(403, {
      message: "Only who may write in this pull request's thread can ask.",
    })
  if (thread.controlledByMemberId)
    throw new HTTPException(409, {
      message: 'A person has control of the thread that opened it. Hand it back first.',
    })

  const before = {
    mergeStatus: row.mergeStatus,
    autoMergeAt: row.autoMergeAt,
    mergeMethod: row.mergeMethod,
    requestedByMemberId: row.requestedByMemberId,
    round: row.round,
    resolveFromSha: row.resolveFromSha,
  }
  await db.pullRequest.updateMany({
    where: { id: row.id },
    data: {
      mergeStatus: 'resolving',
      autoMergeAt: null,
      mergeMethod: method,
      requestedByMemberId: scope.memberId,
      round: 1,
      resolveFromSha: p.head.sha,
      note: `${author.name} is resolving the conflicts with \`${p.base.ref}\``,
    },
  })
  const undo = () =>
    db.pullRequest.updateMany({ where: { id: row.id }, data: { ...before, note: row.note } })
  // Brigade's words, not the person's: the thread shows them as a note, and the audit says who asked.
  const outcome = await promptThread(db, scope, thread, {
    text: resolveConflictsMessage({
      number: p.number,
      title: p.title,
      repository: row.repository,
      url: p.html_url,
      base: p.base.ref,
      head: p.head.ref,
      author: author.name,
      method,
    }),
    memberId: null,
    teammateIds: [author.id],
  }).catch(async (error: unknown) => {
    await undo()
    throw error
  })
  if (outcome === 'offline') {
    await undo()
    throw new HTTPException(409, {
      message: 'The computer of that thread is offline. Start its runner and try again.',
    })
  }
  await closeTickets(db, row.id)
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'pull_request.resolve_requested',
    target: { type: 'pull_request', id: row.id },
    data: { repository: repo, number, authorId: author.id, method },
  })
  return { sessionId: row.sessionId }
}

/**
 * Merge a pull request a person asked to merge, or Auto-merge set merging, as soon as GitHub
 * allows it. Checked when it is ready and every minute after. An auto-merge gives up, back to
 * waiting on a person, where a person's merge would send it back to its author or ask them.
 */
async function advanceMerge(scope: Scope, id: string, now = new Date()) {
  const db = scoped(scope)
  const row = await db.pullRequest.findFirst({ where: { id } })
  if (!row || row.state !== 'open' || row.mergeStatus !== 'merging') return
  const auto = row.autoMergeAt !== null
  if (auto) {
    const held = await autoMergeHeld(db, row.id, now)
    if (held) return autoMergeOff(db, scope, row, held)
    if (now.getTime() - row.autoMergeAt!.getTime() > AUTO_MERGE_WAIT_MS)
      return autoMergeOff(db, scope, row, 'GitHub did not allow the merge in time')
  }
  const gh = await github(db, scope, row.repository)
  const p = await pullOf(gh, row.repository, row.number)
  if (stateOf(p) !== 'open') {
    await db.pullRequest.updateMany({
      where: { id: row.id },
      data: { state: stateOf(p), mergeStatus: 'none', autoMergeAt: null, note: null },
    })
    return
  }
  if (auto) {
    // Pushed since it was set merging (by its author, or Brigade bringing it up to date): its
    // review's approval must still be of what merges.
    const held = await autoMergeHeld(db, row.id, now, p.head.sha)
    if (held) return autoMergeOff(db, scope, row, held)
  }
  if (p.draft) {
    if (auto) return autoMergeOff(db, scope, row, 'it is a draft')
    return waiting(db, row, 'A draft: mark it ready for review on GitHub to merge', true)
  }
  if (p.mergeable == null) return // GitHub is still working it out.
  if (auto && p.mergeable_state === 'dirty')
    return autoMergeOff(db, scope, row, `it conflicts with \`${p.base.ref}\``)
  if (p.mergeable_state === 'dirty')
    return sendBack(
      db,
      scope,
      row,
      p.head.sha,
      `it conflicts with \`${p.base.ref}\``,
      `merge \`${p.base.ref}\` into your branch and resolve the conflicts.`,
    )
  // GitHub failing to list them: an auto-merge tries again next minute. The app not allowed to
  // read check runs: it can never tell, and leaves it to a person.
  const checks = await checksOf(gh, row.repository, p.head.sha, { strict: auto }).catch(
    (error: unknown) => {
      if (error instanceof ConnectorError && NO_PERMISSION.test(error.message)) return null
      throw error
    },
  )
  if (!checks) return autoMergeOff(db, scope, row, 'the GitHub app may not read its check runs')
  const failed = checks.filter((c) => c.status === 'failure')
  if (auto && failed.length)
    return autoMergeOff(db, scope, row, `checks failed (${failed.map((c) => c.name).join(', ')})`)
  if (failed.length)
    return sendBack(
      db,
      scope,
      row,
      p.head.sha,
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
  if (auto && p.mergeable_state === 'blocked')
    return autoMergeOff(db, scope, row, 'GitHub requires an approving review or another rule')
  if (p.mergeable_state === 'blocked')
    return waiting(
      db,
      row,
      'GitHub requires an approving review or another rule before merging. Approve it on GitHub, or let the Brigade app bypass the rule',
      true,
    )
  const asked = MergeMethod.safeParse(row.mergeMethod).data ?? 'squash'
  // A branch GitHub cannot rebase, such as one whose conflicts were resolved by merging
  // its base in, still lands as one commit on the base: squashed.
  const method = asked === 'rebase' && p.rebaseable === false ? 'squash' : asked
  const merged = await mergeOnGitHub(gh, row.repository, p, method)
  if ('refused' in merged) {
    if (auto) return autoMergeOff(db, scope, row, `GitHub refused the merge: ${merged.refused}`)
    return waiting(db, row, `GitHub refused the merge: ${merged.refused}`, true)
  }
  await recordMerge(db, scope, row, { type: 'system', id: 'brigade' }, method, {
    requestedBy: row.requestedByMemberId,
    ...(auto ? { auto: true } : {}),
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
  row: {
    id: string
    repository: string
    number: number
    sessionId: string | null
    authorTeammateId?: string | null
  },
  actor: Actor,
  method: MergeMethod,
  data: Record<string, unknown> = {},
) {
  await db.pullRequest.updateMany({
    where: { id: row.id },
    data: {
      state: 'merged',
      mergedAt: new Date(),
      mergeStatus: 'none',
      autoMergeAt: null,
      note: null,
    },
  })
  await closeTickets(db, row.id)
  await audit({
    ...scope,
    actor,
    action: 'pull_request.merged',
    target: { type: 'pull_request', id: row.id },
    data: { repository: row.repository, number: row.number, method, ...data } as never,
  })
  if (row.sessionId) {
    await settleOnMerge(scope, row.sessionId)
    await stopThreadPreview(db, row.sessionId, 'Stopped: the pull request was merged')
    const by = actor.type === 'member' ? actor.id : undefined
    await noteInThread(db, row.sessionId, await pullNote(row, 'merged', by))
  }
  await settleItemsOnMerge(db, scope, row)
  // Its thread's teammate is woken, to declare the thread done or say what remains; not when it
  // merged it itself, in its turn.
  await wakeOnMerge(scope, row).catch((error) =>
    console.warn(`pull request ${row.id}: its thread not woken: ${String(error)}`),
  )
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

/**
 * An owner or admin closes a pull request without merging it, or reopens it.
 * Closing stops a merge or a review under way, as closing it on GitHub does.
 */
export async function setPullState(
  scope: WorkspaceScope,
  repo: string,
  number: number,
  state: 'open' | 'closed',
) {
  const db = scoped(scope)
  if (scope.role !== 'owner' && scope.role !== 'admin')
    throw new HTTPException(403, {
      message: `Only an owner or admin can ${state === 'closed' ? 'close' : 'reopen'} a pull request`,
    })
  const gh = await github(db, scope, repo)
  const before = await pullOf(gh, repo, number)
  if (before.merged_at) throw new HTTPException(409, { message: 'This pull request is merged' })
  if (before.state === state)
    throw new HTTPException(409, { message: `This pull request is already ${state}` })
  const response = await gh.fetch(`${repoPath(repo)}/pulls/${number}`, {
    method: 'PATCH',
    body: JSON.stringify({ state }),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string }
    throw new HTTPException(409, {
      message: `GitHub refused: ${body.message ?? `status ${response.status}`}`,
    })
  }
  const p = (await response.json()) as GhPull
  const row = await findRow(db, repo, number)
  if (!row) return
  await sync(db, scope, row, p)
  if (state === 'closed') await closeTickets(db, row.id)
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: state === 'closed' ? 'pull_request.closed' : 'pull_request.reopened',
    target: { type: 'pull_request', id: row.id },
    data: { repository: repo, number },
  })
}

// ---------------------------------------------------------------------------
// Auto-merge: a member's preference
// ---------------------------------------------------------------------------

/** How long an auto-merge waits on GitHub (checks still running) before it leaves the pull request to a person. */
const AUTO_MERGE_WAIT_MS = 2 * 60 * 60_000
/** A thread's statuses once its teammate is done with it and asks nothing. */
const AT_REST: readonly string[] = ['idle', 'done']

/** What autoMergeHold reads of a pull request. */
const autoInclude = {
  session: {
    select: {
      status: true,
      archivedAt: true,
      controlledByMemberId: true,
      parentId: true,
      awaited: true,
      report: true,
      reportDeliveredAt: true,
      parent: { select: { status: true } },
      startedBy: { select: { id: true, role: true, autoMerge: true } },
    },
  },
  ...reviewInclude,
} as const
/** With whether the thread that started its child thread has yet to read the child's report. */
type AutoRow = Prisma.PullRequestGetPayload<{ include: typeof autoInclude }> & {
  reportUnread: string | null
}

/** A pull request as autoMergeHold reads it. */
async function autoRow(db: ScopedDb, id: string): Promise<AutoRow | null> {
  const row = await db.pullRequest.findFirst({ where: { id }, include: autoInclude })
  return row && { ...row, reportUnread: await reportUnread(db, row) }
}

const UNREAD = 'the thread that started it has not read its report yet'

/**
 * Why a child nobody awaited (a schedule's run) still holds its pull request: the thread that
 * started it has not read its report, nor asked for the review it may ask for. Its report wakes
 * that thread through a wake-up (src/children.ts, kept with reportSource), which goes once the
 * thread can take it, after the child's turn ended; another turn of the thread meanwhile (a hand
 * back, a person's message) did not read it. So it holds until that wake-up fired and a turn ended
 * after its message (wakeupMessageId) showed in the thread. A report not in yet holds too (one made from the child's
 * last message is settled as its turn ends, alongside this check): its delivery wakes the thread,
 * whose turn's end looks again, or, a report that wakes nobody, looks again itself. A wake-up that
 * never went (missed, cancelled) holds nothing more, nor a report delivered before its wake-up
 * kept reportSource.
 */
async function reportUnread(
  db: ScopedDb,
  row: Prisma.PullRequestGetPayload<{ include: typeof autoInclude }>,
): Promise<string | null> {
  const thread = row.session
  if (!thread?.parentId || thread.awaited || !row.sessionId) return null
  const report = reportOf(thread.report)
  if (!report || !thread.reportDeliveredAt)
    return 'its report has not reached the thread that started it'
  if (!wakesParent(report.status)) return null
  const wakeup = await db.wakeup.findFirst({
    where: {
      sessionId: thread.parentId,
      kind: 'report',
      sourceId: reportSource(row.sessionId, thread.reportDeliveredAt),
    },
    select: { id: true, status: true },
  })
  // None: delivered before its wake-up kept reportSource (deliverReport stores both at once), as
  // auto-merge then did not wait for it. Not held, as before.
  if (!wakeup) return null
  if (wakeup.status === 'pending') return UNREAD
  if (wakeup.status !== 'fired') return null
  // Fired: its message is kept for the thread, which shows it, with its id, when its turn comes.
  // By that id, not its text: two reports of the same child can read the same.
  const shown = await db.sessionEvent.findFirst({
    where: {
      sessionId: thread.parentId,
      type: 'message.user',
      data: { path: ['messageId'], equals: wakeupMessageId(wakeup.id) },
    },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  })
  if (!shown) return UNREAD
  const ended = await db.sessionEvent.findFirst({
    where: { sessionId: thread.parentId, type: 'turn.completed', seq: { gt: shown.seq } },
    select: { seq: true },
  })
  return ended ? null : UNREAD
}

/**
 * Why Brigade may not merge it on its own now, as far as Brigade knows; null when it may. Its
 * thread's member turned Auto-merge on and may merge; a teammate opened it in that thread, which
 * is done with nothing asked (a child's, once its report reached the thread that started it, done
 * too: that one decides whether it gets a review; a report that wakes it, a schedule's run's say,
 * once the turn that read it ended: reportUnread); no review of it is starting or under way, and
 * its latest one, if any, approved it. headSha, once GitHub was asked: that approval read it.
 */
export function autoMergeHold(row: AutoRow, now: Date, headSha?: string): string | null {
  const thread = row.session
  if (!thread || !row.authorTeammateId) return 'no teammate opened it in a thread'
  const member = thread.startedBy
  if (!member.autoMerge) return 'Auto-merge is off'
  if (member.role !== 'owner' && member.role !== 'admin') return 'only owners and admins merge'
  if (thread.archivedAt) return 'its thread is archived'
  if (thread.controlledByMemberId) return 'a person has control of its thread'
  if (!AT_REST.includes(thread.status)) return 'its thread is at work or asks something'
  if (thread.parentId) {
    if (thread.awaited && !thread.reportDeliveredAt)
      return 'its report has not reached the thread that started it'
    if (!thread.parent || !AT_REST.includes(thread.parent.status))
      return 'the thread that started it is at work or asks something'
    if (row.reportUnread) return row.reportUnread
  }
  if (row.reviewClaimedAt && now.getTime() - row.reviewClaimedAt.getTime() < REVIEW_CLAIM_MS)
    return 'a review of it is starting'
  const review = reviewOf(row)
  if (review?.state === 'reviewing') return 'a review of it is under way'
  if (review?.state === 'changes_requested') return 'its review asked for changes'
  const last = row.reviews[0]
  if (last && headSha && last.sha !== headSha) return 'commits came after its review approved it'
  return null
}

const autoMergeHeld = async (db: ScopedDb, id: string, now: Date, headSha?: string) => {
  const row = await autoRow(db, id)
  return row ? autoMergeHold(row, now, headSha) : 'it is gone'
}

/** An auto-merge that cannot go on: the pull request waits on a person again, as before it. */
async function autoMergeOff(db: ScopedDb, scope: Scope, row: MergeRow, reason: string) {
  const { count } = await db.pullRequest.updateMany({
    where: { id: row.id, mergeStatus: 'merging', autoMergeAt: { not: null } },
    data: { mergeStatus: 'none', autoMergeAt: null, note: null },
  })
  if (count)
    await audit({
      ...scope,
      actor: { type: 'system', id: 'brigade' },
      action: 'pull_request.auto_merge_stopped',
      target: { type: 'pull_request', id: row.id },
      data: { repository: row.repository, number: row.number, reason },
    })
}

/**
 * Set a pull request merging on its own, for its thread's member's Auto-merge, when it is
 * ready: what Brigade knows holds it nowhere (autoMergeHold), and on GitHub it is open, no
 * draft, without conflicts or a failed check. Then it merges once its checks pass, as a merge a
 * person asked for does. Whether it was set merging.
 */
export async function autoMerge(scope: Scope, id: string, now = new Date()) {
  const db = scoped(scope)
  const row = await autoRow(db, id)
  if (!row || row.state !== 'open' || row.mergeStatus !== 'none') return false
  if (autoMergeHold(row, now)) return false
  const gh = await github(db, scope, row.repository)
  const p = await pullOf(gh, row.repository, row.number)
  if (stateOf(p) !== 'open' || p.draft || p.mergeable_state === 'dirty') return false
  if (autoMergeHold(row, now, p.head.sha)) return false
  const checks = await checksOf(gh, row.repository, p.head.sha, { strict: true })
  if (checks.some((c) => c.status === 'failure')) return false
  const { count } = await db.pullRequest.updateMany({
    where: { id: row.id, state: 'open', mergeStatus: 'none' },
    data: {
      mergeStatus: 'merging',
      autoMergeAt: now,
      requestedByMemberId: row.session!.startedBy.id,
      round: 0,
      note: 'Merging once its checks pass',
    },
  })
  if (!count) return false
  await audit({
    ...scope,
    actor: { type: 'system', id: 'brigade' },
    action: 'pull_request.auto_merge_started',
    target: { type: 'pull_request', id: row.id },
    data: { repository: row.repository, number: row.number, memberId: row.session!.startedBy.id },
  })
  await advanceMerge(scope, row.id, now)
  return true
}

/**
 * A teammate's turn ended in a thread: the pull requests it may have readied for Auto-merge,
 * opened there or in one of its child threads, or reviewed there.
 */
export async function autoMergeTurnEnded(scope: Scope, sessionId: string) {
  const db = scoped(scope)
  const rows = await db.pullRequest.findMany({
    where: {
      state: 'open',
      mergeStatus: 'none',
      authorTeammateId: { not: null },
      OR: [{ sessionId }, { reviewSessionId: sessionId }, { session: { parentId: sessionId } }],
      session: { startedBy: { autoMerge: true } },
    },
    select: { id: true },
    orderBy: { updatedAt: 'desc' },
    take: 20,
  })
  for (const { id } of rows)
    await autoMerge(scope, id).catch((error) =>
      console.warn(`auto-merge of ${id} failed: ${String(error)}`),
    )
}

/** Workspaces with a pull request a person asked to merge, still open (src/jobs.ts). */
export async function dueMerges() {
  const rows = await prisma.pullRequest.findMany({
    where: { state: 'open', mergeStatus: 'merging' },
    distinct: ['workspaceId'],
    select: { workspaceId: true },
  })
  return rows.map((r) => r.workspaceId)
}

/**
 * Every minute, for one workspace or all: merge pull requests a person asked to merge, once
 * GitHub allows it (src/jobs.ts).
 */
export async function advanceMerges(workspaceId?: string) {
  const rows = await prisma.pullRequest.findMany({
    where: { state: 'open', mergeStatus: 'merging', ...(workspaceId ? { workspaceId } : {}) },
    select: { id: true, organizationId: true, workspaceId: true },
  })
  for (const r of rows)
    await advanceMerge(
      { organizationId: r.organizationId, workspaceId: r.workspaceId },
      r.id,
    ).catch((error) => console.warn(`merge check for ${r.id} failed: ${String(error)}`))
}
