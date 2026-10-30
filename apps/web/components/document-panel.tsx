'use client'
// Documents open in a panel beside whatever page is showing, the way an
// artifact opens beside a chat: from the library, a thread, search. Each one
// opened is a tab; from two on, a row of tabs shows them, with a dot on those
// a teammate changed since you last looked. The panel stays open while you
// move between pages, and its tabs across a reload.
import type { EditTarget, LibraryFile } from '@brigade/contracts'
import {
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  FileText,
  History,
  MessageSquare,
  X,
} from 'lucide-react'
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
import { useDocumentDiscussion } from '@/components/document-discussion'
import { useHandOff } from '@/components/list-items'
import { DocumentEditor } from '@/components/document-editor'
import { FileHistory } from '@/components/library-history'
import { PanelExpandButton, SidePanel } from '@/components/side-panel'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
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
  /**
   * The document Ask stepped aside from, below xl: the reply that mentions it offers
   * to open it again (AskedDocument), until the person dismisses that.
   */
  asked: OpenDocument | null
  setAsked: (document: OpenDocument | null) => void
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
  const [asked, setAsked] = useState<OpenDocument | null>(null)

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
    () => ({ current, tabs: state.tabs, changed, open, close, remove, closeAll, asked, setAsked }),
    [current, state.tabs, changed, open, close, remove, closeAll, asked],
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
  const { current, tabs, close, closeAll, setAsked } = useDocumentPanel()
  const [history, setHistory] = useState(false)
  // The editor again after a restore, with what was restored.
  const [opened, setOpened] = useState(0)
  const key = JSON.stringify(current?.target ?? null)
  useEffect(() => setHistory(false), [key])
  const libraryId = current?.target.kind === 'library' ? current.target.id : null
  const path = current?.subtitle ? `${current.subtitle}/${current.title}` : current?.title
  const file = useMemo(
    () => (libraryId && path ? { id: libraryId, path } : null),
    [libraryId, path],
  )
  const discussion = useDocumentDiscussion(file)
  const askName = discussion?.teammate?.name
  const discuss = discussion?.ask
  // Below xl the panel lies over the page (the whole screen on a phone): it steps
  // aside, so the thread Ask opens shows, and the reply offers it again.
  const onAsk = useMemo(
    () =>
      discuss &&
      current &&
      (async (passage?: string) => {
        await discuss(passage)
        if (window.matchMedia('(min-width: 1280px)').matches) return
        setAsked(current)
        close()
      }),
    [discuss, current, close, setAsked],
  )
  // Checklist lines picked in it go to a teammate (docs/lists.md).
  const handOff = useHandOff(file, discussion?.teammate ?? null)
  const ask = useMemo(
    () => (askName && onAsk ? { teammate: askName, onAsk, onHandOff: handOff.start } : undefined),
    [askName, onAsk, handOff.start],
  )
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
        {discussion?.teammate && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void onAsk?.()}
            tooltip={`Talk about this file with ${discussion.teammate.name}`}
          >
            <MessageSquare aria-hidden />
            Ask {discussion.teammate.name}
          </Button>
        )}
        {target.kind === 'library' && (
          <Button
            type="button"
            variant={history ? 'secondary' : 'ghost'}
            size="icon-sm"
            onClick={() => setHistory((h) => !h)}
            aria-pressed={history}
            aria-label="History"
            tooltip="History"
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
          tooltip={tabbed ? 'Close all' : 'Close'}
        >
          <X aria-hidden />
        </Button>
      </div>
      {history && target.kind === 'library' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <FileHistory
            file={{ id: target.id, path: path ?? current.title }}
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
            ask={ask}
          />
        </div>
      )}
      {handOff.dialog}
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
    <div className="flex h-10 shrink-0 flex-nowrap items-center gap-1 border-b pr-1.5">
      <div
        ref={row}
        role="tablist"
        aria-label="Open documents"
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1.5 [scrollbar-width:none]"
      >
        {tabs.map((t) => {
          const key = keyOf(t.target)
          const selected = key === active
          const changed = isChanged(t)
          const Icon = t.target.kind === 'library' ? FileText : BookOpen
          return (
            <div
              key={key}
              className={cn(
                'group flex h-7 shrink-0 items-center gap-1 rounded-md pr-1 pl-2 text-xs',
                selected
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              <Hint label={t.subtitle ? `${t.subtitle}/${t.title}` : t.title}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => open(t)}
                  // A middle click closes it, as in a browser.
                  onAuxClick={(e) => {
                    if (e.button === 1) remove(t.target)
                  }}
                  className="flex min-w-0 items-center gap-1.5 outline-none focus-visible:underline"
                >
                  <Icon aria-hidden className="size-3.5 shrink-0" />
                  <span className="max-w-40 truncate">{t.title}</span>
                  {changed && <span className="sr-only">, changed</span>}
                </button>
              </Hint>
              <Hint label="Close">
                <button
                  type="button"
                  aria-label={`Close ${t.title}`}
                  onClick={() => remove(t.target)}
                  className="grid size-4 shrink-0 place-items-center rounded-sm hover:bg-foreground/10"
                >
                  {/* Changed: a dot, which turns into the close button under the pointer. */}
                  {changed ? (
                    <>
                      <span className="flex group-hover:hidden">
                        <ChangedDot />
                      </span>
                      <X aria-hidden className="hidden size-3 group-hover:block" />
                    </>
                  ) : (
                    <X
                      aria-hidden
                      className={cn('size-3', !selected && 'opacity-0 group-hover:opacity-100')}
                    />
                  )}
                </button>
              </Hint>
            </div>
          )
        })}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="All open documents"
            tooltip="All open documents"
            className="relative"
          >
            <ChevronDown aria-hidden />
            {tabs.some((t) => isChanged(t)) && (
              <span className="absolute top-1 right-1 flex">
                <ChangedDot />
              </span>
            )}
          </Button>
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

/**
 * Above a reply that mentions the document Ask stepped aside from: a tap opens it
 * again. Gone once the reply is sent (it no longer mentions it) or dismissed.
 */
export function AskedDocument({ text }: { text: string }) {
  const documents = useOptionalDocumentPanel()
  const asked = documents?.asked
  if (!documents || asked?.target.kind !== 'library') return null
  if (!text.includes(`(document:${asked.target.id})`)) return null
  if (documents.current && keyOf(documents.current.target) === keyOf(asked.target)) return null
  return (
    <div className="flex items-center gap-2 pl-2 text-sm text-muted-foreground">
      <FileText className="size-4 shrink-0" aria-hidden />
      <Hint label={`Open ${asked.title}`}>
        <button
          type="button"
          onClick={() => documents.open(asked)}
          aria-label={`Open ${asked.title}`}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none hover:text-foreground focus-visible:underline"
        >
          <span className="min-w-0 truncate font-medium text-foreground">{asked.title}</span>
          <ArrowUpRight aria-hidden className="size-4 shrink-0" />
        </button>
      </Hint>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="shrink-0 rounded-full"
        onClick={() => documents.setAsked(null)}
        aria-label={`Don’t offer ${asked.title} again`}
        tooltip="Dismiss"
      >
        <X aria-hidden />
      </Button>
    </div>
  )
}
