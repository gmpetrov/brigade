'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import type { Ask, TicketAnswer } from '@brigade/contracts'
import { AtlassianDomainHint } from '@/components/atlassian-domain-hint'
import { MixpanelMcpHint } from '@/components/mixpanel-mcp-hint'
import { RegionMenu } from '@/components/region-menu'
import { useDashboard } from '@/components/dashboard'
import { McpServerCard } from '@/components/mcp-server-card'
import { ProviderTile } from '@/components/provider-logo'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, isAdmin, useApi, type Connection, type ConnectionsResponse } from '@/lib/api'
import { openSignIn } from '@/lib/sign-in-window'

type AppAsk = Extract<Ask, { type: 'access' }> & {
  app: NonNullable<Extract<Ask, { type: 'access' }>['app']>
}
type AccessReply = Extract<
  Extract<TicketAnswer, { action: 'answered' }>['replies'][string],
  { type: 'access' }
>

/** App names for a ticket's heading, before the catalog has loaded. An MCP server goes by its ask's. */
export const APP_NAMES: Record<string, string> = {
  gmail: 'Gmail',
  google_calendar: 'Google Calendar',
  google_drive: 'Google Drive',
  google_docs: 'Google Docs',
  google_sheets: 'Google Sheets',
  stripe: 'Stripe',
  github: 'GitHub',
  cloudflare: 'Cloudflare',
  google_cloud: 'Google Cloud',
  neon: 'Neon',
  supabase: 'Supabase',
  atlassian: 'Atlassian',
  notion: 'Notion',
  linear: 'Linear',
  mixpanel: 'Mixpanel',
  resend: 'Resend',
}

/** The same MCP server however its URL was typed, as the API compares them. */
const sameServer = (a: string, b: string) => {
  try {
    const [x, y] = [new URL(a.trim()), new URL(b.trim())]
    x.hash = ''
    y.hash = ''
    return x.href.replace(/\/$/, '') === y.href.replace(/\/$/, '')
  } catch {
    return false
  }
}

/** Where each App signs in; Stripe takes a key on the Apps page. */
const SIGN_IN: Partial<Record<Connection['kind'], 'google' | 'github' | 'mcp'>> = {
  gmail: 'google',
  google_calendar: 'google',
  google_drive: 'google',
  google_docs: 'google',
  google_sheets: 'google',
  github: 'github',
  cloudflare: 'mcp',
  google_cloud: 'mcp',
  neon: 'mcp',
  supabase: 'mcp',
  atlassian: 'mcp',
  notion: 'mcp',
  linear: 'mcp',
  mixpanel: 'mcp',
  resend: 'mcp',
}

/**
 * A teammate asks for an App: Give it the access (the API grants it as the
 * ticket is answered), or Decline. With no account yet, Connect signs in in a
 * window of its own and gives the access as soon as the account is there. A
 * GitHub ask for a repository no account reaches: install the GitHub app on its
 * owner, or add it to an installation, and the access goes once it is reachable.
 */
export function AppAccessAsk({
  ask,
  askerName,
  onReply,
}: {
  ask: AppAsk
  askerName: string
  onReply: (reply: AccessReply) => void
}) {
  const { me } = useDashboard()
  const data = useApi<ConnectionsResponse>('/connections')
  const kind = ask.app.kind as Connection['kind']
  // A GitHub repository: only the accounts whose installation reaches it, listed afresh.
  const repository = kind === 'github' ? ask.app.repository : undefined
  const reach = useApi<{ connections: string[] }>(
    repository ? `/repositories/${repository}/reach?fresh=1` : null,
  )
  // An MCP server, by the URL the teammate gave: its App once someone has added it. With no
  // URL, the server added under the name it asked for, as the API finds it.
  const serverUrl = kind === 'mcp' ? ask.app.url : undefined
  const server =
    kind !== 'mcp'
      ? undefined
      : serverUrl
        ? data.data?.apps.find((a) => a.mcp && sameServer(a.mcp.url, serverUrl))
        : data.data?.apps.find(
            (a) => a.mcp && a.name?.toLowerCase() === ask.what.trim().toLowerCase(),
          )
  const name = server?.name ?? (serverUrl ? ask.what : data.data?.catalog[kind]?.name) ?? ask.what
  const connected = (data.data?.connections ?? []).filter(
    (c) =>
      c.kind === kind &&
      c.status === 'active' &&
      (!(serverUrl || server) || c.appId === server?.id),
  )
  const mayGive = (c: Connection) =>
    c.createdByMemberId === me.memberId || (isAdmin(me) && c.reach === 'workspace')
  const accounts = repository
    ? connected.filter((c) => reach.data?.connections.includes(c.id))
    : connected
  // Those this person may give. Another member's own account is left out: it is used only in
  // their threads. The API checks again that the account is usable in this thread.
  const givable = accounts.filter(mayGive)
  // The installation on the repository's owner, if any, to add the repository to on GitHub. An
  // installation reaches only its own account's repositories: otherwise, install on the owner.
  const owner = repository?.split('/')[0]
  const addTo = connected.filter(
    (c) =>
      owner &&
      mayGive(c) &&
      c.externalUrl &&
      c.externalAccount?.split(' ')[0]?.toLowerCase() === owner,
  )
  const [picked, setPicked] = useState<string>()
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string>()
  const access = ask.app.scope === 'read' ? 'read' : 'read and write'
  const give = (connectionId: string | undefined) =>
    onReply({ type: 'access', granted: true, ...(connectionId ? { connectionId } : {}) })

  // Signing in in its own window, or changing the repositories on GitHub: once the account shows
  // up (reaching the repository), the access goes with the answer.
  useEffect(() => {
    if (!waiting) return
    if (givable.length > 0) {
      setWaiting(false)
      give(givable.length === 1 || repository ? givable[0]!.id : undefined)
      return
    }
    const timer = setInterval(
      () => {
        void data.reload()
        if (repository) void reach.reload()
      },
      repository ? 3000 : 2000,
    )
    return () => clearInterval(timer)
  }, [waiting, givable.length])

  async function connect(region?: string) {
    setError(undefined)
    const route = SIGN_IN[kind]
    if (!route) return
    try {
      const inWindow = await openSignIn(async (returnTo) => {
        const { url } = await api<{ url: string }>(`/connections/${route}`, {
          body: {
            ...(route === 'github' ? {} : { kind }),
            ...(region ? { region } : {}),
            ...(returnTo ? { returnTo } : {}),
          },
        })
        return url
      })
      if (inWindow) setWaiting(true)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const decline = (
    <Button size="sm" variant="ghost" onClick={() => onReply({ type: 'access', granted: false })}>
      Decline
    </Button>
  )
  if (!data.data || (repository && !reach.data && !reach.error)) return null

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {!(serverUrl && accounts.length === 0) && (
          <ProviderTile kind={kind} icons={server?.mcp?.icons} small />
        )}
        {givable.length > 0 ? (
          <>
            {givable.length > 1 && (
              <Select value={picked ?? givable[0]!.id} onValueChange={setPicked}>
                <SelectTrigger size="sm" aria-label={`Which ${name} account`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {givable.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.externalAccount ?? c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button size="sm" onClick={() => give(picked ?? givable[0]!.id)}>
              Give {askerName} {access} access
            </Button>
            {decline}
          </>
        ) : repository && accounts.length === 0 ? (
          // No account reaches the repository: install the app on its owner, or add it on GitHub.
          <>
            <span className="text-sm text-muted-foreground">
              No {name} account here reaches <code>{repository}</code>.
            </span>
            {addTo.length === 0 ? (
              <Button
                size="sm"
                disabled={waiting || !data.data.available[kind]}
                onClick={() => void connect()}
              >
                Install {name} on {owner}
              </Button>
            ) : (
              addTo.map((c) => (
                <Button key={c.id} size="sm" asChild>
                  <a
                    href={c.externalUrl!}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => setWaiting(true)}
                  >
                    Add it on GitHub{addTo.length > 1 ? ` (${c.externalAccount ?? c.label})` : ''}
                  </a>
                </Button>
              ))
            )}
            {decline}
          </>
        ) : accounts.length === 0 && serverUrl ? (
          // Not added yet: the server's card, here in the ticket, then the access with it.
          <div className="flex w-full max-w-md flex-col gap-2">
            <McpServerCard
              url={serverUrl}
              connections={data.data.connections}
              reload={data.reload}
              action={`Connect and give ${askerName} ${access} access`}
              onConnected={({ connectionId }) => give(connectionId)}
            />
            <div>{decline}</div>
          </div>
        ) : accounts.length === 0 && SIGN_IN[kind] ? (
          <>
            <RegionMenu
              regions={data.data.catalog[kind]?.regions}
              onPick={(region) => void connect(region)}
            >
              <Button
                size="sm"
                disabled={waiting || !data.data.available[kind]}
                onClick={data.data.catalog[kind]?.regions ? undefined : () => void connect()}
              >
                Connect {name}
              </Button>
            </RegionMenu>
            {decline}
          </>
        ) : accounts.length === 0 ? (
          <>
            <Button size="sm" variant="outline" asChild>
              <Link href="/app/connections" target="_blank" rel="noreferrer">
                Add {name} in Apps
              </Link>
            </Button>
            {decline}
          </>
        ) : (
          <>
            <span className="text-sm text-muted-foreground">
              Only{' '}
              {[...new Set(accounts.map((c) => data.data!.members[c.createdByMemberId]))]
                .filter(Boolean)
                .join(', ') || 'the member who connected it'}{' '}
              or an admin can give access to {name}.
            </span>
            {decline}
          </>
        )}
      </div>
      {waiting && repository && (
        <p className="text-sm text-muted-foreground">
          Pick <code>{repository}</code> on GitHub, in the tab that opened. {askerName} gets{' '}
          {access} access as soon as an account reaches it.
        </p>
      )}
      {waiting && !repository && (
        <p className="text-sm text-muted-foreground">
          Finish signing in in the tab that opened. {askerName} gets {access} access as soon as{' '}
          {name} is connected.
        </p>
      )}
      {reach.error && <p className="text-sm text-destructive-text">{reach.error.message}</p>}
      {waiting && kind === 'atlassian' && <AtlassianDomainHint />}
      {waiting && kind === 'mixpanel' && <MixpanelMcpHint />}
      {error && <p className="text-sm text-destructive-text">{error}</p>}
    </div>
  )
}
