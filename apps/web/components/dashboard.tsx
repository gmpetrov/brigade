'use client'
import {
  CalendarClock,
  ChevronsUpDown,
  GitPullRequest,
  House,
  Inbox,
  KeyRound,
  Library,
  LogOut,
  MessagesSquare,
  Monitor,
  Plug,
  Plus,
  SquareKanban,
  UserRound,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { HelpMenu } from '@/components/help-menu'
import { QuickThread } from '@/components/quick-thread'
import { SearchButton, SearchDialog } from '@/components/search'
import { ThemeToggle } from '@/components/theme-toggle'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
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
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { Skeleton } from '@/components/ui/skeleton'
import {
  api,
  isAdmin,
  useApi,
  waitsOn,
  type Me,
  type Task,
  type Teammate,
  type Ticket,
} from '@/lib/api'
import { authClient } from '@/lib/auth-client'
import { cn } from '@/lib/utils'

export { StatusBadge } from '@/components/status-badge'

type Dashboard = { me: Me; teammates: Teammate[]; reloadTeammates: () => Promise<void> }
const DashboardContext = createContext<Dashboard | null>(null)

export function useDashboard() {
  const value = useContext(DashboardContext)
  if (!value) throw new Error('useDashboard outside the dashboard')
  return value
}

export { isAdmin }

export const NAV = [
  { href: '/app', label: 'Home', icon: House },
  { href: '/app/tasks', label: 'Tasks', icon: SquareKanban },
  { href: '/app/automations', label: 'Automations', icon: CalendarClock },
  { href: '/app/tickets', label: 'Tickets', icon: Inbox },
  { href: '/app/pulls', label: 'Pull requests', icon: GitPullRequest },
  { href: '/app/library', label: 'Library', icon: Library },
  { href: '/app/connections', label: 'Connections', icon: Plug },
  { href: '/app/vault', label: 'Vault', icon: KeyRound },
  { href: '/app/accounts', label: 'AI Accounts', icon: UserRound },
  { href: '/app/threads', label: 'Threads', icon: MessagesSquare },
  { href: '/app/computers', label: 'Computers', icon: Monitor },
]

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
  useEffect(() => {
    void reloadPulls()
    void reloadTickets()
    void reloadTasks()
  }, [pathname, reloadPulls, reloadTickets, reloadTasks])

  useEffect(() => {
    if (me.error?.status === 401) router.replace('/sign-in')
    else if (me.data && !me.data.activeWorkspaceId) router.replace('/onboarding')
  }, [me.data, me.error, router])

  if (!me.data?.activeWorkspaceId)
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
      value={{ me: data, teammates: teammates.data ?? [], reloadTeammates: teammates.reload }}
    >
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
                      <span className="bg-sidebar-primary text-sidebar-primary-foreground flex size-8 items-center justify-center rounded-sm font-bold">
                        {initial(workspace?.name ?? '')}
                      </span>
                      <span className="grid flex-1 text-left leading-tight">
                        <span className="truncate font-semibold">{workspace?.name}</span>
                        <span className="text-muted-foreground truncate text-xs">
                          {organization?.name}
                        </span>
                      </span>
                      <ChevronsUpDown className="ml-auto" />
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
          </SidebarHeader>

          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Workspace</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {NAV.map(({ href, label, icon: Icon }) => {
                    const badge = badges[href]
                    return (
                      <SidebarMenuItem key={href}>
                        <SidebarMenuButton
                          asChild
                          isActive={
                            pathname === href ||
                            (['/app/pulls', '/app/threads'].includes(href) &&
                              pathname.startsWith(href))
                          }
                        >
                          <Link href={href}>
                            <Icon />
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

            <SidebarGroup>
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
          </SidebarContent>

          <SidebarFooter>
            <div className="bg-card flex items-center gap-2 rounded-lg border p-2">
              <Avatar className="size-8">
                <AvatarFallback className="bg-secondary text-xs font-bold">
                  {initial(data.user.name)}
                </AvatarFallback>
              </Avatar>
              <div className="grid min-w-0 flex-1 leading-tight">
                <span className="truncate text-sm font-semibold">{data.user.name}</span>
                <span className="text-muted-foreground truncate text-xs">{organization?.name}</span>
              </div>
              <HelpMenu />
              <ThemeToggle />
              <Button variant="ghost" size="icon-sm" aria-label="Sign out" onClick={signOut}>
                <LogOut />
              </Button>
            </div>
          </SidebarFooter>
        </Sidebar>

        {/* min-w-0: long unwrapped text inside a page must not widen it past the window. */}
        <SidebarInset className="min-w-0">
          <header className="flex h-12 items-center gap-2 px-4 md:hidden">
            <SidebarTrigger />
            <span className="font-semibold">{workspace?.name}</span>
          </header>
          <div className="mx-auto w-full max-w-5xl min-w-0 px-4 pt-6 pb-16 md:px-10 md:pt-10">
            {children}
          </div>
        </SidebarInset>
      </SidebarProvider>
      <QuickThread />
      <SearchDialog open={searching} onOpenChange={setSearching} />
    </DashboardContext.Provider>
  )
}

export function timeAgo(iso: string) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return new Date(iso).toLocaleDateString()
}
