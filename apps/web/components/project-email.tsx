'use client'
// A Brigade mailbox's pieces for its page (components/mailboxes.tsx): where a project's shared
// mailbox gets its mail (forwarding, domain, a test), and a rule to add on a mailbox.
import { Check, Copy, EllipsisVertical } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useDashboard } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
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
import { api, useApi, type MailAddress, type MailJournalEntry } from '@/lib/api'
import { cn } from '@/lib/utils'

type Forwarding =
  | { found: false }
  | { found: true; at: string; subject: string; code: string | null; link: string | null }

type PreviewResult = { id: string; from: string; subject: string; at: string; matches: boolean }

type Tone = 'success' | 'failed' | 'idle'

export function Dot({ tone, label }: { tone: Tone; label?: string }) {
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

export function CopyButton({ text }: { text: string }) {
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
export function Address({ value }: { value: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <code className="min-w-0 font-mono text-xs break-all">{value}</code>
      <CopyButton text={value} />
    </span>
  )
}

/** One action's busy flag and error, shown inline beside it. */
export function useAction() {
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

export function ErrorLine({ error }: { error?: string }) {
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
export function rulesSummary(options: Record<string, string>) {
  const parts: string[] = []
  if (options.from?.trim()) parts.push(`From ${options.from.trim()}`)
  if (options.subject?.trim()) parts.push(`Subject has "${options.subject.trim()}"`)
  if (parts.length === 0) parts.push('Any mail')
  if (options.automated === 'skip') parts.push('Skips automatic mail')
  parts.push(`${options.perDay?.trim() || '50'} threads a day max`)
  return parts.join(' · ')
}

function recordTone(status: string): Tone {
  return status === 'verified' ? 'success' : status === 'failed' ? 'failed' : 'idle'
}

/**
 * Where a project's shared mailbox gets its mail: its own address, the one customers write to
 * forwarded to it (with Google's confirmation code), the domain its replies go out from, a test.
 */
export function InboxArrival({
  inbox,
  admin,
  reload,
  onTurnedOff,
}: {
  inbox: MailAddress
  admin: boolean
  reload: () => Promise<unknown>
  onTurnedOff?: () => void
}) {
  const journal = useApi<MailJournalEntry[]>(`/email/addresses/${inbox.id}/journal?limit=20`, [
    'mail.updated',
  ])
  const forwarding = useApi<Forwarding>(
    admin && inbox.publicAddress ? `/email/addresses/${inbox.id}/forwarding` : null,
  )
  const [publicDraft, setPublicDraft] = useState(inbox.publicAddress ?? '')
  const [sent, setSent] = useState<string>()
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const off = useAction()
  const savePublic = useAction()
  const check = useAction()
  const test = useAction()

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
    if (done) {
      onTurnedOff?.()
      await reload()
    }
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
    setSent(`Sent to ${done.to}. It shows in the Inbox once it arrives.`)
    for (const delay of [5000, 15000, 40000])
      timers.current.push(
        setTimeout(() => {
          void journal.reload()
          void forwarding.reload()
        }, delay),
      )
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
                    To the mailbox
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
    </section>
  )
}

/** A rule on a Brigade mailbox: from its page, and from the Inbox for an unassigned mail. */
export function AddRule({
  connectionId,
  projectId,
  teammateId: initialTeammate,
  reload,
  onClose,
}: {
  connectionId: string
  /** The project variant of the address it is for; null: the address without a project. */
  projectId: string | null
  /** The teammate it starts threads with, first picked (an agent's address: that agent). */
  teammateId?: string | null
  reload: () => Promise<unknown>
  /** Opened by its caller's own button: the form shows at once, and closing it calls this. */
  onClose?: () => void
}) {
  const { teammates } = useDashboard()
  const [open, setOpenState] = useState(!!onClose)
  const setOpen = (value: boolean) => {
    setOpenState(value)
    if (!value) onClose?.()
  }
  const [label, setLabel] = useState('Answer')
  const [teammateId, setTeammateId] = useState<string | undefined>(initialTeammate ?? undefined)
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
