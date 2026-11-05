'use client'
import {
  ChevronRight,
  MessageSquare,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Trash2,
} from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { isAdmin, timeAgo, useDashboard } from '@/components/dashboard'
import { ProjectFilter } from '@/components/projects'
import { describeCron, localTimezone, ScheduleDialog, zoneName } from '@/components/schedules'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import type { RunOutcome } from '@brigade/contracts'
import { api, projectQuery, useApi, type Schedule } from '@/lib/api'
import { agendaOf, agendaTime } from '@/lib/routine-agenda'
import { cn } from '@/lib/utils'
import { useLive } from '@/lib/use-live'

const OUTCOME: Record<RunOutcome, { label: string; dot: string }> = {
  running: { label: 'Running', dot: 'bg-primary animate-pulse' },
  report: { label: 'Reported', dot: 'bg-success' },
  nothing: { label: 'Nothing to do', dot: 'bg-success' },
  ended: { label: 'Ended', dot: 'bg-success' },
  needs_person: { label: 'Needs a person', dot: 'bg-warning' },
  failed: { label: 'Failed', dot: 'bg-destructive-text' },
  cancelled: { label: 'Cancelled', dot: 'bg-muted-foreground/40' },
}

/** Its latest runs as dots, oldest first: each opens its thread. */
function RunDots({ runs, className }: { runs: Schedule['recentRuns']; className?: string }) {
  if (!runs.length) return null
  return (
    <span className={cn('items-center gap-1', className)}>
      {runs.map((run) => (
        <Link
          key={run.id}
          href={`/app/threads/${run.id}`}
          title={`${OUTCOME[run.outcome].label} · ${timeAgo(run.createdAt)}`}
          aria-label={`Run ${timeAgo(run.createdAt)}: ${OUTCOME[run.outcome].label}`}
          className="flex size-3 items-center justify-center rounded-full"
        >
          <span className={cn('size-2 rounded-full', OUTCOME[run.outcome].dot)} />
        </Link>
      ))}
    </span>
  )
}

const clock = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

/** One routine of the agenda: its time, its name and rhythm; Run now and its menu on hover. */
function ScheduleRow({
  schedule,
  onEdit,
  onChanged,
  showProject,
}: {
  schedule: Schedule
  onEdit: () => void
  onChanged: () => void
  showProject: boolean
}) {
  const { me } = useDashboard()
  const [error, setError] = useState<string>()
  const [note, setNote] = useState<string>()
  const [confirm, setConfirm] = useState(false)
  const [menu, setMenu] = useState(false)
  const owner = schedule.ownerMemberId === me.memberId
  const manager = owner || isAdmin(me)
  const active = !schedule.pausedAt
  const running = schedule.recentRuns.findLast((r) => r.outcome === 'running')
  const zone = schedule.timezone !== localTimezone() ? ` (${zoneName(schedule.timezone)})` : ''
  // Actions stay out of the way until the row is pointed at, unless in use or on a touch screen.
  const pinned = menu || confirm

  async function act(path: string, init: { method?: string; body?: unknown } = {}) {
    setError(undefined)
    setNote(undefined)
    try {
      await api(`/schedules/${schedule.id}${path}`, { method: 'POST', body: {}, ...init })
      if (path === '/run') setNote('Started')
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const meta: React.ReactNode[] = []
  if (running)
    meta.push(
      <Link
        key="running"
        href={`/app/threads/${running.id}`}
        className="font-semibold text-primary hover:underline"
      >
        Running since {clock(running.createdAt)}
      </Link>,
    )
  else if (!active) meta.push(<span key="paused">Paused</span>)
  else if (!schedule.nextRunAt) meta.push(<span key="over">No more runs</span>)
  meta.push(<span key="cron">{describeCron(schedule.cron) + zone}</span>)
  meta.push(<span key="teammate">{schedule.teammate.name}</span>)
  if (showProject && schedule.project) meta.push(<span key="project">{schedule.project.name}</span>)
  if (!owner) meta.push(<span key="owner">on {schedule.owner.user.name}&apos;s accounts</span>)

  return (
    <li className="group flex items-center gap-3 border-t px-4 py-3 first:border-t-0">
      <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">
        {active && schedule.nextRunAt ? agendaTime(schedule.nextRunAt) : '—'}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn('truncate font-semibold', !active && 'text-muted-foreground')}>
          {schedule.title}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {meta.flatMap((part, i) => (i ? [<span key={`sep-${i}`}> · </span>, part] : [part]))}
        </span>
        {schedule.lastError && (
          <span className="text-xs text-destructive-text">
            Couldn&apos;t start: {schedule.lastError}
          </span>
        )}
        {error && <span className="text-xs text-destructive-text">{error}</span>}
        {note && <span className="text-xs text-success">{note}</span>}
      </div>

      {confirm ? (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <span className="text-sm text-muted-foreground">Delete? Its threads stay.</span>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => void act('', { method: 'DELETE', body: undefined })}
          >
            Delete
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
            Keep it
          </Button>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-2">
          <RunDots
            runs={schedule.recentRuns}
            className={cn(
              'flex',
              manager &&
                !pinned &&
                '[@media(hover:hover)]:group-focus-within:hidden [@media(hover:hover)]:group-hover:hidden',
              manager && pinned && '[@media(hover:hover)]:hidden',
            )}
          />
          {manager && (
            <div
              className={cn(
                'items-center gap-1',
                pinned
                  ? 'flex'
                  : 'flex [@media(hover:hover)]:hidden [@media(hover:hover)]:group-focus-within:flex [@media(hover:hover)]:group-hover:flex',
              )}
            >
              <Button
                size="sm"
                variant="outline"
                className="[@media(hover:none)]:hidden"
                onClick={() => void act('/run')}
              >
                <Play aria-hidden />
                Run now
              </Button>
              <DropdownMenu open={menu} onOpenChange={setMenu}>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="ghost" aria-label="More">
                    <MoreHorizontal aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => void act('/run')}>
                    <Play aria-hidden />
                    Run now
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void act(active ? '/pause' : '/resume')}>
                    {active ? <Pause aria-hidden /> : <RotateCw aria-hidden />}
                    {active ? 'Pause' : 'Resume'}
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={!owner} onSelect={onEdit}>
                    <Pencil aria-hidden />
                    Edit
                  </DropdownMenuItem>
                  {schedule.parentSession && (
                    <DropdownMenuItem asChild>
                      <Link href={`/app/threads/${schedule.parentSession.id}`}>
                        <MessageSquare aria-hidden />
                        <span className="truncate">
                          Reports in “{schedule.parentSession.title}”
                        </span>
                      </Link>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => setConfirm(true)}>
                    <Trash2 aria-hidden />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      )}
    </li>
  )
}

function AgendaSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </h2>
      <ul className="rounded-xl border bg-card">{children}</ul>
    </section>
  )
}

/** The fold's name: what the routines that are not coming up are. */
function restLabel(rest: Schedule[]) {
  const paused = rest.filter((s) => s.pausedAt).length
  if (paused === rest.length) return 'Paused'
  if (paused === 0) return 'No more runs'
  return 'Paused or finished'
}

/**
 * Routines: schedules that prompt a teammate at set times, as an agenda: each once, under the
 * day of its next run (lib/routine-agenda.ts). In a project, its own. Playbooks have their own
 * page.
 */
export function ScheduleList({
  projectId,
  initialFilter = '',
}: {
  projectId?: string
  /** The project filter it opens with, e.g. from `?project=` (a project's page links there). */
  initialFilter?: string
}) {
  const [filter, setFilter] = useState(initialFilter)
  const schedules = useApi<Schedule[]>(`/schedules${projectQuery(projectId ?? filter)}`)
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null)
  const reload = schedules.reload
  // A run's thread changing status changes the row's last run.
  useLive((message) => {
    if (message.type === 'schedule.updated' || message.type === 'thread.updated') void reload()
  })

  const list = schedules.data ?? []
  const { groups, rest } = agendaOf(list)
  const [showRest, setShowRest] = useState(false)
  const row = (s: Schedule) => (
    <ScheduleRow
      key={s.id}
      schedule={s}
      onEdit={() => setEditing(s)}
      onChanged={() => void reload()}
      showProject={!projectId}
    />
  )

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        {!projectId && (
          <div className="flex flex-col gap-1">
            <h1 className="text-3xl font-extrabold tracking-tight">Routines</h1>
            <p className="max-w-prose text-muted-foreground">
              Work your teammates do on a schedule, in a fresh thread each time. Ask a teammate in a
              thread, or add a schedule yourself.
            </p>
          </div>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          {!projectId && <ProjectFilter value={filter} onChange={setFilter} />}
          <Button onClick={() => setEditing('new')}>
            <Plus aria-hidden />
            New schedule
          </Button>
        </div>
      </header>

      {!schedules.data ? (
        <Skeleton className="h-24 w-full" />
      ) : list.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No schedules yet. Try &ldquo;Every weekday at 9:00, summarize yesterday&rsquo;s new
          issues&rdquo;.
        </p>
      ) : (
        <>
          {groups.map((group) => (
            <AgendaSection key={group.key} label={group.label}>
              {group.items.map(row)}
            </AgendaSection>
          ))}
          {rest.length > 0 && (
            <section className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setShowRest((open) => !open)}
                aria-expanded={showRest}
                className="flex items-center gap-1 self-start rounded-sm text-sm text-muted-foreground hover:text-foreground"
              >
                {restLabel(rest)} · {rest.length}
                <ChevronRight
                  className={cn('size-3.5 transition-transform', showRest && 'rotate-90')}
                  aria-hidden
                />
              </button>
              {showRest && <ul className="rounded-xl border bg-card">{rest.map(row)}</ul>}
            </section>
          )}
        </>
      )}
      {schedules.error && (
        <p className="text-sm text-destructive-text">{schedules.error.message}</p>
      )}

      <ScheduleDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        schedule={editing && editing !== 'new' ? editing : undefined}
        onSaved={() => void reload()}
        projectId={projectId ?? (filter && filter !== 'none' ? filter : undefined)}
      />
    </div>
  )
}
