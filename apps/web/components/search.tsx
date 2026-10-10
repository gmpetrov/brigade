'use client'
// Search everything from anywhere: ⌘K (Ctrl+K), or the box at the top of the
// sidebar. Pages match as you type; the rest comes from the API, which applies
// the same rules as each page, so nothing turns up that the member can't open.
import type { SearchKind, SearchResult } from '@brigade/contracts'
import {
  ArrowRight,
  Bot,
  Brain,
  CalendarClock,
  CornerDownLeft,
  FileText,
  GitPullRequest,
  History,
  Inbox,
  KeyRound,
  MessagesSquare,
  Monitor,
  Plug,
  Search as SearchIcon,
  SquareKanban,
  UserRound,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isAdmin, NAV, useDashboard } from '@/components/dashboard'
import { isMac, useIsMac } from '@/components/quick-thread'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { api, pullHref } from '@/lib/api'
import { cn } from '@/lib/utils'

/** One row in the popup, whatever it came from. */
type Item = {
  key: string
  /** page, or what the API found. */
  kind: SearchKind | 'page'
  title: string
  detail: string | null
  snippet: string | null
  href: string
}

const GROUPS: { kind: Item['kind']; label: string; icon: LucideIcon }[] = [
  { kind: 'page', label: 'Pages', icon: ArrowRight },
  { kind: 'teammate', label: 'AI teammates', icon: Bot },
  { kind: 'thread', label: 'Threads', icon: MessagesSquare },
  { kind: 'task', label: 'Tasks', icon: SquareKanban },
  { kind: 'pull_request', label: 'Pull requests', icon: GitPullRequest },
  { kind: 'ticket', label: 'Tickets', icon: Inbox },
  { kind: 'automation', label: 'Automations', icon: CalendarClock },
  { kind: 'file', label: 'Library', icon: FileText },
  { kind: 'memory', label: 'Memory', icon: Brain },
  { kind: 'connection', label: 'Connections', icon: Plug },
  { kind: 'trigger', label: 'Triggers', icon: Zap },
  { kind: 'credential', label: 'Vault', icon: KeyRound },
  { kind: 'account', label: 'AI accounts', icon: UserRound },
  { kind: 'computer', label: 'Computers', icon: Monitor },
]
const ICON = Object.fromEntries(GROUPS.map((g) => [g.kind, g.icon])) as Record<
  Item['kind'],
  LucideIcon
>

/** Where a result opens. */
function hrefOf(r: SearchResult) {
  switch (r.kind) {
    case 'thread':
      return `/app/threads/${r.id}`
    case 'teammate':
      return `/app/teammates/${r.id}`
    case 'task':
      return `/app/tasks?task=${r.id}`
    case 'pull_request':
      return r.pull ? pullHref(r.pull.repository, r.pull.number) : '/app/pulls'
    case 'ticket':
      return r.threadId ? `/app/threads/${r.threadId}` : '/app/tickets'
    case 'automation':
      return '/app/automations'
    case 'file':
      return `/app/library?file=${r.id}`
    case 'memory':
      return '/app/library?tab=memory'
    case 'connection':
    case 'trigger':
      return '/app/connections'
    case 'credential':
      return '/app/vault'
    case 'account':
      return '/app/accounts'
    case 'computer':
      return '/app/computers'
  }
}

const words = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean)

/** Last opened first, a few per workspace, kept in this browser only. */
const RECENT_MAX = 6
const recentKey = (workspaceId: string) => `brigade.search.recent.${workspaceId}`
function readRecent(workspaceId: string): Item[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(recentKey(workspaceId)) ?? '[]') as unknown
    return Array.isArray(parsed) ? (parsed as Item[]).slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}
function saveRecent(workspaceId: string, item: Item) {
  try {
    const kept = readRecent(workspaceId).filter((r) => r.key !== item.key)
    const next = [{ ...item, snippet: null }, ...kept].slice(0, RECENT_MAX)
    localStorage.setItem(recentKey(workspaceId), JSON.stringify(next))
  } catch {
    // Private windows and full storage just forget.
  }
}
function forgetRecent(workspaceId: string, key: string) {
  try {
    const next = readRecent(workspaceId).filter((r) => r.key !== key)
    localStorage.setItem(recentKey(workspaceId), JSON.stringify(next))
  } catch {}
}

/** Matches arrive between « and »; shown highlighted. */
function Snippet({ text }: { text: string }) {
  return (
    <span className="line-clamp-2 text-xs text-muted-foreground">
      {text.split(/«|»/).map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-primary/15 px-0.5 text-foreground">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  )
}

/** The sidebar's search box: a button that looks like one, with its shortcut. */
export function SearchButton({ onClick }: { onClick: () => void }) {
  const mac = useIsMac()
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 w-full items-center gap-2 rounded-md border bg-background px-2.5 text-sm text-muted-foreground shadow-xs transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:hidden"
    >
      <SearchIcon className="size-4 shrink-0" aria-hidden />
      <span className="flex-1 text-left">Search…</span>
      <kbd className="font-sans text-xs text-muted-foreground">{mac ? '⌘K' : 'Ctrl K'}</kbd>
    </button>
  )
}

export function SearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const mac = useIsMac()
  const { me } = useDashboard()
  const workspaceId = me.activeWorkspaceId ?? ''
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<{ query: string; results: SearchResult[] }>()
  const [error, setError] = useState<string>()
  const [recent, setRecent] = useState<Item[]>([])
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  // ⌘K anywhere opens it, and closes it again.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Taken already: the terminal, the remote desktop.
      if (e.defaultPrevented || e.repeat) return
      const command = isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      if (!command || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'k') return
      // Not over another dialog.
      if (!open && document.querySelector('[role=dialog][data-state=open]')) return
      e.preventDefault()
      onOpenChange(!open)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onOpenChange])

  // Each opening starts empty, with what was opened last.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setFound(undefined)
    setError(undefined)
    setRecent(readRecent(workspaceId))
  }, [open, workspaceId])

  const trimmed = query.trim()
  useEffect(() => {
    if (!open || !trimmed) return
    let live = true
    const timer = setTimeout(() => {
      api<SearchResult[]>(`/search?q=${encodeURIComponent(trimmed)}`).then(
        (results) => live && (setFound({ query: trimmed, results }), setError(undefined)),
        (e: Error) => live && setError(e.message),
      )
    }, 150)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [open, trimmed])

  const pages = useMemo<Item[]>(() => {
    const all = NAV.map((n) => ({ href: n.href, title: n.label }))
    if (isAdmin(me)) all.push({ href: '/app/teammates/new', title: 'New AI teammate' })
    return all.map((p) => ({
      key: `page:${p.href}`,
      kind: 'page',
      title: p.title,
      detail: null,
      snippet: null,
      href: p.href,
    }))
  }, [me])

  // Pages at once; the rest once the API answers for this query (or the last one, meanwhile).
  const groups = useMemo(() => {
    if (!trimmed) {
      const items = recent.length > 0 ? recent : pages
      return [{ label: recent.length > 0 ? 'Recent' : 'Go to', items }]
    }
    const wanted = words(trimmed)
    const matchingPages = pages.filter((p) =>
      wanted.every((w) => p.title.toLowerCase().includes(w)),
    )
    const items: Item[] = [
      ...matchingPages,
      ...(found?.results ?? []).map((r) => ({
        key: `${r.kind}:${r.id}`,
        kind: r.kind,
        title: r.title,
        detail: r.detail,
        snippet: r.snippet,
        href: hrefOf(r),
      })),
    ]
    return GROUPS.map((g) => ({
      label: g.label,
      items: items.filter((i) => i.kind === g.kind),
    })).filter((g) => g.items.length > 0)
  }, [trimmed, recent, pages, found])
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])
  const searching = Boolean(trimmed) && found?.query !== trimmed && !error

  // The first row again whenever the rows change underneath.
  useEffect(() => setActive(0), [trimmed, found])
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = useCallback(
    (item: Item, newTab = false) => {
      saveRecent(workspaceId, item)
      if (newTab) {
        window.open(item.href, '_blank', 'noopener')
        return
      }
      onOpenChange(false)
      router.push(item.href)
    },
    [onOpenChange, router, workspaceId],
  )

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault()
      setActive((i) => (flat.length ? (i + 1) % flat.length : 0))
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault()
      setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0))
    } else if (e.key === 'Enter') {
      const item = flat[active]
      if (!item) return
      e.preventDefault()
      choose(item, e.metaKey || e.ctrlKey)
    }
  }

  let index = -1
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[12%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-2xl"
        onKeyDown={onKeyDown}
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">
          Search pages, threads, tasks, files, teammates, connections and more.
        </DialogDescription>
        <div className="flex items-center gap-3 border-b px-4">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            aria-label="Search"
            role="combobox"
            aria-expanded
            aria-controls="search-results"
            aria-activedescendant={flat[active] ? `search-item-${active}` : undefined}
            className="h-12 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
          />
          {searching && (
            <span className="text-xs text-muted-foreground" aria-live="polite">
              Searching…
            </span>
          )}
        </div>

        <div
          ref={list}
          id="search-results"
          role="listbox"
          className="max-h-[min(28rem,60svh)] overflow-y-auto p-2"
        >
          {error && <p className="px-3 py-6 text-center text-sm text-destructive-text">{error}</p>}
          {!error && trimmed && !searching && flat.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              Nothing matches “{trimmed}”.
            </p>
          )}
          {groups.map((group) => (
            <div key={group.label} role="group" aria-label={group.label} className="pb-1">
              <div className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                {group.label}
              </div>
              {group.items.map((item) => {
                index += 1
                const i = index
                const Icon =
                  group.label === 'Recent' ? (ICON[item.kind] ?? History) : ICON[item.kind]
                return (
                  <div
                    key={item.key}
                    id={`search-item-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={i === active}
                    onMouseMove={() => i !== active && setActive(i)}
                    onClick={(e) => choose(item, e.metaKey || e.ctrlKey)}
                    className={cn(
                      'group/item flex cursor-pointer items-start gap-3 rounded-md px-3 py-2',
                      i === active && 'bg-accent text-accent-foreground',
                    )}
                  >
                    <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-sm">{item.title}</span>
                      {item.detail && (
                        <span className="truncate text-xs text-muted-foreground">
                          {item.detail}
                        </span>
                      )}
                      {item.snippet && <Snippet text={item.snippet} />}
                    </span>
                    {group.label === 'Recent' && (
                      <button
                        type="button"
                        aria-label={`Remove ${item.title} from recent`}
                        onClick={(e) => {
                          e.stopPropagation()
                          forgetRecent(workspaceId, item.key)
                          setRecent(readRecent(workspaceId))
                        }}
                        className="invisible rounded-sm p-0.5 text-muted-foreground group-hover/item:visible hover:text-foreground"
                      >
                        <X className="size-3.5" />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-4 border-t px-4 py-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <kbd className="rounded border bg-muted px-1 font-sans">↑</kbd>
            <kbd className="rounded border bg-muted px-1 font-sans">↓</kbd>
            Select
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className="rounded border bg-muted px-1 font-sans">
              <CornerDownLeft className="inline size-3" aria-label="Enter" />
            </kbd>
            Open
          </span>
          <span className="hidden items-center gap-1.5 sm:flex">
            <kbd className="rounded border bg-muted px-1 font-sans">{mac ? '⌘' : 'Ctrl'}</kbd>
            <kbd className="rounded border bg-muted px-1 font-sans">
              <CornerDownLeft className="inline size-3" aria-label="Enter" />
            </kbd>
            New tab
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <kbd className="rounded border bg-muted px-1 font-sans">Esc</kbd>
            Close
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
