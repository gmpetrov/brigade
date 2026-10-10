'use client'
import { ArrowRight, GitPullRequest, Inbox, UserPlus } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { ActivityFeed } from '@/components/activity-feed'
import { isAdmin, StatusBadge, TeammateAvatar, useDashboard } from '@/components/dashboard'
import { NewThread } from '@/components/new-thread'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { harnessLabel, useApi, waitsOn, type ThreadSummary, type Ticket } from '@/lib/api'
import { useLive } from '@/lib/use-live'
import { cn } from '@/lib/utils'

const LAST_TEAMMATE = 'brigade.home.teammate'

function greeting(name: string) {
  const hour = new Date().getHours()
  const part =
    hour < 5
      ? 'Good evening'
      : hour < 12
        ? 'Good morning'
        : hour < 18
          ? 'Good afternoon'
          : 'Good evening'
  return `${part}, ${name.split(' ')[0]}`
}

/** The teammate new messages go to, remembered per browser. */
function useLastTeammate() {
  const [id, setId] = useState<string>()
  useEffect(() => {
    try {
      setId(localStorage.getItem(LAST_TEAMMATE) ?? undefined)
    } catch {}
  }, [])
  return [
    id,
    (next: string) => {
      setId(next)
      try {
        localStorage.setItem(LAST_TEAMMATE, next)
      } catch {}
    },
  ] as const
}

const busyStatus = new Set(['starting', 'running', 'waiting'])

/** Tickets and pull requests waiting on this member, with the way to them. */
function NeedsYou({ tickets, pulls }: { tickets: Ticket[]; pulls: number }) {
  if (tickets.length === 0 && pulls === 0)
    return (
      <p className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
        <span aria-hidden className="size-1.5 rounded-full bg-success" />
        Nothing is waiting on you.
      </p>
    )
  return (
    // Side by side when both show; one alone takes the full width.
    <section
      aria-labelledby="needs-you"
      className={cn('grid gap-3', tickets.length > 0 && pulls > 0 && 'sm:grid-cols-2')}
    >
      <h2 id="needs-you" className="sr-only">
        Waiting on you
      </h2>
      {tickets.length > 0 && (
        <Card className="gap-3 border-warning/40 bg-warning/5 p-4">
          <div className="flex items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-warning/15 text-warning">
              <Inbox className="size-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-bold">
                {tickets.length} {tickets.length === 1 ? 'ticket needs' : 'tickets need'} your input
              </p>
              <p className="text-sm text-muted-foreground">
                Your teammates are waiting on a decision.
              </p>
            </div>
          </div>
          <ul className="flex flex-col gap-1 text-sm">
            {tickets.slice(0, 3).map((t) => (
              <li key={t.id} className="truncate">
                <span className="font-medium">{t.session?.teammate.name ?? 'Brigade'}</span>
                <span className="text-muted-foreground">
                  {' · '}
                  {/* Titles start with the teammate's name; it is shown just before. */}
                  {t.session ? t.title.replace(`${t.session.teammate.name}: `, '') : t.title}
                </span>
              </li>
            ))}
            {tickets.length > 3 && (
              <li className="text-muted-foreground">and {tickets.length - 3} more</li>
            )}
          </ul>
          <Button asChild size="sm" className="self-start">
            <Link href="/app/tickets">
              Review tickets
              <ArrowRight aria-hidden />
            </Link>
          </Button>
        </Card>
      )}
      {pulls > 0 && (
        <Card className="gap-3 p-4">
          <div className="flex items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <GitPullRequest className="size-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-bold">
                {pulls} pull {pulls === 1 ? 'request' : 'requests'} waiting on you
              </p>
              <p className="text-sm text-muted-foreground">
                Review or merge what your teammates opened.
              </p>
            </div>
          </div>
          <Button asChild size="sm" variant="outline" className="mt-auto self-start">
            <Link href="/app/pulls">
              Review pull requests
              <ArrowRight aria-hidden />
            </Link>
          </Button>
        </Card>
      )}
    </section>
  )
}

/** Every teammate and what it is doing right now. */
function Team({ threads }: { threads: ThreadSummary[] }) {
  const { teammates } = useDashboard()
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <ul className="divide-y">
        {teammates.map((t) => {
          // Newest first: the first busy thread it is in is what it is on.
          const on = threads.find(
            (s) =>
              busyStatus.has(s.status) &&
              (s.teammate.id === t.id || s.teammates?.some((p) => p.teammate.id === t.id)),
          )
          return (
            <li key={t.id}>
              <Link
                href={on ? `/app/threads/${on.id}` : `/app/teammates/${t.id}`}
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50"
              >
                <TeammateAvatar teammate={t} className="size-8 shrink-0 text-sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{t.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {on ? on.title : `Idle · ${harnessLabel(t.harness)}`}
                  </p>
                </div>
                {on && <StatusBadge status={on.status} />}
              </Link>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

export default function Home() {
  const { me, teammates } = useDashboard()
  const threads = useApi<ThreadSummary[]>('/threads')
  const tickets = useApi<Ticket[]>('/tickets?status=all')
  const pulls = useApi<{ count: number }>('/pulls/attention')
  const [chosen, choose] = useLastTeammate()
  const teammate = teammates.find((t) => t.id === chosen) ?? teammates[0]

  useLive((message) => {
    if (message.type !== 'thread.updated') return
    void threads.reload()
    void tickets.reload()
  })

  const waiting = (tickets.data ?? []).filter((t) => waitsOn(t, me))
  const working = (threads.data ?? []).filter((t) => busyStatus.has(t.status)).length

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-extrabold tracking-tight">{greeting(me.user.name)}</h1>
        <p className="text-muted-foreground">
          {working > 0
            ? `${working} ${working === 1 ? 'thread is' : 'threads are'} running. Give your teammates something else to do.`
            : 'Give your teammates something to do.'}
        </p>
      </header>

      {teammate ? (
        <NewThread
          teammate={teammate}
          rows={3}
          picker={teammates.length > 1 ? { teammates, onChange: choose } : undefined}
          placeholder={`Ask ${teammate.name} to… @ to bring in another teammate, a repository, connection or credential`}
        />
      ) : (
        <section className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card px-6 py-12 text-center">
          <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/15 text-primary">
            <UserPlus className="size-6" aria-hidden />
          </span>
          <h2 className="text-lg font-bold">Add your first AI teammate</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            A teammate is a saved identity with its own instructions. Every message to it opens a
            thread.
          </p>
          {isAdmin(me) ? (
            <Button asChild className="mt-1">
              <Link href="/app/teammates/new">New teammate</Link>
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">Ask an owner or admin to add one.</p>
          )}
        </section>
      )}

      {tickets.data && pulls.data && <NeedsYou tickets={waiting} pulls={pulls.data.count} />}

      <div className="flex flex-wrap items-start gap-6">
        <section
          aria-labelledby="activity"
          className="flex min-w-0 flex-[999_1_28rem] flex-col gap-3"
        >
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="activity" className="text-lg font-bold">
              Recent activity
            </h2>
            <Link
              href="/app/threads"
              className="text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              All threads
            </Link>
          </div>
          {threads.data && tickets.data && (
            <ActivityFeed threads={threads.data} tickets={tickets.data} />
          )}
        </section>
        {teammates.length > 0 && (
          <section aria-labelledby="team" className="flex min-w-0 flex-[1_1_16rem] flex-col gap-3">
            <h2 id="team" className="text-lg font-bold">
              Your team
            </h2>
            <Team threads={threads.data ?? []} />
          </section>
        )}
      </div>
    </div>
  )
}
