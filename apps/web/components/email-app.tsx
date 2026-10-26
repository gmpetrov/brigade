'use client'
// The Email App: Brigade's own addresses on its mail domain. Its sheet turns it on; the mailboxes
// themselves live in Inbox › Mailboxes (components/mailboxes.tsx), and a teammate's Access card
// links to its own.
import Link from 'next/link'
import { useState } from 'react'
import { useDashboard } from '@/components/dashboard'
import { mailboxPath } from '@/components/mailboxes'
import { ProviderTile } from '@/components/provider-logo'
import { Button } from '@/components/ui/button'
import { api, isAdmin, useApi, type EmailState } from '@/lib/api'

/** The Email App's sheet: what it is, Turn on, then where its mailboxes are. */
export function EmailApp({ reload }: { reload: () => Promise<unknown> }) {
  const { me } = useDashboard()
  const admin = isAdmin(me)
  const state = useApi<EmailState>('/email', ['mail.updated', 'connections.updated'])
  const [error, setError] = useState<string>()
  const [turning, setTurning] = useState(false)

  async function enable() {
    setError(undefined)
    setTurning(true)
    try {
      await api('/email/enable', { method: 'POST', body: {} })
      await Promise.all([state.reload(), reload()])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setTurning(false)
    }
  }

  const s = state.data
  if (!s) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (!s.available)
    return (
      <p className="text-sm text-muted-foreground">
        {s.unavailable ?? 'Not available on this Brigade server.'}
      </p>
    )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/60 px-4 py-3 text-sm">
        <span className="min-w-0 flex-[1_1_16rem]">
          Mailboxes of your own on <span className="font-mono text-xs">{s.domain}</span>: an address
          for each agent, and shared ones for the addresses people already write to.
        </span>
        {s.enabled ? (
          <Button asChild size="sm" variant="outline">
            <Link href="/app/inbox/mailboxes">Mailboxes</Link>
          </Button>
        ) : admin ? (
          <Button size="sm" disabled={turning} onClick={() => void enable()}>
            {turning ? 'Turning on…' : 'Turn on'}
          </Button>
        ) : (
          <span className="text-muted-foreground">An owner or admin turns it on.</span>
        )}
      </div>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
    </div>
  )
}

/** A teammate's own mailbox, on its Access card: its address and a link to it, or Give one. */
export function AgentEmailRow({
  teammate,
  editable,
}: {
  teammate: { id: string; name: string }
  /** An owner or admin: gives it one. */
  editable: boolean
}) {
  const state = useApi<EmailState>('/email')
  const s = state.data
  if (!s?.available) return null
  const mine = s.addresses.find((a) => a.kind === 'agent' && a.teammate?.id === teammate.id)
  const on = !!mine?.on

  return (
    <div className="flex flex-wrap items-center gap-3 border-t px-6 py-3">
      <ProviderTile kind="email" small />
      <span className="flex min-w-0 flex-[1_1_12rem] flex-col">
        <span className="truncate text-sm font-semibold">Mailbox</span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {on && mine ? mine.address : 'No address'}
        </span>
      </span>
      {on && mine ? (
        <Button asChild variant="outline" size="sm">
          <Link href={mailboxPath(`email:${mine.id}`)}>Open</Link>
        </Button>
      ) : (
        editable && (
          <Button asChild variant="outline" size="sm">
            <Link
              href={`/app/inbox/mailboxes?add=agent&teammate=${encodeURIComponent(teammate.id)}`}
            >
              Give an address
            </Link>
          </Button>
        )
      )}
    </div>
  )
}
