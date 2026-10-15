'use client'
// Where a pull request stands, in one badge: GitHub's state, then Brigade's review loop.
import { StatusBadge, type StatusTone } from '@/components/status-badge'
import type { PullRequestSummary } from '@/lib/api'

/** mergeableState, when known (one pull request's state, not a list), shows its conflicts. */
type Pull = PullRequestSummary & { mergeableState?: string }

export function pullStatus(p: Pull): { label: string; tone: StatusTone } {
  if (p.state === 'merged') return { label: 'merged', tone: 'success' }
  if (p.state === 'closed') return { label: 'closed', tone: 'neutral' }
  const t = p.tracking
  switch (t?.reviewStatus) {
    case 'reviewing':
      return {
        label: t.round > 1 ? `in review (round ${t.round})` : 'in review',
        tone: 'progress',
      }
    case 'fixing':
      return { label: `fixing (round ${t.round})`, tone: 'progress' }
    case 'approved':
      return t.autoMerge
        ? { label: 'approved, merging', tone: 'success' }
        : { label: 'ready to merge', tone: 'success' }
    case 'changes_requested':
      return { label: 'changes requested', tone: 'warning' }
    case 'stuck':
      return { label: 'needs you', tone: 'destructive' }
    case 'resolving':
      return { label: 'resolving conflicts', tone: 'progress' }
    case 'merging':
      return { label: 'merging', tone: 'progress' }
  }
  if (p.mergeableState === 'dirty') return { label: 'conflicts', tone: 'destructive' }
  return p.draft ? { label: 'draft', tone: 'neutral' } : { label: 'open', tone: 'warning' }
}

export function PullStatus({ pull }: { pull: Pull }) {
  const { label, tone } = pullStatus(pull)
  return <StatusBadge status={label} tone={tone} />
}
