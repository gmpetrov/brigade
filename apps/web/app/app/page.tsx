'use client'
import { UserPlus } from 'lucide-react'
import Link from 'next/link'
import { isAdmin, useDashboard } from '@/components/dashboard'
import { GettingStarted } from '@/components/getting-started'
import { LooseEnds, SinceAway } from '@/components/home-feed'
import { NeedsYou } from '@/components/needs-you'
import { NewThread, useLastTeammate } from '@/components/new-thread'
import { Button } from '@/components/ui/button'
import {
  useApi,
  waitsOn,
  type HomeFeed,
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

export default function Home() {
  const { me, teammates } = useDashboard()
  const threads = useApi<ThreadSummary[]>('/threads')
  const tickets = useApi<Ticket[]>('/tickets?status=all')
  const pulls = useApi<{ pulls: PullWaiting[] }>('/pulls/attention')
  const feed = useApi<HomeFeed>('/home')
  const [chosen, choose] = useLastTeammate()
  const teammate = teammates.find((t) => t.id === chosen) ?? teammates[0]

  useLive((message) => {
    if (message.type === 'tickets.updated') void Promise.all([tickets.reload(), feed.reload()])
    if (message.type === 'pulls.updated') void Promise.all([pulls.reload(), feed.reload()])
    if (message.type !== 'thread.updated') return
    void threads.reload()
    void tickets.reload()
    // A thread's pull requests wait on a person once its teammate stops.
    void pulls.reload()
    void feed.reload()
  })

  const waiting = (tickets.data ?? []).filter((t) => waitsOn(t, me))
  const waitingCount = waiting.length + (pulls.data?.pulls.length ?? 0)
  // Only when nothing waits: then Waiting on you is hidden, and this line says so.
  const calm =
    tickets.data && pulls.data && feed.data && waitingCount === 0
      ? feed.data.looseEnds.length
        ? 'Nothing is waiting on you'
        : 'Nothing is waiting on you, and nothing is left hanging'
      : null

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-extrabold tracking-tight">{greeting(me.user.name)}</h1>
        {calm && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <span aria-hidden className="size-2 flex-none rounded-full bg-success" />
            {calm}
          </p>
        )}
      </header>

      {teammate ? (
        <NewThread
          teammate={teammate}
          rows={3}
          typeToFocus
          picker={teammates.length > 1 ? { teammates, onChange: choose } : undefined}
          placeholder={`Chat with ${teammate.name}`}
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
            await Promise.all([tickets.reload(), pulls.reload(), feed.reload()])
          }}
        />
      )}

      {feed.data && (
        <>
          <LooseEnds items={feed.data.looseEnds} onChange={feed.reload} />
          <SinceAway feed={feed.data} />
        </>
      )}
    </div>
  )
}
