'use client'
// Documents open in a panel beside whatever page is showing, the way an
// artifact opens beside a chat: from the library, a thread, search. Any library
// file opens here, shown as what it is (lib/file-view.ts): a Markdown document
// in the live editor, another text file as text, anything else as the library
// previews it; memory files too. Each one opened is a tab; from two on, a row of tabs shows them, with a dot on those
// a teammate changed since you last looked. The panel stays open while you
// move between pages, and its tabs across a reload. Minimized (⌄, ⌘. or a
// swipe down on a phone), it waits in a pill at the bottom right, with what it
// shows kept as it was: a click on the pill brings it back.
import type { EditTarget, LibraryFile } from '@brigade/contracts'
import {
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  Download,
  FileText,
  History,
  List,
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
import { DocumentPath } from '@/components/document-path'
import { fileIcon } from '@/components/file-icon'
import { FilePreview } from '@/components/file-preview'
import { FileHistory } from '@/components/library-history'
import { TextFile } from '@/components/library-text-file'
import { PUBLIC_LINK, ShareButton, useShare } from '@/components/share-button'
import { editable, PanelExpandButton, SidePanel } from '@/components/side-panel'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { api, ApiError } from '@/lib/api'
import { changedSince, type Stamps } from '@/lib/document-changes'
import {
  downloadable,
  fileView,
  lookupAfter,
  type FileLookup,
  type FileView,
} from '@/lib/file-view'
import { contentUrl } from '@/lib/library-urls'
import { isMac, useIsMac } from '@/lib/platform'
import { useLive } from '@/lib/use-live'
import { cn } from '@/lib/utils'

export type OpenDocument = {
  target: EditTarget
  /** "refunds.md", "Workspace memory". */
  title: string
  /** The folder, or what the document is for. */
  subtitle?: string
  /**
   * A library file: what it is, when the opener knew (the library's list, a thread's file), so
   * it shows at once. Otherwise the panel asks the API (lib/file-view.ts).
   */
  contentType?: string
  editable?: boolean
}

/** `history`: open on its History, as the library's row menu asks. */
type OpenOptions = { history?: boolean }

type DocumentPanel = {
  /** The tab in front, while the panel shows (not minimized). */
  current: OpenDocument | null
  /** The tab in front while the panel is minimized to its pill. */
  minimized: OpenDocument | null
  tabs: OpenDocument[]
  /** Library files a teammate changed since you last had them in front. */
  changed: ReadonlySet<string>
  /** Shows it, in its tab: a new one after the tab in front. */
  open: (document: OpenDocument, options?: OpenOptions) => void
  /** Shows it in place of the tab in front (or in its own tab, when it has one already). */
  replace: (document: OpenDocument) => void
  /** The tab, by its key, that was opened on its History: it shows that first. */
  historyFor: string | null
  /** Hides the panel; its tabs come back with the next document opened. */
  close: () => void
  /** Puts it away in a pill, what it shows kept; `restore` (or opening a document) brings it back. */
  minimize: () => void
  restore: () => void
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

/** A library file's panel title: its name, and its folder below; what it is, when known. */
export function libraryDocument(file: {
  id: string
  path: string
  contentType?: string
  editable?: boolean
}): OpenDocument {
  const slash = file.path.lastIndexOf('/')
  return {
    target: { kind: 'library', id: file.id },
    title: file.path.slice(slash + 1),
    ...(slash > 0 ? { subtitle: file.path.slice(0, slash) } : {}),
    ...(file.contentType !== undefined ? { contentType: file.contentType } : {}),
    ...(file.editable !== undefined ? { editable: file.editable } : {}),
  }
}

type Tabs = { tabs: OpenDocument[]; active: string | null; minimized?: boolean }

export function DocumentPanelProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Tabs>({ tabs: [], active: null })
  const [changed, setChanged] = useState<ReadonlySet<string>>(new Set())
  const [asked, setAsked] = useState<OpenDocument | null>(null)
  const [historyFor, setHistoryFor] = useState<string | null>(null)

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
    (document: OpenDocument, options: OpenOptions = {}) => {
      const key = keyOf(document.target)
      seen(document.target)
      setHistoryFor(options.history ? key : null)
      update(({ tabs, active }) => {
        const at = tabs.findIndex((t) => keyOf(t.target) === key)
        if (at >= 0) return { tabs: tabs.with(at, document), active: key, minimized: false }
        const after = tabs.findIndex((t) => keyOf(t.target) === active)
        return { tabs: tabs.toSpliced(after + 1, 0, document), active: key, minimized: false }
      })
    },
    [update, seen],
  )
  const replace = useCallback(
    (document: OpenDocument) => {
      const key = keyOf(document.target)
      seen(document.target)
      setHistoryFor(null)
      update(({ tabs, active }) => {
        const at = tabs.findIndex((t) => keyOf(t.target) === key)
        if (at >= 0) return { tabs: tabs.with(at, document), active: key, minimized: false }
        const front = tabs.findIndex((t) => keyOf(t.target) === active)
        if (front < 0) return { tabs: [...tabs, document], active: key, minimized: false }
        return { tabs: tabs.with(front, document), active: key, minimized: false }
      })
    },
    [update, seen],
  )
  const close = useCallback(
    () => update((s) => ({ ...s, active: null, minimized: false })),
    [update],
  )
  const minimize = useCallback(
    () => update((s) => (s.active ? { ...s, minimized: true } : s)),
    [update],
  )
  const restore = useCallback(
    () =>
      update((s) => {
        // What changed while it was put away has been seen once it is back.
        const front = s.tabs.find((t) => keyOf(t.target) === s.active)
        if (front) seen(front.target)
        return { ...s, minimized: false }
      }),
    [update, seen],
  )
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

  const front = state.tabs.find((t) => keyOf(t.target) === state.active) ?? null
  const current = state.minimized ? null : front
  const minimized = state.minimized ? front : null
  const value = useMemo(
    () => ({
      current,
      minimized,
      tabs: state.tabs,
      changed,
      open,
      replace,
      historyFor,
      close,
      minimize,
      restore,
      remove,
      closeAll,
      asked,
      setAsked,
    }),
    [
      current,
      minimized,
      state.tabs,
      changed,
      open,
      replace,
      historyFor,
      close,
      minimize,
      restore,
      remove,
      closeAll,
      asked,
    ],
  )
  // Kept while the panel is hidden, so what changed meanwhile still shows when it comes back.
  const stamps = useRef<Stamps>(new Map())
  const watched = state.tabs.flatMap((t) => (t.target.kind === 'library' ? [t.target.id] : []))
  return (
    <Context.Provider value={value}>
      {children}
      {front && (state.tabs.length > 1 || state.minimized) && watched.length > 0 && (
        <WatchChanges
          stamps={stamps.current}
          ids={watched}
          // Minimized, the one in front is out of sight too: its changes are marked.
          front={!state.minimized && front.target.kind === 'library' ? front.target.id : null}
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

/**
 * A library file as the API has it now (GET /library/:id), again each time the library
 * changes: undefined until it answers, or when it never could; null once it says the file is
 * gone. A refresh that fails keeps what was read (lookupAfter). A route the API does not have
 * yet answers 404 without that message: not taken for gone.
 */
function useLibraryFile(id: string | null) {
  const [state, setState] = useState<FileLookup<LibraryFile>>()
  const asked = useRef(0)
  const load = useCallback(() => {
    if (!id) return
    const ask = ++asked.current
    api<LibraryFile>(`/library/${id}`).then(
      (file) => ask === asked.current && setState((s) => lookupAfter(s, id, { file })),
      (e: Error) => {
        if (ask !== asked.current) return
        const gone = e instanceof ApiError && e.status === 404 && e.message === 'File not found'
        setState((s) => lookupAfter(s, id, gone ? { gone: true } : { error: e.message }))
      },
    )
  }, [id])
  useEffect(() => load(), [load])
  useLive((message) => {
    if (message.type === 'library.updated') load()
  })
  const now = state?.id === id ? state : undefined
  return { file: now?.file, error: now?.error, reload: load }
}

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/** A tab's icon: a memory file's, else its file's by what it is, as far as known. */
function iconOf(document: OpenDocument) {
  if (document.target.kind !== 'library') return BookOpen
  if (document.contentType) return fileIcon(document.contentType)
  return FileText
}

/** The open document, beside the page. Rendered once, by the dashboard. */
export function DocumentPanel() {
  const {
    current: shown,
    minimized,
    tabs,
    historyFor,
    close,
    closeAll,
    minimize,
    restore,
    setAsked,
  } = useDocumentPanel()
  // Minimized, it stays mounted, hidden: an edit not saved yet is still there when it is back.
  const current = shown ?? minimized
  useMinimizeShortcut(Boolean(shown), Boolean(minimized), minimize, restore)
  const swipe = useSwipeDown(minimize)
  const [history, setHistory] = useState(false)
  // The editor again after a restore, with what was restored.
  const [opened, setOpened] = useState(0)
  const key = JSON.stringify(current?.target ?? null)
  // Each tab opens on the file, unless it was opened on its History.
  useEffect(() => setHistory(historyFor === key), [key, historyFor])
  const libraryId = current?.target.kind === 'library' ? current.target.id : null
  const looked = useLibraryFile(libraryId)
  // Where it is now (moved since it opened, it says so), else where it was opened from.
  const opener = current?.subtitle ? `${current.subtitle}/${current.title}` : current?.title
  const path = looked.file?.path ?? opener
  const file = useMemo(
    () => (libraryId && path ? { id: libraryId, path } : null),
    [libraryId, path],
  )
  const discussion = useDocumentDiscussion(file)
  const link = useShare(libraryId)
  const share = link.share
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
  const target = current.target
  const view: FileView =
    target.kind === 'library' ? fileView(current.title, current, looked.file) : 'editor'
  const contentType = looked.file?.contentType ?? current.contentType
  const Icon = target.kind !== 'library' ? BookOpen : contentType ? fileIcon(contentType) : FileText
  const name = path ? path.slice(path.lastIndexOf('/') + 1) : current.title
  const tabbed = tabs.length > 1
  return (
    <>
      <SidePanel
        aria-label={current.title}
        onClose={close}
        onPageChange={minimize}
        raiseKey={current}
        besideSidebar
        hidden={!shown}
      >
        {/* On a phone, where it fills the screen: swiped down, it goes to its pill. */}
        <div {...swipe} className="shrink-0">
          <div
            aria-hidden
            className="mx-auto mt-2 h-1 w-9 rounded-full bg-muted-foreground/40 md:hidden"
          />
          {tabbed && <DocumentTabs />}
          <div className="flex flex-nowrap items-center gap-2 border-b px-3 py-2.5">
            <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-1 flex-col">
              {/* With tabs, the tab names it: only its folder here. */}
              {!(tabbed && (current.subtitle || target.kind === 'library')) && (
                <strong className="truncate text-sm font-semibold">
                  {target.kind === 'library' ? name : current.title}
                </strong>
              )}
              {(current.subtitle || target.kind === 'library' || share) && (
                <div className="flex min-w-0 items-center text-xs text-muted-foreground">
                  {target.kind === 'library' ? (
                    <DocumentPath
                      folder={path ? parentOf(path) : (current.subtitle ?? '')}
                      fileId={target.id}
                      path={path ?? current.title}
                    />
                  ) : (
                    current.subtitle && (
                      <span className="truncate" title={current.subtitle}>
                        {current.subtitle}
                      </span>
                    )
                  )}
                  {(current.subtitle || target.kind === 'library') && share && (
                    <span aria-hidden className="shrink-0 px-1">
                      ·
                    </span>
                  )}
                  {share && <span className="shrink-0">{PUBLIC_LINK}</span>}
                </div>
              )}
            </div>
            {discussion?.teammate && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void onAsk?.()}
                tooltip={`Talk about this file with ${discussion.teammate.name}`}
                aria-label={`Ask ${discussion.teammate.name}`}
              >
                <MessageSquare aria-hidden />
                {/* On a phone, the icon alone: the file's path needs the room. */}
                <span className="max-sm:hidden">Ask {discussion.teammate.name}</span>
              </Button>
            )}
            {target.kind === 'library' && <ShareButton key={target.id} name={name} link={link} />}
            {target.kind === 'library' && downloadable(view) && (
              <Button asChild variant="ghost" size="icon-sm" tooltip="Download">
                <a href={contentUrl(target.id, true)} aria-label="Download">
                  <Download aria-hidden />
                </a>
              </Button>
            )}
            {target.kind === 'library' && view !== 'missing' && (
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
            {/* What acts on the panel itself, apart from what acts on the file. */}
            <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />
            <MinimizeButton onMinimize={minimize} />
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
        </div>
        {history && target.kind === 'library' && view !== 'missing' ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <FileHistory
              file={{ id: target.id, path: path ?? current.title }}
              onRestored={() => {
                setHistory(false)
                setOpened((n) => n + 1)
                looked.reload()
              }}
            />
          </div>
        ) : target.kind !== 'library' || view === 'editor' ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-4">
            <DocumentEditor
              key={`${key}:${opened}`}
              target={current.target}
              label={current.title}
              className="min-h-full"
              ask={ask}
            />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            {view === 'missing' ? (
              <p className="p-4 text-sm text-muted-foreground">
                {name} is no longer in the library.
              </p>
            ) : view === 'loading' ? (
              <p className="p-4 text-sm text-muted-foreground">
                {looked.error ?? `Opening ${name}…`}
              </p>
            ) : view === 'text' && contentType ? (
              <TextFile
                key={`${key}:${opened}`}
                file={{
                  id: target.id,
                  path: path ?? current.title,
                  contentType,
                  updatedAt: looked.file?.updatedAt ?? '',
                }}
                onSaved={looked.reload}
              />
            ) : (
              <FilePreview
                key={`${target.id}:${looked.file?.updatedAt ?? ''}`}
                url={contentUrl(target.id)}
                previewUrl={`/library/${target.id}/preview`}
                name={name}
                contentType={contentType ?? ''}
                download={contentUrl(target.id, true)}
              />
            )}
          </div>
        )}
        {handOff.dialog}
      </SidePanel>
      {minimized && <MinimizedPill document={minimized} onRestore={restore} />}
    </>
  )
}

/** ⌘. (Ctrl+. elsewhere) minimizes the document in front, and brings it back. */
function useMinimizeShortcut(
  shown: boolean,
  minimized: boolean,
  minimize: () => void,
  restore: () => void,
) {
  useEffect(() => {
    if (!shown && !minimized) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.shiftKey || e.altKey) return
      const command = isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      if (!command || e.code !== 'Period') return
      // Not over a dialog, which has the keyboard.
      if (document.querySelector('[role=dialog][data-state=open]')) return
      e.preventDefault()
      if (minimized) restore()
      else minimize()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [shown, minimized, minimize, restore])
}

/** A swipe down with a finger, from the top of the panel: `onSwipe`. Only a touch, never a mouse. */
function useSwipeDown(onSwipe: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null)
  return {
    onTouchStart: (e: React.TouchEvent) => {
      const touch = e.touches[0]
      start.current =
        e.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY } : null
    },
    onTouchEnd: (e: React.TouchEvent) => {
      const from = start.current
      const touch = e.changedTouches[0]
      start.current = null
      if (!from || !touch) return
      const dy = touch.clientY - from.y
      const dx = Math.abs(touch.clientX - from.x)
      if (dy > 64 && dx < dy / 2) onSwipe()
    },
    onTouchCancel: () => {
      start.current = null
    },
  }
}

function MinimizeButton({ onMinimize }: { onMinimize: () => void }) {
  const mac = useIsMac()
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={onMinimize}
      aria-label="Minimize"
      tooltip={`Minimize (${mac ? '⌘' : 'Ctrl+'}.)`}
    >
      <ChevronDown aria-hidden />
    </Button>
  )
}

/**
 * Where the pill sits, from the window's bottom right: over a composer at the bottom (a
 * thread's), just above it and lined up with its right edge, so it reads as part of the page
 * and the send button stays in reach.
 */
function usePillPlace() {
  const BASE = 16
  const [place, setPlace] = useState({ bottom: BASE, right: BASE, lifted: false })
  useEffect(() => {
    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const height = window.innerHeight
        const width = window.innerWidth
        let next = { bottom: BASE, right: BASE, lifted: false }
        for (const el of document.querySelectorAll('[data-composer-frame]')) {
          const box = el.getBoundingClientRect()
          // Only one in view, low in the window, wide enough to carry the pill above it.
          if (!box.height || box.top >= height || box.bottom < height - 240) continue
          if (box.width < 280) continue
          const bottom = height - box.top + 8
          if (bottom > next.bottom)
            next = { bottom, right: Math.max(BASE, Math.round(width - box.right)), lifted: true }
        }
        setPlace((p) => (p.bottom === next.bottom && p.right === next.right ? p : next))
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(document.body)
    const changes = new MutationObserver(measure)
    changes.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, { capture: true, passive: true })
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      changes.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, { capture: true })
    }
  }, [])
  return place
}

/** On a touch screen, whether its keyboard is likely up: something to type in has focus. */
function useTyping() {
  const [typing, setTyping] = useState(false)
  useEffect(() => {
    if (!window.matchMedia('(pointer: coarse)').matches) return
    const check = () => {
      const focus = document.activeElement
      setTyping(Boolean(focus && editable(focus)))
    }
    check()
    document.addEventListener('focusin', check)
    document.addEventListener('focusout', check)
    return () => {
      document.removeEventListener('focusin', check)
      document.removeEventListener('focusout', check)
    }
  }, [])
  return typing
}

/** The minimized document, at the bottom right of every page: a click brings it back. */
function MinimizedPill({ document, onRestore }: { document: OpenDocument; onRestore: () => void }) {
  const { tabs, changed, closeAll } = useDocumentPanel()
  const mac = useIsMac()
  const place = usePillPlace()
  const typing = useTyping()
  const Icon = iconOf(document)
  const others = tabs.length - 1
  const anyChanged = tabs.some((t) => t.target.kind === 'library' && changed.has(t.target.id))
  if (typing) return null
  return (
    <div
      role="region"
      aria-label="Minimized document"
      className="fixed z-40 flex max-w-[calc(100vw-2rem)] items-center gap-0.5 rounded-full border bg-card py-1 pr-1 pl-1 shadow-lg"
      style={{
        right: place.right,
        // Above a composer, which keeps clear of the phone's edge already.
        bottom: place.lifted
          ? place.bottom
          : `calc(${place.bottom}px + env(safe-area-inset-bottom))`,
      }}
    >
      <Hint label={`Open ${document.title} (${mac ? '⌘' : 'Ctrl+'}.)`}>
        <button
          type="button"
          onClick={onRestore}
          aria-label={`Open ${document.title}`}
          className="flex min-w-0 items-center gap-2 rounded-full py-1 pr-2 pl-2.5 text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon aria-hidden className="size-4 shrink-0 text-primary" />
          <span className="max-w-56 truncate font-medium">{document.title}</span>
          {others > 0 && (
            <span className="shrink-0 font-mono text-xs text-muted-foreground">+{others}</span>
          )}
          {anyChanged && <ChangedDot />}
          {anyChanged && <span className="sr-only">, changed</span>}
        </button>
      </Hint>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="shrink-0 rounded-full"
        onClick={closeAll}
        aria-label={others > 0 ? 'Close all documents' : `Close ${document.title}`}
        tooltip={others > 0 ? 'Close all' : 'Close'}
      >
        <X aria-hidden />
      </Button>
    </div>
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
          const Icon = iconOf(t)
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
            {/* Not a chevron: the one below it minimizes. */}
            <List aria-hidden />
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
