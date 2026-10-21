'use client'
// A teammate's suggested merge (`[merge] Merge #158` in its replies), as Brigade's
// own button: shown only while the pull request can merge, to an owner or admin,
// quieter while its review holds it, and merging it as its card does (usePull). Once
// merged it goes, and the thread is told.
import { GitMerge } from 'lucide-react'
import { isAdmin, useDashboard } from '@/components/dashboard'
import { usePull } from '@/components/pull-card'
import { Button } from '@/components/ui/button'
import { canMerge, resolving, reviewHolds } from '@/lib/merge-method'

export function PullMergeButton({
  repository,
  number,
  label,
}: {
  repository: string
  number: number
  label: string
}) {
  const { me } = useDashboard()
  const { pull, busy, error, merge } = usePull(repository, number)
  const p = pull.data
  if (!p || p.state !== 'open' || !isAdmin(me) || !canMerge(p) || resolving(p)) return null
  return (
    <span className="flex items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant={reviewHolds(p) ? 'outline' : 'default'}
        className="rounded-full"
        disabled={busy}
        onClick={merge}
      >
        <GitMerge />
        {busy ? 'Merging…' : label}
      </Button>
      {error && <span className="text-xs text-destructive-text">{error}</span>}
    </span>
  )
}
