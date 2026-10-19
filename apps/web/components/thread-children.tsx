'use client'
// Child threads, shown in their parent: they are out of the sidebar. A line each
// where a teammate started one, the runs of a schedule that reports here, the
// asks of a child waiting on a person, and in a child, the way back to its parent.
import type { NoteThread } from '@brigade/contracts'
import { ChevronRight, CornerDownRight, CornerUpLeft, Eye, Send } from 'lucide-react'
import Link from 'next/link'
import { useLayoutEffect, useRef, useState } from 'react'
import { Markdown } from '@/components/markdown'
import { ThreadStatusIcon } from '@/components/sidebar-threads'
import { Button } from '@/components/ui/button'
import { api, type ThreadChild } from '@/lib/api'
import { cn } from '@/lib/utils'

export const REPORTS: Record<string, string> = {
  nothing: 'nothing new',
  report: 'reported',
  needs_person: 'needs you',
  failed: 'failed',
  cancelled: 'cancelled',
}

/** What it is at, in a few words. */
function stateText(child: ThreadChild) {
  if (child.tickets.length) return 'needs you'
  if (child.report) return REPORTS[child.report.status] ?? child.report.status
  if (child.status === 'starting' || child.status === 'running') return 'working'
  if (child.reportDueAt) return 'in conversation'
  if (child.status === 'failed') return 'failed'
  return child.awaited ? 'working' : 'idle'
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

const when = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })

/**
 * Send a child's last message to its parent now, as its report: a person talked with it there
 * and is done, rather than waiting until they have been quiet a while.
 */
export function SendToParent({ threadId, className }: { threadId: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')
  if (state === 'sent')
    return <span className={cn('text-xs text-muted-foreground', className)}>Sent</span>
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={className}
      disabled={state === 'sending'}
      title="Send its last message to the parent thread now, as its report"
      onClick={() => {
        setState('sending')
        api(`/threads/${threadId}/report`, { body: {} }).then(
          () => setState('sent'),
          () => setState('failed'),
        )
      }}
    >
      <Send aria-hidden />
      {state === 'failed' ? 'Try again' : 'Send to parent'}
    </Button>
  )
}

/** The color of its state's label: reported, working, needs you and failed stand out; the rest is grey. */
const STATE_TONES: Record<string, string> = {
  reported: 'bg-success/15 text-success',
  working: 'bg-primary/15 text-primary',
  'needs you': 'bg-warning/15 text-warning',
  failed: 'bg-destructive/15 text-destructive-text',
}

/** One child as a line: who, its title, where it is at as a label. Opens it. */
export function ChildLine({ child, className }: { child: ThreadChild; className?: string }) {
  const summary = child.report && child.report.status !== 'nothing' ? child.report.summary : null
  const sendable = !!child.reportDueAt && !child.report && child.mayPrompt
  const state = stateText(child)
  const line = (
    <Link
      href={`/app/threads/${child.id}`}
      className={cn(
        'flex min-w-0 flex-col rounded-lg px-2 py-1.5 text-sm hover:bg-accent',
        sendable ? 'flex-1' : className,
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {/* Marks it as a child of this thread; its state stays the label at the end. */}
        <CornerDownRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground">{child.teammate.name}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{child.title}</span>
        <span
          className={cn(
            'shrink-0 rounded-md px-1.5 py-0.5 text-xs leading-none font-medium',
            STATE_TONES[state] ?? 'bg-muted text-muted-foreground',
          )}
        >
          {state}
        </span>
      </span>
      {summary && (
        <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{plain(summary)}</span>
      )}
    </Link>
  )
  if (!sendable) return line
  return (
    <div className={cn('flex min-w-0 items-center gap-1', className)}>
      {line}
      {/* A new conversation offers it again. */}
      <SendToParent key={child.reportDueAt} threadId={child.id} className="shrink-0" />
    </div>
  )
}

/** Its dot in a report note: as it was when the note was written. */
const NOTE_DOTS: Record<string, string> = {
  failed: 'failed',
  needs_person: 'waiting',
}

/** Markdown as the line it reads as, for an excerpt: without its marks. */
const plain = (markdown: string) =>
  markdown
    .replace(/^```.*$/gm, '')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .trim()

/**
 * A thread a report note tells about, as one card that opens it: its dot, who, its title,
 * then the start of what it said, which Show more unfolds in place.
 */
export function ReportedThread({ thread }: { thread: NoteThread }) {
  const summary = thread.summary.trim()
  const [open, setOpen] = useState(false)
  // Show more only when the report runs past its two lines.
  const [long, setLong] = useState(false)
  const clamped = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const el = clamped.current
    if (!el) return
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [summary, open])
  // Reported is the usual end: only another one is said in words.
  const state = !thread.status
    ? 'working'
    : thread.status === 'report'
      ? null
      : (REPORTS[thread.status] ?? thread.status)
  return (
    <div
      className={cn(
        'relative flex min-w-0 flex-col gap-1.5 rounded-xl border bg-card px-3.5 py-3 text-sm',
        // Folded, the whole card opens the thread; unfolded, only its top line, so the
        // report can be selected and its code copied.
        !open && 'hover:bg-accent',
      )}
    >
      <Link
        href={`/app/threads/${thread.id}`}
        className={cn(
          'flex min-w-0 items-center gap-2',
          !open && 'after:absolute after:inset-0 after:rounded-xl',
        )}
      >
        {thread.status === 'report' ? (
          <span
            role="img"
            aria-label="reported"
            title="reported"
            className="flex size-4 shrink-0 items-center justify-center"
          >
            <span className="size-2 rounded-full bg-success" />
          </span>
        ) : (
          <ThreadStatusIcon
            status={thread.status ? (NOTE_DOTS[thread.status] ?? 'done') : 'running'}
            unread={false}
          />
        )}
        {thread.teammate && (
          <span className="shrink-0 text-muted-foreground">{thread.teammate}</span>
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{thread.title}</span>
        {state && <span className="shrink-0 text-xs text-muted-foreground">{state}</span>}
        <ChevronRight aria-label="Open" className="size-4 shrink-0 text-muted-foreground" />
      </Link>
      {summary &&
        (open ? (
          <Markdown text={summary} className="pl-6 text-muted-foreground" />
        ) : (
          <span
            ref={clamped}
            className="line-clamp-2 pl-6 leading-relaxed wrap-anywhere text-muted-foreground"
          >
            {plain(summary)}
          </span>
        ))}
      {summary && (long || open) && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="relative z-10 ml-6 self-start text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
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
      className="-mx-2 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm hover:bg-accent"
    >
      <CornerDownRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
      <span className="shrink-0 rounded-md bg-primary/15 px-1.5 py-0.5 text-xs leading-none font-medium text-primary">
        working
      </span>
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
  threadId,
  parent,
  followers = [],
  reportDueAt = null,
}: {
  threadId: string
  parent: { id: string; title: string }
  followers?: { id: string; title: string }[]
  /** A person talked with it here: its last message goes to the parent then, or now from here. */
  reportDueAt?: string | null
}) {
  return (
    <div className="mb-4 flex flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <Link
          href={`/app/threads/${parent.id}`}
          className="flex w-fit max-w-full min-w-0 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <CornerUpLeft aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">From “{parent.title}”</span>
        </Link>
        {reportDueAt && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            Its last message goes to the parent at {time(reportDueAt)}, unless someone writes here
            <SendToParent key={reportDueAt} threadId={threadId} />
          </span>
        )}
      </div>
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
