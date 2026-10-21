'use client'
// Where a pull request stands, in one badge: GitHub's state, a merge Brigade is making, then its review.
import Link from 'next/link'
import { StatusBadge, type StatusTone } from '@/components/status-badge'
import type { PullRequestSummary } from '@/lib/api'

/** mergeableState, when known (one pull request's state, not a list), shows its conflicts. */
type Pull = PullRequestSummary & { mergeableState?: string }

export function pullStatus(p: Pull): { label: string; tone: StatusTone } {
  if (p.state === 'merged') return { label: 'merged', tone: 'success' }
  if (p.state === 'closed') return { label: 'closed', tone: 'neutral' }
  const t = p.tracking
  switch (t?.mergeStatus) {
    case 'stuck':
      return { label: 'needs you', tone: 'destructive' }
    case 'resolving':
      return { label: 'resolving conflicts', tone: 'progress' }
    case 'merging':
      return { label: 'merging', tone: 'progress' }
  }
  if (p.mergeableState === 'dirty') return { label: 'conflicts', tone: 'destructive' }
  if (p.draft) return { label: 'draft', tone: 'neutral' }
  switch (t?.review?.state) {
    case 'reviewing':
      return { label: 'in review', tone: 'progress' }
    case 'approved':
      return t.review.changed
        ? { label: 'changed since approval', tone: 'warning' }
        : { label: 'approved', tone: 'success' }
    case 'changes_requested':
      return t.review.changed
        ? { label: 'changed since review', tone: 'warning' }
        : { label: 'changes requested', tone: 'warning' }
  }
  return { label: 'open', tone: 'warning' }
}

export function PullStatus({ pull }: { pull: Pull }) {
  const { label, tone } = pullStatus(pull)
  return <StatusBadge status={label} tone={tone} />
}

/** Its review in a line, for under its title: who reviews or reviewed it, or why it got none. */
export function reviewLine(p: { tracking: PullRequestSummary['tracking'] }): string | null {
  const review = p.tracking?.review
  if (!review) return null
  const who = review.state === 'skipped' ? null : (review.reviewer?.name ?? 'A teammate')
  switch (review.state) {
    case 'reviewing':
      return `${who} is reviewing it`
    case 'approved':
      return review.changed ? `Approved by ${who}, before the latest commits` : `Approved by ${who}`
    case 'changes_requested':
      return review.changed
        ? `${who} asked for changes, before the latest commits`
        : `${who} asked for changes`
    case 'skipped':
      return `No review: ${review.reason}`
  }
}

/** The thread its review runs or ran in, when it had one. */
export function reviewThread(p: { tracking: PullRequestSummary['tracking'] }): string | null {
  const review = p.tracking?.review
  return review && review.state !== 'skipped' ? review.threadId : null
}

/** Its review in a line that opens the reviewer's thread, above a card that opens the pull request. */
export function ReviewLink({ pull }: { pull: { tracking: PullRequestSummary['tracking'] } }) {
  const line = reviewLine(pull)
  const thread = reviewThread(pull)
  if (!line) return null
  if (!thread) return <>{line}</>
  return (
    <Link
      href={`/app/threads/${thread}`}
      className="relative z-10 hover:text-foreground hover:underline"
      title="Open the review"
    >
      {line}
    </Link>
  )
}
