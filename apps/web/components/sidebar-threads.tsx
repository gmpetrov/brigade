'use client'
// The sidebar's work: one list of the latest threads, each with its status, and below it
// the teammates and projects. A teammate opens its latest thread and a project its page,
// and each narrows the list to theirs; the filter beside "Threads" narrows it by status,
// teammate or project without going anywhere. The list shows a few threads of each status
// (waiting on a person, working, the rest) and folds the others into a "+N" row, so the
// teammates and projects stay in reach however many there are; older ones load on asking.
// Threads this member pinned sit above them, under Pinned; archived ones are out of both,
// and the filter lists them.
import { Archive, ChevronUp, ListFilter, MessagesSquare, Plus, Settings, X } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { TeammateAvatar } from '@/components/dashboard'
import { ProjectIcon } from '@/components/projects'
import { RailPanel } from '@/components/rail-menu'
import { useThreadPanel } from '@/components/thread-panel'
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
import { api, type ProjectSummary, type Teammate, type ThreadSummary } from '@/lib/api'
import { cn } from '@/lib/utils'

type Group = 'waiting' | 'working' | 'rest'

/** How many of each show before the "+N" row. */
const CAPS: Record<Group, number> = { waiting: 2, working: 2, rest: 3 }
const MORE: Record<Group, string> = { waiting: 'waiting', working: 'working', rest: '' }
/** Each "+N more" shows this many more; "Threads" goes back to the caps. */
const STEP = 20
const NONE_EXTRA: Record<Group, number> = { waiting: 0, working: 0, rest: 0 }

const groupOf = (status: string): Group =>
  status === 'waiting'
    ? 'waiting'
    : status === 'starting' || status === 'running'
      ? 'working'
      : 'rest'

const LABELS: Record<string, string> = {
  waiting: 'needs you',
  starting: 'working',
  running: 'working',
}

/**
 * A thread's status as a dot, its word on hover: violet while a teammate works, orange when
 * it waits on a person, red when it failed or its updates stopped reaching Brigade (stuck).
 * Otherwise grey: filled while a reply is unread, a ring once read.
 */
export function ThreadStatusIcon({
  status,
  unread = false,
  stuck = false,
  className,
}: {
  status: string
  unread?: boolean
  stuck?: boolean
  className?: string
}) {
  const group = groupOf(status)
  const label = stuck
    ? 'updates not arriving'
    : (LABELS[status] ?? status) + (group === 'rest' ? (unread ? ', unread' : ', read') : '')
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
        <span className="bg-primary ring-primary/25 size-2 rounded-full ring-[3px]" />
      ) : group === 'waiting' ? (
        <span className="bg-warning ring-warning/25 size-2 rounded-full ring-[3px]" />
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

/** How many of some threads wait on a person: beside a teammate or project. */
function Signals({ threads, hideOnHover }: { threads: ThreadSummary[]; hideOnHover?: boolean }) {
  const waiting = threads.filter((t) => groupOf(t.status) === 'waiting').length
  if (!waiting) return null
  return (
    <span
      className={cn(
        'text-muted-foreground ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[0.6875rem]',
        hideOnHover && 'group-hover/menu-item:opacity-0',
      )}
    >
      <ThreadStatusIcon status="waiting" />
      <span className="text-warning font-semibold">{waiting}</span>
    </span>
  )
}

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

/** The threads with what each waiting on a person asks, those shown as waiting. */
function withAsks(threads: ThreadSummary[], needsYou: Record<string, string>) {
  const asks = new Map<string, string>()
  const all = threads.map((t) => {
    const ask =
      needsYou[t.id] ??
      (t.pullsWaiting ? 'review PR' : t.status === 'waiting' ? 'needs you' : undefined)
    if (!ask) return t
    asks.set(t.id, ask)
    return groupOf(t.status) === 'rest' ? { ...t, status: 'waiting' } : t
  })
  return { all, asks }
}

/** Older threads are asked for this many at a time: a step's worth. */
const OLDER_PAGE = STEP

export function SidebarWork({
  teammates,
  projects,
  admin,
  memberId,
  onNewProject,
  needsYou,
  rail,
}: {
  teammates: Teammate[]
  projects: ProjectSummary[]
  admin: boolean
  memberId: string | null
  onNewProject: () => void
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
  const loadArchived = () =>
    api<ThreadSummary[]>('/threads?archived=1').then(setArchived, () => setArchived([]))
  // How many more than its cap each status shows: a step at a time.
  const [extra, setExtra] = useState(NONE_EXTRA)
  const grown = extra.waiting + extra.working + extra.rest > 0
  const shrink = () => setExtra(NONE_EXTRA)
  // Threads older than the latest the panel loads, asked for from the end of the list; and
  // the filters that have none left, so the list stops offering more.
  const [older, setOlder] = useState<ThreadSummary[]>([])
  const [exhausted, setExhausted] = useState<string[]>([])
  const [loadingOlder, setLoadingOlder] = useState(false)
  const live = projects.filter((p) => !p.archivedAt)
  const teammate = teammates.find((t) => t.id === filter.teammateId)
  const project = live.find((p) => p.id === filter.projectId)
  const filtered = !!(filter.teammateId || filter.projectId || filter.statuses.length || archived)

  // A filter from a row ends on a page that is not its own (or a thread).
  const latest = useRef(filter)
  latest.current = filter
  useEffect(() => {
    const { byRow, teammateId, projectId } = latest.current
    if (!byRow || pathname.startsWith('/app/threads')) return
    const own =
      byRow === 'teammate'
        ? pathname.startsWith(`/app/teammates/${teammateId}`)
        : pathname.startsWith(`/app/projects/${projectId}`)
    if (!own)
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
  // Pinned: in the order they were pinned, whatever the filter.
  const pinned = useMemo(
    () =>
      archived
        ? []
        : all.filter((t) => t.pinnedAt).sort((a, b) => a.pinnedAt!.localeCompare(b.pinnedAt!)),
    [all, archived],
  )
  const shown = useMemo(
    () =>
      all.filter(
        (t) =>
          (archived || !t.pinnedAt) &&
          (!filter.teammateId || inThread(t, filter.teammateId)) &&
          (!filter.projectId || t.projectId === filter.projectId) &&
          (!filter.statuses.length || filter.statuses.includes(statusKey(t)!)),
      ),
    [all, filter],
  )
  const groups = useMemo(() => {
    const by: Record<Group, ThreadSummary[]> = { waiting: [], working: [], rest: [] }
    for (const t of shown) by[groupOf(t.status)].push(t)
    return by
  }, [shown])
  // Another filter starts from the caps again.
  useEffect(() => setExtra(NONE_EXTRA), [filter])

  // Which older threads the server has for this filter: the teammate and project it can
  // narrow to; the status it cannot, so the list narrows what comes back.
  const query = `${filter.teammateId ? `&teammateId=${filter.teammateId}` : ''}${
    filter.projectId ? `&project=${filter.projectId}` : ''
  }`
  // Fewer than the panel's latest 100, unfiltered: there are none older.
  const mayHaveOlder =
    !archived && !!threads && !exhausted.includes(query) && (!!query || threads.length >= 100)
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
    } finally {
      setLoadingOlder(false)
    }
  }

  // What the list shows of each status: its first threads, then a "+N more" past them.
  const sections = (['waiting', 'working', 'rest'] as const).map((group) => {
    const list = groups[group]
    const visible = CAPS[group] + extra[group]
    const hidden = Math.max(0, list.length - visible)
    // The rest goes on past what is loaded: older threads, from the server.
    const older = group === 'rest' && mayHaveOlder
    const next = older && hidden < STEP ? STEP : Math.min(STEP, hidden)
    const loading = group === 'rest' && loadingOlder
    return {
      group,
      threads: list.slice(0, visible),
      more:
        next > 0
          ? {
              label: loading ? 'Loading…' : `+${next} more${MORE[group] ? ` ${MORE[group]}` : ''}`,
              loading,
              onSelect: () => {
                setExtra((e) => ({ ...e, [group]: e[group] + STEP }))
                if (older && hidden < STEP) void loadOlder()
              },
            }
          : undefined,
    }
  })

  /** At a row's end: what a thread waiting on a person asks, else how old it is. */
  function trailing(t: ThreadSummary, group: Group) {
    return (
      <span
        className={
          group === 'waiting' ? 'text-warning font-semibold' : 'text-muted-foreground font-normal'
        }
      >
        {group === 'waiting' ? (asks.get(t.id) ?? 'needs you') : shortAgo(t.updatedAt)}
      </span>
    )
  }

  function changed() {
    void reloadThreads()
    if (archived) void loadArchived()
  }
  function deleted(id: string) {
    setOlder((o) => o.filter((t) => t.id !== id))
    if (threadId === id) router.push('/app')
  }
  function row(t: ThreadSummary, group: Group) {
    const href = `/app/threads/${t.id}`
    return (
      <ThreadRow
        key={t.id}
        thread={t}
        href={href}
        active={threadId === t.id && (expanded || pathname === href)}
        icon={
          <ThreadStatusIcon status={t.status} unread={t.unread} stuck={!!t.eventsWaitingSince} />
        }
        trailing={trailing(t, group)}
        memberId={memberId}
        admin={admin}
        onChanged={changed}
        onDeleted={deleted}
      />
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

  // The list, here and folded in the panel beside the rail: each status's first threads and
  // its "+N more", which grows it in both.
  const list = (
    <>
      {threads && shown.length === 0 && (archived || !pinned.length) && (
        <li className="text-muted-foreground px-2 py-1.5 text-xs">
          {archived ? 'No archived threads.' : filtered ? 'No threads match.' : 'No threads yet.'}
        </li>
      )}
      {sections.map(({ group, threads, more }) => [
        ...threads.map((t) => row(t, group)),
        // No dot: a control, not a thread; its text lines up with the titles.
        more && (
          <SidebarMenuItem key={`more-${group}`}>
            <SidebarMenuButton
              size="sm"
              className="text-muted-foreground pl-8"
              disabled={more.loading}
              onClick={more.onSelect}
            >
              <span>{more.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ),
      ])}
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
                <SidebarMenu>{pinned.map((t) => row(t, groupOf(t.status)))}</SidebarMenu>
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
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>Pinned</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{pinned.map((t) => row(t, groupOf(t.status)))}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      )}

      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel className="pr-8">
          {/* Grown past the caps: the label takes the list back to them. */}
          {grown ? (
            <button
              type="button"
              onClick={shrink}
              title="Show fewer"
              aria-label="Threads: show fewer"
              className="hover:text-sidebar-foreground -ml-1 flex items-center gap-1 rounded-md px-1"
            >
              Threads
              <ChevronUp className="size-3.5" />
            </button>
          ) : (
            'Threads'
          )}
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
            <DropdownMenuLabel className="text-muted-foreground text-xs">Status</DropdownMenuLabel>
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
                  }}
                >
                  Clear filters
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <SidebarGroupContent>
          <SidebarMenu>{list}</SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel>Teammates</SidebarGroupLabel>
        {admin && (
          <SidebarGroupAction asChild title="New teammate">
            <Link href="/app/teammates/new">
              <Plus />
              <span className="sr-only">New teammate</span>
            </Link>
          </SidebarGroupAction>
        )}
        <SidebarGroupContent>
          <SidebarMenu>
            {teammates.map((t) => (
              <SidebarRow
                key={t.id}
                active={filter.teammateId === t.id}
                title={`${t.name}: its latest thread, and only its threads above`}
                onClick={() => clickTeammate(t.id)}
                icon={<TeammateAvatar teammate={t} className="size-5" />}
                label={t.name}
                threads={all.filter((thread) => inThread(thread, t.id))}
                action={{
                  href: `/app/teammates/${t.id}`,
                  label: `${t.name}'s settings`,
                  icon: <Settings />,
                }}
              />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel asChild>
          <Link href="/app/projects">Projects</Link>
        </SidebarGroupLabel>
        <SidebarGroupAction title="New project" onClick={onNewProject}>
          <Plus />
          <span className="sr-only">New project</span>
        </SidebarGroupAction>
        <SidebarGroupContent>
          <SidebarMenu>
            {live.map((p) => (
              <SidebarRow
                key={p.id}
                active={
                  filter.projectId === p.id ||
                  pathname === `/app/projects/${p.id}` ||
                  pathname.startsWith(`/app/projects/${p.id}/`)
                }
                title={`${p.name}: its page, and only its threads above`}
                onClick={() => clickProject(p.id)}
                icon={<ProjectIcon project={p} />}
                label={p.name}
                threads={all.filter((t) => t.projectId === p.id)}
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
      </SidebarGroup>
    </>
  )
}

/** A teammate or project: opens its thread or page, and narrows the list above to it. */
function SidebarRow({
  active,
  title,
  onClick,
  icon,
  label,
  threads,
  action,
}: {
  active: boolean
  title: string
  onClick: () => void
  icon: ReactNode
  label: string
  threads: ThreadSummary[]
  action?: { href: string; label: string; icon: ReactNode }
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={active} title={title} onClick={onClick}>
        {icon}
        <span className="truncate">{label}</span>
        <Signals threads={threads} hideOnHover={!!action} />
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
