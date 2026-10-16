'use client'
// The card for a pull request a teammate opened in a thread: the whole card opens
// its changes, and an owner or admin merges it from here. One that conflicts has
// Resolve conflicts instead: its teammate resolves them, then it merges by itself.
import {
  ExternalLink,
  GitCompareArrows,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
} from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { isAdmin, useDashboard } from '@/components/dashboard'
import { PullStatus } from '@/components/pull-status'
import { Button } from '@/components/ui/button'
import { api, pullHref, useApi, type PullRequestState } from '@/lib/api'
import {
  blockedBecause,
  canMerge,
  hasConflicts,
  resolvesInBrigade,
  resolving,
  useLastMergeMethod,
} from '@/lib/merge-method'
import { cn } from '@/lib/utils'

/** While its conflicts are resolved and it merges, the card follows it. */
const POLL_MS = 10_000

export function PullCard({
  repository,
  number,
  title,
  open,
}: {
  repository: string
  number: number
  title: string | null
  /** Known to be open (Home's waiting ones): Merge shows even when GitHub's state doesn't load. */
  open?: boolean
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
  const following = p?.state === 'open' && resolving(p)
  const reload = pull.reload
  useEffect(() => {
    if (!following) return
    const timer = setInterval(() => void reload(), POLL_MS)
    return () => clearInterval(timer)
  }, [following, reload])

  async function act(run: () => Promise<unknown>) {
    setBusy(true)
    setError(undefined)
    try {
      await run()
      await reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function merge() {
    if (!confirm(`Merge #${number}${p ? ` into ${p.base}` : ''} (${method})?`)) return
    void act(() => api(`${path}/merge`, { body: { method } }))
  }

  function resolve() {
    const author = p?.tracking?.author?.name
    if (
      !p ||
      !confirm(`Ask ${author} to resolve the conflicts with ${p.base}, then merge (${method})?`)
    )
      return
    void act(() => api(`${path}/resolve`, { body: { method } }))
  }

  const action = () => {
    // Its state from GitHub did not load: still merged from here, GitHub says if it can't be.
    if (!p) return open && pull.error && isAdmin(me) ? mergeButton(true) : null
    if (p.state !== 'open' || !isAdmin(me)) return <PullStatus pull={p} />
    if (hasConflicts(p))
      return resolvesInBrigade(p) ? (
        <Button
          size="sm"
          variant="outline"
          className="relative z-10 flex-none"
          disabled={busy}
          onClick={resolve}
          title={`It conflicts with ${p.base}. ${p.tracking?.author?.name} resolves the conflicts, then it merges.`}
        >
          <GitCompareArrows />
          {busy ? 'Asking…' : 'Resolve conflicts'}
        </Button>
      ) : (
        <Button size="sm" variant="outline" className="relative z-10 flex-none" asChild>
          <a href={`${p.url}/conflicts`} target="_blank" rel="noreferrer">
            Resolve on GitHub
            <ExternalLink />
          </a>
        </Button>
      )
    if (resolving(p)) return <PullStatus pull={p} />
    return mergeButton(mergeable, mergeable ? undefined : blockedBecause[p.mergeableState])
  }

  const mergeButton = (enabled: boolean, title?: string) => (
    <Button
      size="sm"
      variant="outline"
      className="relative z-10 flex-none"
      disabled={busy || !enabled}
      onClick={merge}
      title={title}
    >
      <GitMerge />
      {busy ? 'Merging…' : 'Merge'}
    </Button>
  )

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
      {action()}
    </div>
  )
}
