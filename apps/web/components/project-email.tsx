'use client'
import { ArrowDown, ArrowUp, Check, Copy, EllipsisVertical, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { isAdmin, useDashboard } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  api,
  useApi,
  type EmailState,
  type MailAddress,
  type MailJournalEntry,
  type Trigger,
} from '@/lib/api'
import { cn } from '@/lib/utils'

/** A rule is a trigger of event email_received on the inbox's connection. */
type Rule = Trigger & { position: number }

type Forwarding =
  | { found: false }
  | { found: true; at: string; subject: string; code: string | null; link: string | null }

type PreviewResult = { id: string; from: string; subject: string; at: string; matches: boolean }

type Tone = 'success' | 'failed' | 'idle'

function Dot({ tone, label }: { tone: Tone; label?: string }) {
  return (
    <span
      className={cn(
        'mt-1.5 size-2 flex-none rounded-full',
        tone === 'success' && 'bg-success',
        tone === 'failed' && 'bg-destructive-text',
        tone === 'idle' && 'bg-muted-foreground/40',
      )}
      title={label}
      aria-label={label}
      role={label ? 'img' : undefined}
    />
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className="flex-none rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      aria-label={copied ? 'Copied' : `Copy ${text}`}
      title={copied ? 'Copied' : 'Copy'}
    >
      {copied ? (
        <Check className="size-3.5" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
    </button>
  )
}

/** An address in mono with its Copy button. */
function Address({ value }: { value: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <code className="min-w-0 font-mono text-xs break-all">{value}</code>
      <CopyButton text={value} />
    </span>
  )
}

/** One action's busy flag and error, shown inline beside it. */
function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    setBusy(true)
    setError(undefined)
    try {
      return await action()
    } catch (e) {
      setError((e as Error).message)
      return undefined
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

function ErrorLine({ error }: { error?: string }) {
  return error ? <p className="text-sm text-destructive-text">{error}</p> : null
}

const when = (iso: string) =>
  new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

/** "From @acme.com · Subject has "invoice" · Skips automatic mail · 50 threads a day max" */
function rulesSummary(options: Record<string, string>) {
  const parts: string[] = []
  if (options.from?.trim()) parts.push(`From ${options.from.trim()}`)
  if (options.subject?.trim()) parts.push(`Subject has "${options.subject.trim()}"`)
  if (parts.length === 0) parts.push('Any mail')
  if (options.automated === 'skip') parts.push('Skips automatic mail')
  parts.push(`${options.perDay?.trim() || '50'} threads a day max`)
  return parts.join(' · ')
}

/** Where a received mail went, in plain words. */
function destination(entry: MailJournalEntry) {
  if (entry.direction === 'out') return entry.status === 'sent' ? 'Sent' : `Sent · ${entry.status}`
  switch (entry.route) {
    case 'awaited':
      return 'To the thread waiting for it'
    case 'conversation':
      return "To its conversation's thread"
    case 'member':
      return "A member's request"
    case 'rule':
      return entry.rule ? `Rule "${entry.rule.label}"` : 'A rule'
    case 'box':
      return 'Left in the inbox'
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

function recordTone(status: string): Tone {
  return status === 'verified' ? 'success' : status === 'failed' ? 'failed' : 'idle'
}

/** A project's email: its agents' addresses here, its shared inboxes and who answers them. */
export function ProjectEmail({
  projectId,
  projectName,
}: {
  projectId: string
  projectName: string
}) {
  const { me } = useDashboard()
  const admin = isAdmin(me)
  const email = useApi<EmailState>('/email')
  const triggers = useApi<Rule[]>(`/triggers?project=${encodeURIComponent(projectId)}`)
  const state = email.data
  if (!state?.available) return null

  const reload = () => Promise.all([email.reload(), triggers.reload()])
  const inboxes = state.addresses.filter(
    (a) => a.kind === 'inbox' && a.project?.id === projectId && a.on,
  )
  const agents = state.addresses
    .filter((a) => a.kind === 'agent' && a.on)
    .flatMap((a) =>
      a.variants
        .filter((v) => v.projectId === projectId)
        .map((v) => ({ id: a.id, teammate: a.teammate, address: v.address })),
    )

  return (
    <Card className="gap-4 px-6 py-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-bold">Email</h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          Shared inboxes for the project, such as one for support, and which teammate answers each
          email.
        </p>
      </div>
      {!state.enabled ? (
        <p className="text-sm text-muted-foreground">
          <Link href="/app/connections" className="font-medium text-primary hover:underline">
            Turn the Email App on in Settings › Apps to give this project inboxes.
          </Link>
        </p>
      ) : (
        <>
          {agents.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">Agents' addresses in this project</h3>
              <ul className="flex flex-col gap-1">
                {agents.map((a) => (
                  <li key={a.address} className="flex flex-wrap items-center gap-2 text-sm">
                    <span>{a.teammate?.name ?? 'Agent'}</span>
                    <span className="text-muted-foreground">·</span>
                    <Address value={a.address} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {inboxes.map((inbox) => (
            <InboxBlock
              key={inbox.id}
              inbox={inbox}
              admin={admin}
              projectId={projectId}
              rules={(triggers.data ?? [])
                .filter(
                  (t) => t.connectionId === inbox.connectionId && t.event === 'email_received',
                )
                .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt))}
              setRules={(next) =>
                triggers.setData((all) =>
                  all
                    ? [...all.filter((t) => t.connectionId !== inbox.connectionId), ...next]
                    : all,
                )
              }
              reload={reload}
            />
          ))}
          {inboxes.length === 0 && !admin && (
            <p className="text-sm text-muted-foreground">No inbox yet.</p>
          )}
          {admin && <AddInbox projectId={projectId} projectName={projectName} reload={reload} />}
        </>
      )}
    </Card>
  )
}

function AddInbox({
  projectId,
  projectName,
  reload,
}: {
  projectId: string
  projectName: string
  reload: () => Promise<unknown>
}) {
  const [label, setLabel] = useState('')
  const [displayName, setDisplayName] = useState('')
  const action = useAction()

  async function add(event: FormEvent) {
    event.preventDefault()
    if (!label.trim()) return
    const made = await action.run(() =>
      api<MailAddress>('/email/inboxes', {
        body: {
          projectId,
          label: label.trim(),
          ...(displayName.trim() && { displayName: displayName.trim() }),
        },
      }),
    )
    if (!made) return
    setLabel('')
    setDisplayName('')
    await reload()
  }

  return (
    <form onSubmit={(e) => void add(e)} className="flex flex-col gap-3 rounded-lg border p-4">
      <h3 className="text-sm font-semibold">Add an inbox</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`inbox-label-${projectId}`}>Label</Label>
          <Input
            id={`inbox-label-${projectId}`}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Support"
            maxLength={40}
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`inbox-name-${projectId}`}>Display name (optional)</Label>
          <Input
            id={`inbox-name-${projectId}`}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={`${projectName} support`}
            maxLength={80}
          />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="outline" size="sm" disabled={action.busy || !label.trim()}>
          Add inbox
        </Button>
        <ErrorLine error={action.error} />
      </div>
    </form>
  )
}

function InboxBlock({
  inbox,
  admin,
  projectId,
  rules,
  setRules,
  reload,
}: {
  inbox: MailAddress
  admin: boolean
  projectId: string
  rules: Rule[]
  setRules: (rules: Rule[]) => void
  reload: () => Promise<unknown>
}) {
  const journal = useApi<MailJournalEntry[]>(`/email/addresses/${inbox.id}/journal?limit=20`)
  const forwarding = useApi<Forwarding>(
    admin && inbox.publicAddress ? `/email/addresses/${inbox.id}/forwarding` : null,
  )
  const [publicDraft, setPublicDraft] = useState(inbox.publicAddress ?? '')
  const [showMail, setShowMail] = useState(false)
  const [sent, setSent] = useState<string>()
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const off = useAction()
  const savePublic = useAction()
  const check = useAction()
  const test = useAction()
  const order = useAction()

  useEffect(() => setPublicDraft(inbox.publicAddress ?? ''), [inbox.publicAddress])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const entries = journal.data ?? []
  const publicAddress = inbox.publicAddress
  // A test mail that reached the inbox addressed to the public address came through the forward.
  const forwarded =
    !!publicAddress &&
    entries.some(
      (e) =>
        e.direction === 'in' &&
        e.route === 'test' &&
        e.to.some((to) => to.toLowerCase().includes(publicAddress.toLowerCase())),
    )
  const tested = entries.some((e) => e.direction === 'in' && e.route === 'test')
  const domain = inbox.domain
  const verified = domain?.status === 'verified'

  async function turnOff() {
    if (!confirm('Mail to it will no longer arrive, and its rules stop.')) return
    const done = await off.run(async () => {
      await api(`/email/inboxes/${inbox.id}`, { method: 'DELETE' })
      return true
    })
    if (done) await reload()
  }

  async function savePublicAddress(event: FormEvent) {
    event.preventDefault()
    const made = await savePublic.run(() =>
      api<MailAddress>(`/email/inboxes/${inbox.id}`, {
        method: 'PATCH',
        body: { publicAddress: publicDraft.trim() || null },
      }),
    )
    if (made) await reload()
  }

  async function checkDomain() {
    if (!domain) return
    const done = await check.run(() => api(`/email/domains/${domain.id}/check`, { body: {} }))
    if (done) await reload()
  }

  async function sendTest(throughForward: boolean) {
    setSent(undefined)
    const done = await test.run(() =>
      api<{ sent: boolean; to: string }>(
        `/email/addresses/${inbox.id}/test${throughForward ? '?public=1' : ''}`,
        { body: {} },
      ),
    )
    if (!done) return
    setSent(`Sent to ${done.to}. It shows under Recent mail once it arrives.`)
    for (const delay of [5000, 15000, 40000])
      timers.current.push(
        setTimeout(() => {
          void journal.reload()
          void forwarding.reload()
        }, delay),
      )
  }

  async function move(index: number, by: -1 | 1) {
    const next = [...rules]
    const [moved] = next.splice(index, 1)
    next.splice(index + by, 0, moved!)
    setRules(next.map((r, position) => ({ ...r, position })))
    const done = await order.run(() =>
      api('/email/rules/order', { method: 'PUT', body: { triggerIds: next.map((r) => r.id) } }),
    )
    if (!done) await reload()
  }

  async function removeRule(rule: Rule) {
    if (!confirm(`Delete the rule "${rule.label}"? Mail it took then goes to the next rule.`))
      return
    await order.run(() => api(`/triggers/${rule.id}`, { method: 'DELETE' }))
    await reload()
  }

  return (
    <section className="flex flex-col gap-5 rounded-lg border p-4">
      <div className="flex items-start gap-2">
        <Dot tone="success" label="Receiving mail" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-semibold">{inbox.displayName ?? inbox.name}</span>
          <Address value={inbox.address} />
        </div>
        {admin && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                className="flex-none text-muted-foreground"
                aria-label={`${inbox.address}: more`}
                title="More"
              >
                <EllipsisVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-36">
              <DropdownMenuItem variant="destructive" onSelect={() => void turnOff()}>
                Turn off
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <ErrorLine error={off.error} />

      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Customers write to</h3>
        {admin ? (
          <form onSubmit={(e) => void savePublicAddress(e)} className="flex flex-col gap-2">
            <div className="flex gap-2">
              <Input
                aria-label="Address customers write to"
                type="email"
                value={publicDraft}
                onChange={(e) => setPublicDraft(e.target.value)}
                placeholder="support@yourcompany.com"
                className="font-mono"
              />
              <Button
                type="submit"
                variant="outline"
                disabled={savePublic.busy || publicDraft.trim() === (publicAddress ?? '')}
              >
                Save
              </Button>
            </div>
            <ErrorLine error={savePublic.error} />
          </form>
        ) : (
          <p className="text-sm">
            {publicAddress ? (
              <Address value={publicAddress} />
            ) : (
              <span className="text-muted-foreground">Not set</span>
            )}
          </p>
        )}
        {!publicAddress && (
          <p className="text-sm text-muted-foreground">
            The address your customers already use, such as support@yourcompany.com: forward it
            here, and replies go out from it.
          </p>
        )}

        <ol className="flex flex-col gap-4">
          {publicAddress && (
            <li className="flex items-start gap-2">
              <Dot
                tone={forwarded ? 'success' : 'idle'}
                label={forwarded ? 'A test came through the forward' : 'No test through it yet'}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm">
                <span className="font-medium">Forward it here</span>
                <p className="text-muted-foreground">
                  In your mailbox's settings (Gmail: Settings › Forwarding and POP/IMAP › Add a
                  forwarding address), forward {publicAddress} to {inbox.address}.
                </p>
                {forwarding.data?.found && (
                  <div className="flex flex-col gap-1">
                    {forwarding.data.code ? (
                      <span className="flex items-center gap-1">
                        Google's confirmation code:{' '}
                        <code className="font-mono">{forwarding.data.code}</code>
                        <CopyButton text={forwarding.data.code} />
                      </span>
                    ) : (
                      <span>Google's confirmation mail arrived ({when(forwarding.data.at)}).</span>
                    )}
                    {forwarding.data.link && (
                      <a
                        href={forwarding.data.link}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="font-medium text-primary hover:underline"
                      >
                        Confirm it on Google
                      </a>
                    )}
                  </div>
                )}
              </div>
            </li>
          )}
          {publicAddress && (
            <li className="flex items-start gap-2">
              <Dot
                tone={verified ? 'success' : domain?.status === 'failed' ? 'failed' : 'idle'}
                label={domain?.status ?? 'pending'}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-2 text-sm">
                <span className="font-medium">Reply as {publicAddress}</span>
                {domain ? (
                  <>
                    <p className="text-muted-foreground">
                      Add these records at your DNS provider. Your domain's own SPF record does not
                      change.
                    </p>
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
                          {domain.records.map((r) => (
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
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="text-muted-foreground">
                        {verified
                          ? `${domain.name} is verified.`
                          : domain.status === 'failed'
                            ? `${domain.name} could not be verified: check the records.`
                            : `${domain.name} is waiting for its records.`}
                        {domain.checkedAt && ` Checked ${when(domain.checkedAt)}.`}
                      </span>
                      {admin && (
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          disabled={check.busy}
                          onClick={() => void checkDomain()}
                        >
                          Check now
                        </Button>
                      )}
                    </div>
                    <ErrorLine error={check.error} />
                  </>
                ) : null}
                {!verified && (
                  <p className="text-muted-foreground">
                    Until then, replies go out from {inbox.address}.
                  </p>
                )}
              </div>
            </li>
          )}
          <li className="flex items-start gap-2">
            <Dot
              tone={tested ? 'success' : 'idle'}
              label={tested ? 'A test arrived' : 'No test yet'}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-2 text-sm">
              <span className="font-medium">Send a test</span>
              {admin && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={test.busy}
                    onClick={() => void sendTest(false)}
                  >
                    To the inbox
                  </Button>
                  {publicAddress && (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={test.busy}
                      onClick={() => void sendTest(true)}
                    >
                      Through the forward
                    </Button>
                  )}
                </div>
              )}
              {sent && <p className="text-muted-foreground">{sent}</p>}
              <ErrorLine error={test.error} />
            </div>
          </li>
        </ol>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Who answers</h3>
        {rules.length > 0 ? (
          <ol className="flex flex-col divide-y rounded-md border">
            {rules.map((rule, index) => (
              <li key={rule.id} className="flex items-start gap-3 px-3 py-2 text-sm">
                <span className="w-4 flex-none text-right text-muted-foreground tabular-nums">
                  {index + 1}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span>
                    <span className="font-semibold">{rule.label}</span>{' '}
                    <span className="text-muted-foreground">→ {rule.teammate.name}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {rulesSummary(rule.options)}
                  </span>
                  {rule.instructions && (
                    <span
                      className="line-clamp-2 text-xs text-muted-foreground"
                      title={rule.instructions}
                    >
                      {rule.instructions}
                    </span>
                  )}
                </div>
                {admin && (
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
                      disabled={order.busy || index === rules.length - 1}
                      onClick={() => void move(index, 1)}
                      aria-label={`Move "${rule.label}" down`}
                      title="Move down"
                    >
                      <ArrowDown />
                    </Button>
                    <Button
                      type="button"
                      variant="danger"
                      size="icon-xs"
                      disabled={order.busy}
                      onClick={() => void removeRule(rule)}
                      aria-label={`Delete "${rule.label}"`}
                      title="Delete"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">No rule yet: no teammate answers it.</p>
        )}
        <ErrorLine error={order.error} />
        <p className="text-sm text-muted-foreground">
          Each email goes to the first rule that matches it. Mail no rule takes stays in the inbox
          for 30 days, readable by the project's agents.
        </p>
        {admin && inbox.connectionId && (
          <AddRule connectionId={inbox.connectionId} projectId={projectId} reload={reload} />
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-3"
            onClick={() => setShowMail((v) => !v)}
            aria-expanded={showMail}
          >
            {showMail ? 'Hide recent mail' : 'Show recent mail'}
          </Button>
        </div>
        {showMail &&
          (entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {journal.data ? 'No mail yet.' : (journal.error?.message ?? 'Loading…')}
            </p>
          ) : (
            <ul className="flex flex-col divide-y rounded-md border">
              {entries.map((e) => (
                <li key={e.id} className="flex flex-col gap-0.5 px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="min-w-0 truncate font-medium">
                      {e.subject || '(no subject)'}
                    </span>
                    <span className="ml-auto flex-none text-xs text-muted-foreground">
                      {when(e.at)}
                    </span>
                  </div>
                  <span className="truncate text-xs text-muted-foreground">
                    {e.direction === 'out' ? `To ${e.to.join(', ')}` : e.from}
                  </span>
                  <span className="text-xs">
                    {destination(e)}
                    {e.thread && (
                      <>
                        {' · '}
                        <Link
                          href={`/app/threads/${e.thread.id}`}
                          className="text-primary hover:underline"
                        >
                          {e.thread.title || 'Open the thread'}
                        </Link>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ))}
      </div>
    </section>
  )
}

function AddRule({
  connectionId,
  projectId,
  reload,
}: {
  connectionId: string
  projectId: string
  reload: () => Promise<unknown>
}) {
  const { teammates } = useDashboard()
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('Answer')
  const [teammateId, setTeammateId] = useState<string>()
  const [from, setFrom] = useState('')
  const [subject, setSubject] = useState('')
  const [skipAutomated, setSkipAutomated] = useState(true)
  const [perDay, setPerDay] = useState('')
  const [instructions, setInstructions] = useState('')
  const [preview, setPreview] = useState<PreviewResult[]>()
  const tryIt = useAction()
  const add = useAction()
  const id = (field: string) => `rule-${connectionId}-${field}`
  const chosen = teammateId ?? teammates[0]?.id

  const options = () =>
    Object.fromEntries(
      Object.entries({
        from: from.trim(),
        subject: subject.trim(),
        automated: skipAutomated ? 'skip' : '',
        perDay: perDay.trim(),
      }).filter(([, value]) => value),
    )

  // A preview is for the options it was tried with.
  useEffect(() => setPreview(undefined), [from, subject, skipAutomated])

  async function tryOnRecentMail() {
    const result = await tryIt.run(() =>
      api<{ results: PreviewResult[] }>('/email/rules/preview', {
        body: { connectionId, options: options(), projectId },
      }),
    )
    if (result) setPreview(result.results)
  }

  async function create(event: FormEvent) {
    event.preventDefault()
    if (!chosen || !label.trim()) return
    const made = await add.run(() =>
      api<{ id: string }>('/triggers', {
        body: {
          connectionId,
          teammateId: chosen,
          event: 'email_received',
          label: label.trim(),
          options: options(),
          projectId,
          ...(instructions.trim() && { instructions: instructions.trim() }),
        },
      }),
    )
    if (!made) return
    setOpen(false)
    setLabel('Answer')
    setFrom('')
    setSubject('')
    setSkipAutomated(true)
    setPerDay('')
    setInstructions('')
    setPreview(undefined)
    await reload()
  }

  if (!open)
    return (
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          Add a rule
        </Button>
      </div>
    )

  return (
    <form
      onSubmit={(e) => void create(e)}
      className="flex flex-col gap-3 rounded-lg border bg-muted/50 p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={id('label')}>Label</Label>
          <Input
            id={id('label')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={80}
            required
            className="bg-card"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={id('teammate')}>Teammate</Label>
          <Select value={chosen} onValueChange={setTeammateId}>
            <SelectTrigger id={id('teammate')} className="w-full bg-card">
              <SelectValue placeholder="Pick a teammate" />
            </SelectTrigger>
            <SelectContent>
              {teammates.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={id('from')}>From (optional)</Label>
          <Input
            id={id('from')}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder="@acme.com, jane@example.com"
            className="bg-card font-mono"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={id('subject')}>Subject has (optional)</Label>
          <Input
            id={id('subject')}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="invoice"
            className="bg-card"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={id('per-day')}>Threads a day</Label>
          <Input
            id={id('per-day')}
            type="number"
            min={1}
            value={perDay}
            onChange={(e) => setPerDay(e.target.value)}
            placeholder="50"
            className="bg-card"
          />
        </div>
        <div className="flex items-center gap-2 sm:pt-7">
          <Checkbox
            id={id('automated')}
            checked={skipAutomated}
            onCheckedChange={(v) => setSkipAutomated(v === true)}
          />
          <Label htmlFor={id('automated')} className="font-normal">
            Skip automatic mail
          </Label>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={id('instructions')}>Instructions (optional)</Label>
        <Textarea
          id={id('instructions')}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={3}
          maxLength={4000}
          placeholder="What the teammate does with each email"
          className="bg-card"
        />
      </div>
      {preview &&
        (preview.length === 0 ? (
          <p className="text-sm text-muted-foreground">No mail yet.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border bg-card">
            {preview.map((p) => (
              <li key={p.id} className="flex items-start gap-2 px-3 py-2 text-sm">
                <Dot tone={p.matches ? 'success' : 'idle'} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{p.subject || '(no subject)'}</span>
                  <span className="truncate text-xs text-muted-foreground">{p.from}</span>
                </div>
                <span
                  className={cn(
                    'flex-none text-xs',
                    p.matches ? 'font-medium' : 'text-muted-foreground',
                  )}
                >
                  {p.matches ? 'Would take it' : 'Would leave it'}
                </span>
              </li>
            ))}
          </ul>
        ))}
      <ErrorLine error={tryIt.error ?? add.error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={add.busy || !chosen || !label.trim()}>
          Add rule
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={tryIt.busy}
          onClick={() => void tryOnRecentMail()}
        >
          Try on recent mail
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
