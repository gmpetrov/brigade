'use client'
// The sidebar's work: one list of the latest threads, each with its status, and below it
// the teammates and projects. A teammate opens its latest thread and a project its page,
// and each narrows the list to theirs; the filter beside "Threads" narrows it by status,
// teammate or project without going anywhere. The list shows its first few threads (waiting
// on a person first, then working, then the rest) and folds the others into a "+N" row, so
// the teammates and projects stay in reach however many there are; older ones load on asking.
// Threads this member pinned sit above them, under Pinned, in the order they drag them to;
// archived ones are out of both, and so are those the member put away for later, and the
// filter lists each (Later with how many). The teammates and projects stay in the order the
// member drags them to, too (useSidebarOrder). Pinned, Threads, Teammates and Projects each
// fold to their label alone (what waits on a person is counted once, beside Home), and this
// browser remembers which are folded.
// Inside Threads, the latest thread waiting on a person shows first, and the others behind a
// "+N waiting on you".
// A thread's child threads stay out of the list: folded under it, unfolded by the caret
// after its title (SubThreads). The thread already shows their
// state: working while one it waits for works, waiting while one waits on a person.
import {
  Archive,
  ChevronDown,
  Clock,
  ChevronUp,
  ListFilter,
  MessagesSquare,
  Plus,
  Settings,
  X,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { TeammateAvatar } from '@/components/dashboard'
import { TeammateTitle } from '@/components/teammate-title'
import { ProjectIcon } from '@/components/projects'
import { RailPanel } from '@/components/rail-menu'
import { useThreadPanel } from '@/components/thread-panel'
import { FadeText } from '@/components/fade-text'
import { ThreadRow } from '@/components/thread-row'
import { StreamedTitle } from '@/components/streamed-title'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import {
  api,
  useApi,
  type ProjectSummary,
  type SidebarChild,
  type Teammate,
  type ThreadSummary,
} from '@/lib/api'
import { latestSave } from '@/lib/latest-save'
import { groupOf, holds, subThreadRows, type Group } from '@/lib/sub-threads'
import { cn } from '@/lib/utils'

/** How many threads show before the "+N" row. */
const CAP = 5
/** Each "+N more" shows this many more; folding "Threads" goes back to the cap. */
const STEP = 20

/** How many of a thread's child threads show unfolded before their "+N more". */
const CHILD_CAP = 5

/** Whose child threads this browser unfolded, or folded while one of them was open. */
const CHILDREN_KEY = 'brigade:sidebar-children'
/** The most remembered: the latest set first. */
const CHILDREN_KEPT = 100

/** Which of the sidebar's sections this browser folded. */
const FOLDED_KEY = 'brigade:sidebar-folded'
const SECTIONS = ['pinned', 'threads', 'teammates', 'projects'] as const
type Folded = Record<(typeof SECTIONS)[number], boolean>

function useFolded() {
  const [folded, setFolded] = useState<Folded>({
    pinned: false,
    threads: false,
    teammates: false,
    projects: false,
  })
  // Read after the first render, so the server's page and the browser's agree.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? 'null') as Partial<Folded> | null
      setFolded(Object.fromEntries(SECTIONS.map((k) => [k, saved?.[k] === true])) as Folded)
    } catch {
      // Nothing saved, or not readable: both open.
    }
  }, [])
  const toggle = (key: keyof Folded) =>
    setFolded((f) => {
      const next = { ...f, [key]: !f[key] }
      try {
        localStorage.setItem(FOLDED_KEY, JSON.stringify(next))
      } catch {
        // Private mode or full: folded until the page reloads.
      }
      return next
    })
  return [folded, toggle] as const
}

/**
 * Whose child threads show under them. Folded unless the member unfolded them, or one of them
 * is open; what the member set wins, and this browser remembers it.
 */
function useOpenChildren() {
  const [set, setSet] = useState<Record<string, boolean>>({})
  // Read after the first render, so the server's page and the browser's agree.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(CHILDREN_KEY) ?? 'null') as unknown
      if (saved && typeof saved === 'object')
        setSet(
          Object.fromEntries(
            Object.entries(saved).filter((e): e is [string, boolean] => typeof e[1] === 'boolean'),
          ),
        )
    } catch {
      // Nothing saved, or not readable: all folded.
    }
  }, [])
  const toggle = (id: string, open: boolean) =>
    setSet((s) => {
      const { [id]: _, ...rest } = s
      const next = Object.fromEntries(
        [[id, !open] as const, ...Object.entries(rest)].slice(0, CHILDREN_KEPT),
      )
      try {
        localStorage.setItem(CHILDREN_KEY, JSON.stringify(next))
      } catch {
        // Private mode or full: as set until the page reloads.
      }
      return next
    })
  return [set, toggle] as const
}

/**
 * A child thread's branch: a line down from its parent, which the last one ends in a rounded
 * elbow, as in a tree.
 */
const BRANCH =
  'relative pl-3.5 before:pointer-events-none before:absolute before:top-0 before:bottom-0 before:left-0 before:border-l before:border-sidebar-border last:before:bottom-1/2 last:before:w-2 last:before:rounded-bl-lg last:before:border-b'
/** A row under a thread: a child thread or a control, the height of the list's rows. */
const SUB_ROW =
  'flex h-8 w-full min-w-0 items-center gap-2 rounded-[10px] px-2 text-left text-sm text-sidebar-foreground outline-hidden ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground'

/**
 * A thread's child threads, under it: folded, nothing but a button for the keyboard; unfolded, the first
 * of them (waiting on a person, then working, then the latest), the one open among them, and
 * a "+N more" for the rest. No dot on those rows: they are controls, not threads.
 */
function SubThreads({
  items,
  open,
  onToggle,
  activeId,
  needsYou,
}: {
  items: SidebarChild[]
  open: boolean
  onToggle: () => void
  activeId: string | null
  needsYou: Record<string, string>
}) {
  const [all, setAll] = useState(false)
  // What waits on this member is more than its own status, as for the list's threads.
  const { shown, hidden } = subThreadRows(items, { needsYou, activeId, all, cap: CHILD_CAP })
  return (
    // Folded, it takes no room: the caret after the parent's title unfolds it, and from the
    // keyboard a "Show N sub-threads" button, shown once focused.
    <SidebarMenuItem className={cn(!open && 'sr-only has-focus-visible:not-sr-only')}>
      <ul className="ml-[18px] flex min-w-0 flex-col group-data-[collapsible=icon]:hidden">
        {open ? (
          <>
            {/* Folds them again from the keyboard: the caret is a mouse's only. Shown once
                focused, so the list keeps no row for it. */}
            <li className={cn(BRANCH, 'sr-only has-focus-visible:not-sr-only')}>
              <button
                type="button"
                aria-expanded
                onClick={onToggle}
                className={cn(SUB_ROW, 'text-muted-foreground')}
              >
                Hide sub-threads
              </button>
            </li>
            {shown.map((c) => {
              const status = { status: c.status, unread: c.unread, ask: c.ask }
              const group = groupOf(c.status)
              const state = group !== 'rest' || c.status === 'failed' || c.unread
              return (
                <li key={c.id} className={BRANCH}>
                  <Link
                    href={`/app/threads/${c.id}`}
                    data-active={c.id === activeId}
                    title={`${c.title} · ${state ? `${threadStatusLabel(status)} · ` : ''}${shortAgo(c.updatedAt)}`}
                    className={SUB_ROW}
                  >
                    <FadeText
                      className="flex-1"
                      textClassName={cn(group === 'working' && 'text-shimmer-dim')}
                    >
                      <StreamedTitle threadId={c.id} text={c.title} />
                    </FadeText>
                    {state ? (
                      <ThreadStatusIcon {...status} />
                    ) : (
                      <span aria-hidden className="size-4 shrink-0" />
                    )}
                  </Link>
                </li>
              )
            })}
            {hidden > 0 && (
              <li className={BRANCH}>
                <button
                  type="button"
                  onClick={() => setAll(true)}
                  className={cn(SUB_ROW, 'text-muted-foreground')}
                >
                  {`+${hidden} more`}
                </button>
              </li>
            )}
          </>
        ) : (
          <li className={BRANCH}>
            <button
              type="button"
              aria-expanded={false}
              onClick={onToggle}
              className={cn(SUB_ROW, 'text-muted-foreground')}
            >
              Show {items.length} sub-thread{items.length === 1 ? '' : 's'}
            </button>
          </li>
        )}
      </ul>
    </SidebarMenuItem>
  )
}

/**
 * A section's label, which folds it; with `href`, the label opens that page and its chevron
 * folds.
 */
function FoldButton({
  label,
  folded,
  onToggle,
  href,
}: {
  label: string
  folded: boolean
  onToggle: () => void
  href?: string
}) {
  const Chevron = folded ? ChevronDown : ChevronUp
  if (href)
    return (
      <span className="-ml-1 flex items-center">
        <Link href={href} className="hover:text-sidebar-foreground rounded-md px-1">
          {label}
        </Link>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!folded}
          aria-label={`${label}: ${folded ? 'show' : 'hide'}`}
          className="hover:text-sidebar-foreground -ml-1 rounded-md px-1"
        >
          <Chevron className="size-3.5" />
        </button>
      </span>
    )
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!folded}
      aria-label={`${label}: ${folded ? 'show' : 'hide'}`}
      className="hover:text-sidebar-foreground -ml-1 flex items-center gap-1 rounded-md px-1"
    >
      {label}
      <Chevron className="size-3.5" />
    </button>
  )
}

/** The sidebar's lists the member orders by dragging. */
export type SidebarList = 'teammates' | 'projects'

/**
 * The order this member dragged their teammates and projects to, in this workspace (the API
 * keeps it): `sort` puts a list in it, those not placed yet at the end as they came, and
 * `reorder` keeps a new one, shown at once.
 */
export function useSidebarOrder() {
  const { data, setData, reload } = useApi<Record<SidebarList, string[]>>('/me/sidebar-order')
  const sort = useCallback(
    <T extends { id: string }>(list: SidebarList, items: T[]) => {
      const ids = data?.[list]
      if (!ids?.length) return items
      const rank = (id: string) => {
        const i = ids.indexOf(id)
        return i < 0 ? ids.length : i
      }
      // Stable: those not placed keep the list's own order.
      return [...items].sort((a, b) => rank(a.id) - rank(b.id))
    },
    [data],
  )
  // A save per list at a time, the latest asked for: drags in quick succession reach the
  // server in order, so the last one stays. Failed, the list goes back to what it holds.
  const saves = useRef<Partial<Record<SidebarList, (ids: string[]) => Promise<void>>>>({})
  const reorder = useCallback(
    (list: SidebarList, ids: string[]) => {
      setData((d) => ({ teammates: [], projects: [], ...d, [list]: ids }))
      saves.current[list] ??= latestSave(
        (ids: string[]) => api('/me/sidebar-order', { method: 'PUT', body: { list, ids } }),
        (e) => {
          alert(e instanceof Error ? e.message : String(e))
          void reload()
        },
      )
      void saves.current[list](ids)
    },
    [setData, reload],
  )
  return { sort, reorder }
}

/** The lists whose rows drag to another place. */
type DragList = 'pinned' | SidebarList

const LABELS: Record<string, string> = {
  waiting: 'needs you',
  paused: 'paused',
  starting: 'working',
  running: 'working',
}

/**
 * A thread's status as a dot, its word on hover: violet while a teammate works, orange when
 * it waits on a person (the word is what it asks, when known), red when it failed or its
 * updates stopped reaching Brigade (stuck). Otherwise grey: filled while a reply is unread,
 * a ring once read.
 */
/** What a thread's dot says, in words. */
export function threadStatusLabel({
  status,
  unread = false,
  stuck = false,
  ask,
}: {
  status: string
  unread?: boolean
  stuck?: boolean
  ask?: string
}) {
  const group = groupOf(status)
  return stuck
    ? 'updates not arriving'
    : group === 'waiting' && ask
      ? ask
      : (LABELS[status] ?? status) + (group === 'rest' ? (unread ? ', unread' : ', read') : '')
}

export function ThreadStatusIcon({
  status,
  unread = false,
  stuck = false,
  ask,
  className,
}: {
  status: string
  unread?: boolean
  stuck?: boolean
  ask?: string
  className?: string
}) {
  const group = groupOf(status)
  const label = threadStatusLabel({ status, unread, stuck, ask })
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn('flex size-4 shrink-0 items-center justify-center', className)}
    >
      {stuck ? (
        <span className="bg-destructive size-2 rounded-full" />
      ) : group === 'working' ? (
        <span className="bg-primary size-2 rounded-full" />
      ) : group === 'waiting' ? (
        <span className="bg-warning size-2 rounded-full" />
      ) : status === 'failed' ? (
        <span className="bg-destructive size-2 rounded-full" />
      ) : unread ? (
        <span className="bg-muted-foreground size-2 rounded-full" />
      ) : (
        <span className="border-muted-foreground/70 size-2 rounded-full border-[1.5px]" />
      )}
    </span>
  )
}

/** Minutes, hours, then the weekday or date: short, for the end of a row. */
function shortAgo(iso: string) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  const date = new Date(iso)
  if (seconds < 6 * 86400) return date.toLocaleDateString(undefined, { weekday: 'short' })
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const inThread = (t: ThreadSummary, teammateId: string) =>
  t.teammate.id === teammateId || !!t.teammates?.some((p) => p.teammate.id === teammateId)

function FilterChip({
  label,
  icon,
  onClear,
}: {
  label: string
  icon?: React.ReactNode
  onClear: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClear}
      aria-label={`Clear the filter: ${label}`}
      className="bg-primary/15 text-primary ml-1 inline-flex h-5 max-w-28 items-center gap-1 rounded-full pr-1 pl-2 text-[0.6875rem] font-semibold tracking-normal normal-case"
    >
      {icon}
      <span className="truncate">{label}</span>
      <X className="size-3 shrink-0" />
    </button>
  )
}

/** What the filter picks among: the dots the list shows, each with its word. */
const STATUSES = [
  { key: 'waiting', label: 'Needs you', icon: 'waiting', unread: false },
  { key: 'working', label: 'Working', icon: 'running', unread: false },
  { key: 'unread', label: 'Unread', icon: 'idle', unread: true },
  { key: 'failed', label: 'Failed', icon: 'failed', unread: false },
] as const
type StatusKey = (typeof STATUSES)[number]['key']
/** Which of them a thread is: idle or done ones read are none. */
const statusKey = (t: ThreadSummary): StatusKey | undefined => {
  const group = groupOf(t.status)
  if (group !== 'rest') return group
  if (t.status === 'failed') return 'failed'
  return t.unread ? 'unread' : undefined
}

/**
 * What the list shows. A teammate or project picked from its row (`byRow`) goes with the
 * page it opened: leaving for another page ends it. One picked from the menu stays.
 */
type Filter = {
  teammateId?: string
  projectId?: string
  statuses: StatusKey[]
  byRow?: 'teammate' | 'project'
}

/** The filter this browser last set, and whether it showed the archived or later threads. */
const FILTER_KEY = 'brigade:sidebar-filter'
type SavedFilter = Filter & { archived?: boolean; later?: boolean }

/** Whether `pathname` is the page a filter from a row goes with. */
function onOwnPage(filter: Filter, pathname: string) {
  if (!filter.byRow || pathname.startsWith('/app/threads')) return true
  return filter.byRow === 'teammate'
    ? pathname.startsWith(`/app/teammates/${filter.teammateId}`)
    : pathname.startsWith(`/app/projects/${filter.projectId}`)
}

function readFilter(pathname: string): SavedFilter | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY) ?? 'null') as SavedFilter | null
    if (!saved) return
    const keys: readonly string[] = STATUSES.map((s) => s.key)
    const filter: Filter = {
      teammateId: typeof saved.teammateId === 'string' ? saved.teammateId : undefined,
      projectId: typeof saved.projectId === 'string' ? saved.projectId : undefined,
      statuses: Array.isArray(saved.statuses)
        ? saved.statuses.filter((k): k is StatusKey => keys.includes(k))
        : [],
      byRow: saved.byRow === 'teammate' || saved.byRow === 'project' ? saved.byRow : undefined,
    }
    // A filter from a row goes with its page: opened on another, it ends.
    if (!onOwnPage(filter, pathname)) {
      if (filter.byRow === 'teammate') filter.teammateId = undefined
      else filter.projectId = undefined
      filter.byRow = undefined
    }
    return { ...filter, archived: saved.archived === true, later: saved.later === true }
  } catch {
    // Nothing saved, or not readable: no filter.
  }
}

function saveFilter(saved: SavedFilter) {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(saved))
  } catch {
    // Private mode or full: the filter lasts until the page reloads.
  }
}

/** The threads with what each waiting on a person asks, those shown as waiting. */
function withAsks(threads: ThreadSummary[], needsYou: Record<string, string>) {
  const asks = new Map<string, string>()
  const all = threads.map((t) => {
    const ask =
      needsYou[t.id] ??
      (t.pullsWaiting ? 'review PR' : t.status === 'waiting' ? 'needs you' : undefined)
    // Children it waits for at work: it shows as working, as for its own background work.
    if (!ask)
      return t.childrenWorking && groupOf(t.status) === 'rest' ? { ...t, status: 'running' } : t
    asks.set(t.id, ask)
    return groupOf(t.status) === 'rest' ? { ...t, status: 'waiting' } : t
  })
  return { all, asks }
}

/**
 * Older threads are asked for this many at a time, the most the server gives: the status
 * filter narrows them here, so a page may hold few that match.
 */
const OLDER_PAGE = 100

export function SidebarWork({
  teammates,
  projects,
  admin,
  memberId,
  onNewProject,
  onReorder,
  needsYou,
  rail,
}: {
  /** The teammates and projects in the member's order (useSidebarOrder). */
  teammates: Teammate[]
  projects: ProjectSummary[]
  admin: boolean
  memberId: string | null
  onNewProject: () => void
  /** The member dragged a teammate or project to another place: the list's ids, in order. */
  onReorder: (list: SidebarList, ids: string[]) => void
  /**
   * Threads with an open ticket waiting on this member or a task in Needs you, and what it
   * asks ("approve").
   */
  needsYou: Record<string, string>
  /** Folded, the menus beside the rail after Threads (projects, teammates). */
  rail?: ReactNode
}) {
  const router = useRouter()
  const pathname = usePathname()
  const { threads, reloadThreads, threadId, expanded, openTeammate } = useThreadPanel()
  const [filter, setFilter] = useState<Filter>({ statuses: [] })
  // The archived threads, while the list shows them instead (from the filter).
  const [archived, setArchived] = useState<ThreadSummary[]>()
  const loadArchived = () => {
    setLater(false)
    return api<ThreadSummary[]>('/threads?archived=1').then(setArchived, () => setArchived([]))
  }
  // Whether the list shows the threads this member put away for later instead (the filter's
  // Later). They are in the panel's list, all of them, out of the usual one.
  const [later, setLater] = useState(false)
  const putAway = useMemo(() => (threads ?? []).filter((t) => t.laterAt), [threads])
  // How many more than the cap the list shows: a step at a time.
  const [extra, setExtra] = useState(0)
  const [folded, toggleFolded] = useFolded()
  const [childrenSet, toggleChildren] = useOpenChildren()
  // Whether the list shows every thread waiting on a person, not only the latest.
  const [allWaiting, setAllWaiting] = useState(false)
  // Threads older than the latest the panel loads, asked for from the end of the list; and
  // the filters that have none left, so the list stops offering more.
  const [older, setOlder] = useState<ThreadSummary[]>([])
  const [exhausted, setExhausted] = useState<string[]>([])
  const [loadingOlder, setLoadingOlder] = useState(false)
  // Pinned as just dragged, until the list comes back in that order; and the drag under way
  // (pinned, teammates or projects): the row dragged, and where it would land (before or after
  // the row under the pointer, in the same list).
  const [pinOrder, setPinOrder] = useState<string[]>()
  const [dragged, setDragged] = useState<{ list: DragList; id: string }>()
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean }>()
  const live = projects.filter((p) => !p.archivedAt)
  const teammate = teammates.find((t) => t.id === filter.teammateId)
  const project = live.find((p) => p.id === filter.projectId)
  const filtered = !!(
    filter.teammateId ||
    filter.projectId ||
    filter.statuses.length ||
    archived ||
    later
  )
  // The archived or later threads instead of the usual list: in one list, as they come.
  const instead = !!archived || later

  // The filter this browser last set comes back with the page: read after the first render,
  // so the server's page and the browser's agree, and saved from then on.
  const [restored, setRestored] = useState(false)
  useEffect(() => {
    const saved = readFilter(pathname)
    if (saved) {
      const { archived, later, ...rest } = saved
      setFilter(rest)
      if (archived) void loadArchived()
      else if (later) setLater(true)
    }
    setRestored(true)
    // Once, on load: later pages keep the filter as it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (restored) saveFilter({ ...filter, archived: !!archived, later })
  }, [restored, filter, archived, later])
  // A teammate or project since removed filters nothing in: it goes, once the lists are in.
  useEffect(() => {
    if (filter.teammateId && teammates.length && !teammate)
      setFilter((f) => ({ ...f, teammateId: undefined, byRow: undefined }))
  }, [filter.teammateId, teammates.length, teammate])
  useEffect(() => {
    if (filter.projectId && projects.length && !project)
      setFilter((f) => ({ ...f, projectId: undefined, byRow: undefined }))
  }, [filter.projectId, projects.length, project])

  // A filter from a row ends on a page that is not its own (or a thread).
  const latest = useRef(filter)
  latest.current = filter
  useEffect(() => {
    const { byRow } = latest.current
    if (byRow && !onOwnPage(latest.current, pathname))
      setFilter((f) => ({
        ...f,
        byRow: undefined,
        ...(byRow === 'teammate' ? { teammateId: undefined } : { projectId: undefined }),
      }))
  }, [pathname])

  // Waiting on a person is more than the thread's own status: a ticket for this member, a task
  // in Needs you, or a pull request it opened that a person has to review or merge. Unless it is working: then
  // it shows as working, and waits once it stops. What each asks goes at the row's end.
  const { all, asks } = useMemo(() => {
    const latestIds = new Set((threads ?? []).map((t) => t.id))
    return withAsks(
      archived ?? [...(threads ?? []), ...older.filter((t) => !latestIds.has(t.id))],
      needsYou,
    )
  }, [threads, older, needsYou, archived])
  // Pinned: where the member dragged them, else in the order they were pinned, whatever the
  // filter. Pinned since the last drag, at the end.
  const pinned = useMemo(() => {
    if (instead) return []
    const rank = (t: ThreadSummary) => {
      const i = pinOrder?.indexOf(t.id) ?? -1
      return pinOrder ? (i < 0 ? pinOrder.length : i) : (t.pinPosition ?? 0)
    }
    return all
      .filter((t) => t.pinnedAt && !t.laterAt)
      .sort((a, b) => rank(a) - rank(b) || a.pinnedAt!.localeCompare(b.pinnedAt!))
  }, [all, instead, pinOrder])

  /** The list's ids with `id` moved before or after `to`; undefined when nothing moves. */
  function moved(list: { id: string }[], id: string, to: { id: string; after: boolean }) {
    const ids = list.map((t) => t.id).filter((x) => x !== id)
    const at = ids.indexOf(to.id)
    if (at < 0) return
    ids.splice(at + (to.after ? 1 : 0), 0, id)
    if (ids.every((x, i) => x === list[i]?.id)) return
    return ids
  }
  function move({ list, id }: { list: DragList; id: string }, to: { id: string; after: boolean }) {
    if (list === 'pinned') return void movePin(id, to)
    const ids = moved(list === 'teammates' ? teammates : live, id, to)
    if (ids) onReorder(list, ids)
  }
  async function movePin(id: string, to: { id: string; after: boolean }) {
    const ids = moved(pinned, id, to)
    if (!ids) return
    setPinOrder(ids)
    try {
      await api('/threads/pins/order', { method: 'PUT', body: { ids } })
      await reloadThreads()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    }
    // The list now has the order itself (or, failed, goes back to where it was).
    setPinOrder(undefined)
  }
  // A row's drag (pinned, a teammate or a project): picked up anywhere on it, it lands before
  // or after the row of its list last under the pointer, where the line shows. The whole sidebar takes the drop, so past the first or
  // last row it lands where the line still is; out of the sidebar, the line goes and so does
  // the drop. On the window, as the sidebar's padding and edge are in no row or group.
  const drop = useRef(dropAt)
  drop.current = dropAt
  useEffect(() => {
    if (!dragged) return
    const inSidebar = (e: DragEvent) =>
      e.target instanceof Element && !!e.target.closest('[data-slot="sidebar-inner"]')
    const over = (e: DragEvent) => {
      if (!inSidebar(e)) return setDropAt(undefined)
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = drop.current ? 'move' : 'none'
    }
    const dropped = (e: DragEvent) => {
      if (!inSidebar(e)) return
      e.preventDefault()
      const to = drop.current
      if (to && to.id !== dragged.id) move(dragged, to)
      setDragged(undefined)
      setDropAt(undefined)
    }
    window.addEventListener('dragover', over)
    window.addEventListener('drop', dropped)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', dropped)
    }
    // move reads the lists of this render; a drag starts and ends within one list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragged])
  const dragRow = (list: DragList, id: string): ComponentProps<'li'> => ({
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData(`application/x-brigade-${list}`, id)
      e.dataTransfer.setDragImage(e.currentTarget, 16, 16)
      setDragged({ list, id })
    },
    // The window's handler then accepts it and takes the drop. Over another list's row, the
    // line stays where it was.
    onDragOver: (e) => {
      if (dragged?.list !== list) return
      const box = e.currentTarget.getBoundingClientRect()
      const after = e.clientY > box.top + box.height / 2
      if (dropAt?.id !== id || dropAt.after !== after) setDropAt({ id, after })
    },
    onDragEnd: () => {
      setDragged(undefined)
      setDropAt(undefined)
    },
    className: cn(
      dragged?.id === id && 'opacity-50',
      dropAt?.id === id &&
        dragged?.list === list &&
        dragged.id !== id &&
        'before:bg-primary before:pointer-events-none before:absolute before:inset-x-2 before:z-10 before:h-0.5 before:rounded-full',
      dropAt?.id === id && (dropAt.after ? 'before:-bottom-px' : 'before:-top-px'),
    ),
  })
  const shown = useMemo(
    () =>
      all.filter(
        (t) =>
          (instead || !t.pinnedAt) &&
          (later ? !!t.laterAt : !t.laterAt) &&
          (!filter.teammateId || inThread(t, filter.teammateId)) &&
          (!filter.projectId || t.projectId === filter.projectId) &&
          (!filter.statuses.length || filter.statuses.includes(statusKey(t)!)),
      ),
    [all, filter, instead, later],
  )
  const groups = useMemo(() => {
    const by: Record<Group, ThreadSummary[]> = { waiting: [], working: [], rest: [] }
    for (const t of shown) by[groupOf(t.status)].push(t)
    return by
  }, [shown])
  // Another filter starts from the cap again.
  useEffect(() => {
    setExtra(0)
    setAllWaiting(false)
  }, [filter])

  // Which older threads the server has for this filter: the teammate and project it can
  // narrow to; the status it cannot, so the list narrows what comes back.
  const query = `${filter.teammateId ? `&teammateId=${filter.teammateId}` : ''}${
    filter.projectId ? `&project=${filter.projectId}` : ''
  }`
  // Fewer than the panel's latest 100, unfiltered: there are none older.
  const mayHaveOlder =
    !instead && !!threads && !exhausted.includes(query) && (!!query || threads.length >= 100)
  async function loadOlder() {
    const matching = all.filter(
      (t) =>
        (!filter.teammateId || inThread(t, filter.teammateId)) &&
        (!filter.projectId || t.projectId === filter.projectId),
    )
    const oldest = matching[matching.length - 1]
    setLoadingOlder(true)
    try {
      const page = await api<ThreadSummary[]>(
        `/threads?limit=${OLDER_PAGE}&sort=activity${query}${oldest ? `&before=${oldest.id}` : ''}`,
      )
      setOlder((o) => {
        const ids = new Set(o.map((t) => t.id))
        return [...o, ...page.filter((t) => !ids.has(t.id))]
      })
      if (page.length < OLDER_PAGE) setExhausted((e) => [...e, query])
    } catch {
      // Not reachable: the list stops asking, rather than asking again at once.
      setExhausted((e) => [...e, query])
    } finally {
      setLoadingOlder(false)
    }
  }

  // What the list shows: the latest thread waiting on a person, the others behind a "+N waiting on
  // you" until asked; then the first of the rest and a "+N more" past them. Its N counts only
  // threads already loaded and matching, so it never promises ones that may not exist.
  const waitingRows = instead ? [] : groups.waiting
  const waitingShown = allWaiting ? waitingRows : waitingRows.slice(0, 1)
  const ordered = [...(instead ? groups.waiting : []), ...groups.working, ...groups.rest]
  const visible = CAP + extra
  const hidden = Math.max(0, ordered.length - visible)
  const more =
    hidden > 0
      ? { label: `+${Math.min(STEP, hidden)} more`, onSelect: () => setExtra((e) => e + STEP) }
      : undefined
  // Fewer than a step loaded past the list: older threads, from the server, until there are
  // a step's worth or none left, so the next "+N more" is known before it shows.
  useEffect(() => {
    if (mayHaveOlder && hidden < STEP && !loadingOlder) void loadOlder()
    // loadOlder reads the filter and list of this render, which `hidden` and `query` follow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mayHaveOlder, hidden, loadingOlder, query])

  // The thread open, when the list does not show it (older than its threads, behind a "+N",
  // filtered out or put away for later): first under Threads while it stays open, so the
  // member sees where they are. Pinned, it is under Pinned already; a child thread brings
  // its parent, unfolded.
  const openId = expanded && !instead ? threadId : null
  // A child thread open: its parent, which shows it unfolded.
  const inView =
    !!openId &&
    (pinned.some((t) => holds(t, openId)) ||
      waitingShown.some((t) => holds(t, openId)) ||
      ordered.slice(0, visible).some((t) => holds(t, openId)))
  const loaded = openId ? all.find((t) => holds(t, openId)) : undefined
  // Not among those loaded: as the list has it, from the server, again as the list changes.
  const [fetched, setFetched] = useState<ThreadSummary>()
  useEffect(() => {
    if (!openId || inView || loaded) return
    let current = true
    api<ThreadSummary[]>(`/threads?id=${openId}`).then(
      ([t]) =>
        current && setFetched(t && holds(t, openId) ? withAsks([t], needsYou).all[0] : undefined),
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [openId, inView, loaded, threads, needsYou])
  const opened = inView
    ? undefined
    : (loaded ?? (fetched && holds(fetched, openId!) ? fetched : undefined))

  function changed() {
    void reloadThreads()
    if (archived) void loadArchived()
    // Older pages may hold the thread as it was (put away for later, say): asked for again.
    setOlder([])
    setExhausted([])
  }
  function deleted(id: string) {
    setOlder((o) => o.filter((t) => t.id !== id))
    if (threadId === id) router.push('/app')
  }
  /** `dated`: the thread opened from outside the list, which shows its date to say why it is
   * at the top. Other rows give it in their tooltip only. */
  function row(t: ThreadSummary, drag?: ComponentProps<'li'>, dated = false) {
    const href = `/app/threads/${t.id}`
    const status = {
      status: t.status,
      unread: t.unread,
      stuck: !!t.eventsWaitingSince,
      ask: asks.get(t.id),
    }
    // Working also shows on the title, a band passing over it. Stuck: its red dot alone.
    const working = statusKey(t) === 'working' && !t.eventsWaitingSince
    const state = !!(statusKey(t) || t.eventsWaitingSince)
    // Its child threads, folded under it unless the member unfolded them or one is open.
    const children = t.children ?? []
    const activeChild =
      children.find((c) => c.id === threadId && (expanded || pathname === `/app/threads/${c.id}`))
        ?.id ?? null
    const open = children.length > 0 && (childrenSet[t.id] ?? !!activeChild)
    const toggle = () => toggleChildren(t.id, open)
    return (
      <Fragment key={t.id}>
        <ThreadRow
          caret={children.length ? { open, count: children.length, onToggle: toggle } : undefined}
          thread={t}
          href={href}
          active={threadId === t.id && (expanded || pathname === href)}
          dot={state ? <ThreadStatusIcon {...status} /> : undefined}
          working={working}
          hint={
            state
              ? `${threadStatusLabel(status)} · ${shortAgo(t.updatedAt)}`
              : shortAgo(t.updatedAt)
          }
          trailing={
            dated && (
              <span className="text-muted-foreground font-normal">{shortAgo(t.updatedAt)}</span>
            )
          }
          memberId={memberId}
          admin={admin}
          onChanged={changed}
          onDeleted={deleted}
          drag={drag}
        />
        {children.length > 0 && (
          <SubThreads
            items={children}
            open={open}
            onToggle={toggle}
            activeId={activeChild}
            needsYou={needsYou}
          />
        )}
      </Fragment>
    )
  }

  function clickTeammate(id: string) {
    if (filter.teammateId === id)
      return setFilter((f) => ({ ...f, teammateId: undefined, byRow: undefined }))
    setFilter((f) => ({
      ...f,
      teammateId: id,
      byRow: 'teammate',
      ...(f.byRow === 'project' ? { projectId: undefined } : {}),
    }))
    // Its latest thread, else a box to start one with it.
    void openTeammate(id)
  }
  function clickProject(id: string) {
    setFilter((f) => ({
      ...f,
      projectId: id,
      byRow: 'project',
      ...(f.byRow === 'teammate' ? { teammateId: undefined } : {}),
    }))
    router.push(`/app/projects/${id}`)
  }

  // The list, here and folded in the panel beside the rail: its first threads and its
  // "+N more", which grows it in both.
  const list = (
    <>
      {threads && shown.length === 0 && !opened && (instead || !pinned.length) && (
        <li className="text-muted-foreground px-2 py-1.5 text-xs">
          {archived
            ? 'No archived threads.'
            : later
              ? 'Nothing put away for later.'
              : filtered
                ? 'No threads match.'
                : 'No threads yet.'}
        </li>
      )}
      {opened && row(opened, undefined, true)}
      {waitingShown.map((t) => row(t))}
      {/* No dot: a control, not a thread; its text lines up with the titles. */}
      {waitingShown.length < waitingRows.length && (
        <SidebarMenuItem>
          <SidebarMenuButton
            size="sm"
            className="text-muted-foreground pl-8"
            onClick={() => setAllWaiting(true)}
          >
            <span>{`+${waitingRows.length - waitingShown.length} waiting on you`}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      )}
      {ordered.slice(0, visible).map((t) => row(t))}
      {more && (
        <SidebarMenuItem>
          <SidebarMenuButton
            size="sm"
            className="text-muted-foreground pl-8"
            onClick={more.onSelect}
          >
            <span>{more.label}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      )}
    </>
  )

  return (
    <>
      {/* Folded: threads, then the other menus, beside the rail. */}
      <SidebarGroup className="hidden group-data-[collapsible=icon]:flex">
        <SidebarMenu>
          <RailPanel
            icon={MessagesSquare}
            label="Threads"
            href="/app/threads"
            active={pathname.startsWith('/app/threads') || (expanded && !!threadId)}
          >
            {pinned.length > 0 && (
              <>
                <SidebarGroupLabel className="h-6">Pinned</SidebarGroupLabel>
                <SidebarMenu>{pinned.map((t) => row(t))}</SidebarMenu>
                <hr className="border-sidebar-border mx-2 my-1" />
              </>
            )}
            <SidebarMenu>{list}</SidebarMenu>
          </RailPanel>
          {rail}
          {/* The pinned threads in the rail itself: the teammate, and a dot when it has news. */}
          {pinned.length > 0 && (
            <li aria-hidden className="bg-sidebar-border mx-auto my-1 h-px w-4" />
          )}
          {pinned.map((t) => {
            const href = `/app/threads/${t.id}`
            const title = t.title || 'New thread'
            return (
              <SidebarMenuItem key={t.id}>
                <SidebarMenuButton
                  asChild
                  tooltip={title}
                  isActive={threadId === t.id && (expanded || pathname === href)}
                >
                  <Link href={href} aria-label={title}>
                    <span className="relative flex size-4 shrink-0 items-center justify-center">
                      <TeammateAvatar teammate={t.teammate} className="size-5" />
                      {statusKey(t) && (
                        <ThreadStatusIcon
                          status={t.status}
                          unread={t.unread}
                          stuck={!!t.eventsWaitingSince}
                          className="absolute -right-1.5 -bottom-1.5 size-3"
                        />
                      )}
                    </span>
                    <span>
                      <StreamedTitle threadId={t.id} text={title} />
                    </span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      </SidebarGroup>

      {pinned.length > 0 && (
        <SidebarGroup className="py-1 group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>
            <FoldButton
              label="Pinned"
              folded={folded.pinned}
              onToggle={() => toggleFolded('pinned')}
            />
          </SidebarGroupLabel>
          {!folded.pinned && (
            <SidebarGroupContent>
              <SidebarMenu>{pinned.map((t) => row(t, dragRow('pinned', t.id)))}</SidebarMenu>
            </SidebarGroupContent>
          )}
        </SidebarGroup>
      )}

      <SidebarGroup className="py-1 group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel className="pr-8">
          {/* Folding it also takes the list back to its first threads. */}
          <FoldButton
            label="Threads"
            folded={folded.threads}
            onToggle={() => {
              if (!folded.threads) {
                setExtra(0)
                setAllWaiting(false)
              }
              toggleFolded('threads')
            }}
          />
          {teammate && (
            <FilterChip
              label={teammate.name}
              onClear={() => setFilter((f) => ({ ...f, teammateId: undefined, byRow: undefined }))}
            />
          )}
          {project && (
            <FilterChip
              label={project.name}
              icon={
                <ProjectIcon
                  project={project}
                  className="-ml-1 size-3.5 rounded-[3px] text-[0.5rem]"
                />
              }
              onClear={() => setFilter((f) => ({ ...f, projectId: undefined, byRow: undefined }))}
            />
          )}
          {archived && <FilterChip label="Archived" onClear={() => setArchived(undefined)} />}
          {later && <FilterChip label="Later" onClear={() => setLater(false)} />}
          {filter.statuses.length > 0 && (
            <FilterChip
              label={
                filter.statuses.length === 1
                  ? STATUSES.find((s) => s.key === filter.statuses[0])!.label
                  : `${filter.statuses.length} statuses`
              }
              onClear={() => setFilter((f) => ({ ...f, statuses: [] }))}
            />
          )}
        </SidebarGroupLabel>
        {/* Folded, Threads is only its label: no filter beside it. */}
        {!folded.threads && (
          <DropdownMenu>
            <SidebarGroupAction asChild title="Filter threads">
              <DropdownMenuTrigger
                aria-label="Filter threads"
                className="data-[state=open]:bg-sidebar-accent"
              >
                <ListFilter />
                {filtered && (
                  <span
                    aria-hidden
                    className="bg-primary absolute top-0.5 right-0.5 size-1.5 rounded-full"
                  />
                )}
              </DropdownMenuTrigger>
            </SidebarGroupAction>
            <DropdownMenuContent align="start" side="right" className="min-w-56">
              <DropdownMenuLabel className="text-muted-foreground text-xs">
                Status
              </DropdownMenuLabel>
              {STATUSES.map((s) => (
                <DropdownMenuCheckboxItem
                  key={s.key}
                  checked={filter.statuses.includes(s.key)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(on) =>
                    setFilter((f) => ({
                      ...f,
                      statuses: on ? [...f.statuses, s.key] : f.statuses.filter((k) => k !== s.key),
                    }))
                  }
                >
                  <ThreadStatusIcon status={s.icon} unread={s.unread} />
                  {s.label}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-muted-foreground text-xs">
                Teammate
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={filter.teammateId ?? ''}
                onValueChange={(id) =>
                  setFilter((f) => ({
                    ...f,
                    teammateId: id || undefined,
                    byRow: f.byRow === 'teammate' ? undefined : f.byRow,
                  }))
                }
              >
                <DropdownMenuRadioItem value="">Everyone</DropdownMenuRadioItem>
                {teammates.map((t) => (
                  <DropdownMenuRadioItem key={t.id} value={t.id}>
                    <TeammateAvatar teammate={t} className="size-4" />
                    {t.name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              {live.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-muted-foreground text-xs">
                    Project
                  </DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={filter.projectId ?? ''}
                    onValueChange={(id) =>
                      setFilter((f) => ({
                        ...f,
                        projectId: id || undefined,
                        byRow: f.byRow === 'project' ? undefined : f.byRow,
                      }))
                    }
                  >
                    <DropdownMenuRadioItem value="">All projects</DropdownMenuRadioItem>
                    {live.map((p) => (
                      <DropdownMenuRadioItem key={p.id} value={p.id}>
                        <ProjectIcon project={p} />
                        {p.name}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </>
              )}
              <DropdownMenuSeparator />
              {/* How many: a plain count, so what was put away is not forgotten. */}
              <DropdownMenuCheckboxItem
                checked={later}
                onCheckedChange={(on) => {
                  setLater(on)
                  if (on) setArchived(undefined)
                }}
              >
                <Clock />
                Later
                {putAway.length > 0 && (
                  <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                    {putAway.length}
                  </span>
                )}
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={!!archived}
                onCheckedChange={(on) => (on ? void loadArchived() : setArchived(undefined))}
              >
                <Archive />
                Archived
              </DropdownMenuCheckboxItem>
              {filtered && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => {
                      setFilter({ statuses: [] })
                      setArchived(undefined)
                      setLater(false)
                    }}
                  >
                    Clear filters
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {!folded.threads && (
          <SidebarGroupContent>
            <SidebarMenu>{list}</SidebarMenu>
          </SidebarGroupContent>
        )}
      </SidebarGroup>

      <SidebarGroup className="py-1 group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel>
          <FoldButton
            label="Teammates"
            folded={folded.teammates}
            onToggle={() => toggleFolded('teammates')}
          />
        </SidebarGroupLabel>
        {admin && (
          <SidebarGroupAction asChild title="New teammate">
            <Link href="/app/teammates/new">
              <Plus />
              <span className="sr-only">New teammate</span>
            </Link>
          </SidebarGroupAction>
        )}
        {!folded.teammates && (
          <SidebarGroupContent>
            <SidebarMenu>
              {teammates.map((t) => (
                <SidebarRow
                  key={t.id}
                  drag={dragRow('teammates', t.id)}
                  active={filter.teammateId === t.id}
                  title={`${t.name}: its latest thread, and only its threads above`}
                  onClick={() => clickTeammate(t.id)}
                  icon={<TeammateAvatar teammate={t} className="size-5" />}
                  label={t.name}
                  badge={
                    <TeammateTitle title={t.title} className="max-w-28 px-1.5 py-0 text-[11px]" />
                  }
                  action={{
                    href: `/app/teammates/${t.id}`,
                    label: `${t.name}'s settings`,
                    icon: <Settings />,
                  }}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        )}
      </SidebarGroup>

      <SidebarGroup className="py-1 group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel>
          <FoldButton
            label="Projects"
            href="/app/projects"
            folded={folded.projects}
            onToggle={() => toggleFolded('projects')}
          />
        </SidebarGroupLabel>
        <SidebarGroupAction title="New project" onClick={onNewProject}>
          <Plus />
          <span className="sr-only">New project</span>
        </SidebarGroupAction>
        {!folded.projects && (
          <SidebarGroupContent>
            <SidebarMenu>
              {live.map((p) => (
                <SidebarRow
                  key={p.id}
                  drag={dragRow('projects', p.id)}
                  active={
                    filter.projectId === p.id ||
                    pathname === `/app/projects/${p.id}` ||
                    pathname.startsWith(`/app/projects/${p.id}/`)
                  }
                  title={`${p.name}: its page, and only its threads above`}
                  onClick={() => clickProject(p.id)}
                  icon={<ProjectIcon project={p} />}
                  label={p.name}
                />
              ))}
              {live.length === 0 && (
                <SidebarMenuItem>
                  <SidebarMenuButton className="text-muted-foreground" onClick={onNewProject}>
                    <Plus />
                    <span>New project</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        )}
      </SidebarGroup>
    </>
  )
}

/**
 * A teammate or project: opens its thread or page, and narrows the list above to it. Dragged,
 * it goes to another place in its list.
 */
function SidebarRow({
  drag,
  active,
  title,
  onClick,
  icon,
  label,
  badge,
  action,
}: {
  active: boolean
  title: string
  onClick: () => void
  icon: ReactNode
  label: string
  /** Beside the label: a teammate's title. */
  badge?: ReactNode
  action?: { href: string; label: string; icon: ReactNode }
  /** Its drag handlers and the drop line's class. */
  drag?: ComponentProps<'li'>
}) {
  return (
    <SidebarMenuItem {...drag}>
      <SidebarMenuButton isActive={active} title={title} onClick={onClick}>
        {icon}
        <span className="truncate">{label}</span>
        {badge}
      </SidebarMenuButton>
      {action && (
        <SidebarMenuAction asChild showOnHover>
          <Link href={action.href} aria-label={action.label} title={action.label}>
            {action.icon}
          </Link>
        </SidebarMenuAction>
      )}
    </SidebarMenuItem>
  )
}
