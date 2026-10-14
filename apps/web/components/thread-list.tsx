'use client'
import { MessagesSquare } from 'lucide-react'
import Link from 'next/link'
import { Fragment } from 'react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Card } from '@/components/ui/card'
import type { ThreadSummary } from '@/lib/api'
import { cn } from '@/lib/utils'
import { StatusBadge, TeammateAvatar, timeAgo, useDashboard } from './dashboard'
import { ProjectTag } from './projects'

const BUSY = new Set(['starting', 'running'])

/** No threads yet: an invitation, in a card on a page. */
function Empty({ text, bare }: { text: string; bare?: boolean }) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 px-6 py-10 text-center',
        !bare && 'rounded-xl border border-dashed bg-card',
      )}
    >
      <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
        <MessagesSquare className="size-5" aria-hidden />
      </span>
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  )
}

/**
 * A thread as in Slack: the message that started it, under who wrote it, with its
 * replies below (who answered, how many, when last). `continued` is a thread right
 * after another of the same person's: no name over it again, its time in the gutter.
 */
function ThreadMessage({
  thread: t,
  time,
  continued = false,
  showProject,
  compact,
}: {
  thread: ThreadSummary
  /** Beside the name, and in the gutter of a continued one. */
  time: string
  continued?: boolean
  showProject: boolean
  compact: boolean
}) {
  const { projects } = useDashboard()
  const people = t.teammates?.length ? t.teammates.map((p) => p.teammate) : [t.teammate]
  const replies = t.replies ?? 0
  const project = showProject && t.projectId && (
    <span className="min-w-0 truncate text-xs">
      <ProjectTag project={projects.find((p) => p.id === t.projectId)} />
    </span>
  )
  // Idle says nothing: only what is happening shows.
  const status = t.status !== 'idle' && (
    <StatusBadge status={t.status} className="ml-auto shrink-0" />
  )
  return (
    <>
      {continued ? (
        <span
          className={cn(
            'shrink-0 pt-0.5 text-right text-[0.6875rem] text-muted-foreground opacity-0 group-hover/thread:opacity-100',
            compact ? 'w-8' : 'w-9',
          )}
        >
          {time}
        </span>
      ) : (
        // Who started it, as the author of its first message.
        <Avatar className={cn('rounded-lg', compact ? 'size-8' : 'size-9')}>
          <AvatarFallback className="rounded-lg bg-muted text-sm font-bold text-muted-foreground">
            {t.startedBy.user.name.trim().charAt(0).toUpperCase() || '?'}
          </AvatarFallback>
        </Avatar>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {!continued && (
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="truncate font-semibold">{t.startedBy.user.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{time}</span>
            {project}
            {status}
          </div>
        )}
        <div className="flex min-w-0 items-start gap-2">
          <p
            className={cn(
              'line-clamp-2 min-w-0 flex-1 wrap-anywhere',
              compact ? 'text-sm' : 'text-[0.9375rem]',
            )}
          >
            {t.title}
          </p>
          {continued && status}
        </div>
        {/* The replies line: who answered, how many, when last. */}
        <div className="mt-1 flex min-w-0 items-center gap-2 text-xs">
          <span className="flex shrink-0 gap-0.5">
            {people.slice(0, 3).map((p) => (
              <TeammateAvatar key={p.id} teammate={p} className="size-5" />
            ))}
          </span>
          {replies > 0 ? (
            <>
              <span className="shrink-0 font-semibold text-primary">
                {replies === 1 ? '1 reply' : `${replies} replies`}
              </span>
              {t.lastReplyAt && (
                <span className="truncate text-muted-foreground">
                  Last reply {timeAgo(t.lastReplyAt)}
                </span>
              )}
            </>
          ) : (
            <span className="truncate text-muted-foreground">
              {BUSY.has(t.status) ? `${people[0]!.name} is working…` : 'No replies yet'}
            </span>
          )}
          {continued && project}
        </div>
      </div>
    </>
  )
}

/** Threads, newest first, in a card: each opens its page. */
export function ThreadList({
  threads,
  showProject = true,
  empty = 'No threads yet.',
}: {
  threads: ThreadSummary[]
  showProject?: boolean
  empty?: string
}) {
  if (threads.length === 0) return <Empty text={empty} />
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <ul className="divide-y">
        {threads.map((t) => (
          <li key={t.id}>
            <Link
              href={`/app/threads/${t.id}`}
              className="group/thread flex w-full items-start gap-3.5 px-5 py-4 text-left transition-colors hover:bg-accent/50"
            >
              <ThreadMessage
                thread={t}
                time={timeAgo(t.createdAt ?? t.updatedAt)}
                showProject={showProject}
                compact={false}
              />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  )
}

const day = (iso: string) => new Date(iso).toDateString()
/** A thread right after another of the same person's, this soon, reads as its continuation. */
const CONTINUED_MS = 10 * 60_000

/** "Today", "Yesterday", else "Monday, October 6" (with the year when not this one). */
function dayLabel(iso: string) {
  const date = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  })
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * A teammate's threads read as a Slack channel: oldest first, the newest last,
 * just above the box that starts another. A line for each day; a person's threads
 * in a row read as one run under their name.
 */
export function ThreadChannel({
  threads,
  selectedId,
  onSelect,
  empty,
}: {
  /** Oldest first. */
  threads: ThreadSummary[]
  /** The thread open beside it, marked. */
  selectedId?: string | null
  onSelect: (thread: ThreadSummary) => void
  empty: string
}) {
  if (threads.length === 0) return <Empty text={empty} bare />
  return (
    <ul className="flex flex-col">
      {threads.map((t, i) => {
        const before = threads[i - 1]
        const newDay = !before || day(before.createdAt) !== day(t.createdAt)
        const continued =
          !newDay &&
          before.startedBy.id === t.startedBy.id &&
          new Date(t.createdAt).getTime() - new Date(before.createdAt).getTime() < CONTINUED_MS
        return (
          <Fragment key={t.id}>
            {newDay && (
              <li
                role="separator"
                className="flex items-center gap-3 px-4 pt-4 pb-1 text-xs font-semibold text-muted-foreground before:flex-1 before:border-t after:flex-1 after:border-t"
              >
                {dayLabel(t.createdAt)}
              </li>
            )}
            <li>
              <button
                type="button"
                aria-current={t.id === selectedId || undefined}
                onClick={() => onSelect(t)}
                className={cn(
                  'group/thread flex w-full items-start gap-3 px-4 text-left transition-colors hover:bg-accent/50 aria-[current]:bg-accent',
                  continued ? 'py-1.5' : 'pt-3 pb-1.5',
                )}
              >
                <ThreadMessage
                  thread={t}
                  time={clock(t.createdAt)}
                  continued={continued}
                  showProject
                  compact
                />
              </button>
            </li>
          </Fragment>
        )
      })}
    </ul>
  )
}
