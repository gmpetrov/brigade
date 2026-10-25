'use client'
// The Inbox: every email the workspace's mailboxes received (Brigade's own addresses and
// connected Gmail accounts), one row per conversation, with where it went; read one, mark it
// done or hand it to a teammate. Filters and the open email live in the address, so links and back work.
import type {
  InboxDetail,
  InboxItem,
  InboxMessage,
  InboxSourceView,
  InboxStatus,
} from '@brigade/contracts'
import {
  ArrowLeft,
  Check,
  FileText,
  Mail,
  Search,
  ShieldAlert,
  ShieldCheck,
  Undo2,
} from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { fileSize, type Media, MediaPreview, mediaKind, Thumbnail } from '@/components/attachments'
import { timeAgo, useDashboard } from '@/components/dashboard'
import { AddRule } from '@/components/project-email'
import { ProjectSelect } from '@/components/projects'
import { ProviderLogo } from '@/components/provider-logo'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { api, ApiError, attachmentUrl, useApi } from '@/lib/api'
import { API_URL } from '@/lib/config'
import { cn } from '@/lib/utils'

type InboxList = { items: InboxItem[]; sources: InboxSourceView[]; next: string | null }
type StatusFilter = InboxStatus | 'all'
type Param = 'status' | 'source' | 'teammate' | 'project' | 'q' | 'item'

const STATUSES: { value: StatusFilter; label: string }[] = [
  { value: 'waiting', label: 'Unassigned' },
  { value: 'handled', label: 'Assigned' },
  { value: 'done', label: 'Done' },
  { value: 'all', label: 'All' },
]

const ALL = '*'
const SIGN_UP = 'Mail to a sign-up address'

const message = (e: unknown) =>
  e instanceof ApiError || e instanceof Error ? e.message : String(e)
const itemPath = (id: string) => `/inbox/items/${encodeURIComponent(id)}`
/** A mail's file: a received one from its mailbox (through the Inbox), a sent one as Brigade keeps it. */
const fileUrl = (m: InboxMessage, fileId: string) =>
  m.direction === 'out'
    ? attachmentUrl(fileId)
    : `${API_URL}/api${itemPath(m.id)}/files/${encodeURIComponent(fileId)}`

/** Where an email went, in plain words. */
export function destination(item: InboxItem): string {
  switch (item.route) {
    case 'awaited':
      return 'Thread waiting for it'
    case 'conversation':
      return "Its conversation's thread"
    case 'member':
      return 'A member’s request'
    case 'rule':
      return item.rule ? `Rule "${item.rule.label}"` : 'A rule'
    case 'handed':
      return 'Handed over'
    case 'box':
      return 'In the mailbox'
    case 'cap':
      return 'Rule over its daily limit'
    case 'loop':
      return 'Stopped: looks like a loop'
    case 'duplicate':
      return 'Already delivered'
    case 'own_copy':
      return 'Sent from the mailbox'
    case 'bounce':
      return 'Delivery failure'
    case 'test':
      return 'Test mail'
    default:
      return item.thread ? 'Handled by a thread' : 'Unassigned'
  }
}

function DestinationChip({ item, className }: { item: InboxItem; className?: string }) {
  const trouble = item.route === 'cap' || item.route === 'loop' || item.route === 'bounce'
  return (
    <span
      className={cn(
        'inline-flex max-w-full min-w-0 items-center rounded-full px-2 py-0.5 text-xs font-medium',
        trouble ? 'bg-warning/15 text-warning' : 'bg-secondary text-muted-foreground',
        className,
      )}
    >
      <span className="truncate">{destination(item)}</span>
    </span>
  )
}

/** The page: filters, the list and the open email beside it (in its place on a phone). */
export function InboxView() {
  const params = useSearchParams()
  const router = useRouter()
  const { teammates, reloadInboxCount } = useDashboard()
  const status = (STATUSES.find((s) => s.value === params.get('status'))?.value ??
    'waiting') as StatusFilter
  const source = params.get('source') ?? ''
  const teammate = params.get('teammate') ?? ''
  const project = params.get('project') ?? ''
  const q = params.get('q') ?? ''
  const item = params.get('item') ?? ''

  const href = useCallback(
    (patch: Partial<Record<Param, string | null>>) => {
      const next = new URLSearchParams(params.toString())
      for (const [key, value] of Object.entries(patch))
        if (value) next.set(key, value)
        else next.delete(key)
      const query = next.toString()
      return query ? `/app/inbox?${query}` : '/app/inbox'
    },
    [params],
  )
  const go = (patch: Partial<Record<Param, string | null>>) =>
    router.push(href(patch), { scroll: false })

  // The search box: sent ~300 ms after the last key, and following back and forward.
  const [query, setQuery] = useState(q)
  const written = useRef(q)
  useEffect(() => {
    if (q === written.current) return
    written.current = q
    setQuery(q)
  }, [q])
  useEffect(() => {
    if (query.trim() === q) return
    const timer = window.setTimeout(() => {
      written.current = query.trim()
      router.replace(href({ q: query.trim() || null }), { scroll: false })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [query, q, href, router])

  const search = new URLSearchParams({ status })
  if (source) search.set('source', source)
  if (teammate) search.set('teammate', teammate)
  if (project) search.set('project', project)
  if (q) search.set('q', q)
  const path = `/inbox?${search}`
  const list = useApi<InboxList>(path)
  const reloadList = list.reload

  // Older pages, appended below the first: kept for the filters they were asked with.
  const [older, setOlder] = useState<{ path: string; items: InboxItem[]; next: string | null }>()
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState<string>()
  const more = older?.path === path ? older : undefined
  const seen = new Set<string>()
  const items = [...(list.data?.items ?? []), ...(more?.items ?? [])].filter(
    (i) => !seen.has(i.id) && !!seen.add(i.id),
  )
  const next = more ? more.next : (list.data?.next ?? null)

  async function loadOlder() {
    if (!next) return
    setLoadingOlder(true)
    setOlderError(undefined)
    try {
      const page = await api<InboxList>(`${path}&before=${encodeURIComponent(next)}`)
      setOlder({ path, items: [...(more?.items ?? []), ...page.items], next: page.next })
    } catch (e) {
      setOlderError(message(e))
    } finally {
      setLoadingOlder(false)
    }
  }

  const refresh = useCallback(async () => {
    setOlder(undefined)
    await Promise.all([reloadList(), reloadInboxCount()])
  }, [reloadList, reloadInboxCount])

  const sources = list.data?.sources ?? []
  const brigade = sources.filter((s) => s.kind === 'email')
  const gmail = sources.filter((s) => s.kind === 'gmail')

  return (
    <div className="flex flex-col gap-6">
      <header className={cn('flex flex-col gap-1', item && 'hidden lg:flex')}>
        <h1 className="text-3xl font-extrabold tracking-tight">Inbox</h1>
        <p className="max-w-prose text-muted-foreground">
          Every email your mailboxes received, and where it went.
        </p>
      </header>

      <div className={cn('flex flex-col gap-3', item && 'hidden lg:flex')}>
        <div className="flex flex-wrap items-center gap-3">
          <div role="group" aria-label="Status" className="flex flex-wrap gap-2">
            {STATUSES.map((s) => (
              <button
                key={s.value}
                type="button"
                aria-pressed={status === s.value}
                onClick={() => go({ status: s.value === 'waiting' ? null : s.value })}
                className={cn(
                  'inline-flex h-8 items-center rounded-full border px-3.5 text-sm font-semibold transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  status === s.value
                    ? 'border-transparent bg-foreground text-background'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="relative min-w-48 flex-1">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              aria-label="Search"
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Select value={source || ALL} onValueChange={(v) => go({ source: v === ALL ? null : v })}>
            <SelectTrigger aria-label="Source" className="w-full sm:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All sources</SelectItem>
              {brigade.length > 0 && (
                <>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Brigade addresses</SelectLabel>
                    {brigade.map((s) => (
                      <SourceItem key={s.id} source={s} />
                    ))}
                  </SelectGroup>
                </>
              )}
              {gmail.length > 0 && (
                <>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Gmail</SelectLabel>
                    {gmail.map((s) => (
                      <SourceItem key={s.id} source={s} />
                    ))}
                  </SelectGroup>
                </>
              )}
            </SelectContent>
          </Select>
          {teammates.length > 0 && (
            <Select
              value={teammate || ALL}
              onValueChange={(v) => go({ teammate: v === ALL ? null : v })}
            >
              <SelectTrigger aria-label="Agent" className="w-full sm:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All agents</SelectItem>
                <SelectSeparator />
                {teammates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <ProjectSelect
            value={project}
            onChange={(v) => go({ project: v || null })}
            all
            none={false}
            className="sm:w-48"
          />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start">
        <section
          aria-label="Emails"
          className={cn('flex min-w-0 flex-col gap-3', item && 'hidden lg:flex')}
        >
          {list.error && <p className="text-sm text-destructive-text">{list.error.message}</p>}
          {!list.data && !list.error ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : list.data && items.length === 0 ? (
            <section className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card px-6 py-16 text-center">
              <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/15 text-primary">
                <Mail className="size-6" aria-hidden />
              </span>
              <p className="max-w-md text-sm text-muted-foreground">
                {status === 'waiting'
                  ? 'Nothing unassigned. Every email went somewhere.'
                  : 'No email here.'}
              </p>
            </section>
          ) : (
            items.length > 0 && (
              <Card className="gap-0 overflow-hidden py-0">
                <ul className="divide-y">
                  {items.map((i) => (
                    <li key={i.id}>
                      <Row item={i} href={href({ item: i.id })} selected={i.id === item} />
                    </li>
                  ))}
                </ul>
              </Card>
            )
          )}
          {olderError && <p className="text-sm text-destructive-text">{olderError}</p>}
          {next && (
            <Button
              variant="outline"
              className="self-center"
              disabled={loadingOlder}
              onClick={() => void loadOlder()}
            >
              {loadingOlder ? 'Loading…' : 'Load older'}
            </Button>
          )}
        </section>

        <section
          aria-label="Email"
          className={cn(
            'min-w-0 flex-col gap-3 lg:sticky lg:top-6 lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto',
            item ? 'flex' : 'hidden lg:flex',
          )}
        >
          {item ? (
            <>
              <Button asChild variant="ghost" size="sm" className="self-start lg:hidden">
                <Link href={href({ item: null })} scroll={false}>
                  <ArrowLeft /> Back
                </Link>
              </Button>
              <Reader key={item} id={item} onChanged={refresh} />
            </>
          ) : (
            <p className="rounded-xl border border-dashed px-6 py-16 text-center text-sm text-muted-foreground">
              Pick an email to read it.
            </p>
          )}
        </section>
      </div>
    </div>
  )
}

function SourceItem({ source }: { source: InboxSourceView }) {
  return (
    <SelectItem value={source.id}>
      <span className="truncate">{source.label}</span>
      <span className="truncate text-xs text-muted-foreground">{source.address}</span>
    </SelectItem>
  )
}

function Row({ item, href, selected }: { item: InboxItem; href: string; selected: boolean }) {
  const waiting = item.status === 'waiting'
  const who = [item.teammate?.name, item.project?.name].filter(Boolean).join(' · ')
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex gap-3 px-4 py-3 outline-none hover:bg-secondary/50 focus-visible:bg-secondary/50',
        selected && 'bg-secondary hover:bg-secondary',
      )}
    >
      <span className="flex w-2 flex-none justify-center pt-1.5" aria-hidden>
        {waiting && <span className="size-2 rounded-full bg-primary" />}
      </span>
      <ProviderLogo kind={item.source.kind} className="mt-0.5 size-4 flex-none" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm">
            {item.fromName || item.from}
            {item.count > 1 && (
              <span className="ml-1.5 text-xs text-muted-foreground">
                {item.count}
                <span className="sr-only"> emails</span>
              </span>
            )}
          </span>
          <time dateTime={item.at} className="flex-none text-xs text-muted-foreground">
            {timeAgo(item.at)}
          </time>
        </div>
        <span className={cn('truncate text-sm', waiting && 'font-semibold')}>
          {item.hidden ? SIGN_UP : item.subject || '(No subject)'}
          {waiting && <span className="sr-only"> (unassigned)</span>}
        </span>
        {!item.hidden && item.snippet && (
          <span className="truncate text-sm text-muted-foreground">{item.snippet}</span>
        )}
        <div className="mt-1 flex min-w-0 items-center gap-2">
          <DestinationChip item={item} className="flex-none" />
          {who && <span className="truncate text-xs text-muted-foreground">{who}</span>}
        </div>
      </div>
    </Link>
  )
}

/** One conversation, whole, and what a person can do with it. */
function Reader({ id, onChanged }: { id: string; onChanged: () => Promise<void> }) {
  const detail = useApi<InboxDetail>(itemPath(id))
  const [handing, setHanding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  // Earlier mails folded, as in a mail app: the latest is open.
  const [opened, setOpened] = useState<Set<string>>(() => new Set())

  if (detail.error) return <p className="text-sm text-destructive-text">{detail.error.message}</p>
  const d = detail.data
  if (!d) return <p className="text-sm text-muted-foreground">Loading…</p>

  const done = d.status === 'done'
  async function toggleDone() {
    setBusy(true)
    setError(undefined)
    try {
      await api(`${itemPath(id)}/done`, { body: { done: !done } })
      await Promise.all([detail.reload(), onChanged()])
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  const last = d.messages.at(-1)?.id

  return (
    <Card className="gap-4 px-5 py-5">
      <div className="flex flex-col gap-2">
        <div className="flex items-start gap-2">
          <ProviderLogo kind={d.source.kind} className="mt-1.5 size-4 flex-none" />
          <h2 className="min-w-0 flex-1 text-xl font-bold wrap-anywhere">
            {d.hidden ? SIGN_UP : d.subject || '(No subject)'}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <DestinationChip item={d} />
          {d.teammate && <span className="text-xs text-muted-foreground">{d.teammate.name}</span>}
          {d.project && <span className="text-xs text-muted-foreground">{d.project.name}</span>}
          <span className="text-xs text-muted-foreground">{d.to}</span>
        </div>
        {d.reason ? (
          <p className="text-sm text-muted-foreground">
            {d.reason} No teammate is on it: hand it to one, or mark it done.
          </p>
        ) : (
          d.routeNote && <p className="text-sm text-muted-foreground">{d.routeNote}</p>
        )}
        {d.reason && d.addRule && (
          <div className="flex flex-col items-start gap-1.5">
            <AddRule
              connectionId={d.addRule.connectionId}
              projectId={d.addRule.projectId}
              teammateId={d.addRule.teammateId}
              reload={detail.reload}
            />
            <p className="text-xs text-muted-foreground">
              A rule starts a thread for the mail that comes next, not this one.
            </p>
          </div>
        )}
      </div>

      <ol className="flex flex-col">
        {d.messages.map((m) => (
          <li key={m.id} className="border-t">
            <Message
              m={m}
              open={m.id === last || opened.has(m.id)}
              onOpen={() => setOpened((o) => new Set(o).add(m.id))}
            />
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        {d.thread && (
          <Button asChild variant="outline" size="sm">
            <Link href={`/app/threads/${d.thread.id}`}>Open thread</Link>
          </Button>
        )}
        {!d.hidden && (
          <Button
            variant="outline"
            size="sm"
            aria-expanded={handing}
            onClick={() => setHanding((h) => !h)}
          >
            Hand to…
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void toggleDone()}>
          {done ? <Undo2 /> : <Check />}
          {done ? 'Not done' : 'Done'}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      {handing && !d.hidden && (
        <HandForm detail={d} onCancel={() => setHanding(false)} onHanded={onChanged} />
      )}
    </Card>
  )
}

const SENT_LABEL: Record<NonNullable<InboxMessage['sent']>, string> = {
  scheduled: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  bounced: 'Bounced',
  failed: 'Not sent',
}

/** One mail of a conversation: folded to a line, or whole. */
function Message({ m, open, onOpen }: { m: InboxMessage; open: boolean; onOpen: () => void }) {
  const [quoteOpen, setQuoteOpen] = useState(false)
  const date = new Date(m.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const auth = m.authentication
  const verified = auth && (auth.dkim === 'pass' || auth.dmarc === 'pass')
  const sent = m.sent && m.sent !== 'sent' && m.sent !== 'delivered' ? SENT_LABEL[m.sent] : null
  const header = (
    <div className="flex w-full items-baseline gap-2 text-left">
      <span className="min-w-0 flex-1 truncate text-sm">
        <span className="font-semibold">{m.fromName || m.from}</span>
        {m.fromName && m.fromName !== m.from && (
          <span className="text-muted-foreground"> &lt;{m.from}&gt;</span>
        )}
      </span>
      {sent && (
        <span
          className={cn(
            'flex-none text-xs',
            m.sent === 'bounced' || m.sent === 'failed'
              ? 'text-destructive-text'
              : 'text-muted-foreground',
          )}
        >
          {sent}
        </span>
      )}
      <time dateTime={m.at} className="flex-none text-xs text-muted-foreground">
        {date}
      </time>
    </div>
  )

  if (!open)
    return (
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full flex-col gap-0.5 py-3 outline-none hover:bg-secondary/50 focus-visible:bg-secondary/50"
      >
        {header}
        <span className="w-full truncate text-left text-sm text-muted-foreground">
          {m.hidden ? SIGN_UP : m.text.replace(/\s+/g, ' ') || 'No text.'}
        </span>
      </button>
    )

  return (
    <div className="flex flex-col items-start gap-2 py-4">
      {header}
      <p className="text-xs text-muted-foreground wrap-anywhere">
        To {m.to.join(', ')}
        {m.cc.length > 0 && ` · Cc ${m.cc.join(', ')}`}
      </p>
      {auth && (
        <p
          className={cn(
            'flex items-center gap-1.5 text-xs',
            verified ? 'text-muted-foreground' : 'text-warning',
          )}
        >
          {verified ? (
            <ShieldCheck aria-hidden className="size-3.5" />
          ) : (
            <ShieldAlert aria-hidden className="size-3.5" />
          )}
          {verified ? 'Verified by the mail server' : 'Not verified'}
        </p>
      )}
      {m.hidden ? (
        <p className="text-sm text-muted-foreground">
          Mail to a sign-up address is for its thread: only its starter and admins can read it.
        </p>
      ) : m.text ? (
        <p className="w-full text-[15px] leading-relaxed whitespace-pre-wrap wrap-anywhere">
          {m.text}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">No text.</p>
      )}
      {!m.hidden &&
        m.quoted &&
        (quoteOpen ? (
          <p className="w-full border-l-2 pl-3 text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground wrap-anywhere">
            {m.quoted}
          </p>
        ) : (
          <button
            type="button"
            onClick={() => setQuoteOpen(true)}
            className="rounded-full bg-secondary px-2.5 py-0.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
          >
            ··· Show quoted text
          </button>
        ))}
      {m.attachments.length > 0 && <MailFiles m={m} />}
    </div>
  )
}

/**
 * A mail's files, like a thread message's: an image or a video opens over the page, any other
 * file (a PDF, a text) in a new tab, where the browser shows what it can and downloads the rest.
 */
function MailFiles({ m }: { m: InboxMessage }) {
  const [viewing, setViewing] = useState<Media>()
  const chip =
    'flex max-w-64 items-center gap-2 rounded-lg border bg-card py-1.5 pr-3 pl-2 text-xs hover:border-ring'
  return (
    <>
      <ul className="flex w-full flex-wrap gap-2 pt-1" aria-label="Attached files">
        {m.attachments.map((a, i) => {
          const src = fileUrl(m, a.id)
          const kind = mediaKind(a.contentType)
          const body = (
            <>
              {kind ? (
                <span className="relative size-8 shrink-0 overflow-hidden rounded bg-secondary">
                  <Thumbnail src={src} kind={kind} small />
                </span>
              ) : (
                <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="flex min-w-0 flex-col text-left">
                <span className="truncate font-medium">{a.name}</span>
                {a.size > 0 && (
                  <span className="truncate text-muted-foreground">{fileSize(a.size)}</span>
                )}
              </span>
            </>
          )
          return (
            <li key={`${a.id}-${i}`}>
              {kind ? (
                <button
                  type="button"
                  className={cn(chip, 'cursor-zoom-in')}
                  onClick={() => setViewing({ name: a.name, src, kind })}
                  aria-label={`Preview ${a.name}`}
                  title={a.name}
                >
                  {body}
                </button>
              ) : (
                <a href={src} target="_blank" rel="noreferrer" className={chip} title={a.name}>
                  {body}
                </a>
              )}
            </li>
          )
        })}
      </ul>
      <MediaPreview
        media={viewing}
        onClose={() => setViewing(undefined)}
        unavailable="This image can’t be shown: its mailbox no longer has it, or Brigade did not keep it."
      />
    </>
  )
}

/** Give the email to a teammate: a thread of the member's with it, the mail inside. */
function HandForm({
  detail,
  onCancel,
  onHanded,
}: {
  detail: InboxDetail
  onCancel: () => void
  onHanded: () => Promise<void>
}) {
  const router = useRouter()
  const [teammateId, setTeammateId] = useState(
    detail.handTo.length === 1 ? detail.handTo[0]!.id : '',
  )
  const [note, setNote] = useState('')
  const [projectId, setProjectId] = useState(detail.project?.id ?? 'none')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  // Brigade's mail is answered from its mailbox, which only its project's threads reach.
  const gmail = detail.source.kind === 'gmail'

  if (detail.handTo.length === 0)
    return (
      <p className="rounded-lg bg-secondary px-3 py-2 text-sm text-muted-foreground">
        No teammate has this mailbox: give it to one in Settings › Apps.
      </p>
    )

  async function hand() {
    if (!teammateId) return
    setSending(true)
    setError(undefined)
    try {
      const { threadId } = await api<{ threadId: string }>(`${itemPath(detail.id)}/hand`, {
        body: {
          teammateId,
          note: note.trim() || undefined,
          ...(gmail ? { projectId: projectId === 'none' ? null : projectId } : {}),
        },
      })
      void onHanded()
      router.push(`/app/threads/${threadId}`)
    } catch (e) {
      setError(message(e))
      setSending(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border p-4"
      onSubmit={(e) => {
        e.preventDefault()
        void hand()
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="hand-teammate">Teammate</Label>
        <Select value={teammateId} onValueChange={setTeammateId}>
          <SelectTrigger id="hand-teammate" className="w-full sm:w-56">
            <SelectValue placeholder="Pick a teammate" />
          </SelectTrigger>
          <SelectContent>
            {detail.handTo.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="hand-note">Note</Label>
        <Textarea
          id="hand-note"
          placeholder="What should they do?"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={5000}
          rows={3}
        />
      </div>
      {gmail && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="hand-project">Project</Label>
          <ProjectSelect id="hand-project" value={projectId} onChange={setProjectId} />
        </div>
      )}
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!teammateId || sending}>
          {sending ? 'Handing over…' : 'Hand over'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
