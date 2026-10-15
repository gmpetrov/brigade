'use client'
// The card for a pull request a teammate opened in a thread: the whole card opens
// its changes, and an owner or admin merges it from here.
import { GitMerge, GitPullRequest, GitPullRequestClosed } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { isAdmin, useDashboard } from '@/components/dashboard'
import { PullStatus } from '@/components/pull-status'
import { Button } from '@/components/ui/button'
import { api, pullHref, useApi, type PullRequestState } from '@/lib/api'
import { blockedBecause, canMerge, useLastMergeMethod } from '@/lib/merge-method'
import { cn } from '@/lib/utils'

export function PullCard({
  repository,
  number,
  title,
}: {
  repository: string
  number: number
  title: string | null
}) {
  const { me } = useDashboard()
  const path = `/pulls/${repository}/${number}`
  const pull = useApi<PullRequestState>(`${path}/state`)
  const [method] = useLastMergeMethod()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const p = pull.data
  const Icon =
    p?.state === 'merged' ? GitMerge : p?.state === 'closed' ? GitPullRequestClosed : GitPullRequest
  const mergeable = p ? canMerge(p) : false

  async function merge() {
    if (!p || !confirm(`Merge #${number} into ${p.base} (${method})?`)) return
    setBusy(true)
    setError(undefined)
    try {
      await api(`${path}/merge`, { body: { method } })
      await pull.reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex items-center gap-3 rounded-lg border bg-card px-4 py-3 text-sm hover:bg-secondary/50">
      <Icon
        className={cn(
          'size-5 flex-none',
          p?.state === 'merged'
            ? 'text-primary'
            : p?.state === 'closed'
              ? 'text-muted-foreground'
              : 'text-success',
        )}
        aria-hidden
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <Link
          href={pullHref(repository, number)}
          className="truncate font-semibold after:absolute after:inset-0"
        >
          Opened pull request #{number}
          {title && `: ${title}`}
        </Link>
        <span className="truncate font-mono text-xs text-muted-foreground">{repository}</span>
        {error && <span className="text-xs text-destructive-text">{error}</span>}
      </span>
      {!p && pull.error && (
        <span className="flex-none font-medium text-primary">See the changes</span>
      )}
      {p &&
        (p.state === 'open' && isAdmin(me) ? (
          <Button
            size="sm"
            variant="outline"
            className="relative z-10 flex-none"
            disabled={busy || !mergeable}
            onClick={() => void merge()}
            title={mergeable ? undefined : blockedBecause[p.mergeableState]}
          >
            <GitMerge />
            {busy ? 'Merging…' : 'Merge'}
          </Button>
        ) : (
          <PullStatus pull={p} />
        ))}
    </div>
  )
}
