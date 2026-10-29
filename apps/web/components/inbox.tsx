'use client'
// The Inbox: every email the workspace's mailboxes received (Brigade's own addresses and
// connected Gmail accounts), one row per conversation with its next step; read one, approve a
// teammate's reply (now or for later), mark it done or hand it to a teammate, and see what its
// thread did when it did not reply (have it reply, discuss it there, or reply yourself). The
// list and the open conversation are two columns, each the window's height. Filters and the
// open email live in the address, so links and back work.
import {
  formatMention,
  type InboxDetail,
  type InboxDraft,
  type InboxItem,
  type InboxMessage,
  type InboxSourceView,
  type InboxStatus,
} from '@brigade/contracts'
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Clock,
  FileText,
  Mail,
  Search,
  Settings,
  ShieldAlert,
  Undo2,
  X,
} from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { fileSize, type Media, MediaPreview, mediaKind, Thumbnail } from '@/components/attachments'
import { TeammateAvatar, timeAgo, useDashboard } from '@/components/dashboard'
import { type EditedEmail, EmailDraftEditor, emailDraft } from '@/components/email-cards'
import { AddRule } from '@/components/project-email'
import { ProjectIcon, ProjectSelect } from '@/components/projects'
import { ProviderLogo } from '@/components/provider-logo'
import { leavingLabel, SendLaterMenu } from '@/components/send-later'
import { Button } from '@/components/ui/button'
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
import {
  draftFacts,
  filtersKey,
  filtersToRestore,
  type KeptFilters,
  keptFilters,
  reloadsInboxList,
} from '@/lib/inbox'
import { addToReply } from '@/lib/reply-drafts'
import { useLive } from '@/lib/use-live'
import { cn } from '@/lib/utils'

type InboxList = { items: InboxItem[]; sources: InboxSourceView[]; next: string | null }
type Param = 'status' | 'source' | 'teammate' | 'project' | 'q' | 'item'

type StatusFilter = InboxStatus | 'scheduled' | 'all'

/** Its tabs, by what comes next: to do (nobody on it, or a reply to approve), and the rest. */
const STATUSES: { value: StatusFilter; label: string }[] = [
  { value: 'waiting', label: 'To do' },
  { value: 'handled', label: 'With teammates' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'done', label: 'Done' },
  { value: 'all', label: 'All' },
]

const EMPTY: Record<StatusFilter, string> = {
  waiting: 'Nothing to do. Every email has a teammate, and no reply waits for you.',
  handled: 'No conversation with a teammate right now.',
  scheduled: 'No reply set to leave later.',
  done: 'Nothing marked done yet.',
  all: 'No email here.',
}

const ALL = '*'
/** A filter picker under the tabs: plain text until it is set. */
const FILTER =
  'h-8 w-auto max-w-56 sm:w-auto border-transparent bg-transparent px-2.5 text-muted-foreground shadow-none hover:bg-secondary hover:text-foreground dark:bg-transparent dark:hover:bg-secondary'
/** A filter that is set: its icon and short name in a chip, a × beside it to clear it. */
const CHIP =
  'h-7 w-auto max-w-44 border-0 bg-transparent py-0 pr-1 pl-2 text-foreground shadow-none sm:w-auto dark:bg-transparent dark:hover:bg-transparent [&>svg]:hidden'

function FilterChip({
  active,
  what,
  onClear,
  children,
}: {
  active: boolean
  what: string
  onClear: () => void
  children: ReactNode
}) {
  if (!active) return children
  return (
    <span className="inline-flex max-w-full items-center rounded-full border bg-card pr-1 hover:border-ring">
      {children}
      <button
        type="button"
        aria-label={`Clear the ${what} filter`}
        title="Clear"
        onClick={onClear}
        className="flex size-5 flex-none items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </span>
  )
}
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
    case 'read':
      return 'Read by a thread'
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

/** The page: the list with its filters, and the open email beside it (in its place on a phone). */
export function InboxView() {
  const params = useSearchParams()
  const router = useRouter()
  const { me, teammates, projects, reloadInboxCount, inboxWaiting } = useDashboard()
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

  // The tab and pickers are remembered in this browser, per workspace: arriving on the bare
  // address puts them back (a link to a view, a search or an email wins). Until they are back,
  // nothing is asked, so the default view does not flash first.
  const workspaceId = me?.activeWorkspaceId ?? null
  const [restore, setRestore] = useState<'checking' | 'done' | KeptFilters>('checking')
  useEffect(() => {
    if (restore !== 'checking' || !workspaceId) return
    let saved: string | null = null
    try {
      saved = localStorage.getItem(filtersKey(workspaceId))
    } catch {}
    const back = filtersToRestore(new URLSearchParams(params.toString()), saved)
    setRestore(back ?? 'done')
    if (back) router.replace(href(back), { scroll: false })
  }, [restore, workspaceId, params, href, router])
  useEffect(() => {
    if (!workspaceId || restore === 'checking') return
    const kept = keptFilters(new URLSearchParams(params.toString()))
    if (restore !== 'done') {
      // Waiting for the address to take the filters put back (it was bare): once it says
      // anything, they are back, or the member already went elsewhere.
      if (!Object.keys(kept).length && !params.has('q') && !params.has('item')) return
      setRestore('done')
    }
    try {
      localStorage.setItem(filtersKey(workspaceId), JSON.stringify(kept))
    } catch {}
  }, [params, restore, workspaceId])

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

  // "/" goes to the search box, from anywhere on the page but a field.
  const searchBox = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      e.preventDefault()
      searchBox.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // The To do count is the workspace's, so it shows only while nothing narrows the list.
  const filtered = !!(source || teammate || project || q)

  const search = new URLSearchParams({ status })
  if (source) search.set('source', source)
  if (teammate) search.set('teammate', teammate)
  if (project) search.set('project', project)
  if (q) search.set('q', q)
  const path = `/inbox?${search}`
  const list = useApi<InboxList>(restore === 'done' ? path : null)
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

  // Counted up by each refresh: an older page asked for before it is dropped, not appended.
  const generation = useRef(0)
  async function loadOlder() {
    if (!next) return
    const asked = generation.current
    setLoadingOlder(true)
    setOlderError(undefined)
    try {
      const page = await api<InboxList>(`${path}&before=${encodeURIComponent(next)}`)
      if (asked !== generation.current) return
      setOlder({ path, items: [...(more?.items ?? []), ...page.items], next: page.next })
    } catch (e) {
      setOlderError(message(e))
    } finally {
      setLoadingOlder(false)
    }
  }

  // Infinite scroll: the next page comes as the end of the list nears, in the list's own column
  // on a wide screen (it scrolls on its own there), in the page on a phone. Watched again after
  // each page, so a short page that leaves the end in sight asks for the next one too. Once a
  // page failed, Load older asks again by hand.
  const scroller = useRef<HTMLDivElement>(null)
  const end = useRef<HTMLDivElement>(null)
  const latestLoadOlder = useRef(loadOlder)
  latestLoadOlder.current = loadOlder
  const wide = useWide()
  // On a wide screen the first conversation opens by itself, so the reading column is never
  // empty; on a phone the list stays, since opening one hides it.
  const first = items[0]?.id
  useEffect(() => {
    if (wide && !item && first) router.replace(href({ item: first }), { scroll: false })
  }, [wide, item, first, href, router])
  useEffect(() => {
    if (!next || loadingOlder || olderError || !end.current) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void latestLoadOlder.current()
      },
      { root: wide ? scroller.current : null, rootMargin: '400px 0px' },
    )
    observer.observe(end.current)
    return () => observer.disconnect()
  }, [next, loadingOlder, olderError, wide])

  const refresh = useCallback(async () => {
    generation.current++
    setOlder(undefined)
    await Promise.all([reloadList(), reloadInboxCount()])
  }, [reloadList, reloadInboxCount])
  // Live: a mail came or changed anywhere in the list (older pages too, so they go and come
  // back on asking), a mailbox came in or out of the Inbox, or a reply to approve opened or was
  // decided (it moves its conversation in or out of To do). The sidebar's count follows
  // the same messages by itself.
  useLive(
    (message) => {
      if (!reloadsInboxList(message.type)) return
      generation.current++
      setOlder(undefined)
      void reloadList()
    },
    () => void refresh(),
  )

  // Marked done, the open email gives its place to the next one in the list (the one before
  // at its end), as in a mail app: the list is worked through without going back to it.
  const at = items.findIndex((i) => i.id === item)
  const following = at < 0 ? null : (items[at + 1] ?? items[at - 1] ?? null)
  function doneWith() {
    router.replace(href({ item: following?.id ?? null }), { scroll: false })
    void refresh()
  }

  // ↑ and ↓ open the email above or below the open one, from anywhere on the page but a field
  // or an open menu.
  const step = useRef<(by: number) => void>(() => {})
  step.current = (by) => {
    const to = at < 0 ? items[0] : items[at + by]
    if (to) router.replace(href({ item: to.id }), { scroll: false })
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented) return
      const target = e.target as HTMLElement | null
      if (
        target?.closest(
          'input, textarea, select, [contenteditable="true"], [role="listbox"], [role="menu"], [role="dialog"]',
        )
      )
        return
      e.preventDefault()
      step.current(e.key === 'ArrowDown' ? 1 : -1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const sources = list.data?.sources ?? []
  // The filters set, by their short name and icon (an address's own shows in its menu).
  const chosenSource = sources.find((s) => s.id === source)
  const chosenTeammate = teammates.find((t) => t.id === teammate)
  const chosenProject = projects.find((p) => p.id === project)
  // A filter kept or linked to that is no more (a mailbox taken out, a teammate or project
  // deleted) would show an empty list: it goes.
  const stale = {
    ...(source && list.data && !chosenSource ? { source: null } : {}),
    ...(teammate && teammates.length && !chosenTeammate ? { teammate: null } : {}),
    ...(project && projects.length && !chosenProject ? { project: null } : {}),
  }
  const staleKey = Object.keys(stale).join()
  useEffect(() => {
    if (staleKey) router.replace(href(stale), { scroll: false })
  }, [staleKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const brigade = sources.filter((s) => s.kind === 'email')
  const gmail = sources.filter((s) => s.kind === 'gmail')

  return (
    <div className="flex min-w-0 lg:h-dvh">
      <section
        aria-label="Emails"
        className={cn(
          'flex w-full min-w-0 flex-col lg:w-[26rem] lg:flex-none lg:border-r xl:w-[28rem]',
          item && 'hidden lg:flex',
        )}
      >
        <header className="flex flex-col gap-3 border-b px-4 pt-6 pb-3 md:px-5">
          <div className="flex items-baseline gap-2">
            <h1 className="text-2xl font-extrabold tracking-tight">Inbox</h1>
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
              Every email your mailboxes received
            </span>
            {/* The Inbox's own settings: its mailboxes, where mail arrives and who handles it. */}
            <Button
              asChild
              variant="ghost"
              size="icon-sm"
              className="flex-none self-center text-muted-foreground"
            >
              <Link href="/app/inbox/mailboxes" aria-label="Mailboxes" title="Mailboxes">
                <Settings />
              </Link>
            </Button>
          </div>
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={searchBox}
              type="search"
              aria-label="Search"
              placeholder="Search email"
              title="Search (/)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
              className="h-9 pl-9"
            />
          </div>
          <div
            role="group"
            aria-label="Status"
            className="-mx-1 flex gap-1 overflow-x-auto px-1 [scrollbar-width:none]"
          >
            {STATUSES.map((s) => {
              const count = s.value === 'waiting' && !filtered ? inboxWaiting : 0
              return (
                <button
                  key={s.value}
                  type="button"
                  aria-pressed={status === s.value}
                  onClick={() => go({ status: s.value === 'waiting' ? null : s.value, item: null })}
                  className={cn(
                    'inline-flex h-7 flex-none items-center gap-1.5 rounded-full px-3 text-sm font-semibold transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    status === s.value
                      ? 'bg-foreground text-background'
                      : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                  )}
                >
                  {s.label}
                  {count > 0 && <span className="text-xs font-normal tabular-nums">{count}</span>}
                </button>
              )
            })}
          </div>
          <div className="-mx-1 flex flex-wrap items-center gap-1">
            <Select
              value={source || ALL}
              onValueChange={(v) => go({ source: v === ALL ? null : v })}
            >
              <FilterChip active={!!source} what="source" onClear={() => go({ source: null })}>
                <SelectTrigger aria-label="Source" className={source ? CHIP : FILTER}>
                  <SelectValue>
                    {chosenSource ? (
                      <>
                        {chosenSource.teammate ? (
                          <TeammateAvatar teammate={chosenSource.teammate} className="size-4" />
                        ) : (
                          <ProviderLogo kind={chosenSource.kind} className="size-4" />
                        )}
                        <span className="truncate">{chosenSource.label}</span>
                      </>
                    ) : source ? undefined : (
                      'Sources'
                    )}
                  </SelectValue>
                </SelectTrigger>
              </FilterChip>
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
                <FilterChip active={!!teammate} what="agent" onClear={() => go({ teammate: null })}>
                  <SelectTrigger aria-label="Agent" className={teammate ? CHIP : FILTER}>
                    <SelectValue>
                      {chosenTeammate ? (
                        <>
                          <TeammateAvatar teammate={chosenTeammate} className="size-4" />
                          <span className="truncate">{chosenTeammate.name}</span>
                        </>
                      ) : teammate ? undefined : (
                        'Agents'
                      )}
                    </SelectValue>
                  </SelectTrigger>
                </FilterChip>
                <SelectContent>
                  <SelectItem value={ALL}>All agents</SelectItem>
                  <SelectSeparator />
                  {teammates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      <TeammateAvatar teammate={t} className="size-4" />
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {projects.length > 0 && (
              <Select
                value={project || ALL}
                onValueChange={(v) => go({ project: v === ALL ? null : v })}
              >
                <FilterChip active={!!project} what="project" onClear={() => go({ project: null })}>
                  <SelectTrigger aria-label="Project" className={project ? CHIP : FILTER}>
                    <SelectValue>
                      {chosenProject ? (
                        <>
                          <ProjectIcon project={chosenProject} className="size-4 text-[0.625rem]" />
                          <span className="truncate">{chosenProject.name}</span>
                        </>
                      ) : project ? undefined : (
                        'Projects'
                      )}
                    </SelectValue>
                  </SelectTrigger>
                </FilterChip>
                <SelectContent>
                  <SelectItem value={ALL}>All projects</SelectItem>
                  <SelectSeparator />
                  {projects
                    .filter((p) => !p.archivedAt || p.id === project)
                    .map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        <ProjectIcon project={p} className="size-4 text-[0.625rem]" />
                        {p.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </header>

        <div ref={scroller} className="flex min-h-0 flex-1 flex-col lg:overflow-y-auto">
          {list.error && (
            <p className="px-5 py-4 text-sm text-destructive-text">{list.error.message}</p>
          )}
          {!list.data && !list.error ? (
            <p className="px-5 py-4 text-sm text-muted-foreground">Loading…</p>
          ) : list.data && items.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
                <Mail className="size-5" aria-hidden />
              </span>
              <p className="max-w-xs text-sm text-muted-foreground">{EMPTY[status]}</p>
            </div>
          ) : (
            <ul className="divide-y border-b">
              {items.map((i) => (
                <li key={i.id}>
                  <Row item={i} href={href({ item: i.id })} selected={i.id === item} />
                </li>
              ))}
            </ul>
          )}
          {next && <div ref={end} aria-hidden className="h-px flex-none" />}
          {loadingOlder && (
            <p className="py-4 text-center text-xs text-muted-foreground">Loading…</p>
          )}
          {olderError && (
            <div className="flex flex-col items-center gap-2 px-5 py-4">
              <p className="text-sm text-destructive-text">{olderError}</p>
              <Button variant="outline" size="sm" onClick={() => void loadOlder()}>
                Load older
              </Button>
            </div>
          )}
        </div>
      </section>

      <section
        aria-label="Email"
        className={cn('min-w-0 flex-1 lg:overflow-y-auto', item ? 'block' : 'hidden lg:block')}
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pt-6 pb-16 md:px-10 md:pt-8">
          {item ? (
            <>
              <Button asChild variant="ghost" size="sm" className="self-start lg:hidden">
                <Link href={href({ item: null })} scroll={false}>
                  <ArrowLeft /> Back
                </Link>
              </Button>
              <Reader key={item} id={item} onChanged={refresh} onDone={doneWith} />
            </>
          ) : (
            <p className="py-24 text-center text-sm text-muted-foreground">
              Pick an email to read it.
            </p>
          )}
        </div>
      </section>
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

/** A screen wide enough for the Inbox's two columns (Tailwind's lg), following resizes. */
function useWide() {
  const [wide, setWide] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)')
    const update = () => setWide(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return wide
}

/** A sender's initial on a soft colour, the same for the same address. */
function SenderAvatar({
  name,
  address,
  className,
}: {
  name: string
  address: string
  className?: string
}) {
  const tones = [
    'bg-chart-1/20',
    'bg-chart-2/20',
    'bg-chart-3/20',
    'bg-chart-4/20',
    'bg-chart-5/20',
  ]
  const tone = tones[[...address].reduce((sum, c) => sum + c.charCodeAt(0), 0) % tones.length]
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-9 flex-none items-center justify-center rounded-lg text-sm font-semibold text-foreground',
        tone,
        className,
      )}
    >
      {(name || address).trim().charAt(0).toUpperCase() || '?'}
    </span>
  )
}

/** A conversation's next step, in a few words: what the row says under its words. */
function NextStep({ item }: { item: InboxItem }) {
  const trouble = item.route === 'cap' || item.route === 'loop' || item.route === 'bounce'
  const who = item.next?.kind === 'draft' ? (item.next.teammate ?? item.teammate) : item.teammate
  const step =
    item.next?.kind === 'draft' ? (
      <span className="font-semibold text-primary">Draft to approve</span>
    ) : item.status === 'done' ? (
      <span>Done</span>
    ) : item.next?.kind === 'scheduled' ? (
      <span className="inline-flex items-center gap-1">
        <Clock aria-hidden className="size-3" />
        Leaves {leavingLabel(item.next.at)}
      </span>
    ) : item.outcome?.kind === 'no_reply' ? (
      <span className="min-w-0 truncate font-semibold text-warning" title={item.outcome.note}>
        didn’t reply{item.outcome.note && `: ${item.outcome.note}`}
      </span>
    ) : item.status === 'waiting' ? (
      <span className="font-semibold text-warning">
        {trouble ? destination(item) : 'No teammate on it'}
      </span>
    ) : item.outcome?.kind === 'handled' ? (
      <span className="min-w-0 truncate" title={item.outcome.note}>
        handled it without a reply
      </span>
    ) : null
  return (
    <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      {item.status === 'waiting' && !item.next && !item.outcome ? (
        <span aria-hidden className="size-1.5 flex-none rounded-full bg-warning" />
      ) : (
        who && (
          <>
            <TeammateAvatar teammate={who} className="size-4" />
            <span className="truncate">{who.name}</span>
          </>
        )
      )}
      {step}
      {item.project && <span className="truncate">· {item.project.name}</span>}
    </span>
  )
}

function Row({ item, href, selected }: { item: InboxItem; href: string; selected: boolean }) {
  const todo = item.status === 'waiting' || item.next?.kind === 'draft'
  // Opened from the keyboard or by marking the one before done, it comes into view.
  const self = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    if (selected) self.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  return (
    <Link
      ref={self}
      href={href}
      scroll={false}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex gap-3 px-4 py-3.5 outline-none hover:bg-secondary/50 focus-visible:bg-secondary/50 md:px-5',
        selected && 'bg-secondary hover:bg-secondary',
      )}
    >
      <SenderAvatar name={item.fromName} address={item.from} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-baseline gap-2">
          <span className={cn('min-w-0 flex-1 truncate text-sm', todo && 'font-semibold')}>
            {item.fromName || item.from}
            {item.count > 1 && (
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                {item.count}
                <span className="sr-only"> emails</span>
              </span>
            )}
          </span>
          <time dateTime={item.at} className="flex-none text-xs text-muted-foreground">
            {timeAgo(item.at)}
          </time>
        </div>
        <span className={cn('truncate text-sm', todo ? 'font-semibold' : 'text-foreground/90')}>
          {item.hidden ? SIGN_UP : item.subject || '(No subject)'}
        </span>
        {!item.hidden && item.snippet && (
          <span className="truncate text-sm text-muted-foreground">{item.snippet}</span>
        )}
        <NextStep item={item} />
      </div>
    </Link>
  )
}

/** One conversation, whole, and what a person can do with it. */
function Reader({
  id,
  onChanged,
  onDone,
}: {
  id: string
  onChanged: () => Promise<void>
  /** Marked done: the page opens the next email. */
  onDone: () => void
}) {
  const router = useRouter()
  const detail = useApi<InboxDetail>(itemPath(id), ['mail.updated', 'tickets.updated'])
  const [handing, setHanding] = useState(false)
  const [ruling, setRuling] = useState(false)
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
      if (!done) return onDone()
      await Promise.all([detail.reload(), onChanged()])
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  // Handed in one click when it can only go to one teammate and needs nothing more (Gmail's
  // mail asks for its project first); otherwise the form opens.
  const only = d.handTo.length === 1 ? d.handTo[0]! : null
  const oneClick = only && d.source.kind !== 'gmail'
  async function handToOnly() {
    if (!only) return
    setBusy(true)
    setError(undefined)
    try {
      const { threadId } = await api<{ threadId: string }>(`${itemPath(id)}/hand`, {
        body: { teammateId: only.id },
      })
      void onChanged()
      router.push(`/app/threads/${threadId}`)
    } catch (e) {
      setError(message(e))
      setBusy(false)
    }
  }

  const last = d.messages.at(-1)?.id
  const unowned = d.status === 'waiting' && !d.thread
  const trouble = d.route === 'cap' || d.route === 'loop' || d.route === 'bounce'
  const state = d.reason ? 'No teammate is on it' : destination(d)
  const about = [d.teammate && `${d.teammate.name}’s mailbox`, d.project?.name]
    .filter(Boolean)
    .join(' · ')
  // Once a thread has it, handing it over starts a new thread: worth offering only when the
  // mailbox has another teammate than the one on it.
  const handOver = d.handTo.some((t) => t.id !== d.teammate?.id)
  const handButton = (primary: boolean) =>
    oneClick && unowned ? (
      <Button size="sm" disabled={busy} onClick={() => void handToOnly()}>
        Hand to {only.name}
      </Button>
    ) : (
      <Button
        size="sm"
        variant={primary ? 'default' : 'ghost'}
        className={cn(!primary && 'h-7 px-2 text-muted-foreground')}
        aria-expanded={handing}
        onClick={() => setHanding((h) => !h)}
      >
        {primary && only ? `Hand to ${only.name}` : 'Hand to…'}
      </Button>
    )
  const sender = d.fromName || d.from
  const reload = async () => {
    await Promise.all([detail.reload(), onChanged()])
  }

  return (
    <article className="flex flex-col gap-4">
      <header className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 className="text-2xl font-bold tracking-tight wrap-anywhere">
              {d.hidden ? SIGN_UP : d.subject || '(No subject)'}
            </h2>
            <p className="text-sm text-muted-foreground">
              with {sender} · {d.messages.length} {d.messages.length === 1 ? 'message' : 'messages'}
            </p>
          </div>
          <Button
            variant="outline"
            size="icon"
            className="size-8 flex-none"
            disabled={busy}
            aria-label={done ? 'Not done' : 'Done'}
            title={done ? 'Not done' : 'Done'}
            onClick={() => void toggleDone()}
          >
            {done ? <Undo2 /> : <Check />}
          </Button>
        </div>
        {unowned ? (
          // Nobody is on it: what to do with it, and with the mail that comes next, together.
          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-warning/30 bg-warning/10 px-3.5 py-2.5"
            title={d.reason ?? undefined}
          >
            <span aria-hidden className="size-1.5 flex-none rounded-full bg-warning" />
            <span className={cn('min-w-0 flex-1 text-sm', trouble && 'text-warning')}>
              {state}
              {about && <span className="text-muted-foreground"> · {about}</span>}
            </span>
            <div className="flex flex-none items-center gap-1">
              {!d.hidden && handButton(true)}
              {d.reason && d.addRule && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={ruling}
                  className="text-primary hover:text-primary"
                  onClick={() => setRuling((r) => !r)}
                >
                  Add a rule
                </Button>
              )}
            </div>
          </div>
        ) : d.outcome && d.thread && !done ? (
          <OutcomeLine detail={d} about={about} onChanged={reload} />
        ) : (
          <div className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
            <span
              aria-hidden
              className={cn(
                'size-1.5 flex-none rounded-full',
                trouble ? 'bg-warning' : done ? 'bg-muted-foreground/50' : 'bg-primary',
              )}
            />
            {d.thread ? (
              <Link
                href={`/app/threads/${d.thread.id}`}
                className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-4 hover:underline"
              >
                {state}
                <ArrowUpRight aria-hidden className="size-3.5" />
              </Link>
            ) : (
              <span className={cn(trouble ? 'text-warning' : 'text-foreground')}>{state}</span>
            )}
            {about && <span>· {about}</span>}
            {!d.hidden && handOver && <span className="ml-auto">{handButton(false)}</span>}
          </div>
        )}
        {!d.reason && d.routeNote && <p className="text-xs text-muted-foreground">{d.routeNote}</p>}
        {error && <p className="text-sm text-destructive-text">{error}</p>}
        {handing && !d.hidden && (
          <HandForm detail={d} onCancel={() => setHanding(false)} onHanded={onChanged} />
        )}
        {ruling && d.addRule && (
          <AddRule
            connectionId={d.addRule.connectionId}
            projectId={d.addRule.projectId}
            teammateId={d.addRule.teammateId}
            reload={detail.reload}
            onClose={() => setRuling(false)}
          />
        )}
      </header>

      <ol className="flex flex-col gap-3">
        {d.messages.map((m) => (
          <li key={m.id}>
            <Message
              m={m}
              open={m.id === last || opened.has(m.id) || !!m.sendAt}
              onOpen={() => setOpened((o) => new Set(o).add(m.id))}
              onChanged={reload}
            />
          </li>
        ))}
        {d.drafts.map((draft) => (
          <li key={draft.ticketId}>
            <DraftCard draft={draft} thread={d.thread} onChanged={reload} />
          </li>
        ))}
      </ol>
    </article>
  )
}

/**
 * A teammate's reply waiting for approval, in its place in the conversation: approve it now or
 * for later, change it, or turn it down (the thread's ticket, decided as in the thread).
 */
function DraftCard({
  draft,
  thread,
  onChanged,
}: {
  draft: InboxDraft
  thread: InboxDetail['thread']
  onChanged: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const email = emailDraft(draft.input)
  const teammate = draft.teammate
  async function decide(approved: boolean, edited?: EditedEmail) {
    setBusy(true)
    setError(undefined)
    try {
      await api(`/tickets/${draft.ticketId}/resolve`, {
        body: { approved, ...(edited ? { edited } : {}) },
      })
      await onChanged()
    } catch (e) {
      setError(message(e))
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-primary/50 bg-card px-5 py-4">
      <div className="flex items-start gap-3">
        {teammate ? (
          <TeammateAvatar teammate={teammate} className="size-9" />
        ) : (
          <SenderAvatar name="?" address="?" />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2 text-sm font-semibold">
            {teammate?.name ?? 'A teammate'}
            <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold text-primary">
              Draft
            </span>
          </span>
        </div>
        <span className="flex-none text-xs text-muted-foreground">
          {email?.sendAt ? `Leaves ${leavingLabel(email.sendAt)}` : 'Waiting for you'}
        </span>
      </div>
      {/* Whom it goes to, its subject and files: all of what is approved, not only the words. */}
      {email && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-sm">
          {draftFacts(email).map(([label, value]) => (
            <Fragment key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className={cn('wrap-anywhere', label === 'Cc' && 'font-semibold')}>{value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {editing && email ? (
        <EmailDraftEditor
          draft={email}
          onCancel={() => setEditing(false)}
          onSend={(edited) => {
            setEditing(false)
            void decide(true, edited)
          }}
        />
      ) : (
        <p className="text-[15px] leading-relaxed whitespace-pre-wrap wrap-anywhere">
          {email?.body ?? JSON.stringify(draft.input)}
        </p>
      )}
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      {draft.canDecide ? (
        !editing && (
          <div className="flex flex-col gap-2 border-t pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={busy} onClick={() => void decide(true)}>
                <Check />
                {email?.sendAt ? 'Approve' : 'Approve & send'}
              </Button>
              <SendLaterMenu disabled={busy} onPick={(sendAt) => void decide(true, { sendAt })} />
              {email && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setEditing(true)}
                >
                  Edit
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto text-muted-foreground"
                disabled={busy}
                onClick={() => void decide(false)}
              >
                Discard
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {email?.sendAt
                ? 'It leaves at that time once approved, and can be cancelled until then.'
                : 'It leaves 30 seconds after you approve it, and can be cancelled until then.'}
            </p>
          </div>
        )
      ) : (
        <p className="border-t pt-3 text-xs text-muted-foreground">
          Only the member who started{' '}
          {thread ? (
            <Link href={`/app/threads/${thread.id}`} className="underline underline-offset-4">
              its thread
            </Link>
          ) : (
            'its thread'
          )}
          , or an admin, can approve it.
        </p>
      )}
    </div>
  )
}

const SENT_LABEL: Record<NonNullable<InboxMessage['sent']>, string> = {
  scheduled: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  bounced: 'Bounced',
  failed: 'Not sent',
}

/** A mail's time: the hour today, the day this year, else the date. The whole date shows on hover. */
function shortDate(at: string) {
  const date = new Date(at)
  const now = new Date()
  if (date.toDateString() === now.toDateString())
    return date.toLocaleTimeString(undefined, { timeStyle: 'short' })
  if (date.getFullYear() === now.getFullYear())
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return date.toLocaleDateString(undefined, { dateStyle: 'medium' })
}

/** One mail of a conversation, as a card: folded to a line, or whole. */
function Message({
  m,
  open,
  onOpen,
  onChanged,
}: {
  m: InboxMessage
  open: boolean
  onOpen: () => void
  onChanged: () => Promise<void>
}) {
  const { teammates } = useDashboard()
  const [quoteOpen, setQuoteOpen] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<string>()
  const date = new Date(m.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const when = shortDate(m.at)
  const auth = m.authentication
  const verified = auth && (auth.dkim === 'pass' || auth.dmarc === 'pass')
  const sent = m.sent && m.sent !== 'sent' && m.sent !== 'delivered' ? SENT_LABEL[m.sent] : null
  // Sent by a teammate: its pebble, as everywhere else.
  const teammate =
    m.direction === 'out' ? (teammates.find((t) => t.name === m.fromName) ?? null) : null
  const name = m.fromName || m.from
  const avatar = teammate ? (
    <TeammateAvatar teammate={teammate} className="size-9" />
  ) : (
    <SenderAvatar name={name} address={m.from} />
  )
  async function cancel() {
    setCancelling(true)
    setError(undefined)
    try {
      await api(`/email/messages/${encodeURIComponent(m.id.replace(/^mail:/, ''))}/cancel`, {
        method: 'POST',
      })
      await onChanged()
    } catch (e) {
      setError(message(e))
    } finally {
      setCancelling(false)
    }
  }
  const header = (
    <div className="flex w-full items-start gap-3 text-left">
      {avatar}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold" title={m.from}>
          {name}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          to {m.to.join(', ')}
          {m.cc.length > 0 && ` · Cc ${m.cc.join(', ')}`}
        </span>
      </span>
      {sent && !m.sendAt && (
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
      <time dateTime={m.at} title={date} className="flex-none text-xs text-muted-foreground">
        {when}
      </time>
    </div>
  )

  if (!open)
    return (
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full flex-col gap-2 rounded-xl border bg-card px-5 py-3.5 outline-none hover:bg-secondary/40 focus-visible:bg-secondary/40"
      >
        {header}
        <span className="w-full truncate pl-12 text-left text-sm text-muted-foreground">
          {m.hidden ? SIGN_UP : m.text.replace(/\s+/g, ' ') || 'No text.'}
        </span>
      </button>
    )

  return (
    <div
      className={cn(
        'flex flex-col items-start gap-3 rounded-xl border bg-card px-5 py-4',
        m.sendAt && 'border-dashed',
      )}
    >
      {header}
      {m.sendAt && (
        <div className="flex w-full flex-wrap items-center gap-2 rounded-lg bg-secondary px-3 py-2 text-sm">
          <Clock aria-hidden className="size-4 text-muted-foreground" />
          <span className="flex-1">Leaves {leavingLabel(m.sendAt)}</span>
          {m.canCancel && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              disabled={cancelling}
              onClick={() => void cancel()}
            >
              Cancel sending
            </Button>
          )}
        </div>
      )}
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      {auth && !verified && (
        <p className="flex items-center gap-1.5 text-xs text-warning">
          <ShieldAlert aria-hidden className="size-3.5" />
          Not verified by the mail server
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

/** The conversation's latest mail, as a mention its thread can read (email_read takes its id). */
const mailMention = (d: InboxDetail) =>
  formatMention({
    kind: 'email',
    id: d.id.slice('mail:'.length),
    label: `${d.fromName || d.from} · ${d.subject || '(No subject)'}`,
  })

/**
 * What the thread did with a conversation it did not answer, in its own words, and what a person
 * can do about it: have it reply after all, talk it over in the thread, or reply themselves.
 */
function OutcomeLine({
  detail: d,
  about,
  onChanged,
}: {
  detail: InboxDetail
  about: string
  onChanged: () => Promise<void>
}) {
  const router = useRouter()
  const [replying, setReplying] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const outcome = d.outcome!
  const thread = d.thread!
  const who = d.teammate?.name ?? 'The teammate'
  const declined = outcome.kind === 'no_reply'

  async function ask() {
    setBusy(true)
    setError(undefined)
    try {
      await api(`/threads/${thread.id}/messages`, {
        body: { text: `Please reply to ${mailMention(d)} after all.` },
      })
      await api(`${itemPath(d.id)}/asked`, { body: {} })
      await onChanged()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }
  // Its thread opens with the mail in its box, ready for what the person has to say.
  function discuss() {
    addToReply(thread.id, `${mailMention(d)} `)
    router.push(`/app/threads/${thread.id}`)
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        className={cn(
          'flex flex-col gap-2 rounded-xl px-3.5 py-2.5',
          declined ? 'border border-warning/30 bg-warning/10' : 'border bg-secondary/40',
        )}
      >
        <p className="flex flex-wrap items-center gap-x-1.5 text-sm">
          <span
            aria-hidden
            className={cn(
              'size-1.5 flex-none rounded-full',
              declined ? 'bg-warning' : 'bg-primary',
            )}
          />
          <span className="font-medium">
            {declined ? `${who} didn’t reply` : `${who} handled it without a reply`}
          </span>
          <time dateTime={outcome.at} className="text-muted-foreground">
            · {timeAgo(outcome.at)}
          </time>
          {about && <span className="text-muted-foreground">· {about}</span>}
        </p>
        {outcome.note && (
          <p className="text-sm text-muted-foreground wrap-anywhere">“{outcome.note}”</p>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          {declined && d.mayPrompt && (
            <Button size="sm" disabled={busy} onClick={() => void ask()}>
              Ask {who} to reply
            </Button>
          )}
          {d.mayPrompt ? (
            <Button
              size="sm"
              variant={declined ? 'outline' : 'ghost'}
              className={cn(!declined && 'h-7 px-2')}
              onClick={discuss}
            >
              Discuss with {who}
            </Button>
          ) : (
            <Button asChild size="sm" variant="ghost" className="h-7 px-2">
              <Link href={`/app/threads/${thread.id}`}>
                Open its thread
                <ArrowUpRight aria-hidden />
              </Link>
            </Button>
          )}
          {declined && d.canReply && (
            <Button
              size="sm"
              variant="outline"
              aria-expanded={replying}
              onClick={() => setReplying((r) => !r)}
            >
              Reply myself
            </Button>
          )}
        </div>
      </div>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      {replying && (
        <ReplyForm
          detail={d}
          onCancel={() => setReplying(false)}
          onSent={async () => {
            setReplying(false)
            await onChanged()
          }}
        />
      )}
    </div>
  )
}

/** A person's own reply, from the conversation's mailbox, to its people. */
function ReplyForm({
  detail,
  onCancel,
  onSent,
}: {
  detail: InboxDetail
  onCancel: () => void
  onSent: () => Promise<void>
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  async function send() {
    if (!text.trim()) return
    setSending(true)
    setError(undefined)
    try {
      await api(`${itemPath(detail.id)}/reply`, { body: { text } })
      await onSent()
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
        void send()
      }}
    >
      <p className="text-sm text-muted-foreground">
        To {detail.fromName || detail.from}, from {detail.to}
      </p>
      <Textarea
        aria-label="Your reply"
        placeholder="Write your reply"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        autoFocus
      />
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={!text.trim() || sending}>
          {sending ? 'Sending…' : 'Send'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <span className="text-xs text-muted-foreground">
          It leaves in 30 seconds: you can cancel it until then.
        </span>
      </div>
    </form>
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
