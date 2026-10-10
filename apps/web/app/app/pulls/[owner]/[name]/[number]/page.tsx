'use client'
import {
  ArrowLeft,
  CircleCheck,
  CircleDashed,
  CircleX,
  ExternalLink,
  GitMerge,
  MessagesSquare,
  Repeat,
} from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { isAdmin, TeammateAvatar, timeAgo, useDashboard } from '@/components/dashboard'
import { DiffView, type LineComment } from '@/components/diff-view'
import { Markdown } from '@/components/markdown'
import { PullStatus } from '@/components/pull-status'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, useApi, type CheckRun, type MergeMethod, type PullRequestDetail } from '@/lib/api'
import { cn } from '@/lib/utils'

/** While the loop runs, the page follows it. */
const POLL_MS = 10_000

/** Why GitHub will not merge yet, in GitHub's mergeable_state terms. */
const blockedBecause: Record<string, string> = {
  dirty: 'It conflicts with the base branch.',
  blocked: 'GitHub requires an approving review or passing checks first.',
  behind: 'The branch is behind the base branch.',
  draft: 'It is a draft.',
  unknown: 'GitHub is still checking whether it can merge.',
}

const LAST_MERGE_METHOD = 'brigade.pulls.mergeMethod'
const mergeMethods: MergeMethod[] = ['squash', 'merge', 'rebase']

/** The merge method last picked, remembered per browser. Squash until one is picked. */
function useLastMergeMethod() {
  const [method, setMethod] = useState<MergeMethod>('squash')
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LAST_MERGE_METHOD) as MergeMethod | null
      if (saved && mergeMethods.includes(saved)) setMethod(saved)
    } catch {}
  }, [])
  return [
    method,
    (next: MergeMethod) => {
      setMethod(next)
      try {
        localStorage.setItem(LAST_MERGE_METHOD, next)
      } catch {}
    },
  ] as const
}

export default function PullRequestPage() {
  const params = useParams<{ owner: string; name: string; number: string }>()
  const path = `/pulls/${params.owner}/${params.name}/${params.number}`
  const { me, teammates } = useDashboard()
  const admin = isAdmin(me)
  const pull = useApi<PullRequestDetail>(path)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)
  const [reviewerId, setReviewerId] = useState<string>()
  const [autoMerge, setAutoMerge] = useState(admin)
  const [method, setMethod] = useLastMergeMethod()

  const p = pull.data
  const t = p?.tracking
  const running =
    t?.reviewStatus === 'reviewing' ||
    t?.reviewStatus === 'fixing' ||
    (t?.reviewStatus === 'approved' && t.autoMerge)
  const reload = pull.reload
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => void reload(), POLL_MS)
    return () => clearInterval(timer)
  }, [running, reload])

  const comments = useMemo<LineComment[]>(
    () =>
      (p?.reviews ?? []).flatMap((r) =>
        r.comments.map((c) => ({ ...c, author: r.teammate?.name ?? 'A teammate' })),
      ),
    [p?.reviews],
  )

  if (!p)
    return (
      <p className={cn('text-sm', pull.error ? 'text-destructive-text' : 'text-muted-foreground')}>
        {pull.error?.message ?? 'Loading…'}
      </p>
    )

  const open = p.state === 'open'
  const candidates = teammates.filter((m) => m.id !== t?.author?.id)
  const reviewer = reviewerId ?? t?.reviewer?.id ?? candidates[0]?.id
  const mergeable = p.mergeable !== false && !['dirty', 'draft'].includes(p.mergeableState)

  async function act(run: () => Promise<unknown>) {
    setBusy(true)
    setError(undefined)
    try {
      await run()
      await reload()
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }

  const askForReview = () =>
    act(() => api(`${path}/review`, { body: { reviewerId: reviewer, autoMerge } })).then(
      (ok) => ok && setAsking(false),
    )
  const merge = () => {
    if (!confirm(`Merge #${p.number} into ${p.base} (${method})?`)) return
    void act(() => api(`${path}/merge`, { body: { method } }))
  }
  const stop = () => void act(() => api(`${path}/stop`, { body: {} }))

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/app/pulls"
        className="flex items-center gap-1.5 self-start text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Pull requests
      </Link>

      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start gap-3">
          <h1 className="min-w-0 flex-1 text-2xl font-extrabold tracking-tight wrap-anywhere">
            {p.title} <span className="font-normal text-muted-foreground">#{p.number}</span>
          </h1>
          <PullStatus pull={p} />
        </div>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span className="font-mono">{p.repository}</span>
          <span aria-hidden>·</span>
          <span>
            <code className="font-mono text-xs">{p.head}</code> into{' '}
            <code className="font-mono text-xs">{p.base}</code>
          </span>
          <span aria-hidden>·</span>
          <span>by {t?.author?.name ?? p.author}</span>
          <span aria-hidden>·</span>
          <span className="font-mono text-xs">
            <span className="text-success">+{p.additions}</span>{' '}
            <span className="text-destructive-text">−{p.deletions}</span>
          </span>
          <span>
            in {p.changedFiles} file{p.changedFiles === 1 ? '' : 's'}, {p.commits} commit
            {p.commits === 1 ? '' : 's'}
          </span>
          <a
            href={p.url}
            target="_blank"
            rel="noreferrer"
            className="ml-auto flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
          >
            GitHub <ExternalLink className="size-3.5" aria-hidden />
          </a>
        </p>
      </header>

      {open && (
        <div className="flex flex-wrap items-center gap-2">
          {!running && (
            <Button variant={asking ? 'secondary' : 'default'} onClick={() => setAsking(!asking)}>
              <MessagesSquare />
              Ask for review
            </Button>
          )}
          {admin && (
            <div className="flex items-center">
              <Button
                variant="outline"
                className="rounded-r-none"
                disabled={busy || !mergeable}
                onClick={merge}
                title={mergeable ? undefined : blockedBecause[p.mergeableState]}
              >
                <GitMerge />
                Merge
              </Button>
              <Select value={method} onValueChange={(v) => setMethod(v as MergeMethod)}>
                <SelectTrigger aria-label="Merge method" className="w-32 rounded-l-none border-l-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="squash">Squash</SelectItem>
                  <SelectItem value="merge">Merge commit</SelectItem>
                  <SelectItem value="rebase">Rebase</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {t?.sessionId && (
            <Button asChild variant="ghost">
              <Link href={`/app/threads/${t.sessionId}`}>Open the thread</Link>
            </Button>
          )}
          {running && (
            <Button variant="ghost" disabled={busy} onClick={stop}>
              Stop the review
            </Button>
          )}
        </div>
      )}
      {error && <p className="text-sm text-destructive-text">{error}</p>}

      {asking && open && (
        <Card className="gap-4 px-5 py-4">
          <div className="flex flex-col gap-1">
            <h2 className="font-semibold">Ask a teammate to review it</h2>
            <p className="text-sm text-muted-foreground">
              {t?.author
                ? `It reviews in the thread that opened it. ${t.author.name} fixes what it finds, and they go back and forth for up to ${t.maxRounds} rounds.`
                : 'It reviews in a new thread and posts its review on GitHub.'}
            </p>
          </div>
          {candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No other teammate to review it.{' '}
              <Link
                href="/app/teammates/new"
                className="text-primary underline-offset-4 hover:underline"
              >
                Add one
              </Link>
              .
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-4">
              <Select value={reviewer} onValueChange={setReviewerId}>
                <SelectTrigger aria-label="Reviewer" className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      <TeammateAvatar teammate={m} className="size-5" />
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {admin && (
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="auto-merge"
                    checked={autoMerge}
                    onCheckedChange={(v) => setAutoMerge(v === true)}
                  />
                  <Label htmlFor="auto-merge" className="font-normal">
                    Merge when approved and checks pass
                  </Label>
                </div>
              )}
              <div className="ml-auto flex gap-2">
                <Button variant="ghost" onClick={() => setAsking(false)}>
                  Cancel
                </Button>
                <Button disabled={busy || !reviewer} onClick={() => void askForReview()}>
                  Start the review
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {t && t.reviewStatus !== 'none' && open && <Loop pull={p} />}

      {p.checks.length > 0 && <Checks checks={p.checks} />}

      <Tabs defaultValue="conversation">
        <TabsList>
          <TabsTrigger value="conversation">Conversation</TabsTrigger>
          <TabsTrigger value="files">
            Files changed{' '}
            <span className="text-muted-foreground tabular-nums">{p.changedFiles}</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="conversation" className="mt-4 flex flex-col gap-4">
          <Card className="gap-2 px-5 py-4">
            {p.body?.trim() ? (
              <Markdown text={p.body} />
            ) : (
              <p className="text-sm text-muted-foreground">No description.</p>
            )}
          </Card>
          {p.reviews.map((r) => (
            <Card key={r.id} className="gap-3 px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                {r.teammate && (
                  <TeammateAvatar
                    teammate={
                      teammates.find((m) => m.id === r.teammate!.id) ?? {
                        name: r.teammate.name,
                        harness: 'claude_code',
                      }
                    }
                  />
                )}
                <span className="font-semibold">{r.teammate?.name ?? 'A teammate'}</span>
                <StatusBadge
                  status={r.verdict === 'approve' ? 'approved' : 'changes requested'}
                  tone={r.verdict === 'approve' ? 'success' : 'warning'}
                />
                <span className="text-sm text-muted-foreground">
                  round {r.round} · {timeAgo(r.createdAt)} ·{' '}
                  <code className="font-mono text-xs">{r.sha.slice(0, 7)}</code>
                </span>
                {r.url && (
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto text-sm text-primary underline-offset-4 hover:underline"
                  >
                    On GitHub
                  </a>
                )}
              </div>
              <Markdown text={r.body} />
              {r.comments.length > 0 && (
                <ul className="flex flex-col gap-1.5 border-t pt-3 text-sm">
                  {r.comments.map((c, i) => (
                    <li key={i}>
                      <code className="font-mono text-xs">
                        {c.path}:{c.line}
                      </code>{' '}
                      {c.body}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
          {p.githubReviews.map((r, i) => (
            <Card key={i} className="gap-2 px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{r.author ?? 'Someone'}</span>
                <span className="text-sm text-muted-foreground">
                  on GitHub: {r.state.replace(/_/g, ' ')}
                  {r.at && ` · ${timeAgo(r.at)}`}
                </span>
              </div>
              {r.body.trim() && <Markdown text={r.body} />}
            </Card>
          ))}
        </TabsContent>
        <TabsContent value="files" className="mt-4">
          <DiffView files={p.files} cut={p.filesCut} comments={comments} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** Where the review loop is: whose move, which round, and what it waits for. */
function Loop({ pull: p }: { pull: PullRequestDetail }) {
  const t = p.tracking!
  const turn =
    t.reviewStatus === 'reviewing'
      ? `${t.reviewer?.name ?? 'The reviewer'} is reviewing it.`
      : t.reviewStatus === 'fixing'
        ? `${t.author?.name ?? 'The author'} is working on the review.`
        : t.reviewStatus === 'approved'
          ? t.autoMerge
            ? `${t.reviewer?.name ?? 'The reviewer'} approved it. It merges once GitHub allows it.`
            : `${t.reviewer?.name ?? 'The reviewer'} approved it. Ready to merge.`
          : t.reviewStatus === 'changes_requested'
            ? `${t.reviewer?.name ?? 'The reviewer'} asked for changes.`
            : 'The review stopped and needs you.'
  return (
    <Card
      className={cn(
        'flex-row flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4',
        t.reviewStatus === 'stuck' && 'border-destructive/50',
      )}
    >
      <Repeat className="size-5 flex-none text-primary" aria-hidden />
      <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
        <span className="font-semibold">{turn}</span>
        {t.note && <span className="text-sm text-muted-foreground">{t.note}</span>}
      </div>
      <span className="text-sm text-muted-foreground tabular-nums">
        Round {t.round} of {t.maxRounds}
      </span>
    </Card>
  )
}

function Checks({ checks }: { checks: CheckRun[] }) {
  const icon = {
    success: <CircleCheck className="size-4 text-success" aria-hidden />,
    failure: <CircleX className="size-4 text-destructive-text" aria-hidden />,
    pending: (
      <CircleDashed
        className="size-4 animate-spin text-warning [animation-duration:3s]"
        aria-hidden
      />
    ),
    neutral: <CircleDashed className="size-4 text-muted-foreground" aria-hidden />,
  }
  return (
    <Card className="gap-0 divide-y py-0">
      {checks.map((c, i) => (
        <div key={`${c.name}:${i}`} className="flex items-center gap-3 px-5 py-2 text-sm">
          {icon[c.status]}
          <span className="min-w-0 flex-1 truncate">{c.name}</span>
          <span className="text-muted-foreground">{c.status}</span>
          {c.url && (
            <a
              href={c.url}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline-offset-4 hover:underline"
            >
              Details
            </a>
          )}
        </div>
      ))}
    </Card>
  )
}
