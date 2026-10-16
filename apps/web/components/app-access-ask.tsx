'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import type { Ask, TicketAnswer } from '@brigade/contracts'
import { useDashboard } from '@/components/dashboard'
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

/** App names for a ticket's heading, before the catalog has loaded. */
export const APP_NAMES: Record<string, string> = {
  gmail: 'Gmail',
  google_calendar: 'Google Calendar',
  stripe: 'Stripe',
  github: 'GitHub',
  cloudflare: 'Cloudflare',
}

/** Where each App signs in; Stripe takes a key on the Apps page. */
const SIGN_IN: Partial<Record<Connection['kind'], 'google' | 'github' | 'mcp'>> = {
  gmail: 'google',
  google_calendar: 'google',
  github: 'github',
  cloudflare: 'mcp',
}

/**
 * A teammate asks for an App: Give it the access (the API grants it as the
 * ticket is answered), or Decline. With no account yet, Connect signs in in a
 * window of its own and gives the access as soon as the account is there.
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
  const name = data.data?.catalog[kind]?.name ?? ask.what
  const accounts = (data.data?.connections ?? []).filter(
    (c) => c.kind === kind && c.status === 'active',
  )
  // Those this person may give. Another member's own account is left out: it is used only in
  // their threads. The API checks again that the account is usable in this thread.
  const givable = accounts.filter(
    (c) => c.createdByMemberId === me.memberId || (isAdmin(me) && c.reach === 'workspace'),
  )
  const [picked, setPicked] = useState<string>()
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string>()
  const access = ask.app.scope === 'read' ? 'read' : 'read and write'
  const give = (connectionId: string | undefined) =>
    onReply({ type: 'access', granted: true, ...(connectionId ? { connectionId } : {}) })

  // Signing in in its own window: once the account shows up, the access goes with the answer.
  useEffect(() => {
    if (!waiting) return
    if (givable.length > 0) {
      setWaiting(false)
      give(givable.length === 1 ? givable[0]!.id : undefined)
      return
    }
    const timer = setInterval(() => void data.reload(), 2000)
    return () => clearInterval(timer)
  }, [waiting, givable.length])

  async function connect() {
    setError(undefined)
    const route = SIGN_IN[kind]
    if (!route) return
    try {
      const inWindow = await openSignIn(async (returnTo) => {
        const { url } = await api<{ url: string }>(`/connections/${route}`, {
          body: { ...(route === 'github' ? {} : { kind }), ...(returnTo ? { returnTo } : {}) },
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
  if (!data.data) return null

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <ProviderTile kind={kind} small />
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
        ) : accounts.length === 0 && SIGN_IN[kind] ? (
          <>
            <Button
              size="sm"
              disabled={waiting || !data.data.available[kind]}
              onClick={() => void connect()}
            >
              Connect {name}
            </Button>
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
      {waiting && (
        <p className="text-sm text-muted-foreground">
          Finish signing in in the window that opened. {askerName} gets {access} access as soon as{' '}
          {name} is connected.
        </p>
      )}
      {error && <p className="text-sm text-destructive-text">{error}</p>}
    </div>
  )
}
