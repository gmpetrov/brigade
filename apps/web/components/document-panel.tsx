'use client'
// Documents open in a panel beside whatever page is showing, the way an
// artifact opens beside a chat: from the library, a thread, search. Each one
// opened is a tab; from two on, a row of tabs shows them, with a dot on those
// a teammate changed since you last looked. The panel stays open while you
// move between pages, and its tabs across a reload.
import type { EditTarget, LibraryFile } from '@brigade/contracts'
import { BookOpen, ChevronDown, FileText, History, X } from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { DocumentEditor } from '@/components/document-editor'
import { FileHistory } from '@/components/library-history'
import { PanelExpandButton, SidePanel } from '@/components/side-panel'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { api } from '@/lib/api'
import { changedSince, type Stamps } from '@/lib/document-changes'
import { useLive } from '@/lib/use-live'
import { cn } from '@/lib/utils'

export type OpenDocument = {
  target: EditTarget
  /** "refunds.md", "Workspace memory". */
  title: string
  /** The folder, or what the document is for. */
  subtitle?: string
}

type DocumentPanel = {
  /** The tab in front, while the panel shows. */
  current: OpenDocument | null
  tabs: OpenDocument[]
  /** Library files a teammate changed since you last had them in front. */
  changed: ReadonlySet<string>
  /** Shows it, in its tab: a new one after the tab in front. */
  open: (document: OpenDocument) => void
  /** Hides the panel; its tabs come back with the next document opened. */
  close: () => void
  /** Closes a document's tab, e.g. once the file is deleted. */
  remove: (target: EditTarget) => void
  /** Closes every tab, and the panel. */
  closeAll: () => void
}

const Context = createContext<DocumentPanel | null>(null)
const TABS_KEY = 'brigade:open-documents'
/** Before tabs: the one document open. */
const OPEN_KEY = 'brigade:open-document'

const keyOf = (target: EditTarget) => JSON.stringify(target)

export function useDocumentPanel() {
  const value = useContext(Context)
  if (!value) throw new Error('useDocumentPanel outside DocumentPanelProvider')
  return value
}

/** The panel, where there is one (the dashboard); null elsewhere. */
export const useOptionalDocumentPanel = () => useContext(Context)

/** A library file's panel title: its name, and its folder below. */
export function libraryDocument(file: { id: string; path: string }): OpenDocument {
  const slash = file.path.lastIndexOf('/')
  return {
    target: { kind: 'library', id: file.id },
    title: file.path.slice(slash + 1),
    ...(slash > 0 ? { subtitle: file.path.slice(0, slash) } : {}),
  }
}

type Tabs = { tabs: OpenDocument[]; active: string | null }

export function DocumentPanelProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Tabs>({ tabs: [], active: null })
  const [changed, setChanged] = useState<ReadonlySet<string>>(new Set())

  // What was open before a reload, in this tab.
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(TABS_KEY)
      if (saved) return setState(JSON.parse(saved) as Tabs)
      const one = sessionStorage.getItem(OPEN_KEY)
      if (one) {
        const document = JSON.parse(one) as OpenDocument
        setState({ tabs: [document], active: keyOf(document.target) })
      }
    } catch {}
  }, [])

  const update = useCallback((next: (s: Tabs) => Tabs) => {
    setState((s) => {
      const state = next(s)
      try {
        if (state.tabs.length) sessionStorage.setItem(TABS_KEY, JSON.stringify(state))
        else sessionStorage.removeItem(TABS_KEY)
        sessionStorage.removeItem(OPEN_KEY)
      } catch {}
      return state
    })
  }, [])

  const seen = useCallback((target: EditTarget) => {
    if (target.kind !== 'library') return
    setChanged((c) => {
      if (!c.has(target.id)) return c
      const next = new Set(c)
      next.delete(target.id)
      return next
    })
  }, [])

  const open = useCallback(
    (document: OpenDocument) => {
      const key = keyOf(document.target)
      seen(document.target)
      update(({ tabs, active }) => {
        const at = tabs.findIndex((t) => keyOf(t.target) === key)
        if (at >= 0) return { tabs: tabs.with(at, document), active: key }
        const after = tabs.findIndex((t) => keyOf(t.target) === active)
        return { tabs: tabs.toSpliced(after + 1, 0, document), active: key }
      })
    },
    [update, seen],
  )
  const close = useCallback(() => update((s) => ({ ...s, active: null })), [update])
  const closeAll = useCallback(() => update(() => ({ tabs: [], active: null })), [update])
  const remove = useCallback(
    (target: EditTarget) => {
      const key = keyOf(target)
      update(({ tabs, active }) => {
        const at = tabs.findIndex((t) => keyOf(t.target) === key)
        if (at < 0) return { tabs, active }
        const rest = tabs.toSpliced(at, 1)
        if (active !== key) return { tabs: rest, active }
        // The neighbour comes in front, as in an editor.
        const next = rest[Math.min(at, rest.length - 1)]
        if (next) seen(next.target)
        return { tabs: rest, active: next ? keyOf(next.target) : null }
      })
    },
    [update, seen],
  )

  const current = state.tabs.find((t) => keyOf(t.target) === state.active) ?? null
  const value = useMemo(
    () => ({ current, tabs: state.tabs, changed, open, close, remove, closeAll }),
    [current, state.tabs, changed, open, close, remove, closeAll],
  )
  // Kept while the panel is hidden, so what changed meanwhile still shows when it comes back.
  const stamps = useRef<Stamps>(new Map())
  const watched = state.tabs.flatMap((t) => (t.target.kind === 'library' ? [t.target.id] : []))
  return (
    <Context.Provider value={value}>
      {children}
      {current && state.tabs.length > 1 && watched.length > 0 && (
        <WatchChanges
          stamps={stamps.current}
          ids={watched}
          front={current.target.kind === 'library' ? current.target.id : null}
          onChanged={(ids) => setChanged((c) => new Set([...c, ...ids]))}
        />
      )}
    </Context.Provider>
  )
}

/**
 * Marks the library files open in tabs behind the one in front when a
 * teammate changes them: each time the library changes, compares when each
 * was last written with what it was before.
 */
function WatchChanges({
  stamps,
  ids,
  front,
  onChanged,
}: {
  stamps: Stamps
  ids: string[]
  front: string | null
  onChanged: (ids: string[]) => void
}) {
  const latest = useRef({ ids, front, onChanged })
  latest.current = { ids, front, onChanged }

  const check = useCallback(async () => {
    let files: LibraryFile[]
    try {
      files = await api<LibraryFile[]>('/library')
    } catch {
      return
    }
    const { ids, front, onChanged } = latest.current
    const marked = changedSince(stamps, files, ids, front)
    if (marked.length) onChanged(marked)
  }, [stamps])

  // A look as it shows and each time the tabs change: what changed while the
  // panel was hidden, and where each new tab's file stands, to compare with later.
  const opened = ids.join()
  useEffect(() => {
    void check()
  }, [opened, check])

  useLive((message) => {
    if (message.type === 'library.updated') void check()
  })
  return null
}

/** The open document, beside the page. Rendered once, by the dashboard. */
export function DocumentPanel() {
  const { current, tabs, close, closeAll } = useDocumentPanel()
  const [history, setHistory] = useState(false)
  // The editor again after a restore, with what was restored.
  const [opened, setOpened] = useState(0)
  const key = JSON.stringify(current?.target ?? null)
  useEffect(() => setHistory(false), [key])
  if (!current) return null
  const Icon = current.target.kind === 'library' ? FileText : BookOpen
  const target = current.target
  const tabbed = tabs.length > 1
  return (
    <SidePanel aria-label={current.title} onClose={close} raiseKey={current}>
      {tabbed && <DocumentTabs />}
      <div className="flex flex-nowrap items-center gap-2 border-b px-3 py-2.5">
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          {/* With tabs, the tab names it: only its folder here. */}
          {!(tabbed && current.subtitle) && (
            <strong className="truncate text-sm font-semibold">{current.title}</strong>
          )}
          {current.subtitle && (
            <span
              className={cn(
                'truncate text-xs text-muted-foreground',
                current.target.kind === 'library' && 'font-mono',
              )}
              title={current.subtitle}
            >
              {current.subtitle}
            </span>
          )}
        </div>
        {target.kind === 'library' && (
          <Button
            type="button"
            variant={history ? 'secondary' : 'ghost'}
            size="icon-sm"
            onClick={() => setHistory((h) => !h)}
            aria-pressed={history}
            aria-label="History"
            title="History"
          >
            <History aria-hidden />
          </Button>
        )}
        <PanelExpandButton />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={closeAll}
          aria-label={tabbed ? 'Close all documents' : 'Close document'}
          title={tabbed ? 'Close all' : 'Close'}
        >
          <X aria-hidden />
        </Button>
      </div>
      {history && target.kind === 'library' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <FileHistory
            file={{
              id: target.id,
              path: current.subtitle ? `${current.subtitle}/${current.title}` : current.title,
            }}
            onRestored={() => {
              setHistory(false)
              setOpened((n) => n + 1)
            }}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-4">
          <DocumentEditor
            key={`${key}:${opened}`}
            target={current.target}
            label={current.title}
            className="min-h-full"
          />
        </div>
      )}
    </SidePanel>
  )
}

const ChangedDot = () => <span aria-hidden className="size-1.5 flex-none rounded-full bg-primary" />

/** A tab per open document, and a menu of them all for those the row cannot fit. */
function DocumentTabs() {
  const { current, tabs, changed, open, remove, closeAll } = useDocumentPanel()
  const row = useRef<HTMLDivElement>(null)
  const active = current ? keyOf(current.target) : null
  const isChanged = (t: OpenDocument) => t.target.kind === 'library' && changed.has(t.target.id)

  // The tab in front stays in view.
  useEffect(() => {
    row.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  return (
    <div className="flex flex-nowrap items-stretch border-b bg-muted/40">
      <div
        ref={row}
        role="tablist"
        aria-label="Open documents"
        className="flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]"
      >
        {tabs.map((t) => {
          const key = keyOf(t.target)
          const selected = key === active
          return (
            <div
              key={key}
              className={cn(
                'group/tab flex max-w-44 min-w-0 shrink-0 items-center border-r text-xs',
                selected
                  ? 'bg-background text-foreground shadow-[inset_0_-2px_0_var(--primary)]'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                title={t.subtitle ? `${t.subtitle}/${t.title}` : t.title}
                onClick={() => open(t)}
                // A middle click closes it, as in a browser.
                onAuxClick={(e) => {
                  if (e.button === 1) remove(t.target)
                }}
                className="flex min-w-0 items-center gap-1.5 py-2 pl-3 outline-none focus-visible:underline"
              >
                {isChanged(t) && <ChangedDot />}
                <span className="truncate">{t.title}</span>
                {isChanged(t) && <span className="sr-only">, changed</span>}
              </button>
              <button
                type="button"
                aria-label={`Close ${t.title}`}
                title="Close"
                onClick={() => remove(t.target)}
                className={cn(
                  'mr-1 ml-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-accent focus-visible:opacity-100',
                  selected ? 'opacity-70' : 'opacity-0 group-hover/tab:opacity-70',
                )}
              >
                <X aria-hidden className="size-3" />
              </button>
            </div>
          )
        })}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="All open documents"
            title="All open documents"
            className="relative flex w-8 shrink-0 items-center justify-center border-l text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronDown aria-hidden className="size-4" />
            {tabs.some((t) => isChanged(t)) && (
              <span className="absolute top-1.5 right-1.5">
                <ChangedDot />
              </span>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {tabs.map((t) => (
            <DropdownMenuItem
              key={keyOf(t.target)}
              onSelect={() => open(t)}
              className={cn(keyOf(t.target) === active && 'bg-accent/60 font-medium')}
            >
              <span className="flex w-1.5 shrink-0 justify-center">
                {isChanged(t) && <ChangedDot />}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{t.title}</span>
                {t.subtitle && (
                  <span className="truncate text-xs text-muted-foreground">{t.subtitle}</span>
                )}
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={closeAll}>Close all</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
