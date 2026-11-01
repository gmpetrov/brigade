'use client'
// The Board (docs/board.md): what moves across the workspace's lists, threads and routines, in
// three columns, with the routines above and the threads that stopped without being done below.
// The API computes it (GET /board); this page filters it by project, list and teammate.
import type { Board, BoardCard, BoardColumn, BoardRoutine, BoardStopped } from '@brigade/contracts'
import {
  ChevronDown,
  Clock,
  GitPullRequest,
  ListChecks,
  MessageSquare,
  RefreshCw,
  X,
} from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TeammateAvatar, timeAgo, useDashboard } from '@/components/dashboard'
import { ProjectSelect } from '@/components/projects'
import { describeCron, scheduleTime } from '@/components/schedules'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError, useApi } from '@/lib/api'
import { listen } from '@/lib/use-live'
import { cn } from '@/lib/utils'

/** What changes the Board: it reloads once these settle, not on each one. */
const LIVE = new Set([
  'thread.updated',
  'tickets.updated',
  'pulls.updated',
  'lists.updated',
  'schedule.updated',
  'task.updated',
])
const SETTLE_MS = 1500
/** Done cards shown before Show more. */
const DONE_SHOWN = 8

const COLUMNS: { value: BoardColumn; label: string; dot: string; hint?: string }[] = [
  { value: 'needs_you', label: 'Needs you', dot: 'bg-warning' },
  { value: 'in_progress', label: 'In progress', dot: 'bg-primary' },
  { value: 'done', label: 'Done', dot: 'bg-success', hint: '7 days' },
]

/** "Not on a list": the list filter's value for threads and routines on no list. */
const NO_LIST = 'none'

type Filters = { project: string; lists: string[]; teammate: string }

const projectMatches = (project: string, projectId: string | null) =>
  !project || (project === 'none' ? !projectId : projectId === project)

/** The filters in the address, so a list's page can link to the Board on its list. */
function useFilters(): [Filters, (next: Partial<Filters>) => void] {
  const [filters, setFilters] = useState<Filters>({ project: '', lists: [], teammate: '' })
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    setFilters({
      project: params.get('project') ?? '',
      lists: params.getAll('list'),
      teammate: params.get('teammate') ?? '',
    })
  }, [])
  const change = useCallback((next: Partial<Filters>) => {
    setFilters((current) => {
      const merged = { ...current, ...next }
      const url = new URL(window.location.href)
      url.search = ''
      if (merged.project) url.searchParams.set('project', merged.project)
      for (const l of merged.lists) url.searchParams.append('list', l)
      if (merged.teammate) url.searchParams.set('teammate', merged.teammate)
      window.history.replaceState(null, '', url)
      return merged
    })
  }, [])
  return [filters, change]
}

/** The Board, reloaded once a burst of changes settles. */
function useBoard() {
  const board = useApi<Board>('/board')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const { reload } = board
  useEffect(() => {
    const stop = listen((message) => {
      if (!LIVE.has(message.type)) return
      clearTimeout(timer.current)
      timer.current = setTimeout(() => void reload(), SETTLE_MS)
    }, reload)
    return () => {
      clearTimeout(timer.current)
      stop()
    }
  }, [reload])
  return board
}

const cardTeammates = (card: BoardCard) => card.threads.map((t) => t.teammate.id)

/** Why a card waits on a person, or what it waits on, in a few words. */
function reasonText(card: BoardCard) {
  switch (card.reason) {
    case 'ticket':
      return 'Ticket open'
    case 'waiting':
      return 'Waiting on an answer'
    case 'pull':
      return 'Merge or decide'
    case 'failed':
      return 'Failed'
    case 'routine_failed':
      return 'Last run failed'
    case 'working':
      return 'Working'
    case 'wakeup':
      return 'Wake-up set'
    case 'review':
      return 'Pull request in review'
    default:
      return null
  }
}

function Source({ card }: { card: BoardCard }) {
  const Icon =
    card.kind === 'item' ? ListChecks : card.kind === 'routine' ? RefreshCw : MessageSquare
  const text =
    card.kind === 'item' && card.list
      ? [card.list.title, card.list.section].filter(Boolean).join(' · ')
      : card.kind === 'routine'
        ? 'Routine'
        : 'Not on a list'
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{text}</span>
    </span>
  )
}

function PullChip({ pull }: { pull: BoardCard['pulls'][number] }) {
  const merged = pull.state === 'merged'
  return (
    <a
      href={pull.url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'inline-flex h-5.5 shrink-0 items-center gap-1 rounded-full px-2 font-mono text-[11px]',
        merged ? 'bg-success/15 text-success' : 'bg-primary/15 text-primary',
      )}
    >
      <GitPullRequest aria-hidden className="size-3" />#{pull.number} {pull.state}
    </a>
  )
}

function CardView({ card }: { card: BoardCard }) {
  const bad = card.reason === 'failed' || card.reason === 'routine_failed'
  const reason = card.column === 'done' ? null : reasonText(card)
  const thread = card.threads[0]
  const body = (
    <>
      <Source card={card} />
      <span
        className={cn(
          'line-clamp-3 text-[13.5px] leading-snug font-semibold',
          card.column === 'done' && 'font-medium text-muted-foreground',
        )}
      >
        {card.title}
      </span>
      {card.note && (
        <span
          className={cn(
            'line-clamp-2 text-[12.5px] leading-snug',
            bad ? 'text-destructive-text' : 'text-muted-foreground',
          )}
        >
          {card.note}
        </span>
      )}
      <span className="flex flex-wrap items-center gap-1.5">
        {thread && (
          <span className="inline-flex h-5.5 max-w-full min-w-0 items-center gap-1.5 rounded-full border pr-2 pl-0.5 text-[11.5px] text-muted-foreground">
            <TeammateAvatar teammate={thread.teammate} className="size-4.5" />
            <span className="truncate">{thread.routine?.title ?? thread.teammate.name}</span>
            {thread.routine && (
              <span className="shrink-0 rounded-full border px-1 text-[10px] leading-3.5 font-semibold">
                routine
              </span>
            )}
          </span>
        )}
        {card.pulls.slice(-2).map((p) => (
          <PullChip key={`${p.repository}#${p.number}`} pull={p} />
        ))}
        {reason && (
          <span
            className={cn(
              'text-xs font-semibold',
              card.column === 'needs_you'
                ? bad
                  ? 'text-destructive-text'
                  : 'text-warning'
                : 'font-normal text-muted-foreground',
            )}
          >
            {reason}
          </span>
        )}
        {card.done && (
          <span className="text-xs text-muted-foreground">
            {[card.done.by, timeAgo(card.done.at)].filter(Boolean).join(' · ')}
          </span>
        )}
      </span>
    </>
  )
  const className = cn(
    'flex w-full flex-col gap-2 rounded-xl border bg-card p-3 text-left shadow-xs transition-colors outline-none hover:border-foreground/20 focus-visible:ring-[3px] focus-visible:ring-ring/50',
    bad && 'border-destructive-text/40',
  )
  return (
    <li>
      {card.href ? (
        <Link href={card.href} className={className}>
          {body}
        </Link>
      ) : (
        <div className={className}>{body}</div>
      )}
    </li>
  )
}

function Column({
  column,
  cards,
  footer,
}: {
  column: (typeof COLUMNS)[number]
  cards: BoardCard[]
  footer?: React.ReactNode
}) {
  return (
    <section
      aria-label={column.label}
      className="flex min-w-0 flex-col gap-2 rounded-3xl bg-secondary p-2.5"
    >
      <h2 className="flex items-center gap-2 px-1.5 pt-1 text-[13.5px] font-bold">
        <span aria-hidden className={cn('size-1.5 rounded-full', column.dot)} />
        {column.label}
        <span className="font-mono text-xs font-medium text-muted-foreground">{cards.length}</span>
        {column.hint && (
          <span className="ml-auto text-xs font-medium text-muted-foreground">{column.hint}</span>
        )}
      </h2>
      {cards.length === 0 ? (
        <p className="px-1.5 pb-1.5 text-xs text-muted-foreground">
          {column.value === 'needs_you'
            ? 'Nothing is waiting on you.'
            : column.value === 'in_progress'
              ? 'Nothing is moving.'
              : 'Nothing done this week yet.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {cards.map((c) => (
            <CardView key={c.key} card={c} />
          ))}
        </ul>
      )}
      {footer}
    </section>
  )
}

const HEALTH: Record<BoardRoutine['health'], { label: string; tone: string }> = {
  ok: { label: 'OK', tone: 'text-success bg-success/15' },
  degraded: { label: 'Degraded', tone: 'text-warning bg-warning/15' },
  failed: { label: 'Failed', tone: 'text-destructive-text bg-destructive/15' },
  paused: { label: 'Paused', tone: 'text-muted-foreground bg-secondary' },
  new: { label: 'New', tone: 'text-muted-foreground bg-secondary' },
}

/** What a routine did today, or last: what it produced first, the runs that found nothing counted. */
function RoutineLast({ routine }: { routine: BoardRoutine }) {
  const parts: React.ReactNode[] = []
  if (routine.running)
    parts.push(
      <span key="running" className="inline-flex items-center gap-1.5 font-semibold text-primary">
        <span aria-hidden className="size-1.5 rounded-full bg-primary" />
        Running
      </span>,
    )
  if (routine.error)
    parts.push(
      <span key="error" className="font-semibold text-destructive-text">
        Couldn&apos;t start: {routine.error}
      </span>,
    )
  else if (routine.today.runs > 0) {
    const pulls = routine.today.pulls
    const others = routine.today.runs - routine.today.nothing - (routine.running ? 1 : 0)
    parts.push(<span key="today">today</span>)
    if (pulls.length)
      parts.push(
        <span key="pulls" className="font-semibold text-foreground">
          opened {pulls.map((p) => `#${p.number}`).join(', ')}
        </span>,
      )
    else if (others > 0)
      parts.push(
        <span key="reported" className="font-semibold text-foreground">
          {others} {others === 1 ? 'run' : 'runs'} reported
        </span>,
      )
    if (routine.today.nothing)
      parts.push(
        <span key="nothing">
          {routine.today.nothing} {routine.today.nothing === 1 ? 'run' : 'runs'}, nothing to do
        </span>,
      )
  } else if (routine.last)
    parts.push(
      <span key="last">
        {timeAgo(routine.last.at)} ·{' '}
        <span
          className={cn(
            'font-semibold',
            routine.last.outcome === 'failed' ? 'text-destructive-text' : 'text-foreground',
          )}
        >
          {routine.last.outcome === 'nothing'
            ? 'nothing to do'
            : routine.last.outcome === 'failed'
              ? 'failed'
              : routine.last.outcome === 'needs_person'
                ? 'waits on a person'
                : (routine.last.summary ?? 'ran')}
        </span>
      </span>,
    )
  else parts.push(<span key="none">No run yet</span>)
  return (
    <span className="min-w-0 truncate text-[12.5px] text-muted-foreground">
      {parts.flatMap((p, i) => (i ? [' · ', p] : [p]))}
    </span>
  )
}

function Routines({ routines, filtered }: { routines: BoardRoutine[]; filtered: boolean }) {
  const [all, setAll] = useState(false)
  if (!routines.length) return null
  const shown = all ? routines : routines.slice(0, 5)
  return (
    <section
      aria-labelledby="board-routines"
      className="overflow-hidden rounded-3xl border bg-card shadow-sm"
    >
      <div className="flex items-center gap-2 px-5 pt-3 pb-2">
        <Clock aria-hidden className="size-4" />
        <h2 id="board-routines" className="text-[13.5px] font-bold">
          {filtered ? 'Routines on this list' : 'Routines'}
        </h2>
        <span className="text-[12.5px] text-muted-foreground">{routines.length}</span>
        <Link
          href="/app/routines"
          className="ml-auto text-[12.5px] font-semibold text-muted-foreground hover:text-foreground"
        >
          All routines
        </Link>
      </div>
      <ul>
        {shown.map((r) => {
          const health = HEALTH[r.health]
          return (
            <li
              key={r.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-t px-5 py-2 text-[13px] md:grid-cols-[minmax(0,2fr)_9rem_minmax(0,1.7fr)_6.5rem]"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-semibold">{r.title}</span>
                <span className="hidden shrink-0 text-[12.5px] text-muted-foreground lg:inline">
                  {describeCron(r.cron)}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <span
                  className={cn(
                    'inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-[11px] font-semibold',
                    health.tone,
                  )}
                >
                  <span aria-hidden className="size-1.5 rounded-full bg-current" />
                  {health.label}
                </span>
                {r.week.runs > 0 && (
                  <span
                    className="hidden font-mono text-[11px] text-muted-foreground md:inline"
                    title="Runs that didn't fail, of the last 7 days"
                  >
                    {r.week.runs - r.week.failed}/{r.week.runs}
                  </span>
                )}
              </span>
              <span className="col-span-2 min-w-0 md:col-span-1">
                <RoutineLast routine={r} />
              </span>
              <span className="hidden text-right text-[12.5px] whitespace-nowrap text-muted-foreground md:inline">
                {r.health === 'paused' || !r.nextRunAt
                  ? '—'
                  : `Next ${scheduleTime(r.nextRunAt, r.timezone)}`}
              </span>
            </li>
          )
        })}
      </ul>
      {routines.length > shown.length && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="w-full border-t px-5 py-2 text-left text-[12.5px] font-semibold text-muted-foreground hover:text-foreground"
        >
          Show {routines.length - shown.length} more
        </button>
      )}
    </section>
  )
}

function StoppedRow({ row, onChange }: { row: BoardStopped; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const run = async (path: string) => {
    setBusy(true)
    setError(undefined)
    try {
      await api(path, { method: 'POST' })
      onChange()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const closes = Math.max(
    0,
    Math.ceil((new Date(row.closesAt).getTime() - Date.now()) / 86_400_000),
  )
  return (
    <li className="flex items-center gap-3 border-t px-5 py-2">
      <TeammateAvatar teammate={row.teammate} className="size-5" />
      <Link href={row.href} className="flex min-w-0 flex-1 flex-col hover:underline-offset-2">
        <span className="truncate text-[13.5px] font-semibold">{row.title}</span>
        <span className="truncate text-xs text-muted-foreground">
          {[
            row.list?.title ?? 'Not on a list',
            row.teammate.name,
            `idle since ${timeAgo(row.idleSince)}`,
            closes === 0 ? 'closes today' : `closes in ${closes} ${closes === 1 ? 'day' : 'days'}`,
          ].join(' · ')}
        </span>
        {error && <span className="text-xs text-destructive-text">{error}</span>}
      </Link>
      {row.canClose && (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void run(`/threads/${row.threadId}/done`)}
          >
            Mark done
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void run(`/threads/${row.threadId}/archive`)}
            className="hidden text-muted-foreground sm:inline-flex"
          >
            Archive
          </Button>
        </>
      )}
    </li>
  )
}

function Stopped({ rows, onChange }: { rows: BoardStopped[]; onChange: () => void }) {
  const [open, setOpen] = useState(rows.length <= 5)
  if (!rows.length) return null
  return (
    <section
      aria-labelledby="board-stopped"
      className="overflow-hidden rounded-3xl border border-dashed"
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-5 py-2.5 text-left"
      >
        <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground" />
        <h2 id="board-stopped" className="text-[13.5px] font-bold">
          Stopped
        </h2>
        <span className="font-mono text-xs text-muted-foreground">{rows.length}</span>
        <span className="hidden truncate text-[12.5px] text-muted-foreground sm:inline">
          Idle, not done, nothing pending. They close after 7 days without activity.
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            'ml-auto size-4 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && (
        <ul>
          {rows.map((r) => (
            <StoppedRow key={r.key} row={r} onChange={onChange} />
          ))}
        </ul>
      )}
    </section>
  )
}

function ListChips({
  lists,
  chosen,
  counts,
  onChange,
}: {
  lists: Board['lists']
  chosen: string[]
  counts: Map<string, number>
  onChange: (lists: string[]) => void
}) {
  const toggle = (id: string) =>
    onChange(chosen.includes(id) ? chosen.filter((l) => l !== id) : [...chosen, id])
  const chip = (id: string, label: string) => {
    const on = chosen.includes(id)
    return (
      <button
        key={id}
        type="button"
        aria-pressed={on}
        onClick={() => toggle(id)}
        className={cn(
          'inline-flex h-8 max-w-64 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium text-muted-foreground',
          on && 'border-primary/50 bg-primary/15 font-semibold text-foreground',
        )}
      >
        <span className="truncate">{label}</span>
        <span className="font-mono text-[11.5px]">{counts.get(id) ?? 0}</span>
        {on && <X aria-hidden className="size-3 shrink-0" />}
      </button>
    )
  }
  return (
    <div role="group" aria-label="Lists" className="flex min-w-0 flex-wrap items-center gap-2">
      <button
        type="button"
        aria-pressed={chosen.length === 0}
        onClick={() => onChange([])}
        className={cn(
          'inline-flex h-8 items-center rounded-full border px-3 text-[13px] font-medium text-muted-foreground',
          chosen.length === 0 && 'border-primary/50 bg-primary/15 font-semibold text-foreground',
        )}
      >
        All lists
      </button>
      {lists.map((l) => chip(l.documentId, l.title))}
      {chip(NO_LIST, 'Not on a list')}
    </div>
  )
}

function TeammateFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { teammates } = useDashboard()
  const chosen = teammates.find((t) => t.id === value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="ml-auto">
          <span className="text-muted-foreground">Teammate:</span> {chosen?.name ?? 'Everyone'}
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={value || 'all'}
          onValueChange={(v) => onChange(v === 'all' ? '' : v)}
        >
          <DropdownMenuRadioItem value="all">Everyone</DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {teammates.map((t) => (
            <DropdownMenuRadioItem key={t.id} value={t.id}>
              {t.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function BoardPage() {
  const board = useBoard()
  const [filters, setFilters] = useFilters()
  const [column, setColumn] = useState<BoardColumn>('needs_you')
  const [allDone, setAllDone] = useState(false)
  const [showClosed, setShowClosed] = useState(false)

  const view = useMemo(() => {
    const data = board.data
    if (!data) return null
    const { project, lists, teammate } = filters
    const inProject = (projectId: string | null) => projectMatches(project, projectId)
    const onLists = (listId: string | null) => !lists.length || lists.includes(listId ?? NO_LIST)
    const byTeammate = (ids: string[]) => !teammate || ids.includes(teammate)
    // Counts for the chips: what the other filters leave, per list.
    const counts = new Map<string, number>()
    for (const c of data.cards)
      if (inProject(c.projectId) && byTeammate(cardTeammates(c))) {
        const id = c.list?.documentId ?? NO_LIST
        counts.set(id, (counts.get(id) ?? 0) + 1)
      }
    const cards = data.cards.filter(
      (c) =>
        inProject(c.projectId) &&
        onLists(c.list?.documentId ?? null) &&
        byTeammate(cardTeammates(c)),
    )
    const stopped = data.stopped.filter(
      (s) =>
        inProject(s.projectId) &&
        onLists(s.list?.documentId ?? null) &&
        byTeammate([s.teammate.id]),
    )
    // On some lists only: the routines whose runs worked on them.
    const listOnly = lists.length > 0 && !lists.includes(NO_LIST)
    const routines = data.routines.filter(
      (r) =>
        inProject(r.projectId) &&
        byTeammate([r.teammate.id]) &&
        (!listOnly || r.listIds.some((id) => lists.includes(id))),
    )
    const closed =
      lists.length && !lists.includes(NO_LIST)
        ? []
        : data.closed.filter((c) => inProject(c.projectId))
    return {
      counts,
      routines,
      listOnly,
      stopped,
      closed,
      lists: data.lists.filter((l) => inProject(l.projectId) || lists.includes(l.documentId)),
      columns: Object.fromEntries(
        COLUMNS.map((col) => [col.value, cards.filter((c) => c.column === col.value)]),
      ) as Record<BoardColumn, BoardCard[]>,
    }
  }, [board.data, filters])

  if (board.error) return <p className="text-sm text-destructive-text">{board.error.message}</p>
  if (!view)
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-10 w-48 rounded-full" />
        <Skeleton className="h-32 w-full rounded-3xl" />
        <Skeleton className="h-96 w-full rounded-3xl" />
      </div>
    )

  const { columns } = view
  const done = allDone ? columns.done : columns.done.slice(0, DONE_SHOWN)
  const summary = [
    columns.needs_you.length > 0 && (
      <span key="n" className="font-semibold text-warning">
        {columns.needs_you.length} {columns.needs_you.length === 1 ? 'needs' : 'need'} you
      </span>
    ),
    <span key="p">
      <span className="font-semibold text-foreground">{columns.in_progress.length}</span> in
      progress
    </span>,
    view.stopped.length > 0 && <span key="s">{view.stopped.length} stopped</span>,
    <span key="d">{columns.done.length} done this week</span>,
  ].filter(Boolean)

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-extrabold tracking-tight">Board</h1>
        <p className="text-[13.5px] text-muted-foreground">
          {summary.flatMap((p, i) => (i ? [' · ', p] : [p]))}
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <ProjectSelect
          value={filters.project}
          onChange={(project) => setFilters({ project })}
          all
          className="h-8 sm:w-44"
        />
        <ListChips
          lists={view.lists}
          chosen={filters.lists}
          counts={view.counts}
          onChange={(lists) => setFilters({ lists })}
        />
        <TeammateFilter
          value={filters.teammate}
          onChange={(teammate) => setFilters({ teammate })}
        />
      </div>

      <Routines routines={view.routines} filtered={view.listOnly} />

      {/* On a phone, one column at a time. */}
      <div
        role="radiogroup"
        aria-label="Column"
        className="flex gap-0.5 rounded-full bg-secondary p-[3px] md:hidden"
      >
        {COLUMNS.map((c) => (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={column === c.value}
            onClick={() => setColumn(c.value)}
            className={cn(
              'flex h-7.5 flex-1 items-center justify-center gap-1.5 rounded-full text-[13px] text-muted-foreground',
              column === c.value && 'bg-card font-semibold text-foreground shadow-xs',
            )}
          >
            <span aria-hidden className={cn('size-1.5 rounded-full', c.dot)} />
            {c.label}
            <span className="font-mono text-[11.5px]">{columns[c.value].length}</span>
          </button>
        ))}
      </div>

      <div className="grid items-start gap-3 md:grid-cols-3">
        {COLUMNS.map((c) => (
          <div key={c.value} className={cn(column !== c.value && 'hidden md:block')}>
            <Column
              column={c}
              cards={c.value === 'done' ? done : columns[c.value]}
              footer={
                c.value === 'done' && (
                  <>
                    {columns.done.length > done.length && (
                      <button
                        type="button"
                        onClick={() => setAllDone(true)}
                        className="py-1 text-[12.5px] font-semibold text-muted-foreground hover:text-foreground"
                      >
                        Show {columns.done.length - done.length} more
                      </button>
                    )}
                    {view.closed.length > 0 && (
                      <div className="flex flex-col gap-1 px-1.5 pb-1">
                        <button
                          type="button"
                          aria-expanded={showClosed}
                          onClick={() => setShowClosed(!showClosed)}
                          className="text-center text-[12.5px] text-muted-foreground hover:text-foreground"
                        >
                          {view.closed.length} closed with no activity
                        </button>
                        {showClosed && (
                          <ul className="flex flex-col gap-0.5">
                            {view.closed.map((t) => (
                              <li key={t.id}>
                                <Link
                                  href={`/app/threads/${t.id}`}
                                  className="block truncate text-[12.5px] text-muted-foreground hover:text-foreground"
                                >
                                  {t.title}
                                </Link>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </>
                )
              }
            />
          </div>
        ))}
      </div>

      <Stopped rows={view.stopped} onChange={() => void board.reload()} />
    </div>
  )
}
