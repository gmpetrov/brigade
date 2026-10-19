'use client'
// Child threads, shown in their parent: they are out of the sidebar. A line each
// where a teammate started one, the runs of a schedule that reports here, the
// asks of a child waiting on a person, and in a child, the way back to its parent.
import { CornerUpLeft, Eye } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { ThreadStatusIcon } from '@/components/sidebar-threads'
import type { ThreadChild } from '@/lib/api'
import { cn } from '@/lib/utils'

const REPORTS: Record<string, string> = {
  nothing: 'nothing new',
  report: 'reported',
  needs_person: 'needs you',
  failed: 'failed',
  cancelled: 'cancelled',
}

/** Its status for a dot: working, waiting on a person, failed, or done (read). */
function dotStatus(child: ThreadChild) {
  if (child.tickets.length || child.report?.status === 'needs_person') return 'waiting'
  if (child.report?.status === 'failed') return 'failed'
  if (child.report) return 'done'
  return child.status
}

/** What it is at, in a few words. */
function stateText(child: ThreadChild) {
  if (child.tickets.length) return 'needs you'
  if (child.report) return REPORTS[child.report.status] ?? child.report.status
  if (child.status === 'starting' || child.status === 'running') return 'working'
  if (child.status === 'failed') return 'failed'
  return child.awaited ? 'working' : 'idle'
}

const when = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })

/** One child as a line: its dot, who, its title, where it is at. Opens it. */
export function ChildLine({ child, className }: { child: ThreadChild; className?: string }) {
  const summary = child.report && child.report.status !== 'nothing' ? child.report.summary : null
  return (
    <Link
      href={`/app/threads/${child.id}`}
      className={cn(
        'flex min-w-0 items-start gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-accent',
        className,
      )}
    >
      <ThreadStatusIcon status={dotStatus(child)} unread={false} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 text-muted-foreground">{child.teammate.name}</span>
          <span className="truncate font-medium">{child.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground">· {stateText(child)}</span>
        </span>
        {summary && (
          <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{summary}</span>
        )}
      </span>
    </Link>
  )
}

/** Where a start_child call went: the child's line, live, or a plain one while it loads. */
export function StartedChild({
  threadId,
  title,
  children,
}: {
  threadId: string
  title: string
  children: ThreadChild[]
}) {
  const child = children.find((c) => c.id === threadId)
  if (child) return <ChildLine child={child} className="-mx-2" />
  return (
    <Link
      href={`/app/threads/${threadId}`}
      className="-mx-2 flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-accent"
    >
      <ThreadStatusIcon status="starting" />
      <span className="truncate font-medium">{title}</span>
    </Link>
  )
}

/**
 * The children that wait on a person, at the end of the conversation: its ticket is
 * answered in the child, where the teammate asking it works.
 */
export function ChildrenWaiting({ children }: { children: ThreadChild[] }) {
  const waiting = children.filter((c) => c.tickets.length > 0)
  if (!waiting.length) return null
  return (
    <div className="mt-4 flex flex-col gap-2">
      {waiting.map((child) => (
        <Link
          key={child.id}
          href={`/app/threads/${child.id}`}
          className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm hover:bg-warning/15"
        >
          <ThreadStatusIcon status="waiting" className="mt-0.5" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">
              {child.teammate.name} needs you in “{child.title}”
            </span>
            <span className="block text-muted-foreground">{child.tickets[0]!.title}</span>
          </span>
          <span className="shrink-0 font-medium text-warning">Open</span>
        </Link>
      ))}
    </div>
  )
}

/**
 * Every child of the thread, for its panel: those a teammate started, then each
 * schedule's runs, those with nothing new folded into one line.
 */
export function ChildrenList({ children }: { children: ThreadChild[] }) {
  const started = children.filter((c) => !c.schedule)
  const bySchedule = new Map<string, ThreadChild[]>()
  for (const c of children)
    if (c.schedule) bySchedule.set(c.schedule.id, [...(bySchedule.get(c.schedule.id) ?? []), c])
  if (!children.length) return null
  return (
    <div className="flex flex-col gap-1">
      {started.map((child) => (
        <ChildLine key={child.id} child={child} />
      ))}
      {[...bySchedule.values()].map((runs) => (
        <ScheduleRuns key={runs[0]!.schedule!.id} runs={runs} />
      ))}
    </div>
  )
}

/** A schedule's runs: those that said something, and the quiet ones as one line that unfolds. */
function ScheduleRuns({ runs }: { runs: ThreadChild[] }) {
  const [open, setOpen] = useState(false)
  const quiet = runs.filter((r) => r.report?.status === 'nothing' && !r.tickets.length)
  const shown = runs.filter((r) => !quiet.includes(r))
  return (
    <div className="flex flex-col gap-1">
      <p className="px-2 pt-2 text-xs font-medium text-muted-foreground">
        Runs of “{runs[0]!.schedule!.title}”
      </p>
      {shown.map((child) => (
        <ChildLine key={child.id} child={child} />
      ))}
      {quiet.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent"
          >
            <ThreadStatusIcon status="done" />
            {quiet.length === 1
              ? `1 run with nothing new · ${when(quiet[0]!.createdAt)}`
              : `${quiet.length} runs with nothing new · last ${when(quiet[0]!.createdAt)}`}
          </button>
          {open && quiet.map((child) => <ChildLine key={child.id} child={child} />)}
        </>
      )}
    </div>
  )
}

/** In a child: the thread it was started from, which its report goes to, and the others it wakes. */
export function ParentLink({
  parent,
  followers = [],
}: {
  parent: { id: string; title: string }
  followers?: { id: string; title: string }[]
}) {
  return (
    <div className="mb-4 flex flex-col gap-1">
      <Link
        href={`/app/threads/${parent.id}`}
        className="flex w-fit max-w-full items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <CornerUpLeft aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">From “{parent.title}”</span>
      </Link>
      {followers.length > 0 && <FollowedBy followers={followers} />}
    </div>
  )
}

/** Threads of other runs that follow it (follow_thread): its report wakes them too. */
function FollowedBy({ followers }: { followers: { id: string; title: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
      <Eye aria-hidden className="size-3.5 shrink-0" />
      <span>
        Followed by {followers.length} other {followers.length === 1 ? 'thread' : 'threads'}:
      </span>
      {followers.map((f, i) => (
        <span key={f.id} className="flex min-w-0 items-center gap-1.5">
          {i > 0 && <span aria-hidden>·</span>}
          <Link href={`/app/threads/${f.id}`} className="max-w-60 truncate hover:text-foreground">
            “{f.title}”
          </Link>
        </span>
      ))}
    </div>
  )
}
