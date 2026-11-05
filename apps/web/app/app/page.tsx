'use client'
import { UserPlus } from 'lucide-react'
import Link from 'next/link'
import { useBoard } from '@/components/board'
import { ChiefPassSection } from '@/components/chief-pass'
import { isAdmin, useDashboard } from '@/components/dashboard'
import { GettingStarted } from '@/components/getting-started'
import { LooseEnds, SinceAway } from '@/components/home-feed'
import { TeamSummary, TodaysRoutines } from '@/components/home-today'
import { NeedsYou } from '@/components/needs-you'
import { doneToday } from '@/lib/home-day'
import { NewThread, useLastTeammate } from '@/components/new-thread'
import { Button } from '@/components/ui/button'
import {
  choicesWaiting,
  failuresWaiting,
  isViewer,
  useApi,
  useRecheck,
  waitingItemKey,
  waitsOn,
  type HomeFeed,
  type HomeWaiting,
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
  // Open ones: decided ones would only crowd out what waits.
  const tickets = useApi<Ticket[]>('/tickets')
  const pulls = useApi<{ pulls: PullWaiting[] }>('/pulls/attention')
  const feed = useApi<HomeFeed>('/home')
  // What the team finished today and the day's routines: the Board's, so they agree with it.
  const board = useBoard()
  // Failed threads and routines waiting on the member (apps/api/src/failed.ts), and choices
  // to pick from (apps/api/src/choices-waiting.ts).
  const failures = useApi<HomeWaiting>('/home/waiting')
  useRecheck(failures.data?.recheckAt, failures.reload)
  const [chosen, choose] = useLastTeammate()
  const teammate = teammates.find((t) => t.id === chosen) ?? teammates[0]

  useLive((message) => {
    if (message.type === 'tickets.updated')
      // A routine that could not start waits by its ticket while it is open.
      void Promise.all([tickets.reload(), feed.reload(), failures.reload()])
    if (message.type === 'pulls.updated') void Promise.all([pulls.reload(), feed.reload()])
    if (message.type === 'schedule.updated') void failures.reload()
    if (message.type !== 'thread.updated') return
    void threads.reload()
    void tickets.reload()
    // A thread's pull requests wait on a person once its teammate stops.
    void pulls.reload()
    void feed.reload()
    // And it waits on them once it failed.
    void failures.reload()
  })

  const waiting = (tickets.data ?? []).filter((t) => waitsOn(t, me))
  const failed = failuresWaiting(failures.data, waiting)
  const choices = choicesWaiting(failures.data, waiting, pulls.data?.pulls ?? [])
  // A playbook's approvals are one item, as the sidebar counts them.
  const waitingCount =
    new Set(waiting.map(waitingItemKey)).size +
    (pulls.data?.pulls.length ?? 0) +
    failed.threads.length +
    failed.routines.length +
    choices.length
  // The teammates at work now, each once.
  const working = [
    ...new Set(
      (threads.data ?? [])
        .filter((t) => t.status === 'running' || t.status === 'starting')
        .map((t) => t.teammate.name),
    ),
  ]
  const summaryReady = threads.data && tickets.data && pulls.data && failures.data

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-extrabold tracking-tight">{greeting(me.user.name)}</h1>
        {summaryReady && (
          <TeamSummary
            working={working}
            waiting={waitingCount}
            done={board.data ? doneToday(board.data) : null}
          />
        )}
      </header>

      {isViewer(me) ? (
        <p className="text-sm text-muted-foreground">
          You can view this workspace&apos;s threads, tasks and files. Ask an owner or admin to
          start work.
        </p>
      ) : teammate ? (
        <NewThread
          teammate={teammate}
          rows={3}
          typeToFocus
          openAtOnce
          giveBackHere
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

      {/* Chief's daily pass, for a person who has it on (docs/chief-answers.md). */}
      {me.chiefPass && <ChiefPassSection />}

      {tickets.data && pulls.data && (
        <NeedsYou
          tickets={waiting}
          pulls={pulls.data.pulls}
          failed={failed}
          choices={choices}
          onChange={async () => {
            await Promise.all([tickets.reload(), pulls.reload(), feed.reload(), failures.reload()])
          }}
        />
      )}

      {feed.data && (
        <>
          <LooseEnds items={feed.data.looseEnds} onChange={feed.reload} />
          <SinceAway feed={feed.data} />
        </>
      )}

      {board.data && <TodaysRoutines routines={board.data.routines} />}
    </div>
  )
}
