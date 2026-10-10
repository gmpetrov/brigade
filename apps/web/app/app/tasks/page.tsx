'use client'
import { Plus } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { StatusBadge, TeammateAvatar, timeAgo } from '@/components/dashboard'
import { COLUMNS, NewTaskDialog, PriorityBadge, priorityRank, TaskSheet } from '@/components/tasks'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useApi, type Task } from '@/lib/api'
import { useLive } from '@/lib/use-live'
import { cn } from '@/lib/utils'

/** Done tasks shown before "Show all". */
const DONE_SHOWN = 15

/** Most urgent first, then most recently touched. Done: most recently finished. */
function order(a: Task, b: Task) {
  if (a.completedAt && b.completedAt) return b.completedAt.localeCompare(a.completedAt)
  return (
    priorityRank(b.priority) - priorityRank(a.priority) || b.updatedAt.localeCompare(a.updatedAt)
  )
}

/** What the card says about where the work is. */
function progress(task: Task) {
  if (task.completedAt) return `Done ${timeAgo(task.completedAt)}`
  if (!task.thread) return `Added ${timeAgo(task.createdAt)}`
  if (task.thread.openTickets > 0)
    return `${task.thread.openTickets} open ticket${task.thread.openTickets > 1 ? 's' : ''}`
  const [pull, ...more] = task.column === 'needs_you' ? task.thread.openPullRequests : []
  if (pull) return more.length ? `${more.length + 1} PRs to review` : `PR #${pull.number} to review`
  return `Updated ${timeAgo(task.thread.updatedAt)}`
}

function TaskCard({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const status = task.thread?.status
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full flex-col gap-2.5 rounded-lg border bg-card p-3 text-left shadow-xs transition-colors outline-none hover:border-foreground/20 focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span className="line-clamp-3 text-sm leading-snug font-semibold">{task.title}</span>
        <span className="flex flex-wrap items-center gap-1.5">
          <PriorityBadge priority={task.priority} quiet />
          {status &&
            !task.completedAt &&
            ['running', 'starting', 'failed', 'paused'].includes(status) && (
              <StatusBadge status={status} />
            )}
        </span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <TeammateAvatar teammate={task.teammate} className="size-5" />
          <span className="truncate font-medium text-foreground">{task.teammate.name}</span>
          <span className="ml-auto shrink-0">{progress(task)}</span>
        </span>
      </button>
    </li>
  )
}

/** The Tasks board: Backlog, Needs you, Doing and Done. */
export default function Tasks() {
  const tasks = useApi<Task[]>('/tasks')
  const [open, setOpen] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [allDone, setAllDone] = useState(false)

  // /app/tasks?task=<id> opens that task, e.g. from its thread.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('task')
    if (id) setOpen(id)
  }, [])
  const openTask = useCallback((id: string | null) => {
    setOpen(id)
    const url = new URL(window.location.href)
    if (id) url.searchParams.set('task', id)
    else url.searchParams.delete('task')
    window.history.replaceState(null, '', url)
  }, [])

  const reload = tasks.reload
  useLive((message) => {
    if (message.type === 'task.updated' || message.type === 'thread.updated') void reload()
  })

  const byColumn = (column: Task['column']) =>
    (tasks.data ?? []).filter((t) => t.column === column).sort(order)

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-extrabold tracking-tight">Tasks</h1>
          <p className="max-w-prose text-muted-foreground">
            Bigger work your teammates are on. Ask in a thread and they track it here, or add one
            yourself.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus aria-hidden />
          New task
        </Button>
      </header>

      <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map((column) => {
          const all = byColumn(column.id)
          const shown = column.id === 'done' && !allDone ? all.slice(0, DONE_SHOWN) : all
          return (
            <section
              key={column.id}
              aria-labelledby={`column-${column.id}`}
              className="flex flex-col gap-3 rounded-xl bg-secondary/50 p-3"
            >
              <h2
                id={`column-${column.id}`}
                className="flex items-center gap-2 px-1 text-sm font-bold"
              >
                <span
                  aria-hidden
                  className={cn(
                    'size-2 rounded-full',
                    column.tone === 'warning' && 'bg-warning',
                    column.tone === 'progress' && 'bg-primary',
                    column.tone === 'success' && 'bg-success',
                    column.tone === 'neutral' && 'bg-muted-foreground',
                  )}
                />
                {column.label}
                <span className="font-mono text-xs font-normal text-muted-foreground">
                  {tasks.data ? all.length : ''}
                </span>
              </h2>
              {!tasks.data ? (
                <Skeleton className="h-20 w-full" />
              ) : all.length === 0 ? (
                <p className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
                  {column.empty}
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {shown.map((t) => (
                    <TaskCard key={t.id} task={t} onOpen={() => openTask(t.id)} />
                  ))}
                </ul>
              )}
              {shown.length < all.length && (
                <Button variant="ghost" size="sm" onClick={() => setAllDone(true)}>
                  Show all {all.length}
                </Button>
              )}
            </section>
          )
        })}
      </div>
      {tasks.error && <p className="text-sm text-destructive-text">{tasks.error.message}</p>}

      <NewTaskDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(task) => {
          void reload()
          openTask(task.id)
        }}
      />
      <TaskSheet taskId={open} onClose={() => openTask(null)} onChanged={() => void reload()} />
    </div>
  )
}
