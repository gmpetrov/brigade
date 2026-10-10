'use client'
// Where a pull request stands, in one badge: GitHub's state, then Brigade's review loop.
import { StatusBadge, type StatusTone } from '@/components/status-badge'
import type { PullRequestSummary } from '@/lib/api'

export function pullStatus(p: PullRequestSummary): { label: string; tone: StatusTone } {
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
  }
  return p.draft ? { label: 'draft', tone: 'neutral' } : { label: 'open', tone: 'warning' }
}

export function PullStatus({ pull }: { pull: PullRequestSummary }) {
  const { label, tone } = pullStatus(pull)
  return <StatusBadge status={label} tone={tone} />
}
