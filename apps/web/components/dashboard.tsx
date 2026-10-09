'use client'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { api, useApi, type Me, type Teammate } from '@/lib/api'
import { authClient } from '@/lib/auth-client'

type Dashboard = { me: Me; teammates: Teammate[]; reloadTeammates: () => Promise<void> }
const DashboardContext = createContext<Dashboard | null>(null)

export function useDashboard() {
  const value = useContext(DashboardContext)
  if (!value) throw new Error('useDashboard outside the dashboard')
  return value
}

export const isAdmin = (me: Me) => me.role === 'owner' || me.role === 'admin'

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

  if (!me.data?.activeWorkspaceId) return <main className="narrow hint">Loading…</main>
  const data = me.data

  async function switchWorkspace(workspaceId: string) {
    await api('/workspaces/switch', { body: { workspaceId } })
    window.location.href = '/app'
  }

  async function signOut() {
    await authClient.signOut()
    router.replace('/sign-in')
  }

  const link = (href: string, label: string) => (
    <Link key={href} href={href} className={pathname === href ? 'active' : ''}>
      {label}
    </Link>
  )

  return (
    <DashboardContext.Provider
      value={{ me: data, teammates: teammates.data ?? [], reloadTeammates: teammates.reload }}
    >
      <div className="shell">
        <nav className="sidebar">
          <select
            aria-label="Workspace"
            value={data.activeWorkspaceId ?? ''}
            onChange={(e) =>
              e.target.value === '+'
                ? router.push('/onboarding')
                : void switchWorkspace(e.target.value)
            }
          >
            {data.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
            {isAdmin(data) && <option value="+">New workspace…</option>}
          </select>
          <div className="section">Workspace</div>
          {link('/app', 'Threads')}
          {link('/app/computers', 'Computers')}
          {link('/app/tickets', 'Tickets')}
          {link('/app/connections', 'Connections')}
          {link('/app/vault', 'Vault')}
          {link('/app/accounts', 'Accounts')}
          <div className="section">AI teammates</div>
          {(teammates.data ?? []).map((t) => link(`/app/teammates/${t.id}`, t.name))}
          {isAdmin(data) && link('/app/teammates/new', '+ New teammate')}
          <div className="spacer" />
          <div className="hint" style={{ padding: '0 10px' }}>
            {data.user.name} ·{' '}
            {data.organizations.find((o) => o.id === data.activeOrganizationId)?.name}
          </div>
          <button onClick={signOut} style={{ margin: '4px 10px 0' }}>
            Sign out
          </button>
        </nav>
        <main className="main">{children}</main>
      </div>
    </DashboardContext.Provider>
  )
}

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'idle' || status === 'done'
      ? 'ok'
      : status === 'waiting'
        ? 'warn'
        : status === 'failed'
          ? 'danger'
          : ''
  const label = status === 'waiting' ? 'needs approval' : status
  return <span className={`badge ${tone}`}>{label}</span>
}

export function timeAgo(iso: string) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return new Date(iso).toLocaleDateString()
}
