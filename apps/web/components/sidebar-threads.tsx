'use client'
// The sidebar's work: one list of the latest threads, each with its status, and below it
// the teammates and projects, which narrow the list to theirs. The list shows a few
// threads of each status (waiting on a person, working, the rest) and folds the others
// into a "+N" row, so the teammates and projects stay in reach however many there are.
import { ArrowUpRight, Plus, Settings, X } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useMemo, useState, type ReactNode } from 'react'
import { TeammateAvatar } from '@/components/dashboard'
import { ProjectIcon } from '@/components/projects'
import { useThreadPanel } from '@/components/thread-panel'
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
import type { ProjectSummary, Teammate, ThreadSummary } from '@/lib/api'
import { cn } from '@/lib/utils'

type Group = 'waiting' | 'working' | 'rest'

/** How many of each show before the "+N" row. */
const CAPS: Record<Group, number> = { waiting: 2, working: 2, rest: 3 }
const MORE: Record<Group, string> = { waiting: 'waiting', working: 'working', rest: 'more' }

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

/** A thread's status as a shape and a colour, its word on hover. */
export function ThreadStatusIcon({ status, className }: { status: string; className?: string }) {
  const label = LABELS[status] ?? status
  const group = groupOf(status)
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn('flex size-4 shrink-0 items-center justify-center', className)}
    >
      {group === 'working' ? (
        <span className="border-primary size-3 animate-spin rounded-full border-2 border-t-transparent" />
      ) : group === 'waiting' ? (
        <span className="bg-warning ring-warning/25 size-2 rounded-full ring-[3px]" />
      ) : status === 'failed' ? (
        <span className="bg-destructive size-2 rounded-full" />
      ) : status === 'done' ? (
        <span className="bg-success size-2 rounded-full" />
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

/** What waits on a person and whether anything is working, among some threads. */
function signalsOf(threads: ThreadSummary[]) {
  let waiting = 0
  let working = false
  for (const t of threads) {
    const group = groupOf(t.status)
    if (group === 'waiting') waiting++
    else if (group === 'working') working = true
  }
  return { waiting, working }
}

function Signals({ threads }: { threads: ThreadSummary[] }) {
  const { waiting, working } = signalsOf(threads)
  if (!waiting && !working) return null
  return (
    <span className="text-muted-foreground ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[0.6875rem] group-hover/menu-item:opacity-0">
      {working && <ThreadStatusIcon status="running" />}
      {waiting > 0 && (
        <>
          <ThreadStatusIcon status="waiting" />
          <span className="text-warning font-semibold">{waiting}</span>
        </>
      )}
    </span>
  )
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <button
      type="button"
      onClick={onClear}
      aria-label={`Show every thread, not only ${label}'s`}
      className="bg-primary/15 text-primary ml-1 inline-flex h-5 max-w-28 items-center gap-1 rounded-full pr-1 pl-2 text-[0.6875rem] font-semibold tracking-normal normal-case"
    >
      <span className="truncate">{label}</span>
      <X className="size-3 shrink-0" />
    </button>
  )
}

export function SidebarWork({
  teammates,
  projects,
  admin,
  onNewProject,
}: {
  teammates: Teammate[]
  projects: ProjectSummary[]
  admin: boolean
  onNewProject: () => void
}) {
  const pathname = usePathname()
  const { threads, threadId, expanded } = useThreadPanel()
  const [teammateId, setTeammateId] = useState<string>()
  const [projectId, setProjectId] = useState<string>()
  const [open, setOpen] = useState<Group[]>([])
  const all = useMemo(() => threads ?? [], [threads])
  const live = projects.filter((p) => !p.archivedAt)
  const teammate = teammates.find((t) => t.id === teammateId)
  const project = live.find((p) => p.id === projectId)

  const shown = useMemo(
    () =>
      all.filter(
        (t) =>
          (!teammateId || inThread(t, teammateId)) && (!projectId || t.projectId === projectId),
      ),
    [all, teammateId, projectId],
  )
  const groups = useMemo(() => {
    const by: Record<Group, ThreadSummary[]> = { waiting: [], working: [], rest: [] }
    for (const t of shown) by[groupOf(t.status)].push(t)
    return by
  }, [shown])
  const toggleOpen = (group: Group) =>
    setOpen((o) => (o.includes(group) ? o.filter((g) => g !== group) : [...o, group]))

  return (
    <>
      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel>
          Threads
          {teammate && (
            <FilterChip label={teammate.name} onClear={() => setTeammateId(undefined)} />
          )}
          {project && <FilterChip label={project.name} onClear={() => setProjectId(undefined)} />}
        </SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {threads && shown.length === 0 && (
              <li className="text-muted-foreground px-2 py-1.5 text-xs">
                {teammate || project ? 'No threads here yet.' : 'No threads yet.'}
              </li>
            )}
            {(['waiting', 'working', 'rest'] as const).map((group) => {
              const list = groups[group]
              const isOpen = open.includes(group)
              const cap = isOpen ? list.length : CAPS[group]
              const hidden = list.length - Math.min(list.length, CAPS[group])
              return [
                ...list.slice(0, cap).map((t) => {
                  const href = `/app/threads/${t.id}`
                  return (
                    <SidebarMenuItem key={t.id}>
                      <SidebarMenuButton
                        asChild
                        isActive={threadId === t.id && (expanded || pathname === href)}
                      >
                        <Link href={href}>
                          <ThreadStatusIcon status={t.status} />
                          <span className="flex-1 truncate">{t.title || 'New thread'}</span>
                          <span
                            className={cn(
                              'ml-auto shrink-0 text-xs',
                              group === 'waiting'
                                ? 'text-warning font-semibold'
                                : 'text-muted-foreground font-normal',
                            )}
                          >
                            {group === 'waiting' ? 'needs you' : shortAgo(t.updatedAt)}
                          </span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                }),
                hidden > 0 && (
                  <SidebarMenuItem key={`more-${group}`}>
                    <SidebarMenuButton
                      size="sm"
                      className="text-muted-foreground"
                      onClick={() => toggleOpen(group)}
                    >
                      <ThreadStatusIcon
                        status={
                          group === 'working' ? 'running' : group === 'waiting' ? 'waiting' : 'idle'
                        }
                        className="opacity-60"
                      />
                      <span>{isOpen ? 'Show less' : `+${hidden} ${MORE[group]}`}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ),
              ]
            })}
          </SidebarMenu>
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
              <FilterRow
                key={t.id}
                active={teammateId === t.id}
                onToggle={() => setTeammateId((id) => (id === t.id ? undefined : t.id))}
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
              <FilterRow
                key={p.id}
                active={projectId === p.id}
                onToggle={() => setProjectId((id) => (id === p.id ? undefined : p.id))}
                icon={<ProjectIcon project={p} />}
                label={p.name}
                threads={all.filter((t) => t.projectId === p.id)}
                action={{
                  href: `/app/projects/${p.id}`,
                  label: `Open ${p.name}`,
                  icon: <ArrowUpRight />,
                }}
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

/** A teammate or project: narrows the list above to its threads; its own page is beside it. */
function FilterRow({
  active,
  onToggle,
  icon,
  label,
  threads,
  action,
}: {
  active: boolean
  onToggle: () => void
  icon: ReactNode
  label: string
  threads: ThreadSummary[]
  action: { href: string; label: string; icon: ReactNode }
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        aria-pressed={active}
        title={active ? 'Show every thread' : `Show ${label}'s threads`}
        onClick={onToggle}
      >
        {icon}
        <span className="truncate">{label}</span>
        <Signals threads={threads} />
      </SidebarMenuButton>
      <SidebarMenuAction asChild showOnHover>
        <Link href={action.href} aria-label={action.label} title={action.label}>
          {action.icon}
        </Link>
      </SidebarMenuAction>
    </SidebarMenuItem>
  )
}
