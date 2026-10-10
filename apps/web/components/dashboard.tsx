'use client'
import {
  ChevronsUpDown,
  FolderGit2,
  Inbox,
  KeyRound,
  Library,
  LogOut,
  MessagesSquare,
  Monitor,
  Plug,
  Plus,
  UserRound,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createContext, useContext, useEffect, type ReactNode } from 'react'
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
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { Skeleton } from '@/components/ui/skeleton'
import { api, useApi, type Me, type Teammate } from '@/lib/api'
import { authClient } from '@/lib/auth-client'

export { StatusBadge } from '@/components/status-badge'

type Dashboard = { me: Me; teammates: Teammate[]; reloadTeammates: () => Promise<void> }
const DashboardContext = createContext<Dashboard | null>(null)

export function useDashboard() {
  const value = useContext(DashboardContext)
  if (!value) throw new Error('useDashboard outside the dashboard')
  return value
}

export const isAdmin = (me: Me) => me.role === 'owner' || me.role === 'admin'

const NAV = [
  { href: '/app', label: 'Threads', icon: MessagesSquare },
  { href: '/app/computers', label: 'Computers', icon: Monitor },
  { href: '/app/tickets', label: 'Tickets', icon: Inbox },
  { href: '/app/library', label: 'Library', icon: Library },
  { href: '/app/repositories', label: 'Repositories', icon: FolderGit2 },
  { href: '/app/connections', label: 'Connections', icon: Plug },
  { href: '/app/vault', label: 'Vault', icon: KeyRound },
  { href: '/app/accounts', label: 'Accounts', icon: UserRound },
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
          </SidebarHeader>

          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Workspace</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {NAV.map(({ href, label, icon: Icon }) => (
                    <SidebarMenuItem key={href}>
                      <SidebarMenuButton asChild isActive={pathname === href}>
                        <Link href={href}>
                          <Icon />
                          <span>{label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
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
