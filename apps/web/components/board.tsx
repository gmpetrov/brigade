'use client'
// The Board (docs/board.md): what moves across the workspace's lists, threads and failing
// routines, in three columns, with the threads that stopped without being done below. Routines
// themselves are on the Routines page and Home.
// The API computes it (GET /board); this page filters it by project, list and teammate.
import type { Board, BoardCard, BoardColumn, BoardRoutine, BoardStopped } from '@brigade/contracts'
import { AlarmClock, ChevronDown, GitPullRequest, ListChecks, ListFilter, X } from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { TeammateAvatar, timeAgo, useDashboard } from '@/components/dashboard'
import { ProjectIcon } from '@/components/projects'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { shortWakeTime, wakeTime } from '@/components/wakeup-icon'
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

/** "Not on a list": the list filter's value for threads on no list. */
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

/** The Board, reloaded once a burst of changes settles. Home reads it too. */
export function useBoard() {
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

/** What a person does for a card in Needs you, in a few words. Other columns say nothing. */
function actionText(card: BoardCard) {
  switch (card.reason) {
    case 'ticket':
      return 'Answer ticket'
    case 'waiting':
      return 'Reply'
    case 'pull': {
      const open = card.pulls.filter((p) => p.state === 'open')
      return open.length ? `Merge ${open.map((p) => `#${p.number}`).join(', ')}` : 'Merge or decide'
    }
    case 'failed':
      return 'Failed'
    case 'routine_failed':
      return 'Last run failed'
    default:
      return null
  }
}

/** The list a card is a line of; nothing for a thread on no list. */
function Source({ card }: { card: BoardCard }) {
  if (card.kind !== 'item' || !card.list) return null
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
      <ListChecks aria-hidden className="size-3 shrink-0" />
      <span className="truncate">
        {[card.list.title, card.list.section].filter(Boolean).join(' · ')}
      </span>
    </span>
  )
}

/** The card's latest pull request, its color saying its state, and how many others it has. */
function PullChip({ pulls }: { pulls: BoardCard['pulls'] }) {
  const pull = pulls.at(-1)
  if (!pull) return null
  const merged = pull.state === 'merged'
  return (
    <span className="flex shrink-0 items-center gap-1">
      <a
        href={pull.url}
        target="_blank"
        rel="noreferrer"
        title={`${pull.repository}#${pull.number} ${pull.state}`}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'inline-flex h-5.5 items-center gap-1 rounded-full px-2 font-mono text-[11px]',
          merged
            ? 'bg-success/15 text-success'
            : pull.state === 'open'
              ? 'bg-primary/15 text-primary'
              : 'bg-secondary text-muted-foreground',
        )}
      >
        <GitPullRequest aria-hidden className="size-3" />#{pull.number}
      </a>
      {pulls.length > 1 && (
        <span className="font-mono text-[11px] text-muted-foreground">+{pulls.length - 1}</span>
      )}
    </span>
  )
}

function CardView({ card }: { card: BoardCard }) {
  const bad = card.reason === 'failed' || card.reason === 'routine_failed'
  const action = card.column === 'needs_you' ? actionText(card) : null
  const working = card.column === 'in_progress' && card.reason === 'working'
  const thread = card.threads[0]
  const who = thread ? (thread.routine?.title ?? thread.teammate.name) : null
  const byline = [
    who,
    card.done?.by && card.done.by !== who ? card.done.by : null,
    card.done && timeAgo(card.done.at),
  ].filter(Boolean)
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
            'text-[12.5px] leading-snug',
            bad ? 'line-clamp-2 text-destructive-text' : 'line-clamp-1 text-muted-foreground',
          )}
        >
          {card.note}
        </span>
      )}
      <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
        {thread && (
          <span className="relative shrink-0" title={working ? 'Working now' : undefined}>
            <TeammateAvatar teammate={thread.teammate} className="size-4.5" />
            {working && (
              <span
                aria-label="Working now"
                className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full border-2 border-card bg-primary"
              />
            )}
          </span>
        )}
        {byline.length > 0 && <span className="min-w-0 truncate">{byline.join(' · ')}</span>}
        {card.wakeAt && card.column !== 'done' && (
          <span
            title={`Wake-up at ${wakeTime(card.wakeAt)}`}
            className="flex shrink-0 items-center gap-1"
          >
            <AlarmClock aria-hidden className="size-3" />
            <span className="sr-only">Wake-up at </span>
            {shortWakeTime(card.wakeAt)}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {card.reason !== 'pull' || card.column !== 'needs_you' ? (
            <PullChip pulls={card.pulls} />
          ) : null}
          {action && (
            <span
              className={cn(
                'text-xs font-semibold',
                bad ? 'text-destructive-text' : 'text-warning',
              )}
            >
              {action}
            </span>
          )}
        </span>
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
    // From md up, a column stops at the window's height (less the page's header above it, and
    // room for the Stopped bar below) and its cards scroll inside it; the page still scrolls
    // down to Stopped. On a phone, one column shows at a time and the page scrolls.
    <section
      aria-label={column.label}
      className="flex min-w-0 flex-col gap-2 rounded-3xl bg-secondary p-2.5 md:max-h-[max(24rem,calc(100dvh-16rem))]"
    >
      <h2 className="flex items-center gap-2 px-1.5 pt-1 text-[13.5px] font-bold">
        <span aria-hidden className={cn('size-1.5 rounded-full', column.dot)} />
        {column.label}
        <span className="font-mono text-xs font-medium text-muted-foreground">{cards.length}</span>
        {column.hint && (
          <span className="ml-auto text-xs font-medium text-muted-foreground">{column.hint}</span>
        )}
      </h2>
      {/* -m-1 p-1: room for a card's focus ring, which the scroll box would cut off. */}
      <div className="-m-1 flex min-h-0 flex-col gap-2 p-1 scroll-fade-y md:overflow-y-auto">
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
      </div>
    </section>
  )
}

/** What a routine did today, or last: what it produced first, the runs that found nothing counted. */
export function RoutineLast({ routine }: { routine: BoardRoutine }) {
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

function Stopped({
  rows,
  open,
  setOpen,
  onChange,
}: {
  rows: BoardStopped[]
  open: boolean
  setOpen: (open: boolean) => void
  onChange: () => void
}) {
  if (!rows.length) return null
  return (
    <section
      id="stopped"
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

type FilterKey = keyof Filters
const FILTER_LABELS: Record<FilterKey, string> = {
  project: 'Project',
  lists: 'List',
  teammate: 'Teammate',
}

/** What each filter offers, shared by the Filter menu and a filter's own pill. */
function FilterChoices({
  which,
  filters,
  lists,
  counts,
  onChange,
}: {
  which: FilterKey
  filters: Filters
  lists: Board['lists']
  counts: Map<string, number>
  onChange: (next: Partial<Filters>) => void
}) {
  const { projects, teammates } = useDashboard()
  if (which === 'project') {
    const shown = projects.filter((p) => !p.archivedAt || p.id === filters.project)
    return (
      <DropdownMenuRadioGroup
        value={filters.project}
        onValueChange={(project) => onChange({ project })}
      >
        {shown.map((p) => (
          <DropdownMenuRadioItem key={p.id} value={p.id}>
            <ProjectIcon project={p} className="size-4 text-[0.625rem]" />
            {p.name}
          </DropdownMenuRadioItem>
        ))}
        {shown.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuRadioItem value="none">No project</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    )
  }
  if (which === 'teammate')
    return (
      <DropdownMenuRadioGroup
        value={filters.teammate}
        onValueChange={(teammate) => onChange({ teammate })}
      >
        {teammates.map((t) => (
          <DropdownMenuRadioItem key={t.id} value={t.id}>
            <TeammateAvatar teammate={t} className="size-4.5" />
            {t.name}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    )
  const chosen = filters.lists
  const toggle = (id: string) =>
    onChange({ lists: chosen.includes(id) ? chosen.filter((l) => l !== id) : [...chosen, id] })
  const item = (id: string, label: string) => (
    <DropdownMenuCheckboxItem
      key={id}
      checked={chosen.includes(id)}
      // Several lists at once: the menu stays open while they are ticked.
      onSelect={(e) => e.preventDefault()}
      onCheckedChange={() => toggle(id)}
      className="max-w-80"
    >
      <span className="min-w-0 flex-1">{label}</span>
      <span className="font-mono text-[11.5px] text-muted-foreground">{counts.get(id) ?? 0}</span>
    </DropdownMenuCheckboxItem>
  )
  return (
    <>
      {lists.map((l) => item(l.documentId, l.title))}
      {lists.length > 0 && <DropdownMenuSeparator />}
      {item(NO_LIST, 'Not on a list')}
    </>
  )
}

/**
 * The Board's filters: a Filter button that adds one, and a pill per filter set, after it.
 * A pill opens its filter's choices again; its × removes it.
 */
function FilterBar({
  filters,
  lists,
  counts,
  onChange,
}: {
  filters: Filters
  lists: Board['lists']
  counts: Map<string, number>
  onChange: (next: Partial<Filters>) => void
}) {
  const { projects, teammates } = useDashboard()
  const set: Record<FilterKey, boolean> = {
    project: !!filters.project,
    lists: filters.lists.length > 0,
    teammate: !!filters.teammate,
  }
  const offered: FilterKey[] = (['project', 'lists', 'teammate'] as const).filter(
    (k) =>
      !set[k] &&
      (k !== 'project' || projects.length > 0) &&
      (k !== 'teammate' || teammates.length > 0),
  )
  const listTitle = (id: string) =>
    id === NO_LIST ? 'Not on a list' : (lists.find((l) => l.documentId === id)?.title ?? 'A list')
  const value: Record<FilterKey, ReactNode> = {
    project:
      filters.project === 'none'
        ? 'No project'
        : (projects.find((p) => p.id === filters.project)?.name ?? 'A project'),
    lists: filters.lists.length ? listTitle(filters.lists[0]!) : null,
    teammate: teammates.find((t) => t.id === filters.teammate)?.name ?? 'A teammate',
  }
  const cleared: Record<FilterKey, Partial<Filters>> = {
    project: { project: '' },
    lists: { lists: [] },
    teammate: { teammate: '' },
  }
  const choices = (which: FilterKey) => (
    <FilterChoices
      which={which}
      filters={filters}
      lists={lists}
      counts={counts}
      onChange={onChange}
    />
  )
  const active = (['project', 'lists', 'teammate'] as const).filter((k) => set[k])
  return (
    <div role="group" aria-label="Filters" className="flex min-w-0 flex-wrap items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={offered.length === 0}>
            <ListFilter aria-hidden />
            Filter
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {offered.map((k) => (
            <DropdownMenuSub key={k}>
              <DropdownMenuSubTrigger>{FILTER_LABELS[k]}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
                {choices(k)}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {active.map((k) => (
        <span
          key={k}
          className="inline-flex h-8 max-w-72 min-w-0 items-center rounded-full border border-primary/50 bg-primary/15 text-[13px] font-semibold"
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-full min-w-0 items-center gap-1.5 rounded-l-full pl-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="font-medium text-muted-foreground">{FILTER_LABELS[k]}</span>
                <span className="truncate">{value[k]}</span>
                {k === 'lists' && filters.lists.length > 1 && (
                  <span className="font-mono text-[11.5px] font-normal text-muted-foreground">
                    +{filters.lists.length - 1}
                  </span>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
              {choices(k)}
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            aria-label={`Remove the ${FILTER_LABELS[k].toLowerCase()} filter`}
            onClick={() => onChange(cleared[k])}
            className="flex h-full items-center rounded-r-full pr-2.5 pl-1.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        </span>
      ))}
      {active.length > 1 && (
        <button
          type="button"
          onClick={() => onChange({ project: '', lists: [], teammate: '' })}
          className="px-1 text-[13px] font-medium text-muted-foreground hover:text-foreground"
        >
          Clear
        </button>
      )}
    </div>
  )
}

export function BoardPage() {
  const board = useBoard()
  const [filters, setFilters] = useFilters()
  const [column, setColumn] = useState<BoardColumn>('needs_you')
  const [allDone, setAllDone] = useState(false)
  const [showClosed, setShowClosed] = useState(false)
  // Unset until someone opens or closes it: open by default when it is short.
  const [stoppedOpen, setStoppedOpen] = useState<boolean>()

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
    const closed =
      lists.length && !lists.includes(NO_LIST)
        ? []
        : data.closed.filter((c) => inProject(c.projectId))
    return {
      counts,
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
    view.stopped.length > 0 && (
      // The Stopped section is below the columns: this opens it and scrolls down to it.
      <a
        key="s"
        href="#stopped"
        onClick={(e) => {
          e.preventDefault()
          setStoppedOpen(true)
          document.getElementById('stopped')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }}
        className="underline-offset-2 hover:text-foreground hover:underline"
      >
        {view.stopped.length} stopped
      </a>
    ),
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

      <FilterBar filters={filters} lists={view.lists} counts={view.counts} onChange={setFilters} />

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

      <Stopped
        rows={view.stopped}
        open={stoppedOpen ?? view.stopped.length <= 5}
        setOpen={setStoppedOpen}
        onChange={() => void board.reload()}
      />
    </div>
  )
}
