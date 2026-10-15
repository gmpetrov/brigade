'use client'
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  GitPullRequest,
  House,
  Inbox,
  Keyboard,
  KeyRound,
  Library,
  LogOut,
  Monitor,
  Moon,
  Plug,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  SquareKanban,
  Sun,
  UserRound,
  UsersRound,
  FolderKanban,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import Link from 'next/link'
import { useTheme } from 'next-themes'
import { usePathname, useRouter } from 'next/navigation'
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { AppLoader } from '@/components/app-loader'
import { DocumentPanel, DocumentPanelProvider } from '@/components/document-panel'
import { openShortcuts, ShortcutsDialog } from '@/components/help-menu'
import { PebbleAvatar } from '@/components/pebble-avatar'
import { NewProjectDialog, ProjectIcon } from '@/components/projects'
import { SearchDialog } from '@/components/search'
import { SidebarResizer, useSidebarWidth } from '@/components/sidebar-resizer'
import { SidebarWork } from '@/components/sidebar-threads'
import { QuickThread } from '@/components/quick-thread'
import {
  preloadThreadPanel,
  ThreadPanel,
  ThreadPanelProvider,
  useThreadPanel,
} from '@/components/thread-panel'
import { TopBar } from '@/components/top-bar'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar'
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
import { markSignedIn, markSignedOut } from '@/lib/signed-in'
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

/** A teammate's pebble, drawn from its id so it is the same everywhere; a teammate not
 * created yet (a proposal) has no id, and takes its name instead. The chief wears a
 * crown: known from its kind, or else from the workspace's teammates. */
export function TeammateAvatar({
  teammate,
  className,
}: {
  teammate: Pick<Teammate, 'name'> & { id?: string; kind?: Teammate['kind'] }
  className?: string
}) {
  const dashboard = useContext(DashboardContext)
  const kind = teammate.kind ?? dashboard?.teammates.find((t) => t.id === teammate.id)?.kind
  return (
    <PebbleAvatar
      seed={teammate.id ?? teammate.name}
      title={teammate.name}
      crown={kind === 'chief'}
      className={className ?? 'size-6'}
    />
  )
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  // The member first: no page shows before it. What the pages ask for as they open is sent
  // with it, so as not to wait for it (a trip each to the API): the lists below, and the
  // thread panel's (sent ahead). Without a workspace they fail, unseen: onboarding comes next.
  const me = useApi<Me>('/me')
  useEffect(() => preloadThreadPanel(pathname), []) // eslint-disable-line react-hooks/exhaustive-deps
  const teammates = useApi<Teammate[]>('/teammates')
  const projects = useApi<ProjectSummary[]>('/projects')
  const reloadProjects = projects.reload
  const [creatingProject, setCreatingProject] = useState(false)
  const mac = useIsMac()
  const { theme = 'system', setTheme } = useTheme()
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth()
  // Open pull requests and those waiting on a person, refreshed as the member moves around.
  const pullsWaiting = useApi<{ count: number; open: number }>('/pulls/attention')
  const reloadPulls = pullsWaiting.reload
  // Tickets waiting on this member, the same way.
  const tickets = useApi<Ticket[]>('/tickets')
  const reloadTickets = tickets.reload
  // Tasks that need a person, the same way.
  const tasks = useApi<Task[]>('/tasks')
  const reloadTasks = tasks.reload
  const [searching, setSearching] = useState(false)
  // Expanded or folded to icons, as the member left it: the sidebar keeps it in a cookie.
  // Read once, before the sidebar first shows (it waits for the member to load).
  const [sidebarOpen, setSidebarOpen] = useState(
    () => typeof document === 'undefined' || !document.cookie.includes('sidebar_state=false'),
  )
  // On the next page: the first one loaded them as it opened.
  const counted = useRef(pathname)
  useEffect(() => {
    if (counted.current === pathname) return
    counted.current = pathname
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
    if (me.error?.status === 401) {
      markSignedOut()
      router.replace('/sign-in')
    } else if (me.data) markSignedIn()
    // No workspace yet, or no AI account to run anything: onboarding first.
    if (me.data && (!me.data.activeWorkspaceId || !me.data.aiReady)) router.replace('/onboarding')
  }, [me.data, me.error, router])

  if (!me.data?.activeWorkspaceId || !me.data.aiReady) return <AppLoader />
  const data = me.data
  const workspace = data.workspaces.find((w) => w.id === data.activeWorkspaceId)
  const organization = data.organizations.find((o) => o.id === data.activeOrganizationId)
  // A badge counts what waits on the member; quiet ones (open pull requests) just count.
  const pullsWaitingCount = pullsWaiting.data?.count ?? 0
  const tasksNeedingYou = tasks.data?.filter((t) => t.column === 'needs_you').length ?? 0
  const tasksDoing = tasks.data?.filter((t) => t.column === 'doing').length ?? 0
  const badges: Badges = {
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

  // Threads with a ticket waiting on this member, and what the ticket asks of them.
  const needsYou: Record<string, string> = {}
  for (const t of tickets.data ?? [])
    if (t.session && waitsOn(t, data)) needsYou[t.session.id] ??= TICKET_ASKS[t.type] ?? 'needs you'

  async function switchWorkspace(workspaceId: string) {
    await api('/workspaces/switch', { body: { workspaceId } })
    window.location.href = '/app'
  }

  async function signOut() {
    await authClient.signOut()
    markSignedOut()
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
          <SidebarProvider
            open={sidebarOpen}
            onOpenChange={setSidebarOpen}
            style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
          >
            {/* Folds to a rail of icons (the top bar's button, ⌘B): projects, teammates and
                settings then open as menus beside it. */}
            <Sidebar collapsible="icon">
              <SidebarResizer width={sidebarWidth} onWidth={setSidebarWidth} />
              <SidebarHeader>
                <SidebarMenu>
                  <SidebarMenuItem className="flex items-center gap-2 group-data-[collapsible=icon]:block">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <SidebarMenuButton
                          size="lg"
                          className="min-w-0 flex-1 data-[state=open]:bg-sidebar-accent"
                        >
                          <span className="bg-sidebar-primary text-sidebar-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-sm font-bold">
                            {initial(workspace?.name ?? '')}
                          </span>
                          <span className="truncate font-semibold group-data-[collapsible=icon]:hidden">
                            {workspace?.name}
                          </span>
                          <ChevronDown className="text-muted-foreground size-3.5! group-data-[collapsible=icon]:hidden" />
                        </SidebarMenuButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="min-w-56">
                        <DropdownMenuLabel className="text-muted-foreground text-xs">
                          {organization?.name ?? 'Workspaces'}
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
                    <RoundButton
                      label={`Search (${mac ? '⌘K' : 'Ctrl+K'})`}
                      onClick={() => setSearching(true)}
                    >
                      <Search />
                    </RoundButton>
                    <NewThreadButton />
                  </SidebarMenuItem>
                </SidebarMenu>
                {/* Folded: the same two as icons of the rail. */}
                <SidebarMenu className="hidden group-data-[collapsible=icon]:flex">
                  <SidebarMenuItem>
                    <SidebarMenuButton tooltip="Search" onClick={() => setSearching(true)}>
                      <Search />
                      <span>Search</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <NewThreadRailItem />
                </SidebarMenu>
                {/* Home, first: what waits and what runs, across the workspace. */}
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild tooltip="Home" isActive={pathname === '/app'}>
                      <Link href="/app">
                        <House />
                        <span>Home</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarHeader>

              <SidebarContent>
                <SidebarWork
                  teammates={teammates.data ?? []}
                  projects={projects.data ?? []}
                  admin={isAdmin(data)}
                  onNewProject={() => setCreatingProject(true)}
                  needsYou={needsYou}
                />

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
                    <TeammatesRailMenu teammates={teammates.data ?? []} admin={isAdmin(data)} />
                  </SidebarMenu>
                </SidebarGroup>
              </SidebarContent>

              <SidebarFooter className="gap-3">
                <SidebarMenu>
                  <MoreMenu badges={badges} />
                </SidebarMenu>
                {/* The member and their menu, and the way to connect apps; folded, a column. */}
                <div className="flex items-center gap-2.5 group-data-[collapsible=icon]:flex-col">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={`${data.user.name}: appearance, help and sign out`}
                        className="focus-visible:ring-sidebar-ring shrink-0 rounded-full outline-none focus-visible:ring-2"
                      >
                        <Avatar className="size-10 group-data-[collapsible=icon]:size-8">
                          <AvatarFallback className="bg-secondary text-sm font-bold">
                            {initial(data.user.name)}
                          </AvatarFallback>
                        </Avatar>
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="top" align="start" className="min-w-60">
                      <DropdownMenuLabel className="grid leading-tight">
                        <span className="truncate">{data.user.name}</span>
                        <span className="text-muted-foreground truncate text-xs font-normal">
                          {organization?.name}
                        </span>
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
                        Appearance
                      </DropdownMenuLabel>
                      <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
                        <DropdownMenuRadioItem value="light">
                          <Sun /> Light
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="dark">
                          <Moon /> Dark
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="system">
                          <Monitor /> System
                        </DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={openShortcuts}>
                        <Keyboard /> Keyboard shortcuts
                        <span className="text-muted-foreground ml-auto text-xs">
                          {mac ? '⇧?' : 'Shift+?'}
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void signOut()}>
                        <LogOut /> Sign out
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Link
                    href="/app/connections"
                    title="Connect apps"
                    className="bg-card hover:bg-sidebar-accent focus-visible:ring-sidebar-ring flex h-10 min-w-0 flex-1 items-center justify-center gap-2.5 rounded-full border text-sm font-semibold outline-none focus-visible:ring-2 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:flex-none"
                  >
                    <Plug className="hidden size-4 group-data-[collapsible=icon]:block" />
                    <span className="truncate group-data-[collapsible=icon]:hidden">
                      Connect apps
                    </span>
                    <span aria-hidden className="flex group-data-[collapsible=icon]:hidden">
                      {APP_TILES.map(({ letter, className }) => (
                        <span
                          key={letter}
                          className={cn(
                            'border-card bg-secondary -ml-1 flex size-5 items-center justify-center rounded-md border-[1.5px] text-[0.625rem] font-bold first:ml-0',
                            className,
                          )}
                        >
                          {letter}
                        </span>
                      ))}
                    </span>
                  </Link>
                </div>
              </SidebarFooter>
            </Sidebar>

            <Inset>{children}</Inset>
          </SidebarProvider>
          <SearchDialog open={searching} onOpenChange={setSearching} />
          <ShortcutsDialog />
          <NewProjectDialog open={creatingProject} onOpenChange={setCreatingProject} />
        </ThreadPanelProvider>
      </DocumentPanelProvider>
    </DashboardContext.Provider>
  )
}

/** What a ticket asks of a person, at the end of its thread's row. */
const TICKET_ASKS: Partial<Record<Ticket['type'], string>> = {
  approval: 'approve',
  question: 'answer',
  request: 'needs you',
  sign_in: 'sign in',
  cap: 'raise cap',
  usage_limit: 'usage limit',
}

type Badges = Record<string, { count?: number; label: string; quiet?: boolean }>

/** Decoration for Connect apps: letter tiles until the services' own marks are added. */
const APP_TILES = [
  { letter: 'G', className: 'text-chart-4' },
  { letter: 'N', className: 'text-foreground' },
  { letter: 'S', className: 'text-chart-1' },
]

/** A round, outlined icon button beside the workspace's name. */
function RoundButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="bg-card text-foreground hover:bg-sidebar-accent focus-visible:ring-sidebar-ring flex size-9 shrink-0 items-center justify-center rounded-full border outline-none focus-visible:ring-2 group-data-[collapsible=icon]:hidden [&>svg]:size-4"
    >
      {children}
    </button>
  )
}

function NewThreadButton() {
  const { startThread } = useThreadPanel()
  const mac = useIsMac()
  return (
    <RoundButton label={`New thread (${mac ? '⌘⇧K' : 'Ctrl+Shift+K'})`} onClick={startThread}>
      <Plus />
    </RoundButton>
  )
}

function NewThreadRailItem() {
  const { startThread } = useThreadPanel()
  return (
    <SidebarMenuItem>
      <SidebarMenuButton tooltip="New thread" onClick={startThread}>
        <Plus />
        <span>New thread</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

/**
 * The pages that are not threads or Home: the work (tickets, tasks…) and the workspace's
 * settings, in one menu above the member.
 */
function MoreMenu({ badges }: { badges: Badges }) {
  const pathname = usePathname()
  const { isMobile, state } = useSidebar()
  const folded = state === 'collapsed' && !isMobile
  const active = NAV.some(({ href }) => href !== '/app' && pathname.startsWith(href))
  const work = WORK_NAV.filter(({ href }) => href !== '/app')
  const waiting = work.some(({ href }) => badges[href]?.count && !badges[href]?.quiet)
  const item = ({ href, label, icon: Icon }: (typeof NAV)[number]) => {
    const badge = badges[href]
    return (
      <DropdownMenuItem key={href} asChild>
        <Link href={href}>
          <Icon />
          <span className="flex-1">{label}</span>
          {!!badge?.count && (
            <span
              aria-label={`${badge.count} ${badge.label}`}
              className={cn(
                'flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full px-1.5 text-[0.6875rem] leading-none font-semibold',
                badge.quiet
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'bg-primary text-primary-foreground',
              )}
            >
              {badge.count > 99 ? '99+' : badge.count}
            </span>
          )}
        </Link>
      </DropdownMenuItem>
    )
  }
  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            tooltip="More"
            isActive={active}
            className="text-muted-foreground data-[state=open]:bg-sidebar-accent relative"
          >
            <Ellipsis />
            {/* Folded, what waits is a dot on the icon. */}
            {waiting && (
              <span
                aria-hidden
                className="bg-primary ring-sidebar absolute top-1 right-1 hidden size-2 rounded-full ring-2 group-data-[collapsible=icon]:block"
              />
            )}
            <span>More</span>
            <ChevronRight className="ml-auto group-data-[collapsible=icon]:hidden" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={folded ? 'right' : 'top'}
          align={folded ? 'end' : 'start'}
          className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
        >
          {work.map(item)}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
            Workspace settings
          </DropdownMenuLabel>
          {SETTINGS_NAV.map(item)}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
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
/** Folded, the teammates as a menu beside the rail: each opens its threads, as above. */
function TeammatesRailMenu({ teammates, admin }: { teammates: Teammate[]; admin: boolean }) {
  const router = useRouter()
  const { expanded, teammateId, teammateHref, chooseTeammate } = useThreadPanel()
  const pathname = usePathname()
  return (
    <RailMenu
      icon={UsersRound}
      label="AI teammates"
      active={
        pathname.startsWith('/app/teammates') ||
        (expanded && teammates.some((t) => t.id === teammateId))
      }
      items={teammates.map((t) => ({
        id: t.id,
        href: teammateHref(t.id),
        label: t.name,
        icon: <TeammateAvatar teammate={t} className="size-5" />,
        onSelect: () => chooseTeammate(t.id),
      }))}
      action={
        admin
          ? { label: 'New teammate', onSelect: () => router.push('/app/teammates/new') }
          : undefined
      }
    />
  )
}

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
  /** `id` when two go to the same address. */
  items: { id?: string; href: string; label: string; icon: ReactNode; onSelect?: () => void }[]
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
            <DropdownMenuItem key={item.id ?? item.href} asChild onSelect={item.onSelect}>
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
