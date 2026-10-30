'use client'
// Emails as people read them rather than as the teammate gets them: one a trigger received
// (the first message of its thread, or a reply in its conversation), a reply to an email
// sent from the thread or one a person handed over from the Inbox, and one a teammate asks to send (an approval's arguments). The raw
// event or arguments fold under Details.
import {
  AWAITED_EMAIL,
  AWAITED_REPLY,
  EMAIL_IN_CONVERSATION,
  mailbox,
  splitQuoted,
  type MessageAttachment,
  type TriggerEmail,
  type TriggerEventMessage,
} from '@brigade/contracts'
import { ChevronRight, Mail, Reply, Zap } from 'lucide-react'
import Link from 'next/link'
import { Fragment, useState, type ReactNode } from 'react'
import { MessageAttachments } from '@/components/attachments'
import { ProviderLogo } from '@/components/provider-logo'
import { leavingLabel, SendLaterMenu } from '@/components/send-later'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Hint } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

const json = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2)

/** A folded section at the bottom of a card: ids, the raw event or arguments. */
export function Details({
  label = 'Details',
  className,
  children,
}: {
  label?: string
  className?: string
  children: ReactNode
}) {
  return (
    <Collapsible className={className}>
      <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground">
        <ChevronRight
          aria-hidden
          className="size-3.5 transition-transform group-data-[state=open]:rotate-90"
        />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 flex flex-col gap-3">{children}</CollapsibleContent>
    </Collapsible>
  )
}

const str = (value: unknown) => (typeof value === 'string' ? value : undefined)

/** Raw JSON or text, as under a tool call. */
export function Raw({ value }: { value: unknown }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere">
      {json(value)}
    </pre>
  )
}

/** Today: its time; else its day, and its year when not this one. The full date on hover. */
function when(date: string | undefined, fallback: string) {
  const at = new Date(date ?? fallback)
  if (Number.isNaN(at.getTime())) return null
  const now = new Date()
  const label =
    at.toDateString() === now.toDateString()
      ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : at.toLocaleDateString([], {
          day: 'numeric',
          month: 'short',
          ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
        })
  return { label, title: at.toLocaleString() }
}

/** Gmail's system labels in words; its own (Label_123) are left out. */
const LABELS: Record<string, string> = {
  UNREAD: 'Unread',
  IMPORTANT: 'Important',
  STARRED: 'Starred',
  INBOX: 'Inbox',
  SPAM: 'Spam',
  CATEGORY_PERSONAL: 'Personal',
  CATEGORY_UPDATES: 'Updates',
  CATEGORY_PROMOTIONS: 'Promotions',
  CATEGORY_SOCIAL: 'Social',
  CATEGORY_FORUMS: 'Forums',
}

function Facts({ rows }: { rows: [string, ReactNode, boolean?][] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
      {rows.map(([label, value, mono]) => (
        <Fragment key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className={cn('wrap-anywhere', mono && 'font-mono')}>{value}</dd>
        </Fragment>
      ))}
    </dl>
  )
}

/** An email's own words, with what it quotes folded under a chip. */
function Body({ body, className }: { body: string; className?: string }) {
  const { text, quoted } = splitQuoted(body)
  const [open, setOpen] = useState(false)
  return (
    <div className={cn('flex flex-col items-start gap-2', className)}>
      {text && (
        <p className="w-full text-[15px] leading-relaxed whitespace-pre-wrap wrap-anywhere">
          {text}
        </p>
      )}
      {quoted &&
        (open ? (
          <p className="w-full border-l-2 pl-3 text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground wrap-anywhere">
            {quoted}
          </p>
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-full bg-secondary px-2.5 py-0.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
          >
            ··· Show quoted text
          </button>
        ))}
    </div>
  )
}

/** The email a trigger received, as a mail rather than as the teammate's prompt. */
export function ReceivedEmailCard({
  event,
  email,
  attachments,
  reply,
  handed,
}: {
  event: TriggerEventMessage
  email: TriggerEmail
  attachments: MessageAttachment[]
  /** A later email in the thread's conversation, not the one that started it. */
  reply: boolean
  /** Handed over from the Inbox: the card opens its conversation there (its item, when known). */
  handed?: { item: string | null }
}) {
  const at = when(email.date, event.received)
  // Mail the thread waited on (a reply to its email, a sign-up's code) or in a conversation it
  // handles, rather than a trigger's event.
  const awaited = [AWAITED_REPLY, AWAITED_EMAIL, EMAIL_IN_CONVERSATION].includes(event.trigger)
  const labels = email.labels.map((l) => LABELS[l]).filter(Boolean)
  const payload = (event.payload ?? {}) as { provider?: string; sender?: { kind?: string } }
  const sender = SENDERS[payload.sender?.kind ?? '']
  // A handed-over email's conversation before it, oldest first.
  const earlier = (
    Array.isArray((payload as { earlier?: unknown }).earlier)
      ? (payload as { earlier: unknown[] }).earlier
      : []
  ).flatMap((m) => {
    const r = (m ?? {}) as Record<string, unknown>
    return typeof r.from === 'string' && typeof r.body === 'string'
      ? [
          {
            from: r.from,
            body: r.body,
            at: when(str(r.date), event.received),
            sent: r.sent === true,
          },
        ]
      : []
  })
  const inbox = handed?.item ? `/app/inbox?item=${encodeURIComponent(handed.item)}` : '/app/inbox'
  // Handed over: who wrote it and its subject open its conversation in the Inbox.
  const opens = (children: ReactNode) =>
    handed ? (
      <Link href={inbox} className="rounded-md hover:opacity-80">
        {children}
      </Link>
    ) : (
      children
    )
  if (handed)
    return (
      <article className="min-w-0 overflow-hidden rounded-xl border bg-card text-sm shadow-xs">
        <Link
          href={inbox}
          className="flex items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <Mail aria-hidden className="size-3.5 flex-none" />
          <span className="min-w-0 flex-1 truncate">Handed over from the Inbox</span>
          Open conversation
          <ChevronRight aria-hidden className="size-3.5 flex-none" />
        </Link>
        <EmailBody email={email} at={at} attachments={attachments} opens={opens} />
        {earlier.length > 0 && (
          <Details
            label={`${earlier.length} earlier ${earlier.length === 1 ? 'message' : 'messages'}`}
            className="border-t px-4 py-2.5"
          >
            {earlier.map((m, i) => (
              <div key={i} className="flex flex-col gap-1 border-l-2 pl-3">
                <p className="text-xs text-muted-foreground wrap-anywhere">
                  <span className="font-semibold text-foreground">
                    {mailbox(m.from).name ?? mailbox(m.from).address}
                  </span>
                  {m.sent && ' · sent'}
                  {m.at && ` · ${m.at.label}`}
                </p>
                <Body body={m.body} className="[&>p]:text-sm" />
              </div>
            ))}
          </Details>
        )}
        <Details className="border-t px-4 py-2.5">
          <Facts
            rows={[
              ['Mailbox', event.source],
              ['Received', event.received, true],
              ...(email.id ? [['Message id', email.id, true] as [string, string, boolean]] : []),
            ]}
          />
          <Raw value={event.payload} />
        </Details>
      </article>
    )
  return (
    <article className="min-w-0 overflow-hidden rounded-xl border bg-card text-sm shadow-xs">
      <div className="flex items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
        <ProviderLogo kind={payload.provider === 'email' ? 'email' : 'gmail'} className="size-4" />
        {awaited ? (
          <>
            <span className="min-w-0 flex-1 truncate">
              {event.trigger === AWAITED_REPLY
                ? 'Reply to the email sent from this thread'
                : event.definition}
            </span>
            <Reply aria-hidden className="size-3.5 flex-none" />
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate">
              {reply ? 'Reply in this conversation' : 'New email'} ·{' '}
              <span className="font-semibold text-foreground">{event.trigger}</span>
            </span>
            <Zap aria-hidden className="size-3.5 flex-none" />
            Trigger
          </>
        )}
      </div>
      <EmailBody email={email} at={at} attachments={attachments} />
      <Details className="border-t px-4 py-2.5">
        <Facts
          rows={[
            awaited
              ? ['Mailbox', event.source]
              : ['Trigger', `${event.trigger} · ${event.definition} on ${event.source}`],
            ['Received', event.received, true],
            ...(sender ? [['Sender', sender] as [string, string]] : []),
            ...(labels.length ? [['Labels', labels.join(' · ')] as [string, string]] : []),
            ...(email.id ? [['Message id', email.id, true] as [string, string, boolean]] : []),
            ...(email.threadId
              ? [['Thread id', email.threadId, true] as [string, string, boolean]]
              : []),
          ]}
        />
        <Raw value={event.payload} />
      </Details>
    </article>
  )
}

/** Who wrote an email, to whom and when, then its subject, words and files. */
function EmailBody({
  email,
  at,
  attachments,
  opens = (children) => children,
}: {
  email: TriggerEmail
  at: ReturnType<typeof when>
  attachments: MessageAttachment[]
  /** Wraps who wrote it and its subject: a link, on a handed-over email's card. */
  opens?: (children: ReactNode) => ReactNode
}) {
  const from = mailbox(email.from)
  return (
    <div className="flex flex-col gap-2 px-4 pt-3.5 pb-3">
      {opens(
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="grid size-8 flex-none place-items-center rounded-full bg-chart-4/20 text-[13px] font-bold text-chart-4"
          >
            {(from.name ?? from.address).charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="wrap-anywhere">
              <span className="font-bold">{from.name ?? from.address}</span>
              {from.name && (
                <span className="text-xs text-muted-foreground"> &lt;{from.address}&gt;</span>
              )}
            </p>
            {email.to && (
              <p className="text-xs text-muted-foreground wrap-anywhere">
                to {email.to}
                {email.cc && ` · cc ${email.cc}`}
              </p>
            )}
          </div>
          {at && (
            <Hint label={at.title}>
              <time
                dateTime={email.date}
                className="flex-none pt-0.5 text-xs text-muted-foreground"
              >
                {at.label}
              </time>
            </Hint>
          )}
        </div>,
      )}
      <div className="flex flex-col gap-1 sm:pl-11">
        {email.subject &&
          opens(<h3 className="text-base font-bold wrap-anywhere">{email.subject}</h3>)}
        <Body body={email.body} />
        {attachments.length > 0 && (
          <MessageAttachments attachments={attachments} className="mt-1" />
        )}
      </div>
    </div>
  )
}

/** Who wrote a mail to Brigade's own addresses, as the card says it. */
const SENDERS: Record<string, string> = {
  member: 'A member of this workspace (verified by the mail server)',
  contact: 'A known contact',
  unknown: 'Someone this workspace has not exchanged mail with',
  brigade: 'One of Brigade’s own addresses',
}

const strings = (value: unknown) =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string')
      : []

export type EmailDraft = {
  from?: string
  to: string[]
  cc: string[]
  subject: string
  body: string
  replying: boolean
  files: string[]
  /** Set to leave later (the Email App's sendAt). */
  sendAt?: string
}

/** The email a tool would send (gmail_send, gmail_create_draft, Resend's send-email), if it is one. */
export function emailDraft(input: unknown): EmailDraft | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const i = input as Record<string, unknown>
  const body = typeof i.body === 'string' ? i.body : typeof i.text === 'string' ? i.text : null
  if (!strings(i.to).length || typeof i.subject !== 'string' || body === null) return null
  return {
    ...(typeof i.from === 'string' ? { from: i.from } : {}),
    to: strings(i.to),
    cc: strings(i.cc),
    subject: i.subject,
    body,
    replying:
      typeof i.replyToMessageId === 'string' ||
      typeof i.inReplyTo === 'string' ||
      typeof i.replyTo === 'string',
    files: strings(i.attachments).map((path) => path.split('/').pop() ?? path),
    ...(typeof i.sendAt === 'string' ? { sendAt: i.sendAt } : {}),
  }
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="flex min-w-0 gap-2">
      <span className="w-14 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 wrap-anywhere">{children}</span>
    </p>
  )
}

/** An email before it goes: who it goes to, its subject, its whole body and its files. */
export function EmailDraftView({
  draft,
  account,
  className,
}: {
  draft: EmailDraft
  /** The account it goes out from, when the arguments do not say. */
  account?: string
  className?: string
}) {
  const from = draft.from ?? account
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-1 rounded-lg border bg-background px-3.5 py-3 text-sm',
        className,
      )}
    >
      {from && <Line label="From">{from}</Line>}
      <Line label="To">{draft.to.join(', ')}</Line>
      {draft.cc.length > 0 && <Line label="Cc">{draft.cc.join(', ')}</Line>}
      <Line label="Subject">
        <span className="font-semibold">{draft.subject}</span>
      </Line>
      {draft.replying && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Reply aria-hidden className="size-3.5" />
          Sent as a reply, in the email&rsquo;s conversation
        </p>
      )}
      <p className="mt-1.5 max-h-96 overflow-auto border-t pt-2.5 leading-relaxed whitespace-pre-wrap wrap-anywhere">
        {draft.body}
      </p>
      {draft.files.length > 0 && <Line label="Files">{draft.files.join(', ')}</Line>}
      {draft.sendAt && <Line label="Leaves">{leavingLabel(draft.sendAt)}</Line>}
    </div>
  )
}

/**
 * What a person changed in an email's draft before approving it (the Email App's email_send):
 * its recipients and words, or only when it leaves (sendAt, ISO 8601).
 */
export type EditedEmail =
  { to: string[]; cc: string[]; subject: string; text: string } | { sendAt: string }

const list = (value: string) =>
  value
    .split(/[,;\s]+/)
    .map((a) => a.trim())
    .filter(Boolean)

/** An email's draft, changed in place before it is approved: recipients, subject and words. */
export function EmailDraftEditor({
  draft,
  onCancel,
  onSend,
}: {
  draft: EmailDraft
  onCancel: () => void
  onSend: (edited: EditedEmail) => void
}) {
  const [to, setTo] = useState(draft.to.join(', '))
  const [cc, setCc] = useState(draft.cc.join(', '))
  const [subject, setSubject] = useState(draft.subject)
  const [body, setBody] = useState(draft.body)
  const recipients = list(to)
  const row = (label: string, value: string, set: (v: string) => void) => (
    <label className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-muted-foreground">{label}</span>
      <Input
        value={value}
        onChange={(e) => set(e.target.value)}
        aria-label={label}
        className="h-8"
      />
    </label>
  )
  return (
    <form
      className="flex min-w-0 flex-col gap-2 rounded-lg border bg-background px-3.5 py-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault()
        if (!recipients.length || !body.trim()) return
        // Cc always: emptied, it removes the draft's own (the edit replaces the draft's fields).
        onSend({ to: recipients, cc: list(cc), subject, text: body })
      }}
    >
      {row('To', to, setTo)}
      {row('Cc', cc, setCc)}
      {row('Subject', subject, setSubject)}
      <Textarea
        className="min-h-40 leading-relaxed"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        aria-label="Email"
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={!recipients.length || !body.trim()}>
          Allow with these changes
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/**
 * An email waiting for approval, which the person may change before it goes: the draft, with
 * "Edit" opening it in place; approving the changes is approving the email.
 */
export function EditableEmailPreview({
  input,
  onAllow,
}: {
  input: unknown
  onAllow: (edited: EditedEmail) => void
}) {
  const draft = emailDraft(input)
  const [editing, setEditing] = useState(false)
  if (!draft) return <ToolInputPreview input={input} />
  if (editing)
    return (
      <EmailDraftEditor
        draft={draft}
        onCancel={() => setEditing(false)}
        onSend={(edited) => {
          setEditing(false)
          onAllow(edited)
        }}
      />
    )
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <EmailDraftView draft={draft} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
          Edit before allowing
        </Button>
        {/* Allowed now, it leaves then. */}
        <SendLaterMenu onPick={(sendAt) => onAllow({ sendAt })} />
      </div>
    </div>
  )
}

/** The Email App's send, whatever its name carries (email_send, or email_send_<account>). */
export const isEmailSend = (toolName: string) =>
  /^email_send(_|$)/.test(toolName.replace(/^mcp__.+?__/, ''))

/** Any other tool's arguments: one per line, text with its line breaks, an amount first. */
export function ToolArguments({ input, className }: { input: unknown; className?: string }) {
  const box = cn('min-w-0 rounded-lg border bg-background px-3.5 py-3 text-sm', className)
  if (typeof input === 'string')
    return (
      <p className={cn(box, 'max-h-60 overflow-auto whitespace-pre-wrap wrap-anywhere')}>{input}</p>
    )
  if (!input || typeof input !== 'object' || Array.isArray(input)) return <Raw value={input} />
  const entries = Object.entries(input as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => Number(b === 'amount') - Number(a === 'amount'))
  if (!entries.length) return null
  return (
    <dl className={cn(box, 'grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1')}>
      {entries.map(([key, value]) => (
        <Fragment key={key}>
          <dt className="text-muted-foreground">{key}</dt>
          <dd
            className={cn(
              'max-h-48 min-w-0 overflow-auto whitespace-pre-wrap wrap-anywhere',
              key === 'amount' && 'font-semibold tabular-nums',
              typeof value !== 'string' && 'font-mono text-xs',
            )}
          >
            {typeof value === 'string'
              ? value
              : Array.isArray(value) && value.every((v) => typeof v === 'string')
                ? value.join(', ')
                : JSON.stringify(value, null, 2)}
          </dd>
        </Fragment>
      ))}
    </dl>
  )
}

/** A tool's arguments as people read them, the raw JSON under Details. */
export function ToolInputPreview({ input, account }: { input: unknown; account?: string }) {
  const draft = emailDraft(input)
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {draft ? <EmailDraftView draft={draft} account={account} /> : <ToolArguments input={input} />}
      {typeof input !== 'string' && (
        <Details label="Raw arguments">
          <Raw value={input} />
        </Details>
      )}
    </div>
  )
}
