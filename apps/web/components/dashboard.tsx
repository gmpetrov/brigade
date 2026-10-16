'use client'
import {
  Bell,
  CalendarClock,
  ChevronDown,
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
import { ProviderLogo, type ProviderKind } from '@/components/provider-logo'
import {
  NotificationsDialog,
  openNotifications,
  useAppNotifications,
} from '@/components/notifications'
import { NewProjectDialog, ProjectIcon } from '@/components/projects'
import { SearchDialog } from '@/components/search'
import { SidebarResizer, useSidebarWidth } from '@/components/sidebar-resizer'
import { RailMenu } from '@/components/rail-menu'
import { SidebarWork } from '@/components/sidebar-threads'
import { QuickThread } from '@/components/quick-thread'
import {
  preloadThreadPanel,
  ThreadPanel,
  ThreadPanelProvider,
  useThreadPanel,
} from '@/components/thread-panel'
import { TopBar } from '@/components/top-bar'
import { UpdatePill } from '@/components/update-pill'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
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
import { inCaptureWindow } from '@/lib/brigade-app'
import { authClient } from '@/lib/auth-client'
import { markSignedIn, markSignedOut } from '@/lib/signed-in'
import { isMac, useIsMac } from '@/lib/platform'
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

/** The setup every project shares: the Settings page's sections, its first one first. */
export const SETTINGS_NAV = [
  { href: '/app/connections', label: 'Apps', icon: Plug },
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
  // Tickets waiting on this member, refreshed as the member moves around.
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
    void reloadTickets()
    void reloadTasks()
  }, [pathname, reloadTickets, reloadTasks])
  // And live: a task's column follows its thread's status and open tickets.
  useLive((message) => {
    if (message.type === 'projects.updated') void reloadProjects()
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

  // Opened from a notification about another of the member's workspaces: switch to it.
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('workspace')
    if (!wanted || !me.data || wanted === me.data.activeWorkspaceId) return
    if (!me.data.workspaces.some((w) => w.id === wanted)) return
    void api('/workspaces/switch', { body: { workspaceId: wanted } }).then(() =>
      window.location.reload(),
    )
  }, [me.data])

  useSettingsShortcut()

  // Brigade.app's screenshot window shows its page alone; signing in there lands it back on it.
  const capture = pathname === '/app/capture'
  useEffect(() => {
    if (pathname === '/app' && inCaptureWindow()) router.replace('/app/capture')
  }, [pathname, router])

  if (!me.data?.activeWorkspaceId || !me.data.aiReady) return <AppLoader />
  const data = me.data
  const workspace = data.workspaces.find((w) => w.id === data.activeWorkspaceId)
  const organization = data.organizations.find((o) => o.id === data.activeOrganizationId)
  // Threads with a ticket waiting on this member, and what the ticket asks of them.
  const needsYou: Record<string, string> = {}
  for (const t of tickets.data ?? [])
    if (t.session && waitsOn(t, data)) needsYou[t.session.id] ??= TICKET_ASKS[t.type] ?? 'needs you'
  // And threads whose task is in Needs you, so the list agrees with the board.
  for (const t of tasks.data ?? [])
    if (t.column === 'needs_you' && t.thread)
      needsYou[t.thread.id] ??= t.thread.openPullRequests.length ? 'review PR' : 'needs you'

  async function switchWorkspace(workspaceId: string) {
    await api('/workspaces/switch', { body: { workspaceId } })
    window.location.href = '/app'
  }

  async function signOut() {
    await authClient.signOut()
    markSignedOut()
    router.replace('/sign-in')
  }

  const dashboard = {
    me: data,
    teammates: teammates.data ?? [],
    reloadTeammates: teammates.reload,
    projects: projects.data ?? [],
    reloadProjects,
  }
  if (capture)
    return <DashboardContext.Provider value={dashboard}>{children}</DashboardContext.Provider>

  return (
    <DashboardContext.Provider value={dashboard}>
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
              </SidebarHeader>

              <SidebarContent>
                {/* Home, first: what waits and what runs. It scrolls with the threads below. */}
                <SidebarGroup className="py-0">
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
                </SidebarGroup>
                <SidebarWork
                  teammates={teammates.data ?? []}
                  projects={projects.data ?? []}
                  admin={isAdmin(data)}
                  memberId={data.memberId}
                  onNewProject={() => setCreatingProject(true)}
                  needsYou={needsYou}
                  rail={
                    <>
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
                    </>
                  }
                />
              </SidebarContent>

              <SidebarFooter className="gap-3">
                {/* The member and their menu, and the way to connect apps; folded, a column. */}
                <div className="flex items-center gap-2 px-2 pb-2 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:p-0">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={`${data.user.name}: settings, appearance, notifications, help and sign out`}
                        className="focus-visible:ring-sidebar-ring shrink-0 rounded-full outline-none focus-visible:ring-2"
                      >
                        <Avatar className="size-9 group-data-[collapsible=icon]:size-8">
                          {data.user.image && (
                            <AvatarImage
                              src={data.user.image}
                              alt=""
                              referrerPolicy="no-referrer"
                            />
                          )}
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
                      <DropdownMenuItem asChild>
                        <Link href="/app/settings">
                          <Settings /> Settings
                          <span className="text-muted-foreground ml-auto text-xs">
                            {mac ? '⌘,' : 'Ctrl+,'}
                          </span>
                        </Link>
                      </DropdownMenuItem>
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
                      <DropdownMenuItem onSelect={openNotifications}>
                        <Bell /> Notifications
                      </DropdownMenuItem>
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
                    className="group/apps bg-card hover:bg-sidebar-accent focus-visible:ring-sidebar-ring flex h-9 min-w-0 flex-1 items-center justify-center gap-2 rounded-full border text-[0.9375rem] font-medium outline-none focus-visible:ring-2 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:flex-none"
                  >
                    <Plug className="hidden size-4 group-data-[collapsible=icon]:block" />
                    <span className="truncate group-data-[collapsible=icon]:hidden">
                      Connect apps
                    </span>
                    <span aria-hidden className="flex group-data-[collapsible=icon]:hidden">
                      {APP_TILES.map(({ kind, fan }) => (
                        <span
                          key={kind}
                          className={cn(
                            'border-card -ml-1.5 flex size-5 items-center justify-center overflow-hidden rounded-[0.35rem] border bg-white text-[#181717] transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] first:ml-0 motion-reduce:transition-none',
                            fan,
                          )}
                        >
                          <ProviderLogo
                            kind={kind}
                            className={kind === 'stripe' ? 'size-full' : 'size-3.5'}
                          />
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
          <NotificationsDialog />
          <AppNotifications needsYou={Object.keys(needsYou).length} />
          <NewProjectDialog open={creatingProject} onOpenChange={setCreatingProject} />
        </ThreadPanelProvider>
      </DocumentPanelProvider>
    </DashboardContext.Provider>
  )
}

/** What a ticket asks of a person, at the end of its thread's row. */
/** The service worker, this device's subscription and the app icon badge: what needs the member. */
function AppNotifications({ needsYou }: { needsYou: number }) {
  useAppNotifications(needsYou)
  return null
}

const TICKET_ASKS: Partial<Record<Ticket['type'], string>> = {
  approval: 'approve',
  question: 'answer',
  request: 'needs you',
  sign_in: 'sign in',
  cap: 'raise cap',
  usage_limit: 'usage limit',
}

/** Decoration for Connect apps: the services' marks, which fan out while the pointer is over the button. */
const APP_TILES: { kind: ProviderKind; fan: string }[] = [
  {
    kind: 'github',
    fan: 'group-hover/apps:-translate-x-1 group-hover/apps:-rotate-12 group-focus-visible/apps:-translate-x-1 group-focus-visible/apps:-rotate-12',
  },
  {
    kind: 'gmail',
    fan: 'group-hover/apps:-translate-y-0.5 group-hover/apps:scale-110 group-focus-visible/apps:-translate-y-0.5 group-focus-visible/apps:scale-110',
  },
  {
    kind: 'stripe',
    fan: 'group-hover/apps:translate-x-1 group-hover/apps:rotate-12 group-focus-visible/apps:translate-x-1 group-focus-visible/apps:rotate-12',
  },
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
  const { newThreadPage } = useThreadPanel()
  return (
    <RoundButton label="New thread" onClick={newThreadPage}>
      <Plus />
    </RoundButton>
  )
}

function NewThreadRailItem() {
  const { newThreadPage } = useThreadPanel()
  return (
    <SidebarMenuItem>
      <SidebarMenuButton tooltip="New thread" onClick={newThreadPage}>
        <Plus />
        <span>New thread</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

/** ⌘, (Ctrl+, elsewhere) opens Settings, as in most apps; not over a dialog. */
function useSettingsShortcut() {
  const router = useRouter()
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.repeat) return
      const command = isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      if (!command || e.shiftKey || e.altKey || e.key !== ',') return
      if (document.querySelector('[role=dialog][data-state=open]')) return
      e.preventDefault()
      router.push('/app/settings')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [router])
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

/** Folded, the teammates as a menu beside the rail: each opens its threads, as above. */
function TeammatesRailMenu({ teammates, admin }: { teammates: Teammate[]; admin: boolean }) {
  const router = useRouter()
  const { teammateHref, chooseTeammate } = useThreadPanel()
  const pathname = usePathname()
  return (
    <RailMenu
      icon={UsersRound}
      label="AI teammates"
      active={pathname.startsWith('/app/teammates')}
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

/**
 * Beside the sidebar: the top bar and the page, the threads panel and a document beside
 * it. The threads panel expanded is the page (a thread's own address): it takes its place.
 */
function Inset({ children }: { children: ReactNode }) {
  const { expanded, computerPage } = useThreadPanel()
  return (
    // min-w-0: long unwrapped text inside a page must not widen it past the window.
    <SidebarInset className="min-w-0">
      <UpdatePill header={expanded} />
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
