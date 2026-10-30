// Pull requests: what the dashboard shows of a repository's pull requests, their
// reviews by a teammate (src/reviews.ts in the API) and a merge a person asked for.
import { z } from 'zod'

/** Where a merge a person asked for stands. */
export const MergeStatus = z.enum([
  'none',
  /** It stopped and a person has a ticket. */
  'stuck',
  /** A person asked to merge it once its conflicts are resolved: the author's turn. */
  'resolving',
  /** A person asked to merge it: it merges once GitHub allows it. */
  'merging',
])
export type MergeStatus = z.infer<typeof MergeStatus>

export const MergeMethod = z.enum(['squash', 'merge', 'rebase'])
export type MergeMethod = z.infer<typeof MergeMethod>

/** A member asks a teammate to review a pull request. */
export const RequestReview = z.object({
  /** Who reviews it; unset: Brigade picks another teammate, on another model when it can. */
  reviewerId: z.string().min(1).optional(),
})
export type RequestReview = z.infer<typeof RequestReview>

type Ref = { id: string; name: string }

/** A pull request's review by a teammate: under way, its latest verdict, or why it got none. */
export type PullReview =
  /** The reviewer is at it, in its thread. */
  | { state: 'reviewing'; reviewer: Ref | null; threadId: string }
  /**
   * Its latest verdict. changed: commits came after the one it looked at (unset where
   * GitHub was not asked, as in Needs you's list).
   */
  | {
      state: 'approved' | 'changes_requested'
      reviewer: Ref | null
      threadId: string | null
      changed?: boolean
      at: string
    }
  /** The teammate that opened it asked for none, and why. */
  | { state: 'skipped'; reason: string }

/** Preview a pull request without a thread: a teammate checks out its branch in a new one and starts it. */
export const PreviewPullRequest = z.object({ teammateId: z.string().min(1) })
export type PreviewPullRequest = z.infer<typeof PreviewPullRequest>

export const MergePullRequest = z.object({ method: MergeMethod.default('squash') })
export type MergePullRequest = z.infer<typeof MergePullRequest>

/** Ask the teammate that wrote it to resolve its conflicts, then merge it. Owners and admins only. */
export const ResolvePullRequest = MergePullRequest
export type ResolvePullRequest = MergePullRequest

/** Brigade's side of a pull request: who wrote it, its review, and a merge a person asked for. */
export type PullRequestTracking = {
  mergeStatus: MergeStatus
  /** Why a merge waits or stopped. */
  note: string | null
  sessionId: string | null
  author: Ref | null
  review: PullReview | null
  /** Its thread's preview, while one starts or runs: ready once its pages passed their check. */
  preview: 'starting' | 'running' | 'ready' | null
}

export type PullRequestSummary = {
  repository: string
  number: number
  title: string
  url: string
  /** GitHub's author login; a teammate's pull request shows the app. */
  author: string | null
  draft: boolean
  state: 'open' | 'closed' | 'merged'
  head: string
  base: string
  updatedAt: string
  tracking: PullRequestTracking | null
}

export type PullRequestList = {
  pulls: PullRequestSummary[]
  /** Repositories it looked in: every one where a teammate opened a pull request. */
  repositories: string[]
  errors: { repository: string; message: string }[]
}

export type DiffFile = {
  path: string
  previousPath: string | null
  status: string
  additions: number
  deletions: number
  /** Unified diff hunks; missing for binary files or diffs GitHub will not show. */
  patch: string | null
}

export type CheckRun = {
  name: string
  status: 'pending' | 'success' | 'failure' | 'neutral'
  url: string | null
}

export type TeammateReview = {
  id: string
  teammate: { id: string; name: string } | null
  verdict: 'approve' | 'request_changes'
  body: string
  comments: { path: string; line: number; body: string }[]
  sha: string
  round: number
  url: string | null
  createdAt: string
}

/** Where one pull request stands, without its diff: for its card in a thread. */
export type PullRequestState = PullRequestSummary & {
  /** null while GitHub is still working it out. */
  mergeable: boolean | null
  /** GitHub's mergeable_state: clean, blocked, behind, dirty, unstable, unknown, draft. */
  mergeableState: string
  mergedAt: string | null
  /** Its head commit's checks, when asked for (`?checks=1`) and it is open; else empty. */
  checks: CheckRun[]
}

export type PullRequestDetail = PullRequestSummary & {
  body: string | null
  headSha: string
  /** null while GitHub is still working it out. */
  mergeable: boolean | null
  /** GitHub's mergeable_state: clean, blocked, behind, dirty, unstable, unknown, draft. */
  mergeableState: string
  additions: number
  deletions: number
  changedFiles: number
  commits: number
  files: DiffFile[]
  /** More files changed than are shown. */
  filesCut: boolean
  checks: CheckRun[]
  reviews: TeammateReview[]
  /** Reviews people left on GitHub. */
  githubReviews: { author: string | null; state: string; body: string; at: string | null }[]
}

/** What a merge asks a pull request's author when it conflicts (src/pull-requests.ts in the API). */
export function resolveConflictsMessage(r: {
  number: number
  title: string
  repository: string
  url: string
  base: string
  head: string
  author: string
  method: MergeMethod
}) {
  return [
    `Pull request #${r.number} "${r.title}" in ${r.repository} conflicts with \`${r.base}\`, ` +
      `and a person asked to merge it once that is resolved: ${r.url}`,
    '',
    `${r.author}, fetch \`${r.base}\` and merge it into \`${r.head}\`. Resolve each conflict so ` +
      `both sides' changes still work, run the typecheck and tests, then commit and push to ` +
      `\`${r.head}\`. Do not rebase or force-push. When you are done, Brigade merges it ` +
      `(${r.method === 'rebase' ? 'rebase, or squashed when GitHub cannot rebase it' : r.method}) once GitHub allows it. If a conflict needs a person to decide, say so in your ` +
      'reply and do not push. Do not mention other teammates in your reply.',
  ].join('\n')
}

const RESOLVE_MESSAGE =
  /^Pull request #(\d+) "(.*)" in (\S+) conflicts with `([^`\n]+)`, and a person asked to merge it once that is resolved: \S+\n\n\S[^\n]*, fetch `/

/** A resolveConflictsMessage read back, for the dashboard's note; null for any other text. */
export function resolveConflictsNote(text: string) {
  const m = RESOLVE_MESSAGE.exec(text)
  return m ? { number: Number(m[1]), title: m[2]!, repository: m[3]!, base: m[4]! } : null
}
