// Pull requests: what the dashboard shows of a repository's pull requests, and
// the review loop, where one teammate reviews another's work until it merges.
import { z } from 'zod'

export const ReviewStatus = z.enum([
  'none',
  'reviewing',
  'fixing',
  'approved',
  'changes_requested',
  'stuck',
])
export type ReviewStatus = z.infer<typeof ReviewStatus>

export const MergeMethod = z.enum(['squash', 'merge', 'rebase'])
export type MergeMethod = z.infer<typeof MergeMethod>

export const RequestReview = z.object({
  reviewerId: z.string().min(1),
  /** Merge once the reviewer approves and GitHub allows it. Owners and admins only. */
  autoMerge: z.boolean().default(false),
})
export type RequestReview = z.infer<typeof RequestReview>

export const MergePullRequest = z.object({ method: MergeMethod.default('squash') })
export type MergePullRequest = z.infer<typeof MergePullRequest>

/** Brigade's side of a pull request: who wrote it, and where its review loop stands. */
export type PullRequestTracking = {
  reviewStatus: ReviewStatus
  autoMerge: boolean
  round: number
  maxRounds: number
  note: string | null
  sessionId: string | null
  author: { id: string; name: string } | null
  reviewer: { id: string; name: string } | null
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
