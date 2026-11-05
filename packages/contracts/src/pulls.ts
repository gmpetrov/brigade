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

/**
 * A member turns Auto-merge on or off (Member.autoMerge): Brigade merges the pull requests
 * teammates open in their threads once no review is under way or asked for and checks passed.
 */
export const SetAutoMerge = z.object({ autoMerge: z.boolean() })

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
   * GitHub was not asked, as in Needs you's list). kept: an approval that still holds for
   * its head, which resolved its conflicts without changing the lines it adds or removes.
   */
  | {
      state: 'approved' | 'changes_requested'
      reviewer: Ref | null
      threadId: string | null
      changed?: boolean
      kept?: boolean
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
  /** Brigade set it merging on its own, for its member's Auto-merge. */
  autoMerge: boolean
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

/**
 * What a merge asks a pull request's author when it conflicts (src/pull-requests.ts in the API):
 * a merge a person asked for (Resolve conflicts), or their Auto-merge's.
 */
export function resolveConflictsMessage(r: {
  number: number
  title: string
  repository: string
  url: string
  base: string
  head: string
  author: string
  method: MergeMethod
  by?: 'person' | 'auto-merge'
}) {
  const asked = r.by === 'auto-merge' ? 'Auto-merge merges it' : 'a person asked to merge it'
  return [
    `Pull request #${r.number} "${r.title}" in ${r.repository} conflicts with \`${r.base}\`, ` +
      `and ${asked} once that is resolved: ${r.url}`,
    '',
    `${r.author}, fetch \`${r.base}\` and merge it into \`${r.head}\`. Resolve each conflict so ` +
      `both sides' changes still work, run the typecheck and tests, then commit and push to ` +
      `\`${r.head}\`. Do not rebase or force-push. When you are done, Brigade merges it ` +
      `(${r.method === 'rebase' ? 'rebase, or squashed when GitHub cannot rebase it' : r.method}) once GitHub allows it; ` +
      `if a review approved it and you do more than bring in \`${r.base}\`'s changes, its reviewer ` +
      'looks at what you pushed first. If a conflict needs a person to decide, say so in your ' +
      'reply and do not push. Do not mention other teammates in your reply.',
  ].join('\n')
}

const RESOLVE_MESSAGE =
  /^Pull request #(\d+) "(.*)" in (\S+) conflicts with `([^`\n]+)`, and (?:a person asked to merge it|Auto-merge merges it) once that is resolved: \S+\n\n\S[^\n]*, fetch `/

/** A resolveConflictsMessage read back, for the dashboard's note; null for any other text. */
export function resolveConflictsNote(text: string) {
  const m = RESOLVE_MESSAGE.exec(text)
  return m ? { number: Number(m[1]), title: m[2]!, repository: m[3]!, base: m[4]! } : null
}

/**
 * What a merge brings to the thread that opened the pull request (apps/api wakeOnMerge). It
 * names no way to declare the thread done: a teammate's instructions give its own (a done
 * block, or complete_thread on a runner from before them).
 */
export const mergedMessage = (pull: { repository: string; number: number }) =>
  `Pull request #${pull.number} in ${pull.repository} was merged. If nothing else remains of what ` +
  'was asked here, declare this thread done (a line on what was delivered); else say in a line ' +
  'what remains.'

const MERGED = /^Pull request #(\d+) in (\S+) was merged(?: by [^\n]+)?\./

/**
 * The pull request a merge's line (its thread note, "… was merged by Ada.") or its wake-up
 * (mergedMessage) tells about; null for any other text.
 */
export function mergedPull(text: string): { repository: string; number: number } | null {
  const m = MERGED.exec(text)
  return m ? { repository: m[2]!, number: Number(m[1]) } : null
}
