'use client'
// Where a pull request stands, in one badge: GitHub's state, a merge Brigade is making, then its review.
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
      return { label: 'changes requested', tone: 'warning' }
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
      return `${who} asked for changes`
    case 'skipped':
      return `No review: ${review.reason}`
  }
}
