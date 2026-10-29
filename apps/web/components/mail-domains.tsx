'use client'
// Inbox › Mail settings › Domains: where the workspace's addresses live. Brigade's own domain, and the
// workspace's (acme.com, team.acme.com), each added once: its DNS records for sending, and how its
// mail reaches Brigade, directly (its MX points to Brigade) or by forwarding (its mail stays with
// its provider and each address is forwarded to its mailbox). Any mailbox can then have an address
// on it. The header with the Mailboxes and Domains tabs is shared with the mailboxes' list.
import type {
  CloudflareDnsResult,
  CloudflareDnsSetup,
  DomainLookup,
  MailDomainView,
} from '@brigade/contracts'
import { ArrowLeft, Plus } from 'lucide-react'
import Link from 'next/link'
import { useState, type FormEvent, type ReactNode } from 'react'
import { useDashboard } from '@/components/dashboard'
import { Address, Dot, ErrorLine, useAction } from '@/components/project-email'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, isAdmin, useApi, type EmailState } from '@/lib/api'
import { cn } from '@/lib/utils'

/** The mail settings' header: back to the Inbox, the title, Mailboxes and Domains. */
export function MailSettingsHeader({
  tab,
  action,
}: {
  tab: 'mailboxes' | 'domains'
  action?: ReactNode
}) {
  return (
    <>
      <Link
        href="/app/inbox"
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Inbox
      </Link>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-extrabold tracking-tight">Mail settings</h1>
          <p className="text-sm text-muted-foreground">
            Your mailboxes, and the domains their addresses live on.
          </p>
        </div>
        {action}
      </header>
      <nav aria-label="Mail settings" className="flex gap-1 border-b">
        {(
          [
            ['mailboxes', 'Mailboxes', '/app/inbox/mailboxes'],
            ['domains', 'Domains', '/app/inbox/domains'],
          ] as const
        ).map(([id, label, href]) => (
          <Link
            key={id}
            href={href}
            aria-current={tab === id ? 'page' : undefined}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
              tab === id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </Link>
        ))}
      </nav>
    </>
  )
}

/** "Sends" and "receives" for a domain, in words a person reads. */
export function domainState(d: Pick<MailDomainView, 'name' | 'status' | 'receiving'>) {
  const verified = d.status === 'verified'
  return {
    sending: verified
      ? 'Sends'
      : d.status === 'failed'
        ? 'Its DNS records were not found'
        : 'Waiting for its DNS records',
    receiving:
      d.receiving === 'forward'
        ? 'Receives by forwarding'
        : verified
          ? 'Receives directly'
          : 'Receives directly once its records are in',
    tone: verified
      ? ('success' as const)
      : d.status === 'failed'
        ? ('failed' as const)
        : ('idle' as const),
  }
}

export function DomainsView() {
  const { me } = useDashboard()
  const admin = isAdmin(me)
  const email = useApi<EmailState>('/email', ['mail.updated'])
  const domains = useApi<MailDomainView[]>('/email/domains', ['mail.updated'])
  const [adding, setAdding] = useState(false)

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6 md:px-6">
      <MailSettingsHeader
        tab="domains"
        action={
          admin && email.data?.enabled && !adding ? (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus />
              Add a domain
            </Button>
          ) : undefined
        }
      />
      {adding && <AddDomain onDone={() => setAdding(false)} reload={domains.reload} />}
      <Card className="gap-1 px-5 py-4">
        <div className="flex items-start gap-2">
          <Dot tone="success" label="Ready" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-mono text-sm font-semibold">{email.data?.domain ?? '…'}</span>
            <span className="text-sm text-muted-foreground">
              Brigade&apos;s domain: sends and receives directly, nothing to set up. Every mailbox
              has an address on it, and an agent signs up to services with it.
            </span>
          </div>
        </div>
      </Card>
      {domains.error ? (
        <p className="text-sm text-destructive-text">{domains.error.message}</p>
      ) : !domains.data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : domains.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Add your own domain to give mailboxes addresses such as support@yourcompany.com or
          riley@yourcompany.com: they send and receive as it.
        </p>
      ) : (
        domains.data.map((d) => (
          <DomainCard key={d.id} domain={d} admin={admin} reload={domains.reload} />
        ))
      )}
    </div>
  )
}

/** Add a domain: where its mail goes now is looked up first, so the way to receive is clear. */
function AddDomain({ onDone, reload }: { onDone: () => void; reload: () => Promise<unknown> }) {
  const [name, setName] = useState('')
  const [lookup, setLookup] = useState<DomainLookup>()
  const [receiving, setReceiving] = useState<'direct' | 'forward'>('forward')
  const look = useAction()
  const add = useAction()
  const provider = lookup && lookup.mx.length > 0 && !lookup.brigade

  async function find(event: FormEvent) {
    event.preventDefault()
    setLookup(undefined)
    const found = await look.run(() =>
      api<DomainLookup>(`/email/domains/lookup?name=${encodeURIComponent(name.trim())}`),
    )
    if (!found) return
    setLookup(found)
    setReceiving(found.suggested)
  }

  async function create() {
    if (!lookup) return
    const made = await add.run(() =>
      api('/email/domains', { body: { name: lookup.name, receiving } }),
    )
    if (made === undefined) return
    await reload()
    onDone()
  }

  return (
    <Card className="gap-4 px-5 py-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-bold">Add a domain</h2>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <form onSubmit={(e) => void find(e)} className="flex flex-col gap-2">
        <Label htmlFor="domain-name">Domain</Label>
        <div className="flex gap-2">
          <Input
            id="domain-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setLookup(undefined)
            }}
            placeholder="yourcompany.com"
            className="font-mono"
            required
          />
          <Button type="submit" variant="outline" disabled={look.busy || !name.trim()}>
            Continue
          </Button>
        </div>
        <ErrorLine error={look.error} />
      </form>
      {lookup && (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">
            {lookup.brigade
              ? `${lookup.name}'s mail already comes to Brigade.`
              : provider
                ? `${lookup.name}'s mail goes to ${lookup.mx[0]} today. Brigade leaves it there: each address is forwarded from it.`
                : `${lookup.name} receives no mail yet: Brigade can receive it directly.`}
          </p>
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">How its mail reaches Brigade</legend>
            <Choice
              checked={receiving === 'forward'}
              onSelect={() => setReceiving('forward')}
              title="By forwarding"
              text="Its mail stays where it is (Google Workspace, Microsoft 365…). You forward each mailbox's address to Brigade."
            />
            <Choice
              checked={receiving === 'direct'}
              disabled={!!provider}
              onSelect={() => setReceiving('direct')}
              title="Directly"
              text={
                provider
                  ? `Not for ${lookup.name}: it would take the mail ${lookup.mx[0]} receives. Use a subdomain, such as team.${lookup.name}.`
                  : 'Its MX points to Brigade: every address on it works at once, nothing to forward.'
              }
            />
          </fieldset>
          <p className="text-muted-foreground">
            {receiving === 'forward'
              ? `Then add the DNS records Brigade shows at your DNS provider, so mail goes out as ${lookup.name}. The MX and SPF of your current mail do not change.`
              : `Then add the DNS records Brigade shows at your DNS provider, its MX included: mail goes out as ${lookup.name} and comes in to Brigade.`}
          </p>
          <div className="flex items-center gap-3">
            <Button size="sm" disabled={add.busy} onClick={() => void create()}>
              Add {lookup.name}
            </Button>
            <ErrorLine error={add.error} />
          </div>
        </div>
      )}
    </Card>
  )
}

function Choice({
  checked,
  disabled,
  onSelect,
  title,
  text,
}: {
  checked: boolean
  disabled?: boolean
  onSelect: () => void
  title: string
  text: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex flex-col gap-0.5 rounded-lg border p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60',
        checked ? 'border-primary bg-primary/5' : 'hover:bg-secondary/50',
      )}
    >
      <span className="text-sm font-semibold">{title}</span>
      <span className="text-xs text-muted-foreground">{text}</span>
    </button>
  )
}

/** What removing a domain does, its mailboxes' addresses on it named. */
const removeQuestion = (d: Pick<MailDomainView, 'name' | 'addresses'>) =>
  d.addresses.length === 0
    ? `Remove ${d.name}? Mail stops going out as it.`
    : `Remove ${d.name}? Mail stops going out as it, and ${d.addresses.join(', ')} ${
        d.addresses.length === 1 ? 'stops' : 'stop'
      } working. Mailboxes keep their address on Brigade's domain.`

function DomainCard({
  domain: d,
  admin,
  reload,
}: {
  domain: MailDomainView
  admin: boolean
  reload: () => Promise<unknown>
}) {
  const state = domainState(d)
  const verified = d.status === 'verified'
  const [records, setRecords] = useState(!verified)
  const check = useAction()
  const remove = useAction()

  return (
    <Card className="gap-3 px-5 py-4">
      <div className="flex items-start gap-2">
        <Dot tone={state.tone} label={state.sending} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-mono text-sm font-semibold">{d.name}</span>
          <span className="text-sm text-muted-foreground">
            {state.sending} · {state.receiving}
          </span>
        </div>
        {admin && (
          <div className="flex flex-none items-center gap-1">
            {!verified && (
              <Button
                variant="outline"
                size="xs"
                disabled={check.busy}
                onClick={() =>
                  void check
                    .run(() => api(`/email/domains/${d.id}/check`, { body: {} }))
                    .then(() => reload())
                }
              >
                Check now
              </Button>
            )}
            <Button
              variant="ghost"
              size="xs"
              disabled={remove.busy}
              onClick={() =>
                confirm(removeQuestion(d)) &&
                void remove
                  .run(() => api(`/email/domains/${d.id}`, { method: 'DELETE' }))
                  .then(() => reload())
              }
            >
              Remove
            </Button>
          </div>
        )}
      </div>
      <ErrorLine error={check.error ?? remove.error} />
      <p className="text-sm text-muted-foreground">
        {d.receiving === 'forward'
          ? `Mail to its addresses stays with ${d.name}'s mail provider; each mailbox's page says where to forward its address.`
          : `Its MX points to Brigade: mail to any of its mailboxes' addresses arrives directly.`}
      </p>
      {admin && !verified && <CloudflareRecords domain={d} reload={reload} />}
      {!verified && (
        <p className="text-sm text-muted-foreground">
          Add its records within 3 days. After that, while they are not in, another workspace on
          Brigade can add {d.name} instead.
        </p>
      )}
      {d.addresses.length > 0 && (
        <p className="text-sm">
          <span className="text-muted-foreground">Addresses: </span>
          {d.addresses.join(', ')}
        </p>
      )}
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-3"
          aria-expanded={records}
          onClick={() => setRecords((open) => !open)}
        >
          {records ? 'Hide its DNS records' : 'Its DNS records'}
        </Button>
      </div>
      {records && <DnsRecords domain={d} />}
    </Card>
  )
}

const RESULT_WORDS: Record<CloudflareDnsResult['result'], string> = {
  added: 'Added',
  present: 'Already there',
  conflict: 'Left alone: another record has its name',
  failed: 'Not added',
}

/**
 * A domain whose DNS is at Cloudflare: its records added there in one click, with one of the
 * workspace's Cloudflare accounts, instead of copied by hand. Without an account, a link to
 * connect one. Nothing shows for a domain whose DNS is elsewhere.
 */
function CloudflareRecords({
  domain: d,
  reload,
}: {
  domain: MailDomainView
  reload: () => Promise<unknown>
}) {
  const setup = useApi<CloudflareDnsSetup>(`/email/domains/${d.id}/cloudflare`, [
    'connections.updated',
  ])
  const [chosen, setChosen] = useState<string>()
  const [done, setDone] = useState<{ zone: string; results: CloudflareDnsResult[] }>()
  const add = useAction()
  if (!setup.data?.onCloudflare) return null
  const accounts = setup.data.accounts
  const account = chosen ?? accounts[0]?.id

  async function addRecords() {
    if (!account) return
    const answer = await add.run(() =>
      api<{ zone: string; results: CloudflareDnsResult[] }>(`/email/domains/${d.id}/cloudflare`, {
        body: { connectionId: account },
      }),
    )
    if (!answer) return
    setDone(answer)
    await reload()
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-muted/50 p-3 text-sm">
      <span className="font-medium">{d.name}&apos;s DNS is on Cloudflare</span>
      {accounts.length === 0 ? (
        <p className="text-muted-foreground">
          Connect your Cloudflare account and Brigade adds these records for you.{' '}
          <Link
            href="/app/connections?app=cloudflare"
            className="font-medium text-primary hover:underline"
          >
            Connect Cloudflare
          </Link>
        </p>
      ) : (
        <>
          <p className="text-muted-foreground">
            Brigade can add these records there for you. It leaves the domain&apos;s other records
            as they are, and never replaces one.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {accounts.length > 1 && (
              <Select value={account} onValueChange={setChosen}>
                <SelectTrigger aria-label="Cloudflare account" className="w-64 bg-card">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button size="sm" disabled={add.busy} onClick={() => void addRecords()}>
              {add.busy ? 'Adding…' : 'Add them on Cloudflare'}
            </Button>
          </div>
        </>
      )}
      <ErrorLine error={add.error} />
      {done && (
        <ul className="flex flex-col gap-1">
          {done.results.map((r) => (
            <li key={`${r.type}-${r.name}`} className="flex flex-wrap items-baseline gap-x-2">
              <Dot
                tone={r.result === 'added' || r.result === 'present' ? 'success' : 'failed'}
                label={RESULT_WORDS[r.result]}
              />
              <span className="font-mono text-xs">
                {r.type} {r.name}
              </span>
              <span className="text-muted-foreground">
                {RESULT_WORDS[r.result]}
                {r.note ? ` (${r.note})` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {done?.results.some((r) => r.result === 'failed') && (
        <p className="text-muted-foreground">
          Cloudflare refused some of them: the account may not be allowed to edit DNS.{' '}
          <Link
            href="/app/connections?app=cloudflare"
            className="font-medium text-primary hover:underline"
          >
            Reconnect it
          </Link>{' '}
          and allow DNS editing, or add them by hand.
        </p>
      )}
      {done?.results.some((r) => r.result === 'conflict') && (
        <p className="text-muted-foreground">
          Brigade never replaces a record: change the one in the way on Cloudflare, then add them
          again.
        </p>
      )}
      {done?.results.every((r) => r.result === 'added' || r.result === 'present') && (
        <p className="text-muted-foreground">
          Resend checks them within minutes; the domain turns green once it has.
        </p>
      )}
    </div>
  )
}

const recordTone = (status: string) =>
  status === 'verified'
    ? ('success' as const)
    : status === 'failed'
      ? ('failed' as const)
      : ('idle' as const)

/** The records to add at the domain's DNS provider, each with its state. */
export function DnsRecords({
  domain: d,
}: {
  domain: Pick<MailDomainView, 'records' | 'checkedAt'>
}) {
  if (d.records.length === 0)
    return (
      <p className="text-sm text-muted-foreground">Its records show here once Resend has them.</p>
    )
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-xs">
          <thead className="bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="w-4 px-2 py-1.5" aria-label="Status" />
              <th className="px-2 py-1.5 font-medium">Type</th>
              <th className="px-2 py-1.5 font-medium">Name</th>
              <th className="px-2 py-1.5 font-medium">Value</th>
              <th className="px-2 py-1.5 font-medium">Priority</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {d.records.map((r) => (
              <tr key={`${r.record}-${r.type}-${r.name}`} className="align-top">
                <td className="px-2 py-1.5">
                  <Dot tone={recordTone(r.status)} label={r.status} />
                </td>
                <td className="px-2 py-1.5 font-mono">{r.type}</td>
                <td className="px-2 py-1.5">
                  <Address value={r.name} />
                </td>
                <td className="max-w-80 px-2 py-1.5">
                  <Address value={r.value} />
                </td>
                <td className="px-2 py-1.5 font-mono">{r.priority ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {d.checkedAt && (
        <p className="text-xs text-muted-foreground">
          Checked {new Date(d.checkedAt).toLocaleString()}.
        </p>
      )}
    </div>
  )
}
