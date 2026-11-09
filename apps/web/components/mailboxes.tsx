'use client'
// Inbox › Mailboxes: whatever receives mail for the workspace, in one place. The list (agents',
// shared, connected Gmail), Add a mailbox (an address on a domain, for an agent or a project), and
// each mailbox's page: where its mail arrives and how it goes out, who handles it (its rules and
// playbooks, in the order they apply), who reads and replies from it. Domains: mail-domains.tsx.
import type {
  MailboxDetail,
  MailboxRule,
  MailboxSummary,
  MailDomainView,
  MailForwarding,
  MailProvider,
} from '@brigade/contracts'
import { ArrowDown, ArrowLeft, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState, type FormEvent, type ReactNode } from 'react'
import { useDashboard } from '@/components/dashboard'
import { MailSettingsHeader } from '@/components/mail-domains'
import {
  AddRule,
  Address,
  Dot,
  ErrorLine,
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
  agent: "An agent's",
  inbox: 'Shared',
  gmail: 'Connected Gmail',
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

const GROUPS: { kind: MailboxSummary['kind']; title: string }[] = [
  { kind: 'agent', title: 'Agents' },
  { kind: 'inbox', title: 'Shared' },
  { kind: 'gmail', title: 'Connected Gmail' },
]

export function MailboxesView() {
  const params = useSearchParams()
  const list = useApi<MailboxSummary[]>('/inbox/mailboxes', ['mail.updated', 'connections.updated'])
  const [adding, setAdding] = useState(params.get('add') !== null)

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6 md:px-6">
      <MailSettingsHeader
        tab="mailboxes"
        action={
          !adding && (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus />
              Add a mailbox
            </Button>
          )
        }
      />

      {adding && (
        <AddMailbox
          owner={params.get('add') === 'shared' ? 'project' : 'agent'}
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
            No mailbox yet. Give an agent an address, or a project a shared one such as support@, or
            connect a Gmail account in Settings › Apps.
          </p>
        </Card>
      ) : (
        GROUPS.map(({ kind, title }) => {
          const mailboxes = list.data!.filter((m) => m.kind === kind)
          if (mailboxes.length === 0) return null
          return (
            <section key={kind} className="flex flex-col gap-2">
              <h2 className="px-1 text-sm font-medium text-muted-foreground">{title}</h2>
              <Card className="gap-0 divide-y py-0">
                {mailboxes.map((m) => (
                  <MailboxRow key={m.id} mailbox={m} />
                ))}
              </Card>
            </section>
          )
        })
      )}
    </div>
  )
}

function MailboxRow({ mailbox: m }: { mailbox: MailboxSummary }) {
  const waiting = m.domain && m.domain.status !== 'verified'
  return (
    <Link
      href={mailboxPath(m.id)}
      className="flex items-start gap-3 px-4 py-3 outline-none hover:bg-secondary/50 focus-visible:bg-secondary/50"
    >
      <MailboxIcon kind={m.kind} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-sm font-semibold">{m.name}</span>
          {m.visibility === 'you' && (
            <span className="flex-none text-xs text-muted-foreground">Only you</span>
          )}
        </div>
        <span className="truncate font-mono text-xs text-muted-foreground">{m.address}</span>
        <span className="text-xs text-muted-foreground">
          {waiting
            ? `Waiting for ${m.domain!.name}'s DNS records`
            : m.ruleCount === 0
              ? 'No rule: its mail waits for you'
              : `${m.ruleCount} ${m.ruleCount === 1 ? 'rule' : 'rules'}`}
          {m.sendPolicy === 'approve' && ' · Every email approved'}
        </span>
      </div>
    </Link>
  )
}

// ---------------------------------------------------------------------------
// Add a mailbox: an address on a domain, for an agent or a project
// ---------------------------------------------------------------------------

/** Brigade's own domain in the domain picker. */
const BRIGADE = 'brigade'

function AddMailbox({
  owner: initialOwner,
  teammateId,
  onCancel,
}: {
  owner: 'agent' | 'project'
  teammateId?: string
  onCancel: () => void
}) {
  const router = useRouter()
  const { me, teammates, projects } = useDashboard()
  const admin = isAdmin(me)
  const email = useApi<EmailState>('/email', ['mail.updated'])
  const domains = useApi<MailDomainView[]>('/email/domains', ['mail.updated'])
  const [owner, setOwner] = useState(initialOwner)
  const [domain, setDomain] = useState(BRIGADE)
  const [local, setLocal] = useState<string>()
  const state = email.data
  const taken = new Set(
    (state?.addresses ?? []).filter((a) => a.kind === 'agent' && a.on).map((a) => a.teammate?.id),
  )
  const free = teammates.filter((t) => !taken.has(t.id))
  const [picked, setAgentId] = useState(teammateId ?? '')
  // The agents with a mailbox are known once the state loads: one of theirs is never picked.
  const agentId = free.some((t) => t.id === picked) ? picked : (free[0]?.id ?? '')
  const [projectId, setProjectId] = useState(projects.find((p) => !p.archivedAt)?.id ?? '')
  const agent = owner === 'agent' && agentId ? agentId : null
  // An agent's name on Brigade's domain: its own, or the one kept for it.
  const suggestion = useApi<{ name: string; kept: boolean }>(
    agent ? `/email/agents/${agent}/suggestion` : null,
  )
  const enable = useAction()
  const add = useAction()
  const brigade = domain === BRIGADE
  const kept = agent && brigade && suggestion.data?.kept
  const value =
    local ?? (agent ? (suggestion.data?.name ?? '') : owner === 'project' ? 'support' : '')
  const domainName = brigade ? (state?.domain ?? '') : domain

  async function create(event: FormEvent) {
    event.preventDefault()
    const name = value.trim().toLowerCase()
    if (!name) return
    const custom = brigade ? undefined : `${name}@${domain}`
    const made = await add.run(() =>
      owner === 'agent'
        ? api<{ id: string }>(`/email/agents/${agentId}`, {
            method: 'POST',
            body: custom ? { address: custom } : kept ? {} : { name },
          })
        : api<{ id: string }>('/email/inboxes', {
            body: {
              projectId,
              label: (name.charAt(0).toUpperCase() + name.slice(1)).slice(0, 40),
              ...(custom && { publicAddress: custom }),
            },
          }),
    )
    if (made) router.push(mailboxPath(`email:${made.id}`))
  }

  if (state && !state.available)
    return (
      <Card className="px-5 py-5 text-sm text-muted-foreground">
        {state.unavailable ?? 'Brigade addresses are not available on this server.'}
      </Card>
    )

  return (
    <Card className="gap-4 px-5 py-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-bold">Add a mailbox</h2>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {state && !state.enabled ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted/60 px-4 py-3 text-sm">
          <span className="min-w-0 flex-[1_1_16rem]">
            Mailboxes have addresses on <span className="font-mono text-xs">{state.domain}</span>{' '}
            and on your own domains. Turn them on for the workspace first.
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
      ) : !admin ? (
        <p className="text-sm text-muted-foreground">An owner or admin adds mailboxes.</p>
      ) : (
        <form onSubmit={(e) => void create(e)} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>For</Label>
            <div className="flex flex-wrap items-center gap-2">
              <div
                role="radiogroup"
                aria-label="Whose mailbox"
                className="flex rounded-md border p-0.5"
              >
                {(
                  [
                    ['agent', 'An agent'],
                    ['project', 'A project, shared'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={owner === id}
                    onClick={() => {
                      setOwner(id)
                      setLocal(undefined)
                    }}
                    className="rounded px-3 py-1 text-sm aria-checked:bg-secondary aria-checked:font-medium"
                  >
                    {label}
                  </button>
                ))}
              </div>
              {owner === 'agent' ? (
                free.length === 0 ? (
                  <span className="text-sm text-muted-foreground">
                    Every agent has a mailbox already.
                  </span>
                ) : (
                  <Select
                    value={agentId}
                    onValueChange={(v) => {
                      setAgentId(v)
                      setLocal(undefined)
                    }}
                  >
                    <SelectTrigger aria-label="Agent" className="w-48">
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
                )
              ) : (
                <ProjectSelect
                  value={projectId}
                  onChange={setProjectId}
                  none={false}
                  className="w-48"
                />
              )}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="mailbox-local">Address</Label>
            <div className="flex flex-wrap items-center gap-1">
              <Input
                id="mailbox-local"
                value={value}
                onChange={(e) => setLocal(e.target.value)}
                disabled={!!kept}
                className="w-44 font-mono"
                maxLength={64}
                required
              />
              <span className="font-mono text-sm text-muted-foreground">@</span>
              <Select
                value={domain}
                onValueChange={(v) => {
                  setDomain(v)
                  setLocal(undefined)
                }}
              >
                <SelectTrigger aria-label="Domain" className="w-56 font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={BRIGADE}>{state?.domain ?? 'Brigade'}</SelectItem>
                  {(domains.data ?? []).map((d) => (
                    <SelectItem key={d.id} value={d.name}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              {kept
                ? 'Its address before, kept for it: no one else gets it.'
                : brigade && owner === 'project'
                  ? `On ${domainName}, a shared mailbox gets a name of its own made from this one, such as support-askli-7f3k.`
                  : brigade
                    ? `Unique across Brigade; it stays this agent's for good.`
                    : domains.data?.find((d) => d.name === domain)?.receiving === 'forward'
                      ? `${domain}'s mail stays with its provider: the mailbox's page says where to forward ${value || 'it'}@${domain}.`
                      : `Mail to it arrives directly once ${domain}'s DNS records are in.`}{' '}
              <Link href="/app/inbox/domains" className="font-medium text-primary hover:underline">
                Your domains
              </Link>
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              type="submit"
              size="sm"
              disabled={add.busy || !value.trim() || (owner === 'agent' ? !agentId : !projectId)}
            >
              Add mailbox
            </Button>
            <ErrorLine error={add.error} />
          </div>
          <p className="text-sm text-muted-foreground">
            A Gmail account is connected in{' '}
            <Link href="/app/connections" className="font-medium text-primary hover:underline">
              Settings › Apps
            </Link>
            ; it shows here once connected.
          </p>
        </form>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// One mailbox
// ---------------------------------------------------------------------------

/** One line of a mailbox's settings: what it is on the left, its value and controls on the right. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-2 py-4 first:pt-0 last:pb-0 sm:grid-cols-[9rem_1fr] sm:gap-4">
      <h2 className="text-sm leading-6 text-muted-foreground">{label}</h2>
      <div className="flex min-w-0 flex-col gap-2 text-sm">{children}</div>
    </div>
  )
}

export function MailboxView({ id }: { id: string }) {
  const router = useRouter()
  const mailbox = useApi<MailboxDetail>(`/inbox/mailboxes/${encodeURIComponent(id)}`, [
    'mail.updated',
    'connections.updated',
  ])
  const m = mailbox.data

  if (mailbox.error)
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 md:px-6">
        <Back href="/app/inbox/mailboxes">Mailboxes</Back>
        <p className="text-sm text-destructive-text">{mailbox.error.message}</p>
      </div>
    )
  if (!m) return <p className="px-6 py-6 text-sm text-muted-foreground">Loading…</p>

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 md:px-6">
      <Back href="/app/inbox/mailboxes">Mailboxes</Back>
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <MailboxIcon kind={m.kind} />
          <h1 className="min-w-0 text-2xl font-extrabold tracking-tight wrap-anywhere">{m.name}</h1>
        </div>
        <div className="flex flex-col gap-0.5 pl-8">
          {m.name !== m.address && <Address value={m.address} />}
          <span className="text-sm text-muted-foreground">
            {KIND[m.kind]}
            {m.visibility === 'you' && ' · Only you see it'}
          </span>
        </div>
      </header>

      <Card className="gap-0 divide-y px-5 py-5">
        <Row label="Arrives">
          {m.kind === 'gmail' ? (
            <GmailArrival mailbox={m} reload={mailbox.reload} />
          ) : (
            <MailboxArrival
              mailbox={m}
              reload={mailbox.reload}
              onTurnedOff={() => router.push('/app/inbox/mailboxes')}
            />
          )}
        </Row>
        <Row label="New mail goes to">
          <MailboxRules mailbox={m} reload={mailbox.reload} />
        </Row>
        {m.kind !== 'agent' && (
          <Row label="Access">
            {m.readers.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5">
                {m.readers.map((t) => (
                  <li key={t.id}>
                    <Link
                      href={`/app/teammates/${t.id}`}
                      className="rounded-full bg-secondary px-2.5 py-1 hover:bg-secondary/70"
                    >
                      {t.name}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-muted-foreground">No teammate yet.</span>
            )}
            <p className="text-muted-foreground">
              Can read and send from it when asked. Give it to a teammate on their page, under
              Access.
            </p>
          </Row>
        )}
        <Row label="Replies">
          <MailboxSending mailbox={m} reload={mailbox.reload} />
        </Row>
      </Card>
    </div>
  )
}

/**
 * A Brigade mailbox's way in and out: its address (changed to one on another domain), whether it
 * receives (directly, or what to forward where) and sends (as its address only, once its domain's
 * records are in), a test mail, and Turn off.
 */
function MailboxArrival({
  mailbox: m,
  reload,
  onTurnedOff,
}: {
  mailbox: MailboxDetail
  reload: () => Promise<unknown>
  onTurnedOff: () => void
}) {
  const email = useApi<EmailState>('/email')
  const domains = useApi<MailDomainView[]>(m.manages ? '/email/domains' : null, ['mail.updated'])
  const journal = useApi<MailJournalEntry[]>(`/email/addresses/${m.addressId}/journal?limit=20`, [
    'mail.updated',
  ])
  const forward = m.domain?.receiving === 'forward'
  const forwarding = useApi<MailForwarding>(
    m.manages && forward ? `/email/addresses/${m.addressId}/forwarding` : null,
  )
  const [changing, setChanging] = useState(false)
  const [note, setNote] = useState<string>()
  // The last test's time, and whether it has had a minute to come through the forward.
  const [testAt, setTestAt] = useState<number>()
  const [late, setLate] = useState(false)
  // At Google, what the address is: the steps differ for a group and a user's own mailbox.
  const [kind, setKind] = useState<GoogleKind>()
  const save = useAction()
  const test = useAction()
  const off = useAction()
  const verified = !m.domain || m.domain.status === 'verified'
  const forwarded = (journal.data ?? []).some(
    (e) =>
      e.direction === 'in' &&
      e.route === 'test' &&
      e.to.some((to) => to.toLowerCase().includes(m.address)),
  )
  const arrived =
    testAt !== undefined &&
    (journal.data ?? []).some(
      (e) =>
        e.direction === 'in' &&
        e.route === 'test' &&
        new Date(e.at).getTime() >= testAt - 60_000 &&
        e.to.some((to) => to.toLowerCase().includes(m.address)),
    )
  const brigadeDomain = email.data?.domain ?? ''

  async function sendTest() {
    setNote(undefined)
    const done = await test.run(() =>
      api<{ sent: boolean; to: string }>(
        `/email/addresses/${m.addressId}/test${m.internalAddress ? '?public=1' : ''}`,
        { body: {} },
      ),
    )
    if (!done) return
    setNote(`Test mail sent to ${done.to}.`)
    setTestAt(Date.now())
    setLate(false)
    for (const delay of [5000, 15000, 40000, 60000])
      setTimeout(() => {
        void journal.reload()
        void forwarding.reload()
        if (delay === 60000) setLate(true)
      }, delay)
  }

  return (
    <div className="flex flex-col gap-4 text-sm">
      {m.manages && !changing && (
        <Button variant="outline" size="xs" className="w-fit" onClick={() => setChanging(true)}>
          Change address
        </Button>
      )}
      {changing && (
        <ChangeAddress
          mailbox={m}
          brigadeDomain={brigadeDomain}
          domains={domains.data ?? []}
          busy={save.busy}
          onCancel={() => setChanging(false)}
          onSave={(address) =>
            void save
              .run(() =>
                api(`/email/addresses/${m.addressId}`, { method: 'PATCH', body: { address } }),
              )
              .then(async (done) => {
                if (done === undefined) return
                setChanging(false)
                await reload()
              })
          }
        />
      )}
      <ErrorLine error={save.error} />

      <ol className="flex flex-col gap-3">
        <li className="flex items-start gap-2">
          <Dot
            tone={forward ? (forwarded ? 'success' : 'idle') : verified ? 'success' : 'idle'}
            label="Receiving"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="font-medium">
              {forward
                ? forwarded
                  ? 'Receives: a test came through the forward'
                  : 'Receives once its address is forwarded'
                : verified
                  ? 'Receives directly'
                  : `Receives once ${m.domain!.name}'s DNS records are in`}
            </span>
            {forward && m.internalAddress && (
              <>
                <ForwardingGuide
                  address={m.address}
                  internal={m.internalAddress}
                  provider={m.manages ? forwarding.data?.provider : 'other'}
                  kind={kind}
                  onKind={setKind}
                  late={m.manages && late && !arrived}
                />
                {forwarding.data?.found && (
                  <div className="flex flex-col gap-1">
                    {forwarding.data.code ? (
                      <span className="flex items-center gap-1">
                        Google&apos;s confirmation code: <Address value={forwarding.data.code} />
                      </span>
                    ) : (
                      <span>Google&apos;s confirmation mail arrived.</span>
                    )}
                    {forwarding.data.link && (
                      <a
                        href={forwarding.data.link}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="w-fit font-medium text-primary hover:underline"
                      >
                        Confirm it on Google
                      </a>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </li>
        <li className="flex items-start gap-2">
          <Dot tone={verified ? 'success' : 'idle'} label="Sending" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="font-medium">
              {verified ? `Sends as ${m.address}` : 'Sends nothing yet'}
            </span>
            {!verified && (
              <p className="text-muted-foreground">
                Its mail goes out as {m.address} only, once {m.domain!.name}&apos;s DNS records are
                in.{' '}
                <Link
                  href="/app/inbox/domains"
                  className="font-medium text-primary hover:underline"
                >
                  Its records
                </Link>
              </p>
            )}
          </div>
        </li>
      </ol>

      {m.manages && (
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <Button variant="outline" size="sm" disabled={test.busy} onClick={() => void sendTest()}>
            Send a test mail
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={off.busy}
            onClick={() =>
              confirm('Mail to it will no longer arrive, and its rules stop.') &&
              void off
                .run(() =>
                  m.kind === 'agent' && m.teammate
                    ? api(`/email/agents/${m.teammate.id}`, { method: 'DELETE' })
                    : api(`/email/inboxes/${m.addressId}`, { method: 'DELETE' }),
                )
                .then((done) => done !== undefined && onTurnedOff())
            }
          >
            Turn off
          </Button>
        </div>
      )}
      {note && (
        <p className="text-muted-foreground">
          {note} {arrived ? 'It arrived.' : late ? '' : 'Waiting for it to arrive…'}
        </p>
      )}
      <ErrorLine error={test.error ?? off.error} />
    </div>
  )
}

type GoogleKind = 'group' | 'user'

/**
 * How to forward an address on a domain receiving by forwarding to the mailbox's own address on
 * Brigade's domain, in the steps of the provider its mail is with (by its MX): at Google, for a
 * group or for a user's mailbox or alias; at Microsoft 365; or anywhere else. When a test mail
 * has not come through a minute after it was sent, what to check for that case.
 */
function ForwardingGuide({
  address,
  internal,
  provider,
  kind,
  onKind,
  late,
}: {
  address: string
  internal: string
  /** Unknown while it loads: nothing shows until it is. */
  provider?: MailProvider
  kind?: GoogleKind
  onKind: (kind: GoogleKind) => void
  late: boolean
}) {
  if (!provider) return null
  const target = <Address value={internal} />
  const steps: ReactNode[] = []
  let checks: string[] = [`${address} forwards to ${internal}.`]
  if (provider === 'google' && kind === 'group') {
    steps.push(
      <>
        In the Google Admin console, open the group {address} in{' '}
        <ExternalLink href="https://admin.google.com/ac/groups">Directory › Groups</ExternalLink>,
        then Members › Add members, and add {target}.
      </>,
      <>
        In the group&apos;s Access settings, turn on Allow members outside your organization and set
        Who can post to Anyone on the web. If it cannot be turned on, allow it for your organization
        first, in Apps › Google Workspace › Groups for Business.
      </>,
    )
    checks = [
      `${internal} is a member of the group.`,
      'The group allows members outside your organization, and so does your organization.',
      'Who can post is Anyone on the web.',
    ]
  } else if (provider === 'google' && kind === 'user') {
    steps.push(
      <>
        Sign in to Gmail as the user {address} belongs to, then in{' '}
        <ExternalLink href="https://mail.google.com/mail/u/0/#settings/fwdandpop">
          Settings › Forwarding and POP/IMAP
        </ExternalLink>
        , Add a forwarding address: {target}.
      </>,
      <>
        Google sends a confirmation code to that address: it shows here once it arrives. Enter it in
        Gmail, or confirm it on Google.
      </>,
      <>
        Forward a copy of incoming mail to it. For an alias only, make a filter instead: search to:
        {address}, then Create filter › Forward it to {internal}.
      </>,
    )
    checks = [
      'Forwarding is confirmed in Gmail, and turned on (or a filter forwards the alias).',
      `It forwards to ${internal}.`,
    ]
  } else if (provider === 'microsoft') {
    steps.push(
      <>
        In the{' '}
        <ExternalLink href="https://admin.exchange.microsoft.com">
          Exchange admin center
        </ExternalLink>
        , open {address}. For a mailbox or a shared mailbox: Mail flow settings › Email forwarding,
        forward all mail to {target}. For a distribution list or a group: add that address as a
        contact, then as a member.
      </>,
      <>
        Microsoft 365 blocks forwarding outside your organization by default: in Microsoft Defender,
        Policies › Anti-spam › the outbound policy, set Automatic forwarding rules to On.
      </>,
    )
    checks = [
      `${address} forwards to ${internal}, or has it as a member.`,
      'Automatic forwarding to outside addresses is allowed in Microsoft Defender.',
    ]
  } else if (provider === 'other') {
    steps.push(
      <>
        Where {address.split('@')[1]}&apos;s mail is, forward {address} to {target}. Or, when{' '}
        {address} is a group or a list, add that address as a member.
      </>,
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {provider === 'google' && (
        <div className="flex flex-col gap-1.5">
          <p className="text-muted-foreground">
            {address.split('@')[1]}&apos;s mail is with Google Workspace. At Google, {address} is:
          </p>
          <div role="radiogroup" aria-label="What the address is at Google" className="flex gap-1">
            {(
              [
                ['group', 'A group'],
                ['user', 'A user or an alias'],
              ] as const
            ).map(([id, label]) => (
              <Button
                key={id}
                type="button"
                role="radio"
                aria-checked={kind === id}
                variant={kind === id ? 'secondary' : 'outline'}
                size="xs"
                onClick={() => onKind(id)}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
      )}
      {provider === 'microsoft' && (
        <p className="text-muted-foreground">
          {address.split('@')[1]}&apos;s mail is with Microsoft 365.
        </p>
      )}
      {steps.length > 0 && (
        <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-muted-foreground">
          {steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
          <li>Send a test mail: Receives turns green once it comes through.</li>
        </ol>
      )}
      {late && (
        <div className="flex flex-col gap-1 rounded-lg border bg-muted/50 p-3">
          <span className="font-medium">The test mail has not come through yet. Check that:</span>
          <ul className="flex list-disc flex-col gap-0.5 pl-5 text-muted-foreground">
            {checks.map((check) => (
              <li key={check}>{check}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-primary hover:underline"
    >
      {children}
    </a>
  )
}

/** A mailbox's address moved to another domain: one of the workspace's, or Brigade's only. */
function ChangeAddress({
  mailbox: m,
  brigadeDomain,
  domains,
  busy,
  onCancel,
  onSave,
}: {
  mailbox: MailboxDetail
  brigadeDomain: string
  domains: MailDomainView[]
  busy: boolean
  onCancel: () => void
  onSave: (address: string | null) => void
}) {
  const [domain, setDomain] = useState(m.domain?.name ?? BRIGADE)
  const [local, setLocal] = useState(m.domain ? m.address.split('@')[0]! : '')
  const brigade = domain === BRIGADE
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSave(brigade ? null : `${local.trim().toLowerCase()}@${domain}`)
      }}
      className="flex flex-col gap-2 rounded-lg border bg-muted/50 p-3"
    >
      <div className="flex flex-wrap items-center gap-1">
        {brigade ? (
          <span className="font-mono text-sm">
            {(m.internalAddress ?? m.address).split('@')[0]}
          </span>
        ) : (
          <Input
            aria-label="Address"
            value={local}
            onChange={(e) => setLocal(e.target.value)}
            className="w-44 bg-card font-mono"
            required
          />
        )}
        <span className="font-mono text-sm text-muted-foreground">@</span>
        <Select value={domain} onValueChange={setDomain}>
          <SelectTrigger aria-label="Domain" className="w-56 bg-card font-mono">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={BRIGADE}>{brigadeDomain || 'Brigade'}</SelectItem>
            {domains.map((d) => (
              <SelectItem key={d.id} value={d.name}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={busy || (!brigade && !local.trim())}>
          Save
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

const SENDING: { value: MailboxDetail['sendPolicy']; label: string; detail: string }[] = [
  {
    value: 'auto',
    label: 'Teammates reply on their own',
    detail:
      'When the answer is clear. What needs your judgment (money, a promise, a complaint, a doubt) comes to your To do with their reason, unanswered.',
  },
  {
    value: 'approve',
    label: 'Approve every email',
    detail: 'Each email they write waits in your To do as a draft to approve, change or discard.',
  },
]

/**
 * How the email its teammates send goes, the same for Brigade's addresses and Gmail: on their own,
 * or each approved first. Either way it leaves 30 seconds later, and can be cancelled until then.
 */
function MailboxSending({
  mailbox: m,
  reload,
}: {
  mailbox: MailboxDetail
  reload: () => Promise<unknown>
}) {
  const save = useAction()
  const choose = (value: string) =>
    void save
      .run(() =>
        api(`/connections/${m.connectionId}`, { method: 'PATCH', body: { sendPolicy: value } }),
      )
      .then(() => reload())
  const chosen = SENDING.find((o) => o.value === m.sendPolicy)
  return (
    <>
      <Select value={m.sendPolicy} onValueChange={choose} disabled={!m.setsSending || save.busy}>
        <SelectTrigger aria-label="Replies" className="w-fit">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SENDING.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-muted-foreground">
        {chosen?.detail} Each email leaves 30 seconds after it is sent or approved, and can be
        cancelled until then.
        {!m.setsSending &&
          (m.kind === 'gmail'
            ? ' Only the member who connected it, or an owner or admin, changes this.'
            : ' Only an owner or admin changes this.')}
      </p>
      <ErrorLine error={save.error} />
    </>
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
    <>
      <p>
        {shared ? 'A Gmail account shared with every thread.' : 'Your own Gmail account.'}{' '}
        <span className="text-muted-foreground">
          Brigade keeps only the mail a rule takes; the rest stays in Gmail.
        </span>
      </p>
      {shared && (
        <label className="flex items-start gap-2">
          <Checkbox
            checked={m.showAll}
            disabled={!(m.manages || m.accountOwner) || save.busy}
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
              For everyone in the workspace, not only what its rules take.
            </span>
          </span>
        </label>
      )}
      <ErrorLine error={save.error} />
      <Link href="/app/connections" className="w-fit font-medium text-primary hover:underline">
        Manage the account in Settings › Apps
      </Link>
    </>
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
  const [editing, setEditing] = useState<string>()
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
    // The API answers 204, no body: run's result tells only whether it threw.
    const done = await order.run(async () => {
      await api(`/triggers/${rule.id}`, { method: 'DELETE' })
      return true
    })
    if (done) await reload()
  }

  const rest =
    m.kind === 'gmail' && !m.showAll
      ? 'Otherwise it stays in Gmail.'
      : 'Otherwise it waits in the Inbox, unassigned, for 30 days.'

  return (
    <>
      <ol className="flex flex-col gap-3">
        {shown.map((rule, index) =>
          editing === rule.id ? (
            <li key={rule.id} className="flex flex-col gap-2">
              {m.kind === 'gmail' ? (
                <GmailRule
                  mailbox={m}
                  rule={rule}
                  onDone={() => setEditing(undefined)}
                  reload={reload}
                />
              ) : (
                <AddRule
                  connectionId={m.connectionId}
                  projectId={m.project?.id ?? null}
                  rule={rule}
                  onClose={() => setEditing(undefined)}
                  reload={reload}
                />
              )}
            </li>
          ) : (
            <li key={rule.id} className="flex items-start gap-2.5">
              <span className="mt-0.5 flex size-5 flex-none items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground tabular-nums">
                {index + 1}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span>
                  <span className="font-medium">
                    {rule.playbook ? `Playbook ${rule.playbook.name}` : rule.label}
                  </span>{' '}
                  <span className="text-muted-foreground">→ {rule.teammate.name}</span>
                  {rule.playbook && rule.playbook.status !== 'active' && (
                    <span className="ml-1.5 rounded bg-muted px-1.5 py-px text-xs text-muted-foreground">
                      {rule.playbook.status}
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  {m.kind === 'gmail'
                    ? rule.options.query || 'Any mail'
                    : rulesSummary(rule.options)}
                  {rule.project && ` · ${rule.project.name}`}
                </span>
                {rule.playbook && (
                  <Link
                    href={`/app/playbooks/${rule.playbook.id}`}
                    className="w-fit text-xs font-medium text-primary hover:underline"
                  >
                    Change it in the playbook
                  </Link>
                )}
              </div>
              {m.manages && (shown.length > 1 || !rule.playbook) && (
                <div className="flex flex-none items-center gap-0.5">
                  {shown.length > 1 && (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        disabled={order.busy || index === 0}
                        onClick={() => void move(index, -1)}
                        aria-label={`Move "${rule.label}" up`}
                        tooltip="Move up"
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
                        tooltip="Move down"
                      >
                        <ArrowDown />
                      </Button>
                    </>
                  )}
                  {!rule.playbook && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      disabled={order.busy}
                      onClick={() => {
                        setAdding(false)
                        setEditing(rule.id)
                      }}
                      aria-label={`Edit "${rule.label}"`}
                      tooltip="Edit"
                    >
                      <Pencil />
                    </Button>
                  )}
                  {!rule.playbook && (
                    <Button
                      type="button"
                      variant="danger"
                      size="icon-xs"
                      disabled={order.busy}
                      onClick={() => void remove(rule)}
                      aria-label={`Delete "${rule.label}"`}
                      tooltip="Delete"
                    >
                      <Trash2 />
                    </Button>
                  )}
                </div>
              )}
            </li>
          ),
        )}
        <li className="flex items-start gap-2.5 text-muted-foreground">
          <span
            aria-hidden
            className="mt-0.5 flex size-5 flex-none items-center justify-center rounded-full bg-muted text-[11px]"
          >
            –
          </span>
          {shown.length > 0 ? rest : `No rule yet. ${rest}`}
        </li>
      </ol>
      <ErrorLine error={order.error} />
      {m.manages &&
        (m.kind === 'gmail' ? (
          adding ? (
            <GmailRule mailbox={m} onDone={() => setAdding(false)} reload={reload} />
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => {
                setEditing(undefined)
                setAdding(true)
              }}
            >
              <Plus />
              Add a rule
            </Button>
          )
        ) : (
          <AddRule
            connectionId={m.connectionId}
            projectId={m.project?.id ?? null}
            teammateId={m.teammate?.id ?? null}
            reload={reload}
          />
        ))}
    </>
  )
}

/**
 * A rule on a Gmail account: mail matching a Gmail search starts a thread with a teammate. Given a
 * rule, it changes that one.
 */
function GmailRule({
  mailbox: m,
  rule,
  onDone,
  reload,
}: {
  mailbox: MailboxDetail
  rule?: MailboxRule
  onDone: () => void
  reload: () => Promise<unknown>
}) {
  const { teammates } = useDashboard()
  const [label, setLabel] = useState(rule?.label ?? 'Answer')
  const [query, setQuery] = useState(rule?.options.query ?? '')
  const [teammateId, setTeammateId] = useState(rule?.teammate.id ?? m.readers[0]?.id ?? '')
  const [projectId, setProjectId] = useState(rule?.project?.id ?? 'none')
  const action = useAction()
  const choices = teammates

  async function add(event: FormEvent) {
    event.preventDefault()
    if (!teammateId || !label.trim()) return
    const fields = {
      teammateId,
      label: label.trim(),
      // A rule made before keeps how it treats automatic mail.
      options: {
        ...(query.trim() && { query: query.trim() }),
        ...(rule
          ? rule.options.automated
            ? { automated: rule.options.automated }
            : {}
          : { automated: 'skip' }),
      },
      projectId: projectId === 'none' ? null : projectId,
    }
    const made = await action.run(async () => {
      if (rule)
        await api(`/triggers/${rule.id}`, {
          method: 'PUT',
          body: { ...fields, instructions: rule.instructions },
        })
      else
        await api('/triggers', {
          body: { ...fields, connectionId: m.connectionId, event: 'email_received' },
        })
      return true
    })
    if (!made) return
    await reload()
    onDone()
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
          {rule ? 'Save' : 'Add rule'}
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
                  {m.address}
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
