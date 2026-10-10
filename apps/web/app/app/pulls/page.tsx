'use client'
import { GitPullRequest } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { ConnectGitHub, useGitHub } from '@/components/connect-github'
import { timeAgo } from '@/components/dashboard'
import { PullStatus } from '@/components/pull-status'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { pullHref, useApi, type PullRequestList } from '@/lib/api'
import { cn } from '@/lib/utils'

const ALL = '*'

/** Every repository's pull requests in one list, with where each review loop stands. */
export default function PullRequests() {
  const [state, setState] = useState<'open' | 'closed'>('open')
  const [repository, setRepository] = useState(ALL)
  const github = useGitHub()
  const list = useApi<PullRequestList>(github === 'connected' ? `/pulls?state=${state}` : null)
  const shown = (list.data?.pulls ?? []).filter(
    (p) => repository === ALL || p.repository === repository,
  )

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-extrabold tracking-tight">Pull requests</h1>
        <p className="max-w-prose text-muted-foreground">
          What your teammates propose to change in your repositories. Ask a teammate to review one:
          it goes back and forth with the author until it is approved, then merges if you said so.
        </p>
      </header>
      {github !== 'loading' && github !== 'connected' && <ConnectGitHub state={github} />}

      <div className={cn('flex flex-wrap items-center gap-3', github !== 'connected' && 'hidden')}>
        <div role="group" aria-label="State" className="flex flex-1 flex-wrap gap-2">
          {(['open', 'closed'] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={state === s}
              onClick={() => setState(s)}
              className={cn(
                'inline-flex h-8 items-center rounded-full border px-3.5 text-sm font-semibold transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                state === s
                  ? 'border-transparent bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
              )}
            >
              {s === 'open' ? 'Open' : 'Merged and closed'}
            </button>
          ))}
        </div>
        {(list.data?.repositories.length ?? 0) > 1 && (
          <Select value={repository} onValueChange={setRepository}>
            <SelectTrigger aria-label="Repository" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All repositories</SelectItem>
              {list.data!.repositories.map((r) => (
                <SelectItem key={r} value={r}>
                  <span className="font-mono">{r}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {list.error && <p className="text-sm text-destructive-text">{list.error.message}</p>}
      {list.data?.errors.map((e) => (
        <p key={e.repository} className="text-sm text-destructive-text">
          <span className="font-mono">{e.repository}</span>: {e.message}
        </p>
      ))}

      {github !== 'connected' && github !== 'loading' ? null : !list.data && !list.error ? (
        <Card className="gap-0 divide-y py-0">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-4">
              <Skeleton className="size-5 rounded-full" />
              <Skeleton className="h-5 flex-1" />
            </div>
          ))}
        </Card>
      ) : shown.length === 0 && list.data ? (
        <Empty
          title={state === 'open' ? 'No open pull requests.' : 'Nothing merged or closed yet.'}
          text="Ask a teammate in a thread to make a change and open a pull request."
          action={
            <Button asChild variant="outline">
              <Link href="/app">Back to threads</Link>
            </Button>
          }
        />
      ) : (
        <Card className="gap-0 overflow-hidden py-0">
          <ul className="divide-y">
            {shown.map((p) => (
              <li key={`${p.repository}#${p.number}`}>
                <Link
                  href={pullHref(p.repository, p.number)}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 hover:bg-secondary/50"
                >
                  <GitPullRequest
                    className={cn(
                      'size-5 flex-none',
                      p.state === 'merged'
                        ? 'text-primary'
                        : p.state === 'closed'
                          ? 'text-muted-foreground'
                          : 'text-success',
                    )}
                    aria-hidden
                  />
                  <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
                    <span className="truncate font-semibold">
                      {p.title}{' '}
                      <span className="font-normal text-muted-foreground">#{p.number}</span>
                    </span>
                    <span className="truncate text-sm text-muted-foreground">
                      <span className="font-mono">{p.repository}</span>
                      {' · '}
                      {p.tracking?.author ? p.tracking.author.name : p.author}
                      {p.tracking?.reviewer && ` → ${p.tracking.reviewer.name}`}
                      {' · '}
                      {timeAgo(p.updatedAt)}
                    </span>
                  </div>
                  <PullStatus pull={p} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

function Empty({ title, text, action }: { title: string; text: string; action: React.ReactNode }) {
  return (
    <section className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card px-6 py-16 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/15 text-primary">
        <GitPullRequest className="size-6" aria-hidden />
      </span>
      <h2 className="text-lg font-bold">{title}</h2>
      <p className="max-w-md text-sm text-muted-foreground">{text}</p>
      {action}
    </section>
  )
}
