'use client'
import { workspaceLogoPath } from '@brigade/contracts'
import { Building2, ChevronDown, Plus } from 'lucide-react'
import { useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { api, type Me } from '@/lib/api'
import { API_URL } from '@/lib/config'
import { cn } from '@/lib/utils'

const initial = (name: string) => name.trim().charAt(0).toUpperCase() || '?'

/** A workspace's logo, or its first letter on a square of colour. */
export function WorkspaceMark({
  workspace,
  className,
}: {
  workspace: { id: string; name: string; logo?: string | null } | undefined
  className?: string
}) {
  const logo = workspace?.logo
    ? workspaceLogoPath({ id: workspace.id, logo: workspace.logo })
    : null
  const [failed, setFailed] = useState<string | null>(null)
  const shown = logo && failed !== logo
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-sm font-bold',
        className,
        shown && 'bg-transparent',
      )}
    >
      {shown ? (
        // eslint-disable-next-line @next/next/no-img-element -- a stored logo, through the API
        <img
          src={`${API_URL}/api${logo}`}
          alt=""
          className="size-full object-cover"
          onError={() => setFailed(logo)}
        />
      ) : (
        initial(workspace?.name ?? '')
      )}
    </span>
  )
}

async function switchWorkspace(workspaceId: string) {
  await api('/workspaces/switch', { body: { workspaceId } })
  window.location.href = '/app'
}

/** To another organization the member belongs to (one they were invited to, say). */
async function switchOrganization(organizationId: string) {
  await api('/organizations/switch', { body: { organizationId } })
  window.location.href = '/app'
}

const otherOrganizations = (me: Me) =>
  me.organizations.filter((o) => o.id !== me.activeOrganizationId)

/**
 * The workspaces of the member's organization, then their other organizations: the menu of
 * the workspace name, in the sidebar and on setup. With `onNewWorkspace`, it offers one.
 */
export function WorkspaceMenuContent({
  me,
  onNewWorkspace,
}: {
  me: Me
  onNewWorkspace?: () => void
}) {
  const organization = me.organizations.find((o) => o.id === me.activeOrganizationId)
  const others = otherOrganizations(me)
  return (
    <DropdownMenuContent align="start" className="min-w-56">
      <DropdownMenuLabel className="text-muted-foreground text-xs">
        {organization?.name ?? 'Workspaces'}
      </DropdownMenuLabel>
      {me.workspaces.map((w) => (
        <DropdownMenuItem key={w.id} onSelect={() => void switchWorkspace(w.id)}>
          <WorkspaceMark workspace={w} className="bg-secondary size-6 text-xs" />
          {w.name}
        </DropdownMenuItem>
      ))}
      {onNewWorkspace && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onNewWorkspace}>
            <Plus /> New workspace
          </DropdownMenuItem>
        </>
      )}
      {others.length > 0 && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-muted-foreground text-xs">
            Other organizations
          </DropdownMenuLabel>
          {others.map((o) => (
            <DropdownMenuItem key={o.id} onSelect={() => void switchOrganization(o.id)}>
              <Building2 /> {o.name}
            </DropdownMenuItem>
          ))}
        </>
      )}
    </DropdownMenuContent>
  )
}

/**
 * Top left of setup, a way out of a workspace not ready yet (no AI account, no plan) to another
 * of the member's: shown only when there is one to go to.
 */
export function SetupWorkspaceSwitcher({ me }: { me: Me }) {
  if (!me.activeOrganizationId) return null
  if (me.workspaces.length + otherOrganizations(me).length < 2) return null
  const workspace = me.workspaces.find((w) => w.id === me.activeWorkspaceId)
  const organization = me.organizations.find((o) => o.id === me.activeOrganizationId)
  return (
    <div className="fixed top-3 left-3 z-10">
      <DropdownMenu>
        <DropdownMenuTrigger className="flex h-10 max-w-60 min-w-0 items-center gap-2 rounded-md px-2 text-sm font-semibold outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent">
          {workspace ? (
            <WorkspaceMark
              workspace={workspace}
              className="size-7 bg-primary text-xs text-primary-foreground"
            />
          ) : (
            <Building2 className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{workspace?.name ?? organization?.name}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <WorkspaceMenuContent me={me} />
      </DropdownMenu>
    </div>
  )
}
