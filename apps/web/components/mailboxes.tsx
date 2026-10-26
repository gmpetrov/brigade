'use client'
// Inbox › Mailboxes: whatever receives mail for the workspace, in one place. The list, Add a
// mailbox (an agent's address, a shared one for an address people already write to, a Gmail
// account), and each mailbox's page: where its mail arrives, who handles it (its rules and
// playbooks, in the order they apply), who reads and replies from it.
import type { MailboxDetail, MailboxRule, MailboxSummary } from '@brigade/contracts'
import { ArrowDown, ArrowLeft, ArrowUp, ArrowUpRight, Plus, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState, type FormEvent, type ReactNode } from 'react'
import { timeAgo, useDashboard } from '@/components/dashboard'
import {
  AddRule,
  Address,
  ErrorLine,
  InboxArrival,
  rulesSummary,
  useAction,
} from '@/components/project-email'
import { ProjectSelect } from '@/components/projects'
import { ProviderLogo } from '@/components/provider-logo'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, isAdmin, useApi, type EmailState, type MailJournalEntry } from '@/lib/api'

export const mailboxPath = (id: string) => `/app/inbox/mailboxes/${encodeURIComponent(id)}`

const KIND: Record<MailboxSummary['kind'], string> = {
  agent: "Agent's address",
  inbox: 'Shared mailbox',
  gmail: 'Gmail',
}

function Back({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden />
      {children}
    </Link>
  )
}

function MailboxIcon({ kind }: { kind: MailboxSummary['kind'] }) {
  return <ProviderLogo kind={kind === 'gmail' ? 'gmail' : 'email'} className="size-5 flex-none" />
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export function MailboxesView() {
  const params = useSearchParams()
  const list = useApi<MailboxSummary[]>('/inbox/mailboxes', ['mail.updated', 'connections.updated'])
  const [adding, setAdding] = useState(params.get('add') !== null)

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6 md:px-6">
      <Back href="/app/inbox">Inbox</Back>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-extrabold tracking-tight">Mailboxes</h1>
          <p className="text-sm text-muted-foreground">
            Everything that receives mail: where it arrives, who handles it, who reads it.
          </p>
        </div>
        {!adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus />
            Add a mailbox
          </Button>
        )}
      </header>

      {adding && (
        <AddMailbox
          initial={params.get('add') ?? ''}
          teammateId={params.get('teammate') ?? undefined}
          onCancel={() => setAdding(false)}
        />
      )}

      {list.error ? (
        <p className="text-sm text-destructive-text">{list.error.message}</p>
      ) : !list.data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : list.data.length === 0 ? (
        <Card className="items-center gap-2 px-6 py-12 text-center">
          <p className="max-w-md text-sm text-muted-foreground">
            No mailbox yet. Give an agent an address, receive what people send to support@…, or
            connect a Gmail account.
          </p>
        </Card>
      ) : (
        <Card className="gap-0 divide-y py-0">
          {list.data.map((m) => (
            <MailboxRow key={m.id} mailbox={m} />
          ))}
        </Card>
      )}
    </div>
  )
}

function MailboxRow({ mailbox: m }: { mailbox: MailboxSummary }) {
  return (
    <Link
      href={mailboxPath(m.id)}
      className="flex items-start gap-3 px-4 py-3 outline-none hover:bg-secondary/50 focus-visible:bg-secondary/50"
    >
      <MailboxIcon kind={m.kind} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-sm font-semibold">{m.name}</span>
          <span className="flex-none text-xs text-muted-foreground">{KIND[m.kind]}</span>
        </div>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {m.publicAddress ? `${m.publicAddress} → ${m.address}` : m.address}
        </span>
        <span className="text-xs text-muted-foreground">
          {m.ruleCount === 0
            ? 'No rule: its mail waits for you'
            : `${m.ruleCount} ${m.ruleCount === 1 ? 'rule' : 'rules'}`}
          {m.visibility === 'you' && ' · Only you'}
        </span>
      </div>
    </Link>
  )
}

// ---------------------------------------------------------------------------
// Add a mailbox: from what the person wants, not how it works
// ---------------------------------------------------------------------------

type Choice = 'agent' | 'shared' | 'gmail'

const CHOICES: { id: Choice; title: string; text: string }[] = [
  {
    id: 'shared',
    title: 'Receive mail sent to an address you have',
    text: 'support@yourcompany.com and the like: forward it here, and a teammate can answer it.',
  },
  {
    id: 'agent',
    title: 'Give an agent an address',
    text: 'For signing up to services and writing to people, under its own name.',
  },
  {
    id: 'gmail',
    title: 'Connect a Gmail account',
    text: 'Your agents read and send from it; what its rules take shows in the Inbox.',
  },
]

function AddMailbox({
  initial,
  teammateId,
  onCancel,
}: {
  initial: string
  teammateId?: string
  onCancel: () => void
}) {
  const { me } = useDashboard()
  const admin = isAdmin(me)
  const email = useApi<EmailState>('/email', ['mail.updated'])
  const [choice, setChoice] = useState<Choice | undefined>(
    CHOICES.some((c) => c.id === initial) ? (initial as Choice) : undefined,
  )
  const enable = useAction()

  const needsEmail = choice === 'agent' || choice === 'shared'
  const state = email.data
  return (
    <Card className="gap-4 px-5 py-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-bold">Add a mailbox</h2>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {CHOICES.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={choice === c.id}
            onClick={() => setChoice(c.id)}
            className="flex flex-col gap-1 rounded-lg border p-3 text-left outline-none hover:bg-secondary/50 focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-primary aria-pressed:bg-primary/5"
          >
            <span className="text-sm font-semibold">{c.title}</span>
            <span className="text-xs text-muted-foreground">{c.text}</span>
          </button>
        ))}
      </div>

      {needsEmail && state && !state.available && (
        <p className="text-sm text-muted-foreground">
          {state.unavailable ?? 'Brigade addresses are not available on this server.'}
        </p>
      )}
      {needsEmail && state?.available && !state.enabled && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted/60 px-4 py-3 text-sm">
          <span className="min-w-0 flex-[1_1_16rem]">
            Brigade gives mailboxes addresses on{' '}
            <span className="font-mono text-xs">{state.domain}</span>. Turn it on for the workspace
            first.
          </span>
          {admin ? (
            <Button
              size="sm"
              disabled={enable.busy}
              onClick={() =>
                void enable.run(async () => {
                  await api('/email/enable', { method: 'POST', body: {} })
                  await email.reload()
                })
              }
            >
              Turn on
            </Button>
          ) : (
            <span className="text-muted-foreground">An owner or admin turns it on.</span>
          )}
          <ErrorLine error={enable.error} />
        </div>
      )}
      {needsEmail && state?.enabled && !admin && (
        <p className="text-sm text-muted-foreground">An owner or admin adds mailboxes.</p>
      )}
      {choice === 'shared' && state?.enabled && admin && <AddShared />}
      {choice === 'agent' && state?.enabled && admin && (
        <AddAgent state={state} teammateId={teammateId} />
      )}
      {choice === 'gmail' && (
        <p className="text-sm">
          <Link href="/app/connections" className="font-medium text-primary hover:underline">
            Connect Gmail in Settings › Apps
          </Link>
          <span className="text-muted-foreground">
            , then give it to the teammates who use it. It shows here once connected.
          </span>
        </p>
      )}
    </Card>
  )
}

/** A project's shared mailbox for an address people already write to, forwarded to it. */
function AddShared() {
  const router = useRouter()
  const { projects } = useDashboard()
  const [publicAddress, setPublicAddress] = useState('')
  const [projectId, setProjectId] = useState(projects.find((p) => !p.archivedAt)?.id ?? '')
  const action = useAction()

  async function add(event: FormEvent) {
    event.preventDefault()
    const address = publicAddress.trim().toLowerCase()
    if (!address || !projectId) return
    const local = address.split('@')[0] ?? ''
    const label = (local.charAt(0).toUpperCase() + local.slice(1)).slice(0, 40) || 'Support'
    // One call: the address is checked first, and a refused one leaves no mailbox behind.
    const made = await action.run(() =>
      api<{ id: string }>('/email/inboxes', {
        body: { projectId, label, publicAddress: address },
      }),
    )
    if (made) router.push(mailboxPath(`email:${made.id}`))
  }

  return (
    <form onSubmit={(e) => void add(e)} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="shared-address">The address people write to</Label>
          <Input
            id="shared-address"
            type="email"
            value={publicAddress}
            onChange={(e) => setPublicAddress(e.target.value)}
            placeholder="support@yourcompany.com"
            className="font-mono"
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="shared-project">Project</Label>
          <ProjectSelect
            id="shared-project"
            value={projectId}
            onChange={setProjectId}
            none={false}
          />
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Brigade gives it an address of its own; its page then shows how to forward your address to
        it, and checks that mail comes through.
      </p>
      <div className="flex items-center gap-3">
        <Button
          type="submit"
          size="sm"
          disabled={action.busy || !publicAddress.trim() || !projectId}
        >
          Add mailbox
        </Button>
        <ErrorLine error={action.error} />
      </div>
    </form>
  )
}

/** An agent's own address, named after it (or a free variant of its name). */
function AddAgent({ state, teammateId }: { state: EmailState; teammateId?: string }) {
  const router = useRouter()
  const { teammates } = useDashboard()
  const taken = new Set(
    state.addresses.filter((a) => a.kind === 'agent' && a.on).map((a) => a.teammate?.id),
  )
  const free = teammates.filter((t) => !taken.has(t.id))
  const [chosen, setChosen] = useState(
    free.find((t) => t.id === teammateId)?.id ?? free[0]?.id ?? '',
  )
  const suggestion = useApi<{ name: string; address: string; kept: boolean }>(
    chosen ? `/email/agents/${chosen}/suggestion` : null,
  )
  const [name, setName] = useState<string>()
  const action = useAction()
  const value = name ?? suggestion.data?.name ?? ''
  const kept = suggestion.data?.kept ?? false

  if (free.length === 0)
    return <p className="text-sm text-muted-foreground">Every agent has an address already.</p>

  async function add(event: FormEvent) {
    event.preventDefault()
    if (!chosen) return
    const made = await action.run(() =>
      api<{ id: string }>(`/email/agents/${chosen}`, {
        method: 'POST',
        body: kept ? {} : { name: value.trim().toLowerCase() },
      }),
    )
    if (made) router.push(mailboxPath(`email:${made.id}`))
  }

  return (
    <form onSubmit={(e) => void add(e)} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="agent-teammate">Agent</Label>
          <Select
            value={chosen}
            onValueChange={(v) => {
              setChosen(v)
              setName(undefined)
            }}
          >
            <SelectTrigger id="agent-teammate" className="w-full">
              <SelectValue placeholder="Pick an agent" />
            </SelectTrigger>
            <SelectContent>
              {free.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="agent-name">Address</Label>
          <div className="flex items-center gap-1">
            <Input
              id="agent-name"
              value={value}
              onChange={(e) => setName(e.target.value)}
              disabled={kept}
              className="font-mono"
              maxLength={30}
            />
            <span className="flex-none font-mono text-xs text-muted-foreground">
              @{state.domain}
            </span>
          </div>
          {kept && (
            <span className="text-xs text-muted-foreground">
              Its address before, kept for it: no one else gets it.
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={action.busy || !chosen || !value.trim()}>
          Give the address
        </Button>
        <ErrorLine error={action.error} />
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// One mailbox
// ---------------------------------------------------------------------------

function Section({ step, title, children }: { step: number; title: string; children: ReactNode }) {
  return (
    <Card className="gap-3 px-5 py-5">
      <h2 className="flex items-center gap-2 text-base font-bold">
        <span
          aria-hidden
          className="flex size-6 flex-none items-center justify-center rounded-full bg-primary/15 text-xs font-bold text-primary"
        >
          {step}
        </span>
        {title}
      </h2>
      {children}
    </Card>
  )
}

export function MailboxView({ id }: { id: string }) {
  const router = useRouter()
  const mailbox = useApi<MailboxDetail>(`/inbox/mailboxes/${encodeURIComponent(id)}`, [
    'mail.updated',
    'connections.updated',
  ])
  const email = useApi<EmailState>(id.startsWith('email:') ? '/email' : null, ['mail.updated'])
  const m = mailbox.data
  const reload = () => Promise.all([mailbox.reload(), email.reload()])

  if (mailbox.error)
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 md:px-6">
        <Back href="/app/inbox/mailboxes">Mailboxes</Back>
        <p className="text-sm text-destructive-text">{mailbox.error.message}</p>
      </div>
    )
  if (!m) return <p className="px-6 py-6 text-sm text-muted-foreground">Loading…</p>
  const inbox = email.data?.addresses.find((a) => a.id === m.addressId)

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 md:px-6">
      <Back href="/app/inbox/mailboxes">Mailboxes</Back>
      <header className="flex items-start gap-3">
        <MailboxIcon kind={m.kind} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h1 className="text-2xl font-extrabold tracking-tight wrap-anywhere">{m.name}</h1>
          <span className="text-sm text-muted-foreground">
            {KIND[m.kind]}
            {m.visibility === 'you' && ' · Only you see it'}
          </span>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href={`/app/inbox?source=${encodeURIComponent(m.id)}&status=all`}>Its mail</Link>
        </Button>
      </header>

      <Section step={1} title="Where its mail arrives">
        {m.kind === 'inbox' && inbox ? (
          <InboxArrival
            inbox={inbox}
            admin={m.manages}
            reload={reload}
            onTurnedOff={() => router.push('/app/inbox/mailboxes')}
          />
        ) : m.kind === 'agent' ? (
          <AgentArrival mailbox={m} onTurnedOff={() => router.push('/app/inbox/mailboxes')} />
        ) : m.kind === 'gmail' ? (
          <GmailArrival mailbox={m} reload={reload} />
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </Section>

      <Section step={2} title="Who handles it">
        <MailboxRules mailbox={m} reload={reload} />
      </Section>

      <Section step={3} title="Who reads and replies">
        {m.readers.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {m.readers.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/app/teammates/${t.id}`}
                  className="rounded-full bg-secondary px-2.5 py-1 text-sm hover:bg-secondary/70"
                >
                  {t.name}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No teammate has it yet.</p>
        )}
        <p className="text-sm text-muted-foreground">
          {m.kind === 'agent'
            ? `Only ${m.teammate?.name ?? 'its agent'} reads and sends from its address.`
            : 'The teammates given it read its mail and reply from it; give it to one on their page, under Access.'}{' '}
          {m.visibility === 'you'
            ? 'In the Inbox, only you see its mail.'
            : 'In the Inbox, everyone in the workspace sees its mail.'}
        </p>
      </Section>

      {m.addressId && (
        <Card className="gap-3 px-5 py-5">
          <MailboxJournal mailbox={m} />
        </Card>
      )}
    </div>
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
      return 'Left in the mailbox'
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

/**
 * A Brigade mailbox's journal: its latest mail both ways (sent, bounced, looped, duplicated too),
 * and where each went; never its text. With a test mail for an agent's address.
 */
function MailboxJournal({ mailbox: m }: { mailbox: MailboxDetail }) {
  const entries = useApi<MailJournalEntry[]>(`/email/addresses/${m.addressId}/journal?limit=50`, [
    'mail.updated',
  ])
  const test = useAction()
  const [note, setNote] = useState<string>()
  const { reload } = entries

  async function sendTest() {
    setNote(undefined)
    const done = await test.run(() =>
      api<{ sent: boolean; to: string }>(`/email/addresses/${m.addressId}/test`, { body: {} }),
    )
    if (!done) return
    setNote(`Test mail sent to ${done.to}. It shows here once it arrives.`)
    setTimeout(() => void reload(), 6000)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold">Journal</h2>
        {m.manages && m.kind === 'agent' && (
          <Button variant="outline" size="sm" disabled={test.busy} onClick={() => void sendTest()}>
            Send a test mail
          </Button>
        )}
      </div>
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
      <ErrorLine error={test.error} />
      {!entries.data ? (
        <p className="text-sm text-muted-foreground">{entries.error?.message ?? 'Loading…'}</p>
      ) : entries.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No mail yet.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border text-[13px]">
          {entries.data.map((e) => {
            const out = e.direction === 'out'
            return (
              <li key={e.id} className="flex flex-col gap-0.5 px-3 py-2">
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
                  {out && e.status !== 'sent' && e.status !== 'delivered' && ` · ${e.status}`}
                </span>
                {(!out || e.thread) && (
                  <span className="truncate text-xs">
                    {!out && destination(e)}
                    {e.thread && (
                      <>
                        {!out && ' · '}
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
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function AgentArrival({
  mailbox: m,
  onTurnedOff,
}: {
  mailbox: MailboxDetail
  onTurnedOff: () => void
}) {
  const off = useAction()
  return (
    <div className="flex flex-col gap-2 text-sm">
      <Address value={m.address} />
      <p className="text-muted-foreground">
        Mail to it reaches {m.teammate?.name ?? 'its agent'}: replies to what it sent, codes from
        services it signed up to, and what members write to it.
      </p>
      {m.manages && m.teammate && (
        <div className="flex items-center gap-3">
          <Button
            variant="danger"
            size="sm"
            disabled={off.busy}
            onClick={() =>
              confirm("Mail to it will no longer arrive. The name stays this agent's.") &&
              void off
                .run(() => api(`/email/agents/${m.teammate!.id}`, { method: 'DELETE' }))
                .then((done) => done !== undefined && onTurnedOff())
            }
          >
            Turn off
          </Button>
          <ErrorLine error={off.error} />
        </div>
      )}
    </div>
  )
}

function GmailArrival({
  mailbox: m,
  reload,
}: {
  mailbox: MailboxDetail
  reload: () => Promise<unknown>
}) {
  const save = useAction()
  const shared = m.reach === 'workspace'
  return (
    <div className="flex flex-col gap-3 text-sm">
      <Address value={m.address} />
      <p className="text-muted-foreground">
        {shared
          ? 'A Gmail account shared with every thread.'
          : 'Your own Gmail account: its mail is never shown to anyone else.'}{' '}
        Brigade keeps the mail its rules and playbooks take; the rest stays in Gmail.
      </p>
      <label className="flex items-start gap-2">
        <Checkbox
          checked={m.showAll}
          disabled={!(m.manages || m.accountOwner) || !shared || save.busy}
          onCheckedChange={(checked) =>
            void save
              .run(() =>
                api(`/connections/${m.connectionId}`, {
                  method: 'PATCH',
                  body: { inbox: checked === true },
                }),
              )
              .then(() => reload())
          }
          className="mt-0.5"
        />
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">Show all its mail in the Inbox</span>
          <span className="text-muted-foreground">
            {shared
              ? 'For everyone in the workspace, not only what its rules take.'
              : 'Share it with every thread first, in Settings › Apps.'}
          </span>
        </span>
      </label>
      <ErrorLine error={save.error} />
      <Link href="/app/connections" className="w-fit font-medium text-primary hover:underline">
        Manage the account in Settings › Apps
      </Link>
    </div>
  )
}

/** Its rules and playbooks in the order they apply, then what happens to the rest. */
function MailboxRules({
  mailbox: m,
  reload,
}: {
  mailbox: MailboxDetail
  reload: () => Promise<unknown>
}) {
  const [rules, setRules] = useState<MailboxRule[]>(m.rules)
  const order = useAction()
  const [adding, setAdding] = useState(false)
  // A reload brings the server's order back.
  const shown = order.busy ? rules : m.rules

  async function move(index: number, by: -1 | 1) {
    const next = [...shown]
    const [moved] = next.splice(index, 1)
    next.splice(index + by, 0, moved!)
    setRules(next)
    const done = await order.run(() =>
      api('/email/rules/order', { method: 'PUT', body: { triggerIds: next.map((r) => r.id) } }),
    )
    if (done) await reload()
  }

  async function remove(rule: MailboxRule) {
    if (!confirm(`Delete the rule "${rule.label}"? Mail it took then goes to the next one.`)) return
    const done = await order.run(() => api(`/triggers/${rule.id}`, { method: 'DELETE' }))
    if (done !== undefined) await reload()
  }

  const rest =
    m.kind === 'gmail' && !m.showAll
      ? 'Otherwise it stays in Gmail.'
      : 'Otherwise it waits in the Inbox, unassigned, for 30 days.'

  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col divide-y rounded-md border">
        {shown.map((rule, index) => (
          <li key={rule.id} className="flex items-start gap-3 px-3 py-2 text-sm">
            <span className="w-4 flex-none text-right text-muted-foreground tabular-nums">
              {index + 1}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span>
                <span className="font-semibold">
                  {rule.playbook ? `Playbook ${rule.playbook.name}` : rule.label}
                </span>{' '}
                <span className="text-muted-foreground">→ {rule.teammate.name}</span>
                {rule.playbook && rule.playbook.status !== 'active' && (
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    ({rule.playbook.status})
                  </span>
                )}
              </span>
              <span className="text-xs text-muted-foreground">
                {m.kind === 'gmail' ? rule.options.query || 'Any mail' : rulesSummary(rule.options)}
                {rule.project && ` · ${rule.project.name}`}
              </span>
              {rule.playbook && (
                <Link
                  href={`/app/routines/playbooks/${rule.playbook.id}`}
                  className="w-fit text-xs font-medium text-primary hover:underline"
                >
                  Change it in the playbook
                </Link>
              )}
            </div>
            {m.manages && (
              <div className="flex flex-none items-center gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled={order.busy || index === 0}
                  onClick={() => void move(index, -1)}
                  aria-label={`Move "${rule.label}" up`}
                  title="Move up"
                >
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled={order.busy || index === shown.length - 1}
                  onClick={() => void move(index, 1)}
                  aria-label={`Move "${rule.label}" down`}
                  title="Move down"
                >
                  <ArrowDown />
                </Button>
                {!rule.playbook && (
                  <Button
                    type="button"
                    variant="danger"
                    size="icon-xs"
                    disabled={order.busy}
                    onClick={() => void remove(rule)}
                    aria-label={`Delete "${rule.label}"`}
                    title="Delete"
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
        <li className="px-3 py-2 text-sm text-muted-foreground">
          {shown.length > 0 ? rest : `No rule yet. ${rest}`}
        </li>
      </ol>
      <ErrorLine error={order.error} />
      <p className="text-sm text-muted-foreground">
        A reply to what a thread sent goes back to that thread first. Then each mail goes to the
        first rule that matches it.
      </p>
      {m.manages &&
        (m.kind === 'gmail' ? (
          adding ? (
            <GmailRule mailbox={m} onDone={() => setAdding(false)} reload={reload} />
          ) : (
            <div>
              <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
                Add a rule
              </Button>
            </div>
          )
        ) : (
          <AddRule
            connectionId={m.connectionId}
            projectId={m.project?.id ?? null}
            teammateId={m.teammate?.id ?? null}
            reload={reload}
          />
        ))}
    </div>
  )
}

/** A rule on a Gmail account: mail matching a Gmail search starts a thread with a teammate. */
function GmailRule({
  mailbox: m,
  onDone,
  reload,
}: {
  mailbox: MailboxDetail
  onDone: () => void
  reload: () => Promise<unknown>
}) {
  const { teammates } = useDashboard()
  const [label, setLabel] = useState('Answer')
  const [query, setQuery] = useState('')
  const [teammateId, setTeammateId] = useState(m.readers[0]?.id ?? '')
  const [projectId, setProjectId] = useState('none')
  const action = useAction()
  const choices = teammates

  async function add(event: FormEvent) {
    event.preventDefault()
    if (!teammateId || !label.trim()) return
    const made = await action.run(() =>
      api('/triggers', {
        body: {
          connectionId: m.connectionId,
          teammateId,
          event: 'email_received',
          label: label.trim(),
          options: { ...(query.trim() && { query: query.trim() }), automated: 'skip' },
          projectId: projectId === 'none' ? null : projectId,
        },
      }),
    )
    if (made === undefined) return
    onDone()
    await reload()
  }

  return (
    <form
      onSubmit={(e) => void add(e)}
      className="flex flex-col gap-3 rounded-lg border bg-muted/50 p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="gmail-rule-label">Label</Label>
          <Input
            id="gmail-rule-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={80}
            required
            className="bg-card"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="gmail-rule-teammate">Teammate</Label>
          <Select value={teammateId} onValueChange={setTeammateId}>
            <SelectTrigger id="gmail-rule-teammate" className="w-full bg-card">
              <SelectValue placeholder="Pick a teammate" />
            </SelectTrigger>
            <SelectContent>
              {choices.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="gmail-rule-query">Only mail matching (a Gmail search)</Label>
          <Input
            id="gmail-rule-query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="to:support@yourcompany.com"
            className="bg-card font-mono"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="gmail-rule-project">Project</Label>
          <ProjectSelect id="gmail-rule-project" value={projectId} onChange={setProjectId} />
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Automatic mail (newsletters, notifications) is left out.
      </p>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={action.busy || !teammateId || !label.trim()}>
          Add rule
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <ErrorLine error={action.error} />
      </div>
    </form>
  )
}

/** A project's mailboxes, in its settings: links to their pages, where they are set up. */
export function ProjectMailboxes({ projectId }: { projectId: string }) {
  const list = useApi<MailboxSummary[]>('/inbox/mailboxes', ['mail.updated'])
  const mine = (list.data ?? []).filter((m) => m.project?.id === projectId)
  if (!list.data) return null
  return (
    <Card className="gap-3 px-6 py-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-bold">Email</h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          The project&apos;s mailboxes, such as one for support. They are set up in Inbox ›
          Mailboxes.
        </p>
      </div>
      {mine.length > 0 && (
        <ul className="flex flex-col divide-y rounded-md border">
          {mine.map((m) => (
            <li key={m.id}>
              <Link
                href={mailboxPath(m.id)}
                className="flex flex-col gap-0.5 px-3 py-2 text-sm hover:bg-secondary/50"
              >
                <span className="font-semibold">{m.name}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {m.publicAddress ?? m.address}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button asChild variant="outline" size="sm">
          <Link href={mine.length ? '/app/inbox/mailboxes' : '/app/inbox/mailboxes?add=shared'}>
            {mine.length ? 'Mailboxes' : 'Add a mailbox'}
          </Link>
        </Button>
      </div>
    </Card>
  )
}
