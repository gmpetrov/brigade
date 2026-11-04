'use client'
// A teammate's suggested merge (`[merge] Merge #158` in its replies), as Brigade's
// own button: shown only while the pull request can merge, to an owner or admin,
// merging it as its card does (usePull). Once merged it goes, and the thread is told.
// While its review holds it (under way, asked for changes, or did not read its latest
// commits), it does not merge from under words that may call it ready: it says why
// instead, opening the review, and the pull request's card merges it, after a word.
import { GitMerge } from 'lucide-react'
import Link from 'next/link'
import { isAdmin, useDashboard } from '@/components/dashboard'
import { usePull } from '@/components/pull-card'
import { PullStatus, reviewThread } from '@/components/pull-status'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import { canMerge, resolving, reviewHold } from '@/lib/merge-method'

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
  const hold = reviewHold(p, number)
  if (hold) {
    const thread = reviewThread(p)
    const why = (
      <>
        <PullStatus pull={p} />
        {hold}
      </>
    )
    return thread ? (
      <Hint label="Open the review">
        <Link
          href={`/app/threads/${thread}`}
          className="flex items-center gap-2 self-center text-sm text-muted-foreground hover:text-foreground"
        >
          {why}
        </Link>
      </Hint>
    ) : (
      <span className="flex items-center gap-2 self-center text-sm text-muted-foreground">
        {why}
      </span>
    )
  }
  return (
    <span className="flex items-center gap-2">
      <Button type="button" size="sm" className="rounded-full" disabled={busy} onClick={merge}>
        <GitMerge />
        {busy ? 'Merging…' : label}
      </Button>
      {error && <span className="text-xs text-destructive-text">{error}</span>}
    </span>
  )
}
