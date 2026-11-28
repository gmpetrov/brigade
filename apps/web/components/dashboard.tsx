'use client'
import {
  ArrowUpRight,
  BookOpen,
  BookOpenCheck,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  GitPullRequest,
  Inbox,
  Keyboard,
  Palette,
  Library,
  ListChecks,
  LogOut,
  Mail,
  MessageCircle,
  Moon,
  Monitor,
  Plug,
  Plus,
  Search,
  Settings,
  Sun,
  UserRoundCheck,
  UsersRound,
  FolderKanban,
  SquareKanban,
  Target,
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
import { ConnectAppsDialog, openConnectApps } from '@/components/connect-apps'
import { FeedbackDialog, openFeedback } from '@/components/feedback'
import { DocumentPanel, DocumentPanelProvider, DocumentsCorner } from '@/components/document-panel'
import { KeptPreviews } from '@/components/kept-previews'
import { openShortcuts, ShortcutsDialog } from '@/components/help-menu'
import { useSidebarKeys } from '@/components/sidebar-keys'
import { PebbleAvatar } from '@/components/pebble-avatar'
import { ProviderLogo, type ProviderKind } from '@/components/provider-logo'
import { useAppNotifications } from '@/components/notifications'
import { NewProjectDialog, ProjectIcon } from '@/components/projects'
import { SearchDialog } from '@/components/search'
import { SettingsDialog } from '@/components/settings-dialog'
import { TeammateDialog } from '@/components/teammate-dialog'
import { SidebarResizer, useSidebarWidth } from '@/components/sidebar-resizer'
import { RailMenu } from '@/components/rail-menu'
import { SidebarWork, useSidebarOrder } from '@/components/sidebar-threads'
import { QuickThread } from '@/components/quick-thread'
import {
  preloadThreadPanel,
  ThreadPanel,
  ThreadPanelProvider,
  useThreadPanel,
} from '@/components/thread-panel'
import { TopBar } from '@/components/top-bar'
import { UpdatePill } from '@/components/update-pill'
import { UsageMenu } from '@/components/usage-menu'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import { CloudHoursBanner } from '@/components/cloud-hours-banner'
import { DemoBanner } from '@/components/demo-banner'
import { GuestBanner, SaveAccountDialog } from '@/components/save-account'
import { DemoTour } from '@/components/demo-tour'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
  setAnswersScope,
  choicesWaiting,
  failuresWaiting,
  isAdmin,
  isViewer,
  useApi,
  useRecheck,
  waitingItemKey,
  waitsOn,
  type Account,
  type HomeWaiting,
  type Me,
  type ProjectSummary,
  type PullWaiting,
  type Teammate,
  type Ticket,
} from '@/lib/api'
import { setLiveWorkspace } from '@/lib/live-socket'
import { setThreadsShownScope } from '@/lib/use-thread-events'
import { APP_WINDOW, DESKTOP_SIGN_IN, inCaptureWindow } from '@/lib/brigade-app'
import { appWindowBridge } from '@/lib/desktop-bridge'
import { useDesktopFrame } from '@/lib/desktop-frame'
import { WorkspaceMark, WorkspaceMenuContent } from '@/components/workspace-switcher'
import { authClient } from '@/lib/auth-client'
import { DEMO, signUp } from '@/lib/demo/flag'
import { setDocumentScope } from '@/lib/prepare-document'
import { markSignedIn, clearBrowserData, markSignedOut } from '@/lib/signed-in'
import { isMac, useIsMac } from '@/lib/platform'
import { openSettings, SETTINGS_SECTIONS, settingsHref } from '@/lib/settings-dialog'
import { cn } from '@/lib/utils'
import { userImageSrc } from '@/lib/user-image'
import { NEW_TEAMMATE, openTeammate } from '@/lib/teammate-dialog'
import { takeOffTheme, ThemeRuntime, useWornTheme } from '@/components/theme-runtime'

export { StatusBadge } from '@/components/status-badge'

type Dashboard = {
  me: Me
  reloadMe: () => Promise<void>
  teammates: Teammate[]
  reloadTeammates: () => Promise<void>
  /** Archived ones included; the sidebar and pickers leave them out. */
  projects: ProjectSummary[]
  reloadProjects: () => Promise<void>
  /** Count again the Inbox's mail waiting, beside Inbox in the sidebar. */
  reloadInboxCount: () => Promise<void>
  /** The Inbox's mail waiting, workspace-wide: the sidebar's count. */
  inboxWaiting: number
}
const DashboardContext = createContext<Dashboard | null>(null)

export function useDashboard() {
  const value = useContext(DashboardContext)
  if (!value) throw new Error('useDashboard outside the dashboard')
  return value
}

/** The dashboard, or null where a component also shows outside it. */
export const useMaybeDashboard = () => useContext(DashboardContext)

export { isAdmin }
export { WorkspaceMark }

/** The work: what projects group. */
const WORK_NAV = [
  { href: '/app', label: 'Today', icon: Sun },
  { href: '/app/inbox', label: 'Inbox', icon: Mail },
  { href: '/app/board', label: 'Board', icon: SquareKanban },
  { href: '/app/lists', label: 'Lists', icon: ListChecks },
  { href: '/app/tickets', label: 'Tickets', icon: Inbox },
  { href: '/app/pulls', label: 'Pull requests', icon: GitPullRequest },
  { href: '/app/library', label: 'Library', icon: Library },
  { href: '/app/playbooks', label: 'Playbooks', icon: BookOpenCheck },
  { href: '/app/routines', label: 'Routines', icon: CalendarClock },
]

/** Settings' sections, which open its dialog (lib/settings-dialog.ts). */
const SETTINGS_NAV = SETTINGS_SECTIONS.map((s) => ({
  href: settingsHref(s.section),
  label: s.label,
  search: 'search' in s ? s.search : undefined,
}))

export const NAV: { href: string; label: string; search?: string }[] = [
  ...WORK_NAV,
  ...SETTINGS_NAV,
]

const THEMES = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const

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

/**
 * Whose pages and threads this tab keeps as they were last shown, for Back to show them at once:
 * another person or workspace, or none (signed out), forgets them.
 */
function keepShownFor(scope: string | undefined) {
  setAnswersScope(scope)
  setThreadsShownScope(scope)
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  // The member first: no page shows before it. What the pages ask for as they open is sent
  // with it, so as not to wait for it (a trip each to the API): the lists below, and the
  // thread panel's (sent ahead). Without a workspace they fail, unseen: onboarding comes next.
  const me = useApi<Me>('/me')
  // Its live sockets go to the hub of the workspace it shows, once known.
  setLiveWorkspace(me.data?.activeWorkspaceId)
  // Documents kept open (lib/live-documents.ts) are this person's in this workspace: signed out,
  // or in another, none is reused.
  const documentScope = me.data ? `${me.data.user.id}:${me.data.activeWorkspaceId}` : undefined
  useEffect(() => {
    if (!documentScope) return
    setDocumentScope(documentScope)
    // So are the pages' last answers (lib/api.ts's useApi).
    keepShownFor(documentScope)
  }, [documentScope])
  useEffect(
    () => () => {
      setDocumentScope(undefined)
      keepShownFor(undefined)
    },
    [],
  )
  useEffect(() => preloadThreadPanel(pathname), []) // eslint-disable-line react-hooks/exhaustive-deps
  const teammates = useApi<Teammate[]>('/teammates', ['teammates.updated'])
  const projects = useApi<ProjectSummary[]>('/projects', ['projects.updated'])
  const reloadProjects = projects.reload
  // The sidebar's teammates and projects, in the order the member dragged them to.
  const sidebarOrder = useSidebarOrder()
  const sidebarTeammates = sidebarOrder.sort('teammates', teammates.data ?? [])
  const sidebarProjects = sidebarOrder.sort('projects', projects.data ?? [])
  const [creatingProject, setCreatingProject] = useState(false)
  const mac = useIsMac()
  // Brigade.app's window on macOS without a title bar (lib/desktop-frame.ts).
  const frame = useDesktopFrame()
  const { theme = 'dark', setTheme } = useTheme()
  // A theme the member wears (docs/themes.md): their menu takes it off, whatever it hides.
  const { worn: wornTheme, safe: safeLook } = useWornTheme()
  const ThemeIcon = THEMES.find((t) => t.value === theme)?.icon ?? Monitor
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth()
  // Tickets waiting on this member, live and refreshed as the member moves around.
  const tickets = useApi<Ticket[]>('/tickets', ['tickets.updated'])
  const reloadTickets = tickets.reload
  // Pull requests waiting on a person: with the tickets, what Home's Needs you counts.
  const pulls = useApi<{ pulls: PullWaiting[] }>('/pulls/attention', ['pulls.updated'])
  const reloadPulls = pulls.reload
  // Failed threads and routines waiting on this member (apps/api/src/failed.ts): a thread's
  // status, a routine's firing, or the ticket of one that could not start changes them; and a
  // failure its runner may still try again on its own waits from `recheckAt` on.
  const failedWaiting = useApi<HomeWaiting>('/home/waiting', [
    'thread.updated',
    'schedule.updated',
    'tickets.updated',
  ])
  const reloadFailures = failedWaiting.reload
  useRecheck(failedWaiting.data?.recheckAt, reloadFailures)
  // The Inbox's To do beside it (mail nobody took, replies to approve): live, and again when the
  // window comes back (a phone that slept missed what its socket would have said).
  const inboxCount = useApi<{ waiting: number }>('/inbox/count', [
    'mail.updated',
    // A Gmail account put in the Inbox or taken out of it, an address released.
    'connections.updated',
    // A teammate's reply asked for approval, or was decided.
    'tickets.updated',
  ])
  const reloadInboxCount = inboxCount.reload
  const inboxWaiting = inboxCount.data?.waiting ?? 0
  useEffect(() => {
    const onFocus = () => void reloadInboxCount()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [reloadInboxCount])
  // The member's AI accounts, for the avatar menu's usage: fresh each time it opens.
  const accounts = useApi<Account[]>('/accounts')
  const reloadAccounts = accounts.reload
  const [searching, setSearching] = useState(false)
  // A guest (docs/guests.md) saves their account; asked to sign out, they are offered it first.
  const [saving, setSaving] = useState<'save' | 'leave'>()
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
    void reloadPulls()
    void reloadFailures()
    void reloadInboxCount()
  }, [pathname, reloadTickets, reloadPulls, reloadFailures, reloadInboxCount])

  useEffect(() => {
    if (me.error?.status === 401) {
      markSignedOut()
      keepShownFor(undefined)
      // Brigade.app's sign-in in the browser comes back here once signed in. A full load, as on
      // signing out: no draft kept in memory waits for whoever signs in next in this tab.
      location.replace(
        location.pathname === DESKTOP_SIGN_IN
          ? `/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`
          : '/sign-in',
      )
    } else if (me.data) markSignedIn()
  }, [me.data, me.error])

  // No workspace yet, or no AI account to run anything: onboarding first. Not on the page that
  // signs Brigade.app in from the browser: someone new is sent back to the app, where onboarding
  // links that computer, rather than through it here (it offers to download the app they come
  // from). Again on each route: leaving that page (⌘, to Settings) goes to onboarding.
  useEffect(() => {
    // Nor in an installed app's window: an app needs no AI account of the person's to open.
    if (pathname === APP_WINDOW) return
    if (me.data && (!me.data.activeWorkspaceId || !me.data.aiReady) && pathname !== DESKTOP_SIGN_IN)
      router.replace('/onboarding')
  }, [me.data, pathname, router])

  // Opened from a notification about another of the member's workspaces: switch to it.
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('workspace')
    // An installed app's window never switches the session: its calls name its workspace.
    if (window.location.pathname === APP_WINDOW) return
    if (!wanted || !me.data || wanted === me.data.activeWorkspaceId) return
    // A workspace of another of their organizations too: the API checks they are a member.
    // Refused (gone, or no longer theirs): the page carries on without it, and says what it can.
    void api('/workspaces/switch', { body: { workspaceId: wanted } }).then(
      () => window.location.reload(),
      () => {
        const url = new URL(window.location.href)
        url.searchParams.delete('workspace')
        router.replace(`${url.pathname}${url.search}`)
      },
    )
  }, [me.data, router])

  // The member could not be read (the API restarting, a deploy, the network): asked again,
  // sooner then less often, rather than the loader staying for good. 401 signs out above.
  const failures = useRef(0)
  // An installed app's window whose workspace the person may no longer open (removed, or left
  // its organization): the API refuses its pinned calls (403), and asking again changes nothing.
  const revoked = !me.data && me.error?.status === 403 && pathname === APP_WINDOW
  const unreachable = !me.data && !!me.error && me.error.status !== 401 && !revoked
  const reloadMe = me.reload
  useEffect(() => {
    if (!me.error || me.error.status === 401 || revoked) {
      failures.current = 0
      return
    }
    const wait = Math.min(1000 * 2 ** failures.current++, 15000)
    const timer = setTimeout(() => void reloadMe(), wait)
    return () => clearTimeout(timer)
  }, [me.error, reloadMe, revoked])

  useSettingsShortcut()
  // ⌥↑ / ⌥↓ through the sidebar, Enter unfolds a folded row.
  useSidebarKeys()

  // Brigade.app's screenshot window shows its page alone; signing in there lands it back on it.
  // So does the page that signs that window in, in the browser, and an installed app's window.
  const alone =
    pathname === '/app/capture' || pathname === DESKTOP_SIGN_IN || pathname === APP_WINDOW

  useEffect(() => {
    if (pathname === '/app' && inCaptureWindow()) router.replace('/app/capture')
  }, [pathname, router])

  if (revoked) return <RevokedAppWindow />
  // The page that signs Brigade.app in needs only who is signed in, onboarded or not; an
  // installed app's window, its workspace.
  if (
    !me.data ||
    (pathname !== DESKTOP_SIGN_IN && !me.data.activeWorkspaceId) ||
    (pathname !== DESKTOP_SIGN_IN && pathname !== APP_WINDOW && !me.data.aiReady)
  )
    return <AppLoader note={unreachable ? 'Cannot reach Brigade. Trying again…' : undefined} />
  const data = me.data
  const workspace = data.workspaces.find((w) => w.id === data.activeWorkspaceId)
  // What Home's Needs you holds, counted beside Home in the sidebar: the one count of
  // what waits on this member (folded sections show none). A playbook's approvals are one.
  const waitingTickets = (tickets.data ?? []).filter((t) => waitsOn(t, data))
  const failing = failuresWaiting(failedWaiting.data, waitingTickets)
  const choosing = choicesWaiting(failedWaiting.data, waitingTickets, pulls.data?.pulls ?? [])
  const waitingOnYou =
    new Set(waitingTickets.map(waitingItemKey)).size +
    (pulls.data?.pulls.length ?? 0) +
    failing.threads.length +
    failing.routines.length +
    choosing.length
  // Threads with a ticket waiting on this member, and what the ticket asks of them.
  const needsYou: Record<string, string> = {}
  // What the app icon badge counts: those threads, but a playbook's approvals once, whichever
  // of its runs (out of the sidebar) ask.
  const badge = new Set<string>()
  // A child thread is out of the sidebar's list: its ticket marks the thread at the top, which
  // shows it (a child's review: under that child).
  for (const t of tickets.data ?? [])
    if (t.session && waitsOn(t, data)) {
      const thread = t.session.rootId ?? t.session.parentId ?? t.session.id
      needsYou[thread] ??= TICKET_ASKS[t.type] ?? 'needs you'
      // And the sub-threads down to it, under the thread at the top once the member unfolds it.
      if (t.session.parentId && t.session.parentId !== thread)
        needsYou[t.session.parentId] ??= TICKET_ASKS[t.type] ?? 'needs you'
      if (thread !== t.session.id) needsYou[t.session.id] ??= TICKET_ASKS[t.type] ?? 'needs you'
      const item = waitingItemKey(t)
      badge.add(item.startsWith('playbook:') ? item : thread)
    }
  // Failed threads waiting on this member: their dot stays red, in the list with those
  // waiting (sidebar-threads.tsx). A routine by its latest run, under the thread it reports to.
  for (const t of failing.threads) {
    needsYou[t.id] ??= 'failed'
    badge.add(t.id)
  }
  for (const r of failing.routines) {
    if (r.runId) needsYou[r.runId] ??= 'failed'
    if (r.runParentId) needsYou[r.runParentId] ??= 'routine failed'
    badge.add(`routine:${r.scheduleId}`)
  }
  // Threads whose teammate offered choices nobody picked (apps/api/src/choices-waiting.ts).
  for (const c of choosing) {
    needsYou[c.id] ??= 'pick one'
    badge.add(c.id)
  }

  async function signOut(confirmed = false) {
    // The demo has no account to leave: the way out is signing up for real.
    if (DEMO) return signUp()
    if (data?.guest && !confirmed) return setSaving('leave')
    await authClient.signOut()
    markSignedOut()
    await clearBrowserData()
    setDocumentScope(undefined)
    keepShownFor(undefined)
    // A full load, not the router: drafts and other state kept in memory (reply and code drafts,
    // pending attachments) go with the page, so the next person to sign in here finds none.
    location.replace('/sign-in')
  }

  const dashboard = {
    me: data,
    reloadMe: me.reload,
    teammates: teammates.data ?? [],
    reloadTeammates: teammates.reload,
    projects: projects.data ?? [],
    reloadProjects,
    reloadInboxCount,
    inboxWaiting,
  }
  // The member's own look (docs/themes.md), while they have the themes feature.
  const themes = <ThemeRuntime enabled={data.features?.includes('themes') ?? false} />
  if (alone)
    return (
      <DashboardContext.Provider value={dashboard}>
        {themes}
        {children}
      </DashboardContext.Provider>
    )

  return (
    <DashboardContext.Provider value={dashboard}>
      {themes}
      <DocumentPanelProvider>
        <ThreadPanelProvider>
          <SidebarProvider
            data-look="app"
            open={sidebarOpen}
            onOpenChange={setSidebarOpen}
            style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
          >
            {/* Folds to a rail of icons (the top bar's button, ⌘B): projects, teammates and
                settings then open as menus beside it. */}
            <Sidebar collapsible="icon">
              <SidebarResizer width={sidebarWidth} onWidth={setSidebarWidth} />
              <SidebarHeader data-window-drag className={cn(frame === 'mac' && 'pt-0')}>
                {/* Brigade.app on macOS, with no title bar: the traffic lights at the start of
                    this row, search and new thread across from them (lib/desktop-frame.ts).
                    Folded to the rail, the row keeps the lights' room above the icons. Narrower,
                    the app keeps a band above the page instead. */}
                {frame === 'mac' && (
                  <div className="flex h-[3.25rem] items-center justify-end gap-2 pl-[4.75rem] group-data-[collapsible=icon]:h-9 group-data-[collapsible=icon]:pl-0">
                    <RoundButton
                      label={`Search (${mac ? '⌘K' : 'Ctrl+K'})`}
                      onClick={() => setSearching(true)}
                    >
                      <Search />
                    </RoundButton>
                    <NewThreadButton />
                  </div>
                )}
                <SidebarMenu>
                  <SidebarMenuItem className="flex items-center gap-2 group-data-[collapsible=icon]:block">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <SidebarMenuButton
                          size="lg"
                          data-look="workspace-switcher"
                          className="min-w-0 flex-1 data-[state=open]:bg-sidebar-accent"
                        >
                          <WorkspaceMark
                            workspace={workspace}
                            className="bg-sidebar-primary text-sidebar-primary-foreground size-8"
                          />
                          <span className="truncate font-semibold group-data-[collapsible=icon]:hidden">
                            {workspace?.name}
                          </span>
                          <ChevronDown className="text-muted-foreground size-3.5! group-data-[collapsible=icon]:hidden" />
                        </SidebarMenuButton>
                      </DropdownMenuTrigger>
                      <WorkspaceMenuContent
                        me={data}
                        onNewWorkspace={
                          isAdmin(data) ? () => router.push('/onboarding') : undefined
                        }
                      />
                    </DropdownMenu>
                    {frame !== 'mac' && (
                      <>
                        <RoundButton
                          label={`Search (${mac ? '⌘K' : 'Ctrl+K'})`}
                          onClick={() => setSearching(true)}
                        >
                          <Search />
                        </RoundButton>
                        <NewThreadButton />
                      </>
                    )}
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

              <SidebarContent className="scroll-fade-y">
                {/* Today (the Home page), first: what waits and what runs. It scrolls with the threads below. */}
                <SidebarGroup className="py-0">
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild tooltip="Today" isActive={pathname === '/app'}>
                        <Link href="/app">
                          <Sun />
                          <span>Today</span>
                          {waitingOnYou > 0 && (
                            <Hint label={`${waitingOnYou} waiting on you`}>
                              <span className="bg-warning/15 text-warning ml-auto shrink-0 rounded-full px-1.5 text-[0.6875rem] leading-4 font-semibold tabular-nums">
                                {waitingOnYou}
                              </span>
                            </Hint>
                          )}
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    {/* Not in the public demo: it shows the work teammates do, not the mail and the
                        board around it. */}
                    {!DEMO && (
                      <>
                        <SidebarMenuItem>
                          <SidebarMenuButton
                            asChild
                            tooltip="Inbox"
                            isActive={pathname.startsWith('/app/inbox')}
                          >
                            <Link href="/app/inbox">
                              <Mail />
                              <span>Inbox</span>
                              {inboxWaiting > 0 && (
                                <Hint
                                  label={`${inboxWaiting} ${inboxWaiting === 1 ? 'email' : 'emails'} waiting`}
                                >
                                  <span className="bg-primary/15 text-primary ml-auto shrink-0 rounded-full px-1.5 text-[0.6875rem] leading-4 font-semibold tabular-nums">
                                    {inboxWaiting}
                                  </span>
                                </Hint>
                              )}
                            </Link>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                        {/* What moves across lists, threads and routines (docs/board.md); no badge: Home counts what waits. */}
                        <SidebarMenuItem>
                          <SidebarMenuButton
                            asChild
                            tooltip="Board"
                            isActive={pathname.startsWith('/app/board')}
                          >
                            <Link href="/app/board">
                              <SquareKanban />
                              <span>Board</span>
                            </Link>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      </>
                    )}
                    {/* Ongoing work delegated to teammates (docs/missions.md), behind its feature. */}
                    {data.features?.includes('missions') && (
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          asChild
                          tooltip="Missions"
                          isActive={pathname.startsWith('/app/missions')}
                        >
                          <Link href="/app/missions">
                            <Target />
                            <span>Missions</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    )}
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        asChild
                        tooltip="Lists"
                        isActive={pathname.startsWith('/app/lists')}
                      >
                        <Link href="/app/lists">
                          <ListChecks />
                          <span>Lists</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        asChild
                        tooltip="Library"
                        isActive={pathname.startsWith('/app/library')}
                      >
                        <Link href="/app/library">
                          <Library />
                          <span>Library</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroup>
                <SidebarWork
                  teammates={sidebarTeammates}
                  projects={sidebarProjects}
                  admin={isAdmin(data)}
                  memberId={data.memberId}
                  onNewProject={() => setCreatingProject(true)}
                  onReorder={sidebarOrder.reorder}
                  needsYou={needsYou}
                  rail={
                    <>
                      <RailMenu
                        icon={FolderKanban}
                        label="Projects"
                        href="/app/projects"
                        active={pathname.startsWith('/app/projects')}
                        items={sidebarProjects
                          .filter((p) => !p.archivedAt)
                          .map((p) => ({
                            href: `/app/projects/${p.id}`,
                            label: p.name,
                            icon: <ProjectIcon project={p} />,
                          }))}
                        action={{ label: 'New project', onSelect: () => setCreatingProject(true) }}
                      />
                      <TeammatesRailMenu teammates={sidebarTeammates} admin={isAdmin(data)} />
                    </>
                  }
                />
              </SidebarContent>

              <SidebarFooter className="gap-3">
                <DemoBanner place="sidebar" />
                {data?.guest && <GuestBanner onSave={() => setSaving('save')} />}
                <CloudHoursBanner admin={isAdmin(data)} />
                <SaveAccountDialog
                  open={!!saving}
                  onOpenChange={(open) => !open && setSaving(undefined)}
                  onSaved={() => void me.reload()}
                  leaving={saving === 'leave'}
                  onLeave={() => void signOut(true)}
                />
                {/* The member and their menu, and the way to connect apps; folded, a column. */}
                <div className="flex items-center gap-2 px-2 pb-2 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:p-0">
                  <DropdownMenu onOpenChange={(open) => open && void reloadAccounts()}>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={`${data.user.name}: settings, usage, theme, help and sign out`}
                        className="focus-visible:ring-sidebar-ring shrink-0 rounded-full outline-none focus-visible:ring-2"
                      >
                        <Avatar className="size-9 group-data-[collapsible=icon]:size-8">
                          {data.user.image && (
                            <AvatarImage
                              src={userImageSrc(data.user.image) ?? undefined}
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
                      {data.guest ? (
                        // A guest (docs/guests.md): the menu says they are not signed in, and
                        // saving the account is the way to be.
                        <>
                          <DropdownMenuItem onSelect={() => setSaving('save')}>
                            <span className="grid min-w-0 flex-1 leading-tight">
                              <span className="truncate font-semibold">{data.user.name}</span>
                              <span className="text-muted-foreground truncate text-xs">
                                Not signed in
                              </span>
                            </span>
                            <ChevronRight className="text-muted-foreground" />
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => setSaving('save')}>
                            <UserRoundCheck /> Save your account
                          </DropdownMenuItem>
                        </>
                      ) : (
                        // Who they are, and their profile a click away (Settings › Profile).
                        <DropdownMenuItem onSelect={() => openSettings('/app/profile')}>
                          <span className="grid min-w-0 flex-1 leading-tight">
                            <span className="truncate font-semibold">{data.user.name}</span>
                            <span className="text-muted-foreground truncate text-xs">
                              {data.user.email}
                            </span>
                          </span>
                          <ChevronRight className="text-muted-foreground" />
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => openSettings()}>
                        <Settings /> Settings
                        <span className="text-muted-foreground ml-auto text-xs">
                          {mac ? '⌘,' : 'Ctrl+,'}
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <UsageMenu accounts={accounts.data} />
                      <DropdownMenuSeparator />
                      {/* Theme on one row: three icon segments, kept open on pick so the change shows. */}
                      <div
                        role="group"
                        aria-label="Theme"
                        className="flex items-center gap-2 px-2 py-1 text-sm"
                      >
                        <ThemeIcon className="text-muted-foreground size-4" />
                        Theme
                        <div className="bg-muted ml-auto flex gap-0.5 rounded-md p-0.5">
                          {THEMES.map(({ value, label, icon: Icon }) => (
                            <Hint key={value} label={label}>
                              <DropdownMenuItem
                                role="menuitemradio"
                                aria-checked={theme === value}
                                aria-label={label}
                                onSelect={(e) => {
                                  e.preventDefault()
                                  setTheme(value)
                                }}
                                className={cn(
                                  'rounded-sm px-1.5 py-1',
                                  theme === value && 'bg-card shadow-xs',
                                )}
                              >
                                <Icon
                                  className={cn(
                                    'size-3.5',
                                    theme === value ? 'text-foreground' : 'text-muted-foreground',
                                  )}
                                />
                              </DropdownMenuItem>
                            </Hint>
                          ))}
                        </div>
                      </div>
                      {wornTheme && !safeLook && (
                        <DropdownMenuItem onSelect={() => void takeOffTheme()}>
                          <Palette /> Take off {wornTheme.theme.name}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={openShortcuts}>
                        <Keyboard /> Keyboard shortcuts
                        <span className="text-muted-foreground ml-auto text-xs">
                          {mac ? '⇧?' : 'Shift+?'}
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <a href="https://www.brigade.lol/docs" target="_blank" rel="noreferrer">
                          <BookOpen /> Documentation
                          <ArrowUpRight className="text-muted-foreground ml-auto" />
                        </a>
                      </DropdownMenuItem>
                      {/* A viewer can't upload or send (requireWorkspace answers 403). */}
                      {!isViewer(data) && (
                        <DropdownMenuItem onSelect={openFeedback}>
                          <MessageCircle /> Give feedback
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => void signOut()}>
                        {/* A guest has nothing to sign out of: what they want is another account. */}
                        <LogOut /> {data.guest ? 'Sign in to another account' : 'Sign out'}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <ConnectAppsButton />
                </div>
              </SidebarFooter>
            </Sidebar>

            <Inset>{children}</Inset>
          </SidebarProvider>
          <SearchDialog open={searching} onOpenChange={setSearching} />
          <ShortcutsDialog />
          <ConnectAppsDialog />
          <FeedbackDialog />
          <SettingsDialog />
          <TeammateDialog />
          <AppNotifications needsYou={badge.size} />
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

/** The sidebar footer's Connect apps: opens the popup, over the sidebar on a phone. */
function ConnectAppsButton() {
  const { isMobile, setOpenMobile } = useSidebar()
  return (
    <Hint label="Connect apps">
      <button
        type="button"
        aria-label="Connect apps"
        data-look="connect-apps"
        onClick={() => {
          if (isMobile) setOpenMobile(false)
          openConnectApps()
        }}
        className="group/apps @container/apps bg-card hover:bg-sidebar-accent focus-visible:ring-sidebar-ring flex h-9 min-w-0 flex-1 items-center justify-center gap-2 rounded-full border text-[0.9375rem] font-medium outline-none focus-visible:ring-2 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:flex-none"
      >
        <Plug className="hidden size-4 group-data-[collapsible=icon]:block" />
        {/* Too narrow for the words: the logos alone, never a cut-off label. */}
        <span className="hidden truncate @[11rem]/apps:inline group-data-[collapsible=icon]:hidden">
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
              <ProviderLogo kind={kind} className={kind === 'stripe' ? 'size-full' : 'size-3.5'} />
            </span>
          ))}
        </span>
      </button>
    </Hint>
  )
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

/** A round, outlined icon button beside the workspace's name (and the sidebar's on a phone). */
const roundButtonClass =
  'bg-card text-foreground hover:bg-sidebar-accent focus-visible:ring-sidebar-ring flex size-9 shrink-0 items-center justify-center rounded-full border outline-none focus-visible:ring-2 group-data-[collapsible=icon]:hidden [&>svg]:size-4'

function RoundButton({
  label,
  onClick,
  children,
  nav,
}: {
  label: string
  onClick: () => void
  children: ReactNode
  /** In the sidebar, a stop of ⌥↑ / ⌥↓ that opens as a click does (sidebar-keys.tsx). */
  nav?: { active: boolean }
}) {
  return (
    <Hint label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        data-nav-stop={nav && 'link'}
        data-nav-top={nav && true}
        data-active={nav?.active}
        data-look="round-button"
        className={roundButtonClass}
      >
        {children}
      </button>
    </Hint>
  )
}

/** The round + that starts a thread: beside the workspace's name, and on a phone at the top of each page. */
export function NewThreadButton() {
  const { newThreadPage, expanded, threadId } = useThreadPanel()
  // A viewer starts nothing.
  if (isViewer(useDashboard().me)) return null
  return (
    // The first stop of ⌥↑ / ⌥↓, above Today: it opens the new-thread page, where it stands
    // while that page shows.
    <RoundButton label="New thread" onClick={newThreadPage} nav={{ active: expanded && !threadId }}>
      <Plus />
    </RoundButton>
  )
}

function NewThreadRailItem() {
  const { newThreadPage } = useThreadPanel()
  if (isViewer(useDashboard().me)) return null
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip="New thread"
        onClick={newThreadPage}
        data-nav-stop="link"
        data-nav-top
      >
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
      // Where no dialog shows Settings (Brigade.app's quick-capture window): its address.
      if (!openSettings()) router.push('/app/settings')
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
      // On a phone, round like the + across from it; wider, a plain icon in the sidebar's header.
      className={cn(
        isMobile ? roundButtonClass : '-ml-1 size-8 text-muted-foreground hover:text-foreground',
        className,
      )}
      aria-label={label}
      tooltip={isMobile ? label : `${label} (${mac ? '⌘' : 'Ctrl+'}B)`}
    />
  )
}

/** Folded, the teammates as a menu beside the rail: each starts a new thread with it, as above. */
function TeammatesRailMenu({ teammates, admin }: { teammates: Teammate[]; admin: boolean }) {
  const router = useRouter()
  const { chooseTeammate } = useThreadPanel()
  const pathname = usePathname()
  return (
    <RailMenu
      icon={UsersRound}
      label="AI teammates"
      active={pathname.startsWith('/app/teammates')}
      items={teammates.map((t) => ({
        id: t.id,
        href: '/app/threads',
        label: t.name,
        icon: <TeammateAvatar teammate={t} className="size-5" />,
        onSelect: () => chooseTeammate(t.id),
      }))}
      action={
        admin
          ? {
              label: 'New teammate',
              onSelect: () => openTeammate(NEW_TEAMMATE) || router.push('/app/teammates/new'),
            }
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
  const frame = useDesktopFrame()
  const { state } = useSidebar()
  // The Inbox lays out its own columns, edge to edge, each the window's height.
  const inboxPage = usePathname().startsWith('/app/inbox')
  return (
    // min-w-0: long unwrapped text inside a page must not widen it past the window.
    <SidebarInset className="min-w-0">
      {/* Brigade.app's window on macOS, without a title bar: the empty top of the page moves
          it, as a title bar would (lib/desktop-frame.ts). Controls over it still click. */}
      {frame && <div data-window-drag aria-hidden className="absolute inset-x-0 top-0 h-10" />}
      {frame === 'mac' && state === 'collapsed' && <TrafficLightsPill />}
      <DemoBanner place="phone" />
      <DemoTour />
      <UpdatePill header={expanded} />
      {!expanded && <TopBar />}
      {/* A minimized document's button, at the page's top right; a thread has its own. */}
      {!expanded && <DocumentsCorner />}
      {/* Before the document: a document opened over a docked thread covers it until closed. */}
      <ThreadPanel />
      {/* A thread's preview: here, so its page stays as it was while another thread shows. */}
      <KeptPreviews />
      <QuickThread />
      <DocumentPanel />
      {/* A computer's screen, and the Inbox, take the whole page, edge to edge. */}
      <div
        data-bleed={computerPage ? '' : undefined}
        className={cn(
          computerPage || inboxPage
            ? 'w-full min-w-0'
            : 'mx-auto w-full max-w-5xl min-w-0 px-4 pt-6 pb-16 md:px-10 md:pt-8',
          expanded && 'hidden',
        )}
      >
        {/* Not kept behind it: a thread opens in place (lib/thread-address.ts), over the page
            it was opened from, which would go on loading and listening unseen. */}
        {!expanded && children}
      </div>
    </SidebarInset>
  )
}

/**
 * Brigade.app on macOS with the sidebar folded to its rail: the traffic lights (drawn by macOS
 * at TRAFFIC_LIGHTS in apps/desktop/src/windows.ts, over the page) reach past the rail onto the
 * page, whatever it shows there. A pill under them, the same surface as the thread's pills,
 * gives them a ground of their own. It moves the window, as the title bar would.
 */
function TrafficLightsPill() {
  return (
    <div
      data-window-drag
      aria-hidden
      className="fixed top-3 left-2 z-40 h-7 w-[4.25rem] rounded-full bg-card/90 shadow-sm backdrop-blur"
    />
  )
}

export function timeAgo(iso: string) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return new Date(iso).toLocaleDateString()
}

/** An installed app's window whose workspace the person may no longer open: its app goes too. */
function RevokedAppWindow() {
  const bridge = appWindowBridge()
  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-4 bg-background p-6">
      <p className="max-w-sm text-center text-sm text-muted-foreground">
        You no longer have access to the workspace this app is in.
      </p>
      {bridge?.apps.uninstall && (
        <Button type="button" variant="outline" onClick={() => void bridge.apps.uninstall?.()}>
          Uninstall
        </Button>
      )}
    </main>
  )
}
