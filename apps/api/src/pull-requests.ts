// Pull requests. GitHub keeps the code and the pull request; Brigade keeps who
// wrote it, its review and where a merge a person asked for stands (PullRequest).
// A review is a child thread of the thread that opened it (src/reviews.ts); its
// verdict (github_review_pull_request) is kept here. A person merges, or asks a
// teammate with write access to (github_merge_pull_request). A pull request that
// conflicts goes back to the teammate that wrote it to resolve, and merges once
// that is done: right away when its resolution left what it adds and removes as its
// review approved it, else once its reviewer looked at the resolution (resolverDone).
// A member who turned Auto-merge on has Brigade merge what teammates open in their
// threads once it is ready (autoMerge), resolving its conflicts the same way.
import { createHash } from 'node:crypto'
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
  type PullSpecs,
  type TeammateReview,
  resolveConflictsMessage,
  wakesParent,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { personOfThread, trackLater } from './analytics.js'
import { previewStates, stopThreadPreview } from './app-previews.js'
import { audit, type Actor } from './audit.js'
import { messageChild, reportOf, reportSource } from './children.js'
import { GITHUB_API, githubHeaders, installationToken } from './connectors/github-app.js'
import { ConnectorError, json } from './connectors/types.js'
import { captureError, markTracked } from './error-tracking.js'
import { prisma, scoped, Prisma, type Scope, type ScopedDb } from './db.js'
import { linkPullItems, settleItemsOnMerge, type PullItems } from './lists.js'
import { linkPullSpecs, settleSpecsOnMerge } from './decisions.js'
import { renamedRepository, teammateGitHub, workspaceGitHub } from './git.js'
import { projectOfRepository } from './projects.js'
import { REVIEW_DONE, REVIEW_THREAD, reviewUnderWay } from './review-state.js'
import { cancelReview, REVIEW_CLAIM_MS } from './reviews.js'
import type { WorkspaceScope } from './scope.js'
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
  /** Its repository, under its name now, and its id, which a rename keeps. */
  base: { ref: string; repo?: { id: number; full_name: string } | null }
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

/**
 * The workspace's GitHub, for a repository one of its connections reaches. One known by a name
 * it no longer has (renamed or transferred, Brigade not told) is reached under its name now:
 * paths under the old one are sent to the new one, so that what Brigade kept can be read again.
 */
export async function github(db: ScopedDb, scope: Scope, repo: string): Promise<GitHub> {
  const found = await workspaceGitHub(db, scope, repo)
  const renamed = found ? null : await renamedRepository(db, scope, repo)
  const reached = found ?? renamed
  if (!reached)
    throw new HTTPException(404, {
      message: `No GitHub connection of this workspace reaches ${repo}`,
    })
  const from = repoPath(repo)
  const to = renamed && repoPath(renamed.repository)
  return {
    fetch: async (path, init = {}) =>
      askAgain(init.method, async () =>
        fetch(
          `${GITHUB_API}${to && path.toLowerCase().startsWith(`${from}/`) ? to + path.slice(from.length) : path}`,
          {
            ...init,
            headers: {
              ...githubHeaders,
              authorization: `Bearer ${await installationToken(reached.installationId)}`,
              ...(init.body ? { 'content-type': 'application/json' } : {}),
            },
          },
        ),
      ),
  }
}

/** A GitHub answer that a short outage gives, worth asking again. A 4xx (and 501) never is. */
export const transient = (status: number) => [500, 502, 503, 504].includes(status)

/** The waits before asking GitHub again a read it answered 5xx: two more asks, 2 seconds at most. */
export const RETRY_WAITS_MS = [400, 1_600] as const

/**
 * A GitHub call, asked again after a short wait while GitHub answers 5xx, for a read only (GET,
 * HEAD): a write (a merge, a review) GitHub may have made before failing is never sent twice.
 * The last answer is returned as it is, failed or not.
 */
export async function askAgain(
  method: string | undefined,
  send: () => Promise<Response>,
  waits: readonly number[] = RETRY_WAITS_MS,
) {
  const read = !method || ['GET', 'HEAD'].includes(method.toUpperCase())
  for (let attempt = 0; ; attempt++) {
    const response = await send()
    if (!transient(response.status)) githubAnswered()
    if (!read || !transient(response.status) || attempt >= waits.length) return response
    await response.body?.cancel().catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, waits[attempt]))
  }
}

/** A run of 5xx answers from GitHub shorter than this is not reported: a blip, asked again. */
export const OUTAGE_REPORT_MS = 60_000
/** After an outage is reported, no other is for this long: one that comes and goes is one report. */
export const OUTAGE_GAP_MS = 10 * 60_000

/**
 * GitHub's current run of 5xx answers (one for the whole API: GitHub's outage is everyone's):
 * ended by any other answer of GitHub's, or by a minute without one; and when one was last reported.
 */
let outage: { since: number; last: number; reported: boolean } | null = null
let reportedAt: number | null = null

/**
 * Whether a 5xx GitHub still answered after being asked again is to be reported now: once 5xx
 * answers have gone on for OUTAGE_REPORT_MS with no other answer between them; once per run, and
 * not for another run within OUTAGE_GAP_MS of a report; never for a blip shorter than a minute.
 */
export function reportOutage(now = Date.now()) {
  if (!outage || now - outage.last > OUTAGE_REPORT_MS)
    outage = { since: now, last: now, reported: false }
  outage.last = now
  if (outage.reported || now - outage.since < OUTAGE_REPORT_MS) return false
  outage.reported = true
  if (reportedAt !== null && now - reportedAt < OUTAGE_GAP_MS) return false
  reportedAt = now
  return true
}

/** GitHub answered other than a 5xx: the run of 5xx under way, if any, has ended. */
export const githubAnswered = () => void (outage = null)

/** For tests: forget the outage under way and the last report. */
export const forgetOutage = () => void ((outage = null), (reportedAt = null))

/**
 * The name Brigade keeps a repository's pull requests under, for a name someone gives (a card
 * or a teammate's call written before a rename): that name while rows are kept under it; else
 * the name GitHub answers for it now, asked each time rather than from the installations'
 * cached lists, which may still have the old name.
 */
export async function canonicalRepository(db: ScopedDb, scope: Scope, repo: string) {
  repo = repo.toLowerCase()
  if (await db.pullRequest.findFirst({ where: { repository: repo }, select: { id: true } }))
    return repo
  return (await renamedRepository(db, scope, repo).catch(() => null))?.repository ?? repo
}

async function call<T>(gh: GitHub, path: string, init?: RequestInit) {
  try {
    return await json<T>(await gh.fetch(path, init))
  } catch (error) {
    if (!(error instanceof ConnectorError)) throw error
    const failure = new HTTPException(502, { message: `GitHub: ${error.message}` })
    if (!error.status || !transient(error.status)) throw failure
    // GitHub down: the request fails, and the outage is reported once, not each request it failed.
    if (reportOutage())
      captureError(
        new Error(
          `GitHub has answered 5xx for over ${OUTAGE_REPORT_MS / 1000} seconds: ${error.message}`,
        ),
        { kind: 'github:outage', handled: true },
      )
    throw markTracked(failure)
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
 * Whether a verdict holds for this head: the commit it read, or, for an approval, a head the
 * author pushed to resolve its conflicts that left what it adds and removes as the approval read
 * it (approvalCarriedTo, resolverDone).
 */
export const holdsFor = (
  verdict: { verdict: string; sha: string },
  carriedTo: string | null | undefined,
  headSha: string,
) => verdict.sha === headSha || (verdict.verdict === 'approve' && carriedTo === headSha)

/**
 * Its review as the dashboard shows it: under way, its latest verdict, or why the teammate
 * that opened it asked for none. headSha, when GitHub was asked: whether commits came after.
 */
export function reviewOf(
  row: Pick<ReviewRow, 'reviewSession' | 'reviews' | 'noReviewReason'> & {
    approvalCarriedTo?: string | null
  },
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
      ...(headSha
        ? {
            changed: !holdsFor(last, row.approvalCarriedTo, headSha),
            ...(last.sha !== headSha && holdsFor(last, row.approvalCarriedTo, headSha)
              ? { kept: true }
              : {}),
          }
        : {}),
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
  // Its repository renamed or transferred: what Brigade kept under the old name follows it.
  const repo = p.base.repo
  // Another repository has its name now (a new one where it was renamed from): not this one.
  if (repo && row.repositoryId && row.repositoryId !== String(repo.id)) return
  if (
    repo &&
    (row.repository !== repo.full_name.toLowerCase() || row.repositoryId !== String(repo.id))
  )
    row = { ...row, ...(await renameRepository(db, row, repo)) }
  const state = stateOf(p)
  if (
    row.title === p.title &&
    row.state === state &&
    row.headRef === p.head.ref &&
    row.baseRef === p.base.ref
  )
    return
  const closed = state !== 'open'
  // Only the write that moves it to its new state tells its thread: a merge from Brigade
  // (recordMerge), GitHub's webhook and a card's reload can all see it open at once.
  const moved =
    row.state !== state &&
    (
      await db.pullRequest.updateMany({
        where: { id: row.id, state: { not: state } },
        data: { state },
      })
    ).count > 0
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
  if (closed && moved && row.sessionId) {
    await stopThreadPreview(db, row.sessionId, `Stopped: the pull request was ${state}`)
    await noteInThread(db, row.sessionId, await pullNote(row, state))
  }
  if (state === 'merged' && moved) {
    await settleItemsOnMerge(db, scope, row)
    await settleSpecsOnMerge(db, scope, row)
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
 * A repository renamed or transferred on GitHub: the workspace's pull requests kept under its
 * old name take its name now, and its id. One already kept under the new name as well (made
 * there meanwhile) keeps its row, and the old one stays as it is: each is still read from GitHub.
 * The row's repository and id after it.
 */
export async function renameRepository(
  db: ScopedDb,
  row: { id: string; repository: string },
  to: { id: number; full_name: string },
) {
  const repository = to.full_name.toLowerCase()
  const repositoryId = String(to.id)
  // Kept under the old name (but none with another repository's id, made there since), or by
  // the id under another name: the row among them, unless it is another repository's.
  const kept = await db.pullRequest.findMany({
    where: {
      OR: [
        { repository: row.repository, OR: [{ repositoryId: null }, { repositoryId }] },
        { repositoryId },
      ],
    },
    select: { id: true, repository: true },
  })
  let now = row.repository
  for (const other of kept)
    try {
      await db.pullRequest.updateMany({
        where: { id: other.id },
        data: { repository, repositoryId },
      })
      if (other.id === row.id) now = repository
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'))
        throw error
      // Kept under the new name too: this one only learns the id.
      await db.pullRequest.updateMany({ where: { id: other.id }, data: { repositoryId } })
    }
  return { repository: now, repositoryId }
}

/**
 * GitHub's repository event, renamed or transferred: what the workspace kept under the old name
 * takes the new one.
 */
export async function repositoryRenamed(
  scope: Scope,
  from: string,
  to: { id: number; full_name: string },
) {
  const db = scoped(scope)
  const repositoryId = String(to.id)
  const row = await db.pullRequest.findFirst({
    where: {
      OR: [
        { repository: from.toLowerCase(), OR: [{ repositoryId: null }, { repositoryId }] },
        { repositoryId },
      ],
    },
    select: { id: true, repository: true },
  })
  if (row) await renameRepository(db, row, to)
}

/**
 * The thread's pull requests, and its children's, that Brigade still has open: read again on
 * GitHub, so that a merge or close it missed (a repository renamed meanwhile, an event lost) is
 * known before it is refused as still open. Best effort: one GitHub does not answer stays as kept.
 */
export async function refreshOpenPulls(db: ScopedDb, scope: Scope, sessionId: string) {
  const rows = await db.pullRequest.findMany({
    where: { state: 'open', OR: [{ sessionId }, { session: { parentId: sessionId } }] },
    include: rowInclude,
    take: 20,
  })
  await Promise.all(
    rows.map(async (row) => {
      try {
        const gh = await github(db, scope, row.repository)
        await sync(db, scope, row, await pullOf(gh, row.repository, row.number))
      } catch (error) {
        console.warn(`pull request ${row.id}: not read again: ${String(error)}`)
      }
    }),
  )
}

/**
 * GitHub's pull_request event, for the workspaces tracking that pull request,
 * and for those listing its repository when it is a new open one.
 */
export async function pullRequestEvent(scope: Scope, repo: string, p: GhPull) {
  const db = scoped(scope)
  repo = repo.toLowerCase()
  // Under its name, or by its repository's id when that was renamed since (the event has the new name).
  const id = p.base.repo?.id
  const row =
    (await findRow(db, repo, p.number)) ??
    (id === undefined
      ? null
      : await db.pullRequest.findFirst({
          where: { repositoryId: String(id), number: p.number },
          include: rowInclude,
        }))
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
  const repo = await canonicalRepository(db, scope, String(call.input.repository))
  if (call.operation === 'github_create_pull_request') {
    const out = call.output as {
      number: number
      title: string
      head: string
      base: string
      repositoryId?: number
    }
    const repositoryId = out.repositoryId === undefined ? null : String(out.repositoryId)
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
      if (repositoryId && !existing.repositoryId)
        await db.pullRequest.updateMany({ where: { id: existing.id }, data: { repositoryId } })
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
          repositoryId,
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
    // The library's specs and designs it ships, or is part of (src/decisions.ts).
    const specs = call.input.specs as PullSpecs | undefined
    if (specs) {
      const missed = await linkPullSpecs(db, row.id, call.teammateId, specs).catch((error) => {
        console.warn(`decisions: specs of pull request ${row.id} not kept: ${String(error)}`)
        return []
      })
      if (missed.length)
        await noteInThread(
          db,
          call.sessionId,
          `#${out.number} is not linked to these, as they are not files of the library you may ` +
            `change (check the paths: a Markdown file, or a design's folder):\n${missed.map((p) => `- ${p}`).join('\n')}`,
        )
    }
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
 * it comes back to merging when the author is done, each time a round. ask: what it is
 * asked, worded for it by name.
 */
async function sendBack(
  db: ScopedDb,
  scope: Scope,
  row: MergeRow,
  head: string,
  note: string,
  ask: (author: string) => string,
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
  await nudge(db, scope, { ...row, round: row.round + 1 }, author, ask(author.name))
}

/** How Brigade merges it: as asked, squash when nobody said. */
const methodOf = (row: { mergeMethod: string | null }) =>
  MergeMethod.safeParse(row.mergeMethod).data ?? 'squash'

/** The ask of a merge that cannot go on yet, for its author to fix (failed checks). */
const fixAsk =
  (row: MergeRow, note: string, ask: string) =>
  (author: string): string =>
    [
      `Pull request #${row.number} in ${row.repository} was set to merge, but cannot merge yet: ${note}.`,
      '',
      `${author}, ${ask} Push to \`${row.headRef}\`. ` +
        'When you are done, Brigade merges it once GitHub allows it. ' +
        'Do not mention other teammates in your reply.',
    ].join('\n')

/** Waiting on GitHub, with a reason for the dashboard. GitHub refusing it also tells a person, once. */
async function waiting(db: ScopedDb, row: MergeRow, note: string, ticket = false) {
  if (row.note !== note) await db.pullRequest.updateMany({ where: { id: row.id }, data: { note } })
  if (ticket) await ticketFor(db, row, note)
}

/**
 * The author's turn to resolve conflicts (or fix failed checks) ended: now it merges, once
 * GitHub allows it. Nothing pushed means it could not, and said why in its reply: a person
 * decides. resolveFromSha holds the head it started from.
 *
 * A review that approved it must still stand for what merges (approvalAfter): when what the
 * author pushed left the lines the pull request itself adds and removes as the approval read
 * them, the approval holds for the new head (approvalCarriedTo); else its reviewer looks at
 * what was pushed first. A person's merge then waits for that look's verdict (advanceMerge); an
 * auto-merge goes back to waiting on its review, as before it was set merging, and merges once
 * the review approves its head (autoMergeTurnEnded).
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
  const auto = row.autoMergeAt !== null
  const approval = await approvalAfter(db, gh, row, p)
  const checked = (data: Prisma.InputJsonObject) =>
    audit({
      ...scope,
      actor: { type: 'system', id: 'brigade' },
      action: 'pull_request.resolution_checked',
      target: { type: 'pull_request', id: row.id },
      data: { repository: row.repository, number: row.number, head: p.head.sha, ...data },
    })
  if (approval.kind === 'holds') {
    if (
      !(await claim(db, row, {
        mergeStatus: 'merging',
        resolveFromSha: p.head.sha,
        note: 'Merging once GitHub allows it',
        ...(approval.carried ? { approvalCarriedTo: p.head.sha } : {}),
        // An auto-merge's wait on GitHub starts again from here.
        ...(auto ? { autoMergeAt: new Date() } : {}),
      }))
    )
      return
    if (approval.carried) await checked({ approvalKept: true })
    void advanceMerge(scope, row.id).catch(console.error)
    return
  }
  // Its reviewer reads what was pushed first: asked here, unless it is at it already (the
  // author asked it in its turn, or this was asked once already). Asked before the merge moves
  // on, so that a person's merge never finds the look not yet under way.
  if (approval.kind === 'look') {
    const asked = await askLook(db, scope, row, p, approval).catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }))
    if ('error' in asked) {
      // Worded for the author, who would have asked: for a person, why in a few words.
      const looks = /took their (\d+) looks/.exec(asked.error)
      const why = looks ? `its reviews took their ${looks[1]} looks` : asked.error
      return stop(
        db,
        scope,
        row,
        `${approval.reviewer} approved it before what was pushed to merge it, and could not be ` +
          `asked to look at that (${why}): have it reviewed again, or merge it as it is`,
      )
    }
  }
  if (
    !(await claim(
      db,
      row,
      auto
        ? { mergeStatus: 'none', autoMergeAt: null, resolveFromSha: p.head.sha, note: null }
        : {
            mergeStatus: 'merging',
            resolveFromSha: p.head.sha,
            note: `Waiting for ${approval.reviewer}'s review`,
          },
    ))
  )
    return
  await checked({
    approvalKept: false,
    lookAsked: approval.kind === 'look',
    ...(approval.kind === 'look' ? { files: approval.files?.slice(0, 50) ?? null } : {}),
  })
  if (!auto) void advanceMerge(scope, row.id).catch(console.error)
}

/** Where a review that approved a pull request stands after its author pushed to merge it. */
type ApprovalAfter =
  /** Nothing to keep (no review, or one that asked for changes a person merges past), or kept. */
  | { kind: 'holds'; carried: boolean }
  /** A review of it is under way already. */
  | { kind: 'reviewing'; reviewer: string }
  /** Since the approval, more changed than its base brought (in files), or it could not be told (null). */
  | {
      kind: 'look'
      reviewer: string
      /** The thread that approved it, which is asked to look (its latest review's, once gone). */
      threadId: string | null
      approved: string
      files: string[] | null
    }

/**
 * Whether its latest review's approval still stands for its head, now that its author pushed
 * to get it merged: nothing changed since the approval but what its base brought, where its
 * base brought it (changedSinceApproval). GitHub failing to say counts as changed: its reviewer
 * looks.
 */
async function approvalAfter(
  db: ScopedDb,
  gh: GitHub,
  row: MergeRow,
  p: GhPull,
): Promise<ApprovalAfter> {
  const reviewed = await db.pullRequest.findFirst({ where: { id: row.id }, include: reviewInclude })
  const thread = reviewed?.reviewSession
  if (thread && reviewUnderWay(thread)) return { kind: 'reviewing', reviewer: thread.teammate.name }
  const last = reviewed?.reviews[0]
  if (
    !last ||
    last.verdict !== 'approve' ||
    holdsFor(last, reviewed!.approvalCarriedTo, p.head.sha)
  )
    return { kind: 'holds', carried: false }
  const files = await changedSinceApproval(gh, row.repository, p.base.ref, last.sha, p.head.sha, {
    warn: (what, error) => console.warn(`${ref(row)}: ${what} not read: ${String(error)}`),
  })
  if (files?.length === 0) return { kind: 'holds', carried: true }
  return {
    kind: 'look',
    reviewer: last.teammate?.name ?? 'Its reviewer',
    threadId: last.sessionId ?? reviewed!.reviewSessionId,
    approved: last.sha,
    files,
  }
}

/**
 * Where what was pushed to a pull request since an approval (`approved` → `head`) is more than
 * what its base branch (`base`) brought: [] when it is not, so that the approval holds for
 * `head`; the files where it is; null when GitHub cannot tell, which is to be taken as more.
 *
 * Its own lines must be the same (ownChanges, in their order, without their places). Still, none
 * may have moved, nor gone where its base had the same (a guard put back in the wrong function
 * adds and removes the same lines): what changed since the approval must be what its base brought
 * between the commits each head starts from, line for line and in the same places of its base's
 * lines (changesBetween). And its base may not have brought lines where its own go, in an order
 * only a look can judge (ownGaps). GitHub's answers are read one at a time, each kept only as
 * small digests: a compare can be large.
 */
export async function changedSinceApproval(
  gh: GitHub,
  repo: string,
  base: string,
  approved: string,
  head: string,
  options: { warn?: (what: string, error: unknown) => void } = {},
) {
  const read = <T>(what: string, work: () => Promise<T>) =>
    work().catch((error: unknown) => {
      options.warn?.(what, error)
      return null
    })
  const before = await read(`its changes at ${approved}`, () =>
    ownChanges(gh, repo, base, approved),
  )
  const after = await read(`its changes at ${head}`, () => ownChanges(gh, repo, base, head))
  const files = changedFiles(before?.changes ?? null, after?.changes ?? null)
  if (!before || !after || files?.length !== 0) return files
  const [from, to] = [before.mergeBase, after.mergeBase]
  if (!from || !to) return null
  const brought = await read('what its base brought', () =>
    changesBetween(gh, repo, from, to, { crowded: ownGaps(before.hunks) }),
  )
  const since = await read('what changed since its approval', () =>
    changesBetween(gh, repo, approved, head, { own: before.hunks }),
  )
  return changedFiles(brought, since)
}

/** Files GitHub's compare lists at most: past them, what changed is not known whole. */
const COMPARE_FILES_MAX = 300

/** A file a compare lists: its patch, or for one GitHub shows none of (binary, too big), its blob. */
type GhChange = {
  filename: string
  previous_filename?: string
  status: string
  sha?: string | null
  patch?: string
}

/** GitHub's compare of two commits: ahead when the second descends from the first. */
type GhCompare = {
  status?: string
  merge_base_commit?: { sha: string } | null
  files?: GhChange[]
}

/** GitHub's compare of `from` with `to`, from where they meet (three dots). */
const compareOf = (gh: GitHub, repo: string, from: string, to: string) =>
  call<GhCompare>(
    gh,
    `${repoPath(repo)}/compare/${from.split('/').map(encodeURIComponent).join('/')}...` +
      // One commit a page: its files come with the first, whatever their count.
      `${encodeURIComponent(to)}?per_page=1`,
  )

const digest = (text: string) => createHash('sha256').update(text).digest('hex')

/**
 * The lines each file of a compare adds and removes, in their order, one value per file:
 * without the lines around them nor where they are. A file GitHub shows no patch for (binary,
 * too big) counts by its contents, its blob. Null when GitHub cannot list them all: as many
 * files as it lists at most, or one with neither.
 */
function linesOf(files: GhChange[]) {
  if (files.length >= COMPARE_FILES_MAX) return null
  const changes = new Map<string, string>()
  for (const f of files) {
    const what = `${f.status} ${f.previous_filename ?? ''}`
    if (f.patch === undefined) {
      if (!f.sha) return null
      changes.set(f.filename, `${what} blob ${f.sha}`)
      continue
    }
    const lines = f.patch.split('\n')
    const these = (sign: string) => digest(lines.filter((line) => line.startsWith(sign)).join('\n'))
    changes.set(f.filename, `${what} ${these('+')} ${these('-')}`)
  }
  return changes
}

/**
 * A hunk of a file's patch: where it starts in the older file and the newer one, how many lines
 * of each it covers, and its lines (` ` kept, `-` removed, `+` added), or only their kinds.
 */
type Hunk = { from: number; fromLines: number; to: number; toLines: number; lines: string[] }

/** The hunks of a file's patch, as GitHub gives it (unified, without the file's header). */
function hunksOf(patch: string) {
  const hunks: Hunk[] = []
  let old = 0
  let now = 0
  for (const line of patch.split('\n')) {
    const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (head) {
      const [from, fromLines, to, toLines] = [head[1], head[2] ?? '1', head[3], head[4] ?? '1']
      hunks.push({
        from: Number(from),
        fromLines: Number(fromLines),
        to: Number(to),
        toLines: Number(toLines),
        lines: [],
      })
      old = Number(fromLines)
      now = Number(toLines)
      continue
    }
    // What its counts still expect, each line once: not "\ No newline at end of file".
    const kind = line[0] ?? ' '
    if (!hunks.length || (kind === '-' ? !old : kind === '+' ? !now : !old || !now)) continue
    if (!'-+ '.includes(kind)) continue
    if (kind !== '+') old--
    if (kind !== '-') now--
    hunks.at(-1)!.lines.push(kind === ' ' ? ` ${line.slice(1)}` : line)
  }
  return hunks
}

/**
 * Where a line of the newer file of a patch was in the older one: that same line, or after which
 * line of it the patch added it (0: at the top).
 */
function placeIn(hunks: Hunk[], line: number): { line: number } | { after: number } {
  let shift = 0
  for (const hunk of hunks) {
    let old = hunk.fromLines ? hunk.from : hunk.from + 1
    let now = hunk.toLines ? hunk.to : hunk.to + 1
    if (line < now) break
    for (const kind of hunk.lines.map((l) => l[0])) {
      if (kind === '-') {
        old++
        continue
      }
      if (now === line) return kind === '+' ? { after: old - 1 } : { line: old }
      if (kind !== '+') old++
      now++
    }
    shift = now - old
  }
  return { line: line - shift }
}

/**
 * The lines a file's patch removes and adds, each with its place in the older file: the line it
 * removes, or the line it adds after. Given `own`, the patch that made that older file from its
 * base (what a pull request changed there), places are said in its base's lines, and a line of the
 * pull request's own that the patch removes as such: none of what a base brings.
 */
function placedLines(hunks: Hunk[], own?: Hunk[]) {
  const place = (line: number) => {
    if (!own) return { line }
    return placeIn(own, line)
  }
  const placed: string[] = []
  for (const hunk of hunks) {
    let old = hunk.fromLines ? hunk.from : hunk.from + 1
    for (const l of hunk.lines) {
      if (l[0] === '-') {
        const at = place(old++)
        placed.push(`-${'line' in at ? at.line : `own after ${at.after}`} ${l.slice(1)}`)
      } else if (l[0] === '+') {
        const at = old > 1 ? place(old - 1) : { line: 0 }
        placed.push(`+after ${'line' in at ? at.line : at.after} ${l.slice(1)}`)
      } else old++
    }
  }
  return placed
}

/**
 * What a pull request changes at a commit, as its Files changed shows it then (GitHub's compare
 * of its base branch with that commit, from where they meet): for each file, the lines it adds
 * and removes, in their order, without the lines around them nor where they are, which merging
 * its base in moves (linesOf); the commit of its base it starts from; and each file's hunks, by
 * their kinds of lines, to place what changes later in its base's lines (changesBetween).
 */
export async function ownChanges(gh: GitHub, repo: string, base: string, sha: string) {
  const compared = await compareOf(gh, repo, base, sha)
  const files = compared.files ?? []
  return {
    changes: linesOf(files),
    mergeBase: compared.merge_base_commit?.sha ?? null,
    hunks: new Map(
      files.map((f) => [
        f.filename,
        f.patch === undefined
          ? null
          : hunksOf(f.patch).map((h) => ({ ...h, lines: h.lines.map((l) => l[0]!) })),
      ]),
    ),
  }
}

/**
 * After which lines of its base a pull request's own lines go, by file (as its own hunks say):
 * lines its base brought there too sit in an order its resolution chose, before or after its
 * own, which nothing but a look can judge (a deletion before or after its guard).
 */
function ownGaps(own: Map<string, Hunk[] | null>) {
  const gaps = new Map<string, Set<number>>()
  for (const [file, hunks] of own) {
    const after = new Set<number>()
    for (const hunk of hunks ?? []) {
      let old = hunk.fromLines ? hunk.from : hunk.from + 1
      for (const kind of hunk.lines.map((l) => l[0])) {
        if (kind === '+') after.add(old - 1)
        else old++
      }
    }
    gaps.set(file, after)
  }
  return gaps
}

/** What a file is when its base brought lines where the pull request's own go: never the same. */
const CROWDED = 'crowded'

/**
 * The lines each file gains and loses from a commit to a later one, each with its place (as
 * placedLines), in any order: one value per file. `own`: the hunks of the pull request's own
 * changes at `from` (ownChanges), so that places are said in its base's lines, as they are in
 * what its base brought. `crowded`: places of its base where its own lines go (ownGaps); a file
 * that gains lines at one of them is CROWDED. A file GitHub shows no patch for counts by its
 * blob. Null when `to` does not descend from `from` (a branch rewritten), or GitHub cannot show
 * it whole or it cannot be placed.
 */
export async function changesBetween(
  gh: GitHub,
  repo: string,
  from: string,
  to: string,
  options: { own?: Map<string, Hunk[] | null>; crowded?: Map<string, Set<number>> } = {},
) {
  if (from === to) return new Map<string, string>()
  const compared = await compareOf(gh, repo, from, to)
  const files = compared.files ?? []
  if (compared.status !== 'ahead' || files.length >= COMPARE_FILES_MAX) return null
  const changes = new Map<string, string>()
  for (const f of files) {
    const what = `${f.status} ${f.previous_filename ?? ''}`
    if (f.patch === undefined) {
      if (!f.sha) return null
      changes.set(f.filename, `${what} blob ${f.sha}`)
      continue
    }
    const hunks = options.own?.get(f.filename)
    // A file of its own GitHub showed no patch for: where its lines were is not known.
    if (hunks === null) return null
    const placed = placedLines(hunksOf(f.patch), hunks)
    const own = options.crowded?.get(f.filename)
    const crowded = own && placed.some((l) => own.has(Number(/^\+after (\d+) /.exec(l)?.[1])))
    changes.set(f.filename, crowded ? CROWDED : `${what} ${digest(placed.sort().join('\n'))}`)
  }
  return changes
}

/** The files whose lines differ between two reads; null when either is not whole. */
export function changedFiles(a: Map<string, string> | null, b: Map<string, string> | null) {
  if (!a || !b) return null
  return [...new Set([...a.keys(), ...b.keys()])].filter((f) => a.get(f) !== b.get(f)).sort()
}

/** Commits named in a message: short enough to read, long enough for git. */
const short = (sha: string) => sha.slice(0, 10)

/**
 * Ask the reviewer that approved it to look at what its author pushed since, in its review's
 * thread, as the author would (message_thread): its report wakes the author, as a look's does.
 * The pull request's review follows that thread.
 */
async function askLook(
  db: ScopedDb,
  scope: Scope,
  row: MergeRow,
  p: GhPull,
  look: Extract<ApprovalAfter, { kind: 'look' }>,
): Promise<{ ok: true } | { error: string }> {
  const review = look.threadId
    ? await db.session.findFirst({
        where: { id: look.threadId },
        select: { id: true, parentId: true },
      })
    : null
  if (!review?.parentId) return { error: 'its review has no thread to ask' }
  const parent = await loadThread(db, review.parentId)
  const asker =
    parent.teammates.find((t) => t.teammateId === row.authorTeammateId)?.teammate ?? parent.teammate
  const author =
    (row.authorTeammateId &&
      (await db.teammate.findFirst({ where: { id: row.authorTeammateId } }))?.name) ||
    'Its author'
  const fixed = row.note?.startsWith('checks failed')
    ? 'fixed its failing checks'
    : `resolved its conflicts with \`${p.base.ref}\``
  const files = look.files ?? []
  const listed = files.slice(0, 20).map((f) => `\`${f}\``)
  const more = files.length > 20 ? `, and ${files.length - 20} more` : ''
  const since = `since you approved \`${short(look.approved)}\``
  const brought = `what \`${p.base.ref}\` brought`
  const text = [
    `To get #${p.number} merged, ${author} ${fixed}. ` +
      (look.files
        ? `What it pushed ${since} changes more than ${brought}, or puts it among the pull ` +
          `request's own lines in an order to check: in ${listed.join(', ')}${more}.`
        : `Brigade could not tell whether what it pushed ${since} changes more than ${brought}.`),
    `Look at what was pushed (\`git log ${short(look.approved)}..${short(p.head.sha)}\` on a ` +
      'checkout of its branch; `git show --remerge-diff` on a merge commit shows what its ' +
      "resolution did beyond merging). Check that both sides' changes still work together, then " +
      `give a new verdict on its head \`${short(p.head.sha)}\` with \`github_review_pull_request\` ` +
      'and report, as before: Brigade merges it once you approve.',
  ].join('\n\n')
  const told = await messageChild(
    db,
    scope,
    { id: parent.id, title: parent.title },
    { id: asker.id, name: asker.name },
    review.id,
    text,
  )
  if ('error' in told) return told
  if (look.threadId !== (await reviewThreadOf(db, row.id)))
    await db.pullRequest.updateMany({ where: { id: row.id }, data: { reviewSessionId: review.id } })
  return told
}

const reviewThreadOf = async (db: ScopedDb, id: string) =>
  (await db.pullRequest.findFirst({ where: { id }, select: { reviewSessionId: true } }))
    ?.reviewSessionId ?? null

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
 * What its review says of a person's merge now. It waits while a review is under way, such as its
 * reviewer's look at a conflict resolution. Once done, its latest verdict must hold for its head:
 * an approval merges, changes asked for stop it. One that read commits before its head stops it
 * too (pushed since without a look, or a look that ended with no verdict: resolverDone asks one
 * when the author pushed), unless it asked for changes before the person asked to merge, who
 * merges past them, as before; while its thread is at work, it waits instead, for the author may
 * be asking its reviewer to look again at what it just pushed.
 */
async function reviewHold(
  db: ScopedDb,
  id: string,
  headSha: string,
): Promise<{ wait: string } | { stop: string } | null> {
  const row = await db.pullRequest.findFirst({
    where: { id },
    include: { ...reviewInclude, session: { select: { status: true } } },
  })
  const review = row && reviewOf(row, headSha)
  if (!review || review.state === 'skipped') return null
  const who = review.reviewer?.name ?? 'Its reviewer'
  if (review.state === 'reviewing') return { wait: `Waiting for ${who}'s review` }
  if (!review.changed)
    return review.state === 'changes_requested' ? { stop: `${who} asked for changes` } : null
  if (review.state === 'changes_requested') {
    const asked = await mergeAskedAt(db, id)
    if (asked && new Date(review.at) < asked) return null
  }
  if (row.session && ['starting', 'running'].includes(row.session.status))
    return { wait: `Waiting for its thread to finish: commits came after ${who}'s review` }
  return {
    stop: `Commits came after ${who}'s review: have it reviewed again, or merge it as it is`,
  }
}

/** When a person last asked to merge it once its conflicts are resolved (Resolve conflicts). */
const mergeAskedAt = async (db: ScopedDb, id: string) =>
  (
    await db.auditEntry.findFirst({
      where: {
        action: 'pull_request.resolve_requested',
        targetType: 'pull_request',
        targetId: id,
      },
      orderBy: { at: 'desc' },
      select: { at: true },
    })
  )?.at ?? null

/**
 * Merge a pull request a person asked to merge, or Auto-merge set merging, as soon as GitHub
 * allows it. Checked when it is ready and every minute after. Conflicts go back to its author
 * either way; otherwise an auto-merge gives up, back to waiting on a person, where a person's
 * merge would send it back to its author (failed checks) or ask them. A person's merge also
 * goes by its review (reviewHold): it waits for a review under way, such as its reviewer's look
 * at a conflict resolution, and stops when its latest verdict does not hold for its head.
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
  if (p.mergeable_state === 'dirty')
    return sendBack(db, scope, row, p.head.sha, `it conflicts with \`${p.base.ref}\``, (author) =>
      resolveConflictsMessage({
        number: p.number,
        title: p.title,
        repository: row.repository,
        url: p.html_url,
        base: p.base.ref,
        head: p.head.ref,
        author,
        method: methodOf(row),
        by: auto ? 'auto-merge' : 'person',
      }),
    )
  if (!auto) {
    const hold = await reviewHold(db, row.id, p.head.sha)
    if (hold && 'wait' in hold) return waiting(db, row, hold.wait)
    if (hold) return stop(db, scope, row, hold.stop)
  }
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
  if (failed.length) {
    const note = `checks failed (${failed.map((c) => c.name).join(', ')})`
    return sendBack(
      db,
      scope,
      row,
      p.head.sha,
      note,
      fixAsk(
        row,
        note,
        `find out why these checks fail and fix it:\n${failed.map((c) => `- ${c.name}${c.url ? `: ${c.url}` : ''}`).join('\n')}\n`,
      ),
    )
  }
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
  const asked = methodOf(row)
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
  // Its webhook or a reload may have recorded the merge first: then that one told the thread.
  const moved =
    (
      await db.pullRequest.updateMany({
        where: { id: row.id, state: { not: 'merged' } },
        data: { state: 'merged' },
      })
    ).count > 0
  await db.pullRequest.updateMany({
    where: { id: row.id },
    data: { mergedAt: new Date(), mergeStatus: 'none', autoMergeAt: null, note: null },
  })
  await closeTickets(db, row.id)
  await audit({
    ...scope,
    actor,
    action: 'pull_request.merged',
    target: { type: 'pull_request', id: row.id },
    data: { repository: row.repository, number: row.number, method, ...data } as never,
  })
  if (moved && row.sessionId) {
    await stopThreadPreview(db, row.sessionId, 'Stopped: the pull request was merged')
    const by = actor.type === 'member' ? actor.id : undefined
    await noteInThread(db, row.sessionId, await pullNote(row, 'merged', by))
  }
  await settleItemsOnMerge(db, scope, row)
  await settleSpecsOnMerge(db, scope, row)
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
 * its latest one, if any, approved it. headSha, once GitHub was asked: that approval holds for it
 * (holdsFor: it read it, or a conflict resolution kept what it approved).
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
  if (last && headSha && !holdsFor(last, row.approvalCarriedTo, headSha))
    return 'commits came after its review approved it'
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
 * draft, without a failed check. Then it merges once its checks pass, as a merge a person asked
 * for does; one that conflicts goes back to its author to resolve first (advanceMerge). Whether
 * it was set merging.
 */
export async function autoMerge(scope: Scope, id: string, now = new Date()) {
  const db = scoped(scope)
  const row = await autoRow(db, id)
  if (!row || row.state !== 'open' || row.mergeStatus !== 'none') return false
  if (autoMergeHold(row, now)) return false
  const gh = await github(db, scope, row.repository)
  const p = await pullOf(gh, row.repository, row.number)
  if (stateOf(p) !== 'open' || p.draft) return false
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
