'use client'
// The Email App: Brigade's own addresses on its mail domain. Its sheet's panel (turn it on, the
// addresses and each one's journal), and the Email address row on a teammate's Access card.
import Link from 'next/link'
import { useEffect, useState, type ReactNode } from 'react'
import { ArrowUpRight, Check, Copy } from 'lucide-react'
import { useDashboard, timeAgo } from '@/components/dashboard'
import { ProviderTile } from '@/components/provider-logo'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  api,
  isAdmin,
  useApi,
  type EmailState,
  type MailAddress,
  type MailJournalEntry,
} from '@/lib/api'
import { cn } from '@/lib/utils'

/** The Email App's sheet: what it is, Turn on, then its addresses. */
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

  if (!s.enabled)
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/60 px-4 py-3 text-sm">
          <span className="min-w-0 flex-[1_1_16rem]">
            Addresses of your own for your agents, on{' '}
            <span className="font-mono text-xs">{s.domain}</span>. Each agent&apos;s is turned on
            from its page.
          </span>
          {admin ? (
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

  const agents = s.addresses.filter((a) => a.kind === 'agent')
  const inboxes = s.addresses.filter((a) => a.kind === 'inbox')
  return (
    <div className="flex flex-col gap-6">
      <Section title="How it works">
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Each agent gets an address on <span className="font-mono text-xs">{s.domain}</span>,
          turned on from its page under Access. Projects get inboxes in their settings. A mail goes
          to the thread waiting for it, else to the first rule that matches it, else it stays in the
          address&apos;s box for 30 days.
        </p>
      </Section>
      <Section title="Agents">
        {agents.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            No agent has an address yet. Turn one on from an agent&apos;s page, under Access.
          </p>
        ) : (
          agents.map((a) => <AddressRow key={a.id} address={a} admin={admin} />)
        )}
      </Section>
      <Section title="Project inboxes">
        {inboxes.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            No inbox yet. A project gets one in its settings.
          </p>
        ) : (
          inboxes.map((a) => <AddressRow key={a.id} address={a} admin={admin} />)
        )}
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-1 text-sm font-medium text-muted-foreground">{title}</h3>
      <div className="flex flex-col divide-y rounded-xl bg-muted/60">{children}</div>
    </section>
  )
}

/** One address: a dot, the address to copy, whose it is, its journal and a test mail. */
function AddressRow({ address: a, admin }: { address: MailAddress; admin: boolean }) {
  const [journal, setJournal] = useState(false)
  const [sending, setSending] = useState(false)
  const [note, setNote] = useState<{ text: string; error?: boolean }>()
  // Bumped after a test mail, so an open journal shows it once it has arrived.
  const [fresh, setFresh] = useState(0)

  async function test() {
    setNote(undefined)
    setSending(true)
    try {
      const { to } = await api<{ sent: boolean; to: string }>(`/email/addresses/${a.id}/test`, {
        method: 'POST',
        body: {},
      })
      setNote({ text: `Test mail sent to ${to}. It shows in the journal once it arrives.` })
      setJournal(true)
      setTimeout(() => setFresh((n) => n + 1), 6000)
    } catch (e) {
      setNote({ text: (e as Error).message, error: true })
    } finally {
      setSending(false)
    }
  }

  const owner =
    a.kind === 'agent' && a.teammate ? (
      <Link
        href={`/app/teammates/${a.teammate.id}`}
        className="hover:text-foreground hover:underline"
      >
        {a.teammate.name}
      </Link>
    ) : a.project ? (
      <Link
        href={`/app/projects/${a.project.id}/settings`}
        className="hover:text-foreground hover:underline"
      >
        {a.project.name}
      </Link>
    ) : null

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1">
        <StatusDot on={a.on} />
        <span className="flex min-w-0 flex-[1_1_14rem] flex-col gap-0.5">
          <CopyAddress address={a.address} />
          <span className="truncate text-xs text-muted-foreground">
            {owner}
            {owner && !a.on && ' · '}
            {!a.on && 'Off'}
          </span>
          {a.kind === 'agent' &&
            a.variants.map((v) => (
              <span key={v.projectId} className="truncate text-xs text-muted-foreground">
                <span className="font-mono">{v.address}</span> in {v.project}
              </span>
            ))}
          {a.kind === 'inbox' && a.publicAddress && (
            <span className="truncate text-xs text-muted-foreground">
              Customers write to <span className="font-mono">{a.publicAddress}</span>
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {admin && a.on && (
            <Button variant="ghost" size="sm" disabled={sending} onClick={() => void test()}>
              {sending ? 'Sending…' : 'Send a test mail'}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={journal}
            onClick={() => setJournal((open) => !open)}
          >
            Journal
          </Button>
        </span>
      </div>
      {note && (
        <p
          className={cn('text-xs', note.error ? 'text-destructive-text' : 'text-muted-foreground')}
        >
          {note.text}
        </p>
      )}
      {journal && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Journal</span>
            <button
              type="button"
              onClick={() => setJournal(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              Done
            </button>
          </div>
          <Journal address={a} fresh={fresh} />
        </div>
      )}
    </div>
  )
}

function StatusDot({ on }: { on: boolean }) {
  const label = on ? 'On' : 'Off'
  return (
    <span
      className={cn('size-2 shrink-0 rounded-full', on ? 'bg-success' : 'bg-muted-foreground/40')}
      title={label}
    >
      <span className="sr-only">{label}</span>
    </span>
  )
}

/** An address in monospace, with a button that copies it. */
export function CopyAddress({ address, className }: { address: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className={cn('flex min-w-0 items-center gap-1', className)}>
      <span className="min-w-0 truncate font-mono text-sm font-medium">{address}</span>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(address).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
        className="flex-none rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
        aria-label={copied ? 'Copied' : `Copy ${address}`}
        title={copied ? 'Copied' : 'Copy'}
      >
        {copied ? (
          <Check className="size-3.5" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
      </button>
    </span>
  )
}

/** Where a received mail went, in plain words. */
function destination(e: MailJournalEntry) {
  switch (e.route) {
    case 'awaited':
      return 'To the thread waiting for it'
    case 'conversation':
      return "To its conversation's thread"
    case 'member':
      return "A member's request"
    case 'rule':
      return e.rule ? `Rule "${e.rule.label}"` : 'A rule'
    case 'handed':
      return 'Handed to a teammate from the Inbox'
    case 'read':
      return 'Taken by the thread that read it'
    case 'box':
      return 'Left in the box'
    case 'duplicate':
      return 'Already delivered from another address'
    case 'loop':
      return 'Stopped: looks like a loop'
    case 'cap':
      return 'Rule over its daily limit'
    case 'own_copy':
      return 'A reply sent from the mailbox itself'
    case 'bounce':
      return 'Delivery failure'
    case 'test':
      return 'Test mail'
    default:
      return 'Being delivered'
  }
}

/** An address's latest mail and where each went; never its text. */
function Journal({ address, fresh }: { address: MailAddress; fresh: number }) {
  const entries = useApi<MailJournalEntry[]>(`/email/addresses/${address.id}/journal?limit=50`, [
    'mail.updated',
  ])
  const { reload } = entries
  useEffect(() => {
    if (fresh) void reload()
  }, [fresh, reload])

  if (!entries.data) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (entries.data.length === 0)
    return <p className="text-sm text-muted-foreground">No mail yet.</p>
  return (
    <div className="flex flex-col divide-y rounded-lg border bg-card text-[13px]">
      {entries.data.map((e) => {
        const out = e.direction === 'out'
        return (
          <div key={e.id} className="flex flex-col gap-0.5 px-3 py-2">
            <div className="flex items-baseline gap-2">
              {out && (
                <span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
                  <ArrowUpRight className="size-3" aria-hidden />
                  Sent
                </span>
              )}
              <span className="min-w-0 flex-1 truncate font-medium">
                {e.subject || '(no subject)'}
              </span>
              <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">
                {timeAgo(e.at)}
              </span>
            </div>
            <span className="truncate text-xs text-muted-foreground">
              {out ? `To ${e.to.join(', ')}` : `From ${e.from}`}
              {e.address !== address.address && (
                <>
                  {' · '}
                  {out ? 'from' : 'to'} <span className="font-mono">{e.address}</span>
                </>
              )}
            </span>
            {!out && (
              <span className="truncate text-xs">
                {destination(e)}
                {e.thread && (
                  <>
                    {' · '}
                    <Link
                      href={`/app/threads/${e.thread.id}`}
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {e.thread.title || 'Untitled thread'}
                    </Link>
                  </>
                )}
              </span>
            )}
            {out && e.thread && (
              <span className="truncate text-xs">
                <Link
                  href={`/app/threads/${e.thread.id}`}
                  className="font-medium text-primary underline-offset-4 hover:underline"
                >
                  {e.thread.title || 'Untitled thread'}
                </Link>
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * A teammate's own address on its Access card: on with its variants, or off with Turn on for an
 * owner or admin. Shown only when this server runs the Email App.
 */
export function AgentEmailRow({
  teammate,
  editable,
}: {
  teammate: { id: string; name: string }
  /** An owner or admin: turns it on or off. */
  editable: boolean
}) {
  const state = useApi<EmailState>('/email', ['mail.updated', 'connections.updated'])
  const [form, setForm] = useState(false)
  const suggestion = useApi<{ name: string; address: string; kept: boolean }>(
    form ? `/email/agents/${teammate.id}/suggestion` : null,
  )
  const [name, setName] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const s = state.data
  if (!s?.available) return null
  const mine = s.addresses.find((a) => a.kind === 'agent' && a.teammate?.id === teammate.id)
  const on = !!mine?.on
  const kept = suggestion.data?.kept ?? false
  const value = name ?? suggestion.data?.name ?? ''

  async function turnOn() {
    setError(undefined)
    setBusy(true)
    try {
      await api(`/email/agents/${teammate.id}`, {
        method: 'POST',
        body: kept ? {} : { name: value.trim().toLowerCase() },
      })
      await state.reload()
      setForm(false)
      setName(undefined)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function turnOff() {
    if (!confirm("Mail to it will no longer arrive. The name stays this agent's.")) return
    setError(undefined)
    setBusy(true)
    try {
      await api(`/email/agents/${teammate.id}`, { method: 'DELETE' })
      await Promise.all([state.reload(), suggestion.reload()])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-t px-6 py-3">
      <ProviderTile kind="email" small />
      <span className="flex min-w-0 flex-[1_1_12rem] flex-col">
        <span className="truncate text-sm font-semibold">Email address</span>
        {!s.enabled ? (
          <span className="text-xs text-muted-foreground">
            Turn the Email App on in{' '}
            <Link href="/app/connections" className="font-medium text-primary hover:underline">
              Settings › Apps
            </Link>{' '}
            to give agents an address.
          </span>
        ) : on && mine ? (
          <>
            <CopyAddress address={mine.address} className="text-muted-foreground" />
            {mine.variants.map((v) => (
              <span key={v.projectId} className="truncate text-xs text-muted-foreground">
                <span className="font-mono">{v.address}</span> in {v.project}
              </span>
            ))}
          </>
        ) : (
          <span className="truncate text-xs text-muted-foreground">
            {mine ? (
              <>
                Off · <span className="font-mono">{mine.address}</span>
              </>
            ) : (
              'Off'
            )}
          </span>
        )}
      </span>
      {s.enabled &&
        editable &&
        (on ? (
          <Button variant="danger" size="sm" disabled={busy} onClick={() => void turnOff()}>
            Turn off
          </Button>
        ) : (
          !form && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setError(undefined)
                setForm(true)
              }}
            >
              Turn on
            </Button>
          )
        ))}
      {form && !on && editable && (
        <form
          className="flex basis-full flex-col gap-2 pl-11"
          onSubmit={(e) => {
            e.preventDefault()
            void turnOn()
          }}
        >
          {!suggestion.data ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {kept ? (
                  <span className="font-mono text-sm">
                    {suggestion.data.name}@{s.domain}
                  </span>
                ) : (
                  <label className="flex h-8 min-w-0 flex-[0_1_22rem] items-center overflow-hidden rounded-md border bg-background focus-within:ring-2 focus-within:ring-ring">
                    <Input
                      value={value}
                      onChange={(e) => setName(e.target.value)}
                      aria-label={`${teammate.name}'s address name`}
                      autoFocus
                      required
                      className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent font-mono shadow-none focus-visible:ring-0"
                    />
                    <span className="shrink-0 border-l bg-muted px-2 font-mono text-sm leading-8 text-muted-foreground">
                      @{s.domain}
                    </span>
                  </label>
                )}
                <Button size="sm" disabled={busy || !value.trim()}>
                  {busy ? 'Turning on…' : 'Turn on'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setForm(false)
                    setName(undefined)
                    setError(undefined)
                  }}
                >
                  Cancel
                </Button>
              </div>
              {kept && (
                <p className="text-xs text-muted-foreground">Its name is kept for it for good.</p>
              )}
            </>
          )}
        </form>
      )}
      {error && <p className="basis-full pl-11 text-xs text-destructive-text">{error}</p>}
    </div>
  )
}
