'use client'
// The card for a pull request a teammate opened in a thread: the whole card opens
// its changes, its review line and review badge the reviewer's thread, and an owner or
// admin merges it from here, after a word while its review is under way, asked for
// changes or did not read its latest commits (then Review again has them read). One that
// conflicts has Resolve conflicts instead: its teammate resolves them, then it merges by
// itself. In its thread, its review's child thread shows under it as a line, like a child a
// teammate started. A thread's outputs show the same pull request as a row (thread-outputs).
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
import { PullStatus, ReviewLink, reviewLine, reviewThread } from '@/components/pull-status'
import { ChildLine } from '@/components/thread-children'
import { Button } from '@/components/ui/button'
import { api, pullHref, useApi, type PullRequestState, type ThreadChild } from '@/lib/api'
import {
  blockedBecause,
  canMerge,
  confirmMerge,
  hasConflicts,
  resolvesInBrigade,
  resolving,
  reviewer,
  reviewHolds,
  changesAskedBy,
  unreviewedBy,
  useLastMergeMethod,
} from '@/lib/merge-method'
import { cn } from '@/lib/utils'

/** While it is reviewed, or its conflicts are resolved and it merges, the card follows it. */
const POLL_MS = 10_000

/**
 * A pull request's state from GitHub, and Merge and Resolve conflicts for it.
 * While it is reviewed, or its conflicts are resolved and it merges, it follows it.
 */
export function usePull(repository: string, number: number, options: { checks?: boolean } = {}) {
  const path = `/pulls/${repository}/${number}`
  const pull = useApi<PullRequestState>(`${path}/state${options.checks ? '?checks=1' : ''}`)
  const [method] = useLastMergeMethod()
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string>()

  const p = pull.data
  const following = p?.state === 'open' && (resolving(p) || !!reviewer(p))
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
    if (!confirmMerge(p, number, method)) return
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

  /** Its latest commits are not reviewed: the same reviewer reads it again, in a new review. */
  function reviewAgain() {
    const review = p?.tracking?.review
    const id = review && review.state !== 'skipped' ? review.reviewer?.id : undefined
    setAsking(true)
    void act(() => api(`${path}/review`, { body: id ? { reviewerId: id } : {} })).finally(() =>
      setAsking(false),
    )
  }

  return { pull, busy, asking, error, merge, resolve, reviewAgain }
}

export function PullCard({
  repository,
  number,
  title,
  open,
  mergeElsewhere,
  childThreads = [],
}: {
  repository: string
  number: number
  title: string | null
  /** Known to be open (Home's waiting ones): Merge shows even when GitHub's state doesn't load. */
  open?: boolean
  /** A teammate's merge button under it does the merging: the card shows where it stands instead. */
  mergeElsewhere?: boolean
  /** The thread's children: its review, when it runs in one of them, shows as its line. */
  childThreads?: ThreadChild[]
}) {
  const { me } = useDashboard()
  const { pull, busy, asking, error, merge, resolve, reviewAgain } = usePull(repository, number)

  const p = pull.data
  const Icon =
    p?.state === 'merged' ? GitMerge : p?.state === 'closed' ? GitPullRequestClosed : GitPullRequest
  const mergeable = p ? canMerge(p) : false

  const action = () => {
    // Its state from GitHub did not load: still merged from here, GitHub says if it can't be.
    if (!p) return open && pull.error && isAdmin(me) ? mergeButton(true) : null
    if (p.state !== 'open' || !isAdmin(me)) return <PullStatus pull={p} />
    if (hasConflicts(p))
      return resolvesInBrigade(p) ? (
        <Button
          size="sm"
          className="relative z-10 flex-none"
          disabled={busy}
          onClick={resolve}
          title={`It conflicts with ${p.base}. ${p.tracking?.author?.name} resolves the conflicts, then it merges.`}
        >
          <GitCompareArrows />
          {busy ? 'Asking…' : 'Resolve conflicts'}
        </Button>
      ) : (
        <Button size="sm" className="relative z-10 flex-none" asChild>
          <a href={`${p.url}/conflicts`} target="_blank" rel="noreferrer">
            Resolve on GitHub
            <ExternalLink />
          </a>
        </Button>
      )
    if (resolving(p) || (mergeElsewhere && mergeable)) return <PullStatus pull={p} />
    const button = mergeButton(mergeable, mergeable ? undefined : blockedBecause[p.mergeableState])
    // Its review is under way or asked for changes: it says so first, opening the review, and
    // Merge steps back.
    const thread = reviewThread(p)
    return reviewHolds(p) ? (
      <span className="flex flex-none items-center gap-2">
        {thread ? (
          <Link
            href={`/app/threads/${thread}`}
            className="relative z-10 rounded-md hover:opacity-80"
            title={`Open ${reviewer(p) ?? unreviewedBy(p) ?? changesAskedBy(p)}'s review`}
          >
            <PullStatus pull={p} />
          </Link>
        ) : (
          <PullStatus pull={p} />
        )}
        {button}
      </span>
    ) : (
      button
    )
  }

  // Filled, as every card's main action, while it can merge and its review holds nothing back.
  const mergeButton = (enabled: boolean, title?: string) => (
    <Button
      size="sm"
      variant={enabled && !(p && reviewHolds(p)) ? 'default' : 'outline'}
      className="relative z-10 flex-none"
      disabled={busy || !enabled}
      onClick={merge}
      title={title}
    >
      <GitMerge />
      {busy && !asking ? 'Merging…' : 'Merge'}
    </Button>
  )

  const reviewThreadId = p ? reviewThread(p) : null
  const review = reviewThreadId ? childThreads.find((c) => c.id === reviewThreadId) : undefined

  const card = (
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
        <span className="truncate text-xs text-muted-foreground">
          <span className="font-mono">{repository}</span>
          {p && reviewLine(p) && (
            <>
              {' · '}
              <ReviewLink pull={p} />
            </>
          )}
          {p?.state === 'open' && unreviewedBy(p) && (
            <>
              {' · '}
              <button
                type="button"
                className="relative z-10 font-medium text-primary hover:underline disabled:opacity-50"
                disabled={busy}
                onClick={reviewAgain}
                title={`${unreviewedBy(p)} reviews its latest commits, in a new review`}
              >
                {asking ? 'Asking…' : 'Review again'}
              </button>
            </>
          )}
        </span>
        {error && <span className="text-xs text-destructive-text">{error}</span>}
      </span>
      {action()}
    </div>
  )
  if (!review) return card
  return (
    <div className="flex flex-col gap-1">
      {card}
      <ChildLine child={review} className="-mx-2" />
    </div>
  )
}
