'use client'
// Home's day at a glance: one sentence under the greeting (who is working, what needs the
// member, what the team finished today), and the routines of the day at the bottom. Both read
// the Board, so "5 tasks" is what its Done column holds for today (lib/home-day.ts).
import type { BoardRoutine } from '@brigade/contracts'
import Link from 'next/link'
import { RoutineLast } from '@/components/board'
import { Card } from '@/components/ui/card'
import { namesInWords, routinesOfToday } from '@/lib/home-day'
import { cn } from '@/lib/utils'

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * "Riley and Max are working, and 2 things need you. Your team finished 5 tasks today."
 * The count of what needs the member is Home's own, the one beside Home in the sidebar.
 */
export function TeamSummary({
  working,
  waiting,
  done,
}: {
  /** The teammates with a thread running, each once. */
  working: string[]
  waiting: number
  /** Null while the Board loads. */
  done: number | null
}) {
  return (
    <p className="text-[15px] leading-relaxed">
      <span
        aria-hidden
        className={cn(
          'mr-2 inline-block size-2 rounded-full align-[1px]',
          waiting ? 'bg-warning' : 'bg-primary',
        )}
      />
      {working.length
        ? `${namesInWords(working)} ${working.length === 1 ? 'is' : 'are'} working`
        : 'No teammate is working right now'}
      {', and '}
      {waiting ? (
        <a
          href="#needs-you"
          className="font-semibold underline decoration-warning underline-offset-4"
        >
          {waiting} {waiting === 1 ? 'thing needs' : 'things need'} you
        </a>
      ) : (
        'nothing needs you'
      )}
      .
      {!!done && (
        <>
          {' Your team finished '}
          <Link
            href="/app/board"
            className="font-semibold underline decoration-primary underline-offset-4"
          >
            {done} {done === 1 ? 'task' : 'tasks'}
          </Link>
          {' today.'}
        </>
      )}
    </p>
  )
}

/** The routines of the day, those still to come dimmed. */
export function TodaysRoutines({ routines }: { routines: BoardRoutine[] }) {
  const rows = routinesOfToday(routines)
  if (!rows.length) return null
  return (
    <section aria-labelledby="todays-routines" className="flex flex-col gap-3">
      <h2 id="todays-routines" className="text-lg font-bold">
        Today&apos;s routines
      </h2>
      <Card className="gap-0 overflow-hidden py-0">
        <ul className="divide-y">
          {rows.map(({ routine: r, at, ran, next }) => (
            <li
              key={r.id}
              className={cn('flex items-center gap-3 px-4 py-2.5', !ran && 'opacity-70')}
            >
              <span className="w-12 flex-none text-sm font-semibold text-muted-foreground tabular-nums">
                {clock(at)}
              </span>
              <Link href="/app/routines" className="min-w-0 flex-1 rounded-sm">
                <p className="truncate text-sm font-semibold">{r.title}</p>
                <p className="flex min-w-0 text-xs text-muted-foreground">
                  <span className="flex-none">{r.teammate.name}&nbsp;·&nbsp;</span>
                  {ran ? <RoutineLast routine={r} /> : <span className="truncate">Upcoming</span>}
                </p>
              </Link>
              {next && (
                <span className="hidden flex-none text-xs text-muted-foreground sm:inline">
                  Next {clock(next)}
                </span>
              )}
            </li>
          ))}
        </ul>
      </Card>
      <Link
        href="/app/routines"
        className="self-start text-sm font-semibold text-muted-foreground hover:text-foreground"
      >
        See all routines
      </Link>
    </section>
  )
}
