'use client'
// A Brigade mailbox's pieces for its page (components/mailboxes.tsx): where a project's shared
// mailbox gets its mail (forwarding, domain, a test), and a rule to add on a mailbox.
import { Check, Copy } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useDashboard } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
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
import { Textarea } from '@/components/ui/textarea'
import { api, useApi } from '@/lib/api'
import { cn } from '@/lib/utils'

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
