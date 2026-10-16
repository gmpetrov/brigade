'use client'
import { UserPlus } from 'lucide-react'
import Link from 'next/link'
import { ActivityFeed } from '@/components/activity-feed'
import { isAdmin, StatusBadge, TeammateAvatar, useDashboard } from '@/components/dashboard'
import { GettingStarted } from '@/components/getting-started'
import { NeedsYou } from '@/components/needs-you'
import { NewThread, useLastTeammate } from '@/components/new-thread'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  teammateModelLabel,
  useApi,
  waitsOn,
  type PullWaiting,
  type ThreadSummary,
  type Ticket,
} from '@/lib/api'
import { useLive } from '@/lib/use-live'

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

const busyStatus = new Set(['starting', 'running', 'waiting'])

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
                    {on ? on.title : `Idle · ${teammateModelLabel(t)}`}
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
  const pulls = useApi<{ pulls: PullWaiting[] }>('/pulls/attention')
  const [chosen, choose] = useLastTeammate()
  const teammate = teammates.find((t) => t.id === chosen) ?? teammates[0]

  useLive((message) => {
    if (message.type === 'tickets.updated') void tickets.reload()
    if (message.type === 'pulls.updated') void pulls.reload()
    if (message.type !== 'thread.updated') return
    void threads.reload()
    void tickets.reload()
    // A thread's pull requests wait on a person once its teammate stops.
    void pulls.reload()
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
          placeholder={`Ask ${teammate.name} to… Type @ to mention, / for commands`}
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

      <GettingStarted threads={threads.data} />

      {tickets.data && pulls.data && (
        <NeedsYou
          tickets={waiting}
          pulls={pulls.data.pulls}
          onChange={async () => {
            await Promise.all([tickets.reload(), pulls.reload()])
          }}
        />
      )}

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
              Threads
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
