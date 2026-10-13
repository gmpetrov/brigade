'use client'
import {
  CalendarClock,
  ChevronRight,
  ChevronsUpDown,
  GitPullRequest,
  House,
  Inbox,
  KeyRound,
  Library,
  LogOut,
  Monitor,
  Plug,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  SquareKanban,
  UserRound,
  UsersRound,
  FolderKanban,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { DocumentPanel, DocumentPanelProvider } from '@/components/document-panel'
import { HelpMenu } from '@/components/help-menu'
import { NewProjectDialog, ProjectIcon } from '@/components/projects'
import { SearchButton, SearchDialog } from '@/components/search'
import { ThemeToggle } from '@/components/theme-toggle'
import { QuickThread } from '@/components/quick-thread'
import { ThreadPanel, ThreadPanelProvider, useThreadPanel } from '@/components/thread-panel'
import { TopBar } from '@/components/top-bar'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar'
import { Skeleton } from '@/components/ui/skeleton'
import {
  api,
  isAdmin,
  useApi,
  waitsOn,
  type Me,
  type ProjectSummary,
  type Task,
  type Teammate,
  type Ticket,
} from '@/lib/api'
import { authClient } from '@/lib/auth-client'
import { useIsMac } from '@/lib/platform'
import { useLive } from '@/lib/use-live'
import { cn } from '@/lib/utils'

export { StatusBadge } from '@/components/status-badge'

type Dashboard = {
  me: Me
  teammates: Teammate[]
  reloadTeammates: () => Promise<void>
  /** Archived ones included; the sidebar and pickers leave them out. */
  projects: ProjectSummary[]
  reloadProjects: () => Promise<void>
}
const DashboardContext = createContext<Dashboard | null>(null)

export function useDashboard() {
  const value = useContext(DashboardContext)
  if (!value) throw new Error('useDashboard outside the dashboard')
  return value
}

export { isAdmin }

/** The work: what projects group. */
const WORK_NAV = [
  { href: '/app', label: 'Home', icon: House },
  { href: '/app/tickets', label: 'Tickets', icon: Inbox },
  { href: '/app/tasks', label: 'Tasks', icon: SquareKanban },
  { href: '/app/pulls', label: 'Pull requests', icon: GitPullRequest },
  { href: '/app/library', label: 'Library', icon: Library },
  { href: '/app/automations', label: 'Automations', icon: CalendarClock },
]

/** The setup every project shares. */
const SETTINGS_NAV = [
  { href: '/app/connections', label: 'Connections', icon: Plug },
  { href: '/app/vault', label: 'Secrets', icon: KeyRound },
  { href: '/app/security', label: 'Security', icon: ShieldCheck },
  { href: '/app/accounts', label: 'AI Accounts', icon: UserRound },
  { href: '/app/computers', label: 'Computers', icon: Monitor },
]

export const NAV = [...WORK_NAV, ...SETTINGS_NAV]

const initial = (name: string) => name.trim().charAt(0).toUpperCase() || '?'

export function TeammateAvatar({
  teammate,
  className,
}: {
  teammate: Pick<Teammate, 'name' | 'harness'>
  className?: string
}) {
  return (
    <Avatar className={className ?? 'size-6'}>
      <AvatarFallback
        className={
          teammate.harness === 'codex'
            ? 'bg-accent text-accent-foreground text-[0.7em] font-bold'
            : 'bg-primary/15 text-primary text-[0.7em] font-bold'
        }
      >
        {initial(teammate.name)}
      </AvatarFallback>
    </Avatar>
  )
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const me = useApi<Me>('/me')
  const ready = me.data?.activeWorkspaceId ?? null
  const teammates = useApi<Teammate[]>(ready ? '/teammates' : null)
  const projects = useApi<ProjectSummary[]>(ready ? '/projects' : null)
  const reloadProjects = projects.reload
  const [creatingProject, setCreatingProject] = useState(false)
  const inSettings = SETTINGS_NAV.some((n) => pathname.startsWith(n.href))
  const [settingsOpen, setSettingsOpen] = useState(inSettings)
  useEffect(() => {
    if (inSettings) setSettingsOpen(true)
  }, [inSettings])
  // Open pull requests and those waiting on a person, refreshed as the member moves around.
  const pullsWaiting = useApi<{ count: number; open: number }>(ready ? '/pulls/attention' : null)
  const reloadPulls = pullsWaiting.reload
  // Tickets waiting on this member, the same way.
  const tickets = useApi<Ticket[]>(ready ? '/tickets' : null)
  const reloadTickets = tickets.reload
  // Tasks that need a person, the same way.
  const tasks = useApi<Task[]>(ready ? '/tasks' : null)
  const reloadTasks = tasks.reload
  const [searching, setSearching] = useState(false)
  // Expanded or folded to icons, as the member left it: the sidebar keeps it in a cookie.
  // Read once, before the sidebar first shows (it waits for the member to load).
  const [sidebarOpen, setSidebarOpen] = useState(
    () => typeof document === 'undefined' || !document.cookie.includes('sidebar_state=false'),
  )
  useEffect(() => {
    void reloadPulls()
    void reloadTickets()
    void reloadTasks()
  }, [pathname, reloadPulls, reloadTickets, reloadTasks])
  // And live: a task's column follows its thread's status and open tickets.
  useLive((message) => {
    if (message.type === 'projects.updated') void reloadProjects()
    if (message.type === 'pulls.updated') void reloadPulls()
    if (message.type === 'tickets.updated') void reloadTickets()
    if (
      message.type === 'task.updated' ||
      message.type === 'thread.updated' ||
      message.type === 'tickets.updated'
    )
      void reloadTasks()
  })

  useEffect(() => {
    if (me.error?.status === 401) router.replace('/sign-in')
    // No workspace yet, or no AI account to run anything: onboarding first.
    else if (me.data && (!me.data.activeWorkspaceId || !me.data.aiReady))
      router.replace('/onboarding')
  }, [me.data, me.error, router])

  if (!me.data?.activeWorkspaceId || !me.data.aiReady)
    return (
      <div className="flex min-h-svh items-center justify-center">
        <Skeleton className="h-6 w-40" />
      </div>
    )
  const data = me.data
  const workspace = data.workspaces.find((w) => w.id === data.activeWorkspaceId)
  const organization = data.organizations.find((o) => o.id === data.activeOrganizationId)
  // A badge counts what waits on the member; quiet ones (open pull requests) just count.
  const pullsWaitingCount = pullsWaiting.data?.count ?? 0
  const tasksNeedingYou = tasks.data?.filter((t) => t.column === 'needs_you').length ?? 0
  const tasksDoing = tasks.data?.filter((t) => t.column === 'doing').length ?? 0
  const badges: Record<string, { count?: number; label: string; quiet?: boolean }> = {
    '/app/tickets': {
      count: tickets.data?.filter((t) => waitsOn(t, data)).length,
      label: 'waiting on you',
    },
    '/app/pulls': {
      count: pullsWaiting.data?.open,
      label: pullsWaitingCount > 0 ? `open, ${pullsWaitingCount} waiting on you` : 'open',
      quiet: pullsWaitingCount === 0,
    },
    '/app/tasks': {
      count: tasksNeedingYou + tasksDoing,
      label: `active: ${tasksNeedingYou} need you, ${tasksDoing} in progress`,
      quiet: tasksNeedingYou === 0,
    },
  }

  async function switchWorkspace(workspaceId: string) {
    await api('/workspaces/switch', { body: { workspaceId } })
    window.location.href = '/app'
  }

  async function signOut() {
    await authClient.signOut()
    router.replace('/sign-in')
  }

  return (
    <DashboardContext.Provider
      value={{
        me: data,
        teammates: teammates.data ?? [],
        reloadTeammates: teammates.reload,
        projects: projects.data ?? [],
        reloadProjects,
      }}
    >
      <DocumentPanelProvider>
        <ThreadPanelProvider>
          <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
            {/* Folds to a rail of icons (the top bar's button, ⌘B): projects, teammates and
                settings then open as menus beside it. */}
            <Sidebar collapsible="icon">
              <SidebarHeader>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <SidebarMenuButton
                          size="lg"
                          className="data-[state=open]:bg-sidebar-accent"
                        >
                          <span className="bg-sidebar-primary text-sidebar-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-sm font-bold">
                            {initial(workspace?.name ?? '')}
                          </span>
                          <span className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                            <span className="truncate font-semibold">{workspace?.name}</span>
                            <span className="text-muted-foreground truncate text-xs">
                              {organization?.name}
                            </span>
                          </span>
                          <ChevronsUpDown className="ml-auto group-data-[collapsible=icon]:hidden" />
                        </SidebarMenuButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="start"
                        className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
                      >
                        <DropdownMenuLabel className="text-muted-foreground text-xs">
                          Workspaces
                        </DropdownMenuLabel>
                        {data.workspaces.map((w) => (
                          <DropdownMenuItem key={w.id} onSelect={() => void switchWorkspace(w.id)}>
                            <span className="bg-secondary flex size-6 items-center justify-center rounded-sm text-xs font-bold">
                              {initial(w.name)}
                            </span>
                            {w.name}
                          </DropdownMenuItem>
                        ))}
                        {isAdmin(data) && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => router.push('/onboarding')}>
                              <Plus /> New workspace
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </SidebarMenuItem>
                </SidebarMenu>
                <SearchButton onClick={() => setSearching(true)} />
                <SidebarMenu className="hidden group-data-[collapsible=icon]:flex">
                  <SidebarMenuItem>
                    <SidebarMenuButton tooltip="Search" onClick={() => setSearching(true)}>
                      <Search />
                      <span>Search</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarHeader>

              <SidebarContent>
                <SidebarGroup>
                  <SidebarGroupLabel>Work</SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {WORK_NAV.map(({ href, label, icon: Icon }) => {
                        const badge = badges[href]
                        return (
                          <SidebarMenuItem key={href}>
                            <SidebarMenuButton
                              asChild
                              tooltip={
                                badge?.count ? `${label} · ${badge.count} ${badge.label}` : label
                              }
                              isActive={
                                pathname === href ||
                                (href === '/app/pulls' && pathname.startsWith(href))
                              }
                            >
                              <Link href={href} className="relative">
                                <Icon />
                                {/* Folded, the count is a dot on the icon. */}
                                {!!badge?.count && (
                                  <span
                                    aria-hidden
                                    className={cn(
                                      'absolute top-1 right-1 hidden size-2 rounded-full ring-2 ring-sidebar group-data-[collapsible=icon]:block',
                                      badge.quiet ? 'bg-muted-foreground' : 'bg-primary',
                                    )}
                                  />
                                )}
                                <span>{label}</span>
                              </Link>
                            </SidebarMenuButton>
                            {!!badge?.count && (
                              <SidebarMenuBadge
                                aria-label={`${badge.count} ${badge.label}`}
                                className="right-2"
                              >
                                <span
                                  className={cn(
                                    'flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full px-1.5 text-[0.6875rem] leading-none font-semibold',
                                    badge.quiet
                                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                                      : 'bg-primary text-primary-foreground',
                                  )}
                                >
                                  {badge.count > 99 ? '99+' : badge.count}
                                </span>
                              </SidebarMenuBadge>
                            )}
                          </SidebarMenuItem>
                        )
                      })}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>

                {/* Folded: projects and teammates as menus beside the rail. */}
                <SidebarGroup className="hidden group-data-[collapsible=icon]:flex">
                  <SidebarMenu>
                    <RailMenu
                      icon={FolderKanban}
                      label="Projects"
                      href="/app/projects"
                      active={pathname.startsWith('/app/projects')}
                      items={(projects.data ?? [])
                        .filter((p) => !p.archivedAt)
                        .map((p) => ({
                          href: `/app/projects/${p.id}`,
                          label: p.name,
                          icon: <ProjectIcon project={p} />,
                        }))}
                      action={{ label: 'New project', onSelect: () => setCreatingProject(true) }}
                    />
                    <RailMenu
                      icon={UsersRound}
                      label="AI teammates"
                      active={pathname.startsWith('/app/teammates')}
                      items={(teammates.data ?? []).map((t) => ({
                        href: `/app/teammates/${t.id}`,
                        label: t.name,
                        icon: <TeammateAvatar teammate={t} className="size-5" />,
                      }))}
                      action={
                        isAdmin(data)
                          ? {
                              label: 'New teammate',
                              onSelect: () => router.push('/app/teammates/new'),
                            }
                          : undefined
                      }
                    />
                  </SidebarMenu>
                </SidebarGroup>

                <SidebarGroup className="group-data-[collapsible=icon]:hidden">
                  <SidebarGroupLabel asChild>
                    <Link href="/app/projects">Projects</Link>
                  </SidebarGroupLabel>
                  <SidebarGroupAction title="New project" onClick={() => setCreatingProject(true)}>
                    <Plus />
                    <span className="sr-only">New project</span>
                  </SidebarGroupAction>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {(projects.data ?? [])
                        .filter((p) => !p.archivedAt)
                        .map((p) => {
                          const href = `/app/projects/${p.id}`
                          return (
                            <SidebarMenuItem key={p.id}>
                              <SidebarMenuButton
                                asChild
                                isActive={pathname === href || pathname.startsWith(`${href}/`)}
                              >
                                <Link href={href}>
                                  <ProjectIcon project={p} />
                                  <span>{p.name}</span>
                                </Link>
                              </SidebarMenuButton>
                            </SidebarMenuItem>
                          )
                        })}
                      {projects.data?.every((p) => p.archivedAt) && (
                        <SidebarMenuItem>
                          <SidebarMenuButton
                            className="text-muted-foreground"
                            onClick={() => setCreatingProject(true)}
                          >
                            <Plus />
                            <span>New project</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      )}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>

                <SidebarGroup className="group-data-[collapsible=icon]:hidden">
                  <SidebarGroupLabel>AI teammates</SidebarGroupLabel>
                  {isAdmin(data) && (
                    <SidebarGroupAction asChild title="New teammate">
                      <Link href="/app/teammates/new">
                        <Plus />
                        <span className="sr-only">New teammate</span>
                      </Link>
                    </SidebarGroupAction>
                  )}
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {(teammates.data ?? []).map((t) => {
                        const href = `/app/teammates/${t.id}`
                        return (
                          <SidebarMenuItem key={t.id}>
                            <SidebarMenuButton asChild isActive={pathname === href}>
                              <Link href={href}>
                                <TeammateAvatar teammate={t} className="size-5" />
                                <span>{t.name}</span>
                              </Link>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        )
                      })}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>

                <SidebarGroup className="mt-auto">
                  <SidebarGroupContent>
                    <SidebarMenu className="hidden group-data-[collapsible=icon]:flex">
                      <RailMenu
                        icon={Settings}
                        label="Workspace settings"
                        active={inSettings}
                        items={SETTINGS_NAV.map(({ href, label, icon: Icon }) => ({
                          href,
                          label,
                          icon: <Icon />,
                        }))}
                      />
                    </SidebarMenu>
                    <SidebarMenu className="group-data-[collapsible=icon]:hidden">
                      <Collapsible
                        open={settingsOpen}
                        onOpenChange={setSettingsOpen}
                        className="group/settings"
                        asChild
                      >
                        <SidebarMenuItem>
                          <CollapsibleTrigger asChild>
                            <SidebarMenuButton isActive={inSettings && !settingsOpen}>
                              <Settings />
                              <span>Workspace settings</span>
                              <ChevronRight className="ml-auto transition-transform group-data-[state=open]/settings:rotate-90" />
                            </SidebarMenuButton>
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <SidebarMenuSub>
                              {SETTINGS_NAV.map(({ href, label, icon: Icon }) => (
                                <SidebarMenuSubItem key={href}>
                                  <SidebarMenuSubButton
                                    asChild
                                    isActive={pathname.startsWith(href)}
                                  >
                                    <Link href={href}>
                                      <Icon />
                                      <span>{label}</span>
                                    </Link>
                                  </SidebarMenuSubButton>
                                </SidebarMenuSubItem>
                              ))}
                            </SidebarMenuSub>
                          </CollapsibleContent>
                        </SidebarMenuItem>
                      </Collapsible>
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              </SidebarContent>

              <SidebarFooter>
                {/* Folded, a column: the member, then help, appearance and sign out. */}
                <div className="bg-card flex items-center gap-2 rounded-lg border p-2 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-0">
                  <Avatar className="size-8">
                    <AvatarFallback className="bg-secondary text-xs font-bold">
                      {initial(data.user.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:hidden">
                    <span className="truncate text-sm font-semibold">{data.user.name}</span>
                    <span className="text-muted-foreground truncate text-xs">
                      {organization?.name}
                    </span>
                  </div>
                  <HelpMenu />
                  <ThemeToggle />
                  <Button variant="ghost" size="icon-sm" aria-label="Sign out" onClick={signOut}>
                    <LogOut />
                  </Button>
                </div>
              </SidebarFooter>
            </Sidebar>

            <Inset>{children}</Inset>
          </SidebarProvider>
          <SearchDialog open={searching} onOpenChange={setSearching} />
          <NewProjectDialog open={creatingProject} onOpenChange={setCreatingProject} />
        </ThreadPanelProvider>
      </DocumentPanelProvider>
    </DashboardContext.Provider>
  )
}

/** Folds the sidebar to its icons and back (⌘B); on a phone, opens it. */
export function SidebarToggle({ className }: { className?: string }) {
  const { open, isMobile } = useSidebar()
  const mac = useIsMac()
  const label = isMobile ? 'Open the sidebar' : open ? 'Collapse the sidebar' : 'Expand the sidebar'
  return (
    <SidebarTrigger
      className={cn('-ml-1 size-8 text-muted-foreground hover:text-foreground', className)}
      aria-label={label}
      title={isMobile ? label : `${label} (${mac ? '⌘' : 'Ctrl+'}B)`}
    />
  )
}

/**
 * The folded sidebar's way to a list (projects, teammates, settings): its icon, and
 * beside it a menu of the list.
 */
function RailMenu({
  icon: Icon,
  label,
  href,
  active,
  items,
  action,
}: {
  icon: LucideIcon
  label: string
  /** The list's own page, first in the menu. */
  href?: string
  active: boolean
  items: { href: string; label: string; icon: ReactNode }[]
  action?: { label: string; onSelect: () => void }
}) {
  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton tooltip={label} isActive={active}>
            <Icon />
            <span>{label}</span>
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="min-w-52">
          {href ? (
            <DropdownMenuItem asChild>
              <Link href={href} className="text-muted-foreground text-xs font-medium">
                {label}
              </Link>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuLabel className="text-muted-foreground text-xs">{label}</DropdownMenuLabel>
          )}
          {items.map((item) => (
            <DropdownMenuItem key={item.href} asChild>
              <Link href={item.href}>
                {item.icon}
                <span className="truncate">{item.label}</span>
              </Link>
            </DropdownMenuItem>
          ))}
          {action && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={action.onSelect}>
                <Plus /> {action.label}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
}

/**
 * Beside the sidebar: the top bar and the page, the threads panel and a document beside
 * it. The threads panel expanded is the page (a thread's own address): it takes its place.
 */
function Inset({ children }: { children: ReactNode }) {
  const { expanded, computerPage } = useThreadPanel()
  return (
    // min-w-0: long unwrapped text inside a page must not widen it past the window.
    <SidebarInset className="min-w-0">
      {!expanded && <TopBar />}
      {/* Before the document: a document opened over a docked thread covers it until closed. */}
      <ThreadPanel />
      <QuickThread />
      <DocumentPanel />
      {/* A computer's screen takes the whole page, edge to edge. */}
      <div
        data-bleed={computerPage ? '' : undefined}
        className={cn(
          computerPage
            ? 'w-full min-w-0'
            : 'mx-auto w-full max-w-5xl min-w-0 px-4 pt-6 pb-16 md:px-10 md:pt-8',
          expanded && 'hidden',
        )}
      >
        {children}
      </div>
    </SidebarInset>
  )
}

export function timeAgo(iso: string) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return new Date(iso).toLocaleDateString()
}
