'use client'
// Threads, from any page. The top bar's button opens a panel beside the page:
// a teammate's latest threads with a box to start another below them, and a
// thread opens in place, its conversation and reply box the same as anywhere.
// It stays open, on the same thread, while you move between pages, and across
// a reload. Expanded, it takes the page's place: that is the thread's own
// address (/app/threads/<id>, the list at /app/threads), so links to a thread
// open it there; docking it again goes back to the page you were on.
// ⌘⇧K (Ctrl+Shift+K) opens it on the list with the cursor in the box.
import {
  ArrowLeft,
  List,
  LoaderCircle,
  Maximize2,
  MessagesSquare,
  Minimize2,
  Monitor,
  Plus,
  X,
} from 'lucide-react'
import { usePathname, useRouter } from 'next/navigation'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { TeammatePanel } from '@/components/computer-panel'
import { SidebarToggle, StatusBadge, TeammateAvatar, useDashboard } from '@/components/dashboard'
import { StatusDot } from '@/components/status-badge'
import { useDesktopPreview } from '@/components/desktop-preview'
import { useDocumentPanel } from '@/components/document-panel'
import {
  NewThread,
  TeammatePicker,
  useLastTeammate,
  useThreadDraft,
  type TeammateActivity,
  type ThreadDraft,
} from '@/components/new-thread'
import { SidePanel, useEscapeToClose } from '@/components/side-panel'
import {
  EarlierMessages,
  JumpToEnd,
  ThreadConversation,
  type ThreadHeading,
} from '@/components/thread-conversation'
import { ThreadChannel } from '@/components/thread-list'
import { Button } from '@/components/ui/button'
import { api, useApi, type Teammate, type ThreadSummary } from '@/lib/api'
import { isMac, useIsMac } from '@/lib/platform'
import { useRememberedFlag } from '@/lib/use-remembered'
import { useLive } from '@/lib/use-live'
import { cn } from '@/lib/utils'

type ThreadPanel = {
  /** Shown: docked beside the page, or expanded in its place. */
  visible: boolean
  expanded: boolean
  /** The thread shown, or null for the list. */
  threadId: string | null
  toggle: () => void
  /** The list, with the cursor in the box for a new thread. */
  startThread: () => void
  openThread: (id: string) => void
  /** From a thread to the list. */
  back: () => void
  expand: () => void
  /** Docked beside the page again, the one you were on before it expanded. */
  dock: () => void
  close: () => void
  /** What each teammate is doing, for the dots beside it. */
  activity: Record<string, TeammateActivity>
  /** Threads waiting on a person: an approval or an answer. */
  waiting: number
  /** The new thread being written: closing the panel keeps it. */
  draft: ThreadDraft
  /** Changes each time the box should take the cursor. */
  focusKey: number
  /**
   * The teammate's panel beside it, expanded only: its computer, routines and profile.
   * Remembered in this browser.
   */
  details: boolean
  setDetails: (open: boolean) => void
  /** Changes each time the teammate's panel should come in front of a file or preview. */
  revealKey: number
  /** A thread's file or preview is in the teammate panel's place. */
  covered: boolean
  setCovered: (covered: boolean) => void
  /** The teammate the list shows: the one picked last, in this browser. */
  teammateId?: string
  chooseTeammate: (id: string) => void
  /**
   * A teammate's computer, a page like any other (/app/teammates/<id>/computer):
   * this docks the panel beside it, on a thread or else the teammate's list.
   * With `shell`, the shell opens below the screen.
   */
  openComputer: (teammateId: string, options?: { threadId?: string; shell?: boolean }) => void
  /** The teammate whose computer page is open, if one is. */
  computerPage?: string
  /** The shell below the computer's screen: the docked thread's, once this member has control. */
  shell: boolean
  setShell: (open: boolean) => void
}

const Context = createContext<ThreadPanel | null>(null)
const OPEN_KEY = 'brigade:threads-panel'

/** Whether the panel was open, and on which thread, when this browser last left it. */
function readSaved(): { open: boolean; threadId: string | null } {
  try {
    const saved = JSON.parse(localStorage.getItem(OPEN_KEY) ?? 'null') as {
      open?: unknown
      threadId?: unknown
    } | null
    return {
      open: saved?.open === true,
      threadId: typeof saved?.threadId === 'string' ? saved.threadId : null,
    }
  } catch {
    return { open: false, threadId: null }
  }
}

export function useThreadPanel() {
  const value = useContext(Context)
  if (!value) throw new Error('useThreadPanel outside ThreadPanelProvider')
  return value
}

/** The thread an address shows expanded: its id, null for the list, undefined for none. */
function routeThread(pathname: string): string | null | undefined {
  const match = /^\/app\/threads(?:\/([^/]+))?\/?$/.exec(pathname)
  return match ? (match[1] ?? null) : undefined
}

const BUSY = new Set(['starting', 'running'])

export function ThreadPanelProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const routed = routeThread(pathname)
  const expanded = routed !== undefined
  // As it was left, in this browser: read as it mounts (only in the browser, once the member
  // is in), so nothing can save the defaults over it first.
  const [saved] = useState(readSaved)
  const [open, setOpen] = useState(saved.open)
  const [docked, setDocked] = useState<string | null>(saved.threadId)
  const threadId = expanded ? (routed ?? null) : docked
  const [focusKey, setFocusKey] = useState(0)
  const draft = useThreadDraft()
  const [details, remember] = useDesktopPreview()
  const [revealKey, setRevealKey] = useState(0)
  const [covered, setCovered] = useState(false)
  const [teammateId, chooseTeammate] = useLastTeammate()
  const [shell, setShell] = useState(false)
  const computerPage = /^\/app\/teammates\/([^/]+)\/computer\/?$/.exec(pathname)?.[1]
  const openComputer = useCallback(
    (teammate: string, options: { threadId?: string; shell?: boolean } = {}) => {
      if (!options.threadId) chooseTeammate(teammate)
      setDocked(options.threadId ?? null)
      setOpen(true)
      setShell(!!options.shell)
      router.push(`/app/teammates/${teammate}/computer`)
    },
    [chooseTeammate, router],
  )
  const setDetails = useCallback(
    (open: boolean) => {
      remember(open)
      if (open) setRevealKey((k) => k + 1)
    },
    [remember],
  )

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify({ open, threadId: docked }))
    } catch {}
  }, [open, docked])

  // A computer's page has the threads beside it: opening it opens them, on the teammate's
  // list unless a thread is open there.
  useEffect(() => {
    if (!computerPage) return
    chooseTeammate(computerPage)
    setOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computerPage])

  // The page to dock back to: the last one that was not the panel itself.
  const lastPage = useRef<string>(undefined)
  useEffect(() => {
    if (!expanded) lastPage.current = pathname
  }, [expanded, pathname])

  const dock = useCallback(() => {
    setDocked(routed ?? null)
    setOpen(true)
    router.push(lastPage.current ?? '/app')
  }, [routed, router])
  const close = useCallback(() => {
    setOpen(false)
    if (expanded) {
      setDocked(routed ?? null)
      router.push(lastPage.current ?? '/app')
    }
  }, [expanded, routed, router])
  const openThread = useCallback(
    (id: string) => {
      if (expanded) router.push(`/app/threads/${id}`)
      else {
        setDocked(id)
        setOpen(true)
      }
    },
    [expanded, router],
  )
  const back = useCallback(() => {
    if (expanded) router.push('/app/threads')
    else setDocked(null)
  }, [expanded, router])
  const expand = useCallback(() => {
    router.push(docked ? `/app/threads/${docked}` : '/app/threads')
  }, [docked, router])
  const startThread = useCallback(() => {
    if (expanded) {
      if (routed) router.push('/app/threads')
    } else {
      setDocked(null)
      setOpen(true)
    }
    setFocusKey((k) => k + 1)
  }, [expanded, routed, router])
  const toggle = useCallback(() => setOpen((o) => !o), [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Taken already: the terminal, the remote desktop.
      if (e.defaultPrevented || e.repeat) return
      // ⌘K alone is search.
      const command = isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      const shortcut = command && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k'
      // Not over a dialog.
      if (!shortcut || document.querySelector('[role=dialog][data-state=open]')) return
      e.preventDefault()
      startThread()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [startThread])

  // Every thread, for what each teammate is doing and what waits; live.
  const threads = useApi<ThreadSummary[]>('/threads')
  const reloadThreads = threads.reload
  useLive((message) => {
    if (message.type === 'thread.updated') void reloadThreads()
  })
  const { activity, waiting } = useMemo(() => {
    const activity: Record<string, TeammateActivity> = {}
    let waiting = 0
    for (const t of threads.data ?? []) {
      const state = t.status === 'waiting' ? 'waiting' : BUSY.has(t.status) ? 'busy' : undefined
      if (!state) continue
      if (state === 'waiting') waiting++
      const people = t.teammates?.length ? t.teammates.map((p) => p.teammate) : [t.teammate]
      // Waiting on a person shows over working.
      for (const p of people) if (activity[p.id] !== 'waiting') activity[p.id] = state
    }
    return { activity, waiting }
  }, [threads.data])

  const value = useMemo(
    () => ({
      visible: expanded || open,
      expanded,
      threadId,
      toggle,
      startThread,
      openThread,
      back,
      expand,
      dock,
      close,
      activity,
      waiting,
      draft,
      focusKey,
      details,
      setDetails,
      revealKey,
      covered,
      setCovered,
      teammateId,
      chooseTeammate,
      openComputer,
      computerPage,
      shell,
      setShell,
    }),
    [
      expanded,
      open,
      threadId,
      toggle,
      startThread,
      openThread,
      back,
      expand,
      dock,
      close,
      activity,
      waiting,
      draft,
      focusKey,
      details,
      setDetails,
      revealKey,
      covered,
      teammateId,
      chooseTeammate,
      openComputer,
      computerPage,
      shell,
    ],
  )
  return <Context.Provider value={value}>{children}</Context.Provider>
}

/** The top bar's button: opens and closes the panel; counts the threads waiting on a person. */
export function ThreadsButton({ className }: { className?: string }) {
  const { visible, toggle, waiting, activity } = useThreadPanel()
  const working = Object.values(activity).includes('busy')
  const label = visible ? 'Hide threads' : 'Threads'
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-pressed={visible}
      onClick={toggle}
      aria-label={waiting > 0 ? `${label}, ${waiting} waiting on a person` : label}
      title={label}
      className={cn(
        'relative aria-pressed:bg-accent aria-pressed:text-accent-foreground',
        className,
      )}
    >
      <MessagesSquare aria-hidden />
      {/* On the icon's corner: a count of what waits, else a dot while teammates work. */}
      {waiting > 0 ? (
        <span
          aria-hidden
          className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.625rem] leading-none font-semibold text-primary-foreground ring-2 ring-background"
        >
          {waiting > 99 ? '99+' : waiting}
        </span>
      ) : (
        working && (
          <span
            aria-hidden
            className="absolute top-1 right-1 size-2 animate-pulse rounded-full bg-primary ring-2 ring-background"
          />
        )
      )}
    </Button>
  )
}

/** The panel. Rendered once, by the dashboard, docked or in the page's place. */
export function ThreadPanel() {
  const panel = useThreadPanel()
  const { teammates } = useDashboard()
  const choose = panel.chooseTeammate
  const teammate = teammates.find((t) => t.id === panel.teammateId) ?? teammates[0]
  // The open thread's title and state, from the conversation below; its lead teammate's
  // threads are where back goes.
  const [heading, setHeading] = useState<{ id: string } & ThreadHeading>()
  const shown = heading && heading.id === panel.threadId ? heading : undefined
  const lead = shown?.teammate
  // Expanded, the channel beside a thread can be hidden: remembered in this browser.
  const [listShown, showList] = useRememberedFlag('brigade.threads.list', true)
  // The channel beside a thread is one of its teammates': the one picked, if in it.
  const inThread = shown?.teammateIds
  // Once per thread, as it opens: picking another teammate after that is the member's choice
  // (and a pick made on the way to a thread is not undone by the one before it).
  const placedFor = useRef<string>(undefined)
  useEffect(() => {
    if (!shown || placedFor.current === shown.id) return
    placedFor.current = shown.id
    if (!lead || !inThread || !teammate || inThread.includes(teammate.id)) return
    if (teammates.some((t) => t.id === lead.id)) choose(lead.id)
  }, [shown, lead, inThread, teammate, teammates, choose])
  // Expanded, Escape docks it beside the page you were on, once nothing beside it took it;
  // docked, Escape again closes it (SidePanel's own).
  const escapeArea = useRef<HTMLElement>(null)
  useEscapeToClose(escapeArea, panel.expanded ? panel.dock : undefined, true)
  if (!panel.visible) return null
  const { expanded, threadId } = panel
  // Expanded, the thread's title is the page's heading.
  const Title = expanded ? 'h1' : 'h2'
  const icon = 'size-8'
  return (
    <SidePanel
      aria-label="Threads"
      data-thread-panel
      expanded={expanded}
      onClose={expanded ? undefined : panel.close}
    >
      <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
        {/* Expanded, this bar is the top bar: the sidebar's toggle starts it. */}
        {expanded && <SidebarToggle className="ml-0 shrink-0" />}
        {threadId ? (
          // Teammate / title · status: the title stays in sight while the conversation scrolls.
          // Docked there is room for the title alone, and the status as a dot.
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-8 shrink-0"
              onClick={panel.back}
              aria-label={teammate ? `Back to ${teammate.name}'s threads` : 'Back to threads'}
              title={teammate ? `${teammate.name}'s threads` : 'Threads'}
            >
              <ArrowLeft aria-hidden />
            </Button>
            {/* Who leads it; a click goes to another teammate's latest threads. */}
            {lead &&
              (teammates.some((t) => t.id === lead.id) ? (
                <TeammatePicker
                  teammates={teammates}
                  value={teammates.find((t) => t.id === lead.id)!}
                  onChange={choose}
                  heading="Go to"
                  activity={panel.activity}
                  compact={!expanded}
                  recent={{
                    onOpen: (teammateId, id) => {
                      choose(teammateId)
                      panel.openThread(id)
                    },
                    onAll: (teammateId) => {
                      choose(teammateId)
                      panel.back()
                    },
                    onNew: (teammateId) => {
                      choose(teammateId)
                      panel.startThread()
                    },
                  }}
                />
              ) : (
                <TeammateAvatar teammate={lead} className="size-5 shrink-0" />
              ))}
            {shown && (
              <>
                {expanded && (
                  <span aria-hidden className="text-muted-foreground">
                    /
                  </span>
                )}
                <Title className="min-w-0 truncate text-sm font-semibold" title={shown.title}>
                  {shown.title}
                </Title>
                {expanded ? (
                  <StatusBadge status={shown.status} className="shrink-0" />
                ) : (
                  <StatusDot status={shown.status} />
                )}
                {shown.private && expanded && (
                  <StatusBadge
                    status="private"
                    tone="neutral"
                    label="Private"
                    className="shrink-0"
                  />
                )}
                {!shown.connected && (
                  <LoaderCircle
                    role="status"
                    aria-label="Reconnecting"
                    className="size-3.5 shrink-0 animate-spin text-muted-foreground"
                  />
                )}
              </>
            )}
          </div>
        ) : (
          teammate &&
          (teammates.length > 1 ? (
            <TeammatePicker
              teammates={teammates}
              value={teammate}
              onChange={choose}
              heading="Threads with"
              activity={panel.activity}
            />
          ) : (
            <span className="flex min-w-0 items-center gap-2 px-1.5 text-sm font-semibold">
              <TeammateAvatar teammate={teammate} className="size-5" />
              <span className="truncate">{teammate.name}</span>
            </span>
          ))
        )}
        {!threadId && <span className="flex-1" />}
        {/* Expanded, the threads on the left and the details on the right toggle side by side. */}
        {expanded && threadId && (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="hidden size-8 aria-pressed:bg-accent aria-pressed:text-accent-foreground lg:inline-flex"
            aria-pressed={listShown}
            aria-label={listShown ? 'Hide the thread list' : 'Show the thread list'}
            title={listShown ? 'Hide the thread list' : 'Show the thread list'}
            onClick={() => showList(!listShown)}
          >
            <List aria-hidden />
          </Button>
        )}
        {/* Room for the teammate's panel beside it only expanded; docked, the page is there. */}
        {expanded && <DetailsButton name={threadId ? lead?.name : teammate?.name} />}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={icon}
          onClick={expanded ? panel.dock : panel.expand}
          aria-label={expanded ? 'Dock beside the page' : 'Expand'}
          title={expanded ? 'Dock beside the page' : 'Expand'}
        >
          {expanded ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={icon}
          onClick={panel.close}
          aria-label="Close threads"
          title={expanded ? 'Close' : 'Close (Esc)'}
        >
          <X aria-hidden />
        </Button>
      </div>
      {teammate || threadId ? (
        // The channel, and a thread opened from it. Expanded, the thread opens beside the
        // channel, which narrows on the left: the same one, so the pages it loaded and where
        // it was stay. Docked, the thread takes its place.
        <div className="flex min-h-0 flex-1">
          {teammate && (!threadId || (expanded && listShown)) && (
            <div
              className={cn(
                'flex min-h-0 flex-col',
                threadId ? 'hidden w-72 shrink-0 border-r lg:flex 2xl:w-96' : 'min-w-0 flex-1',
              )}
            >
              <TeammateThreads key={teammate.id} teammate={teammate} beside={!!threadId} />
            </div>
          )}
          {threadId && (
            <div className="flex min-w-0 flex-1 flex-col">
              <ThreadConversation
                key={threadId}
                id={threadId}
                expanded={expanded}
                onExpand={panel.expand}
                onHeading={(h) => setHeading({ id: threadId, ...h })}
              />
            </div>
          )}
        </div>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">
          No AI teammates yet. Threads start with one.
        </p>
      )}
    </SidePanel>
  )
}

/** Opens and closes the details beside the expanded threads panel: the thread's, its computer's, the teammate's. */
function DetailsButton({ name }: { name?: string }) {
  const { details, setDetails, covered } = useThreadPanel()
  const documents = useDocumentPanel()
  // A file, preview or document in its place: pressing brings it back in front.
  const shown = details && !covered && !documents.current
  const label = shown
    ? 'Hide details'
    : `Details: ${name ?? 'the teammate'}'s computer, routines and more`
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      className="size-8 aria-pressed:bg-accent aria-pressed:text-accent-foreground"
      aria-pressed={shown}
      aria-label={label}
      title={label}
      onClick={() => {
        if (shown) return setDetails(false)
        documents.close()
        setDetails(true)
      }}
    >
      <Monitor aria-hidden />
    </Button>
  )
}

const PAGE = 30

/**
 * A teammate's threads as a channel, oldest first: the latest page, then earlier
 * ones as they are asked for. Live: what is loaded comes again on each change.
 */
function useThreadChannel(teammateId: string) {
  const [threads, setThreads] = useState<ThreadSummary[]>()
  const [error, setError] = useState<string>()
  const [more, setMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  // One earlier page at a time: what asks for it (scrolling near the top, looking for an
  // open thread) may ask again before the first one is in.
  const loading = useRef(false)
  const loaded = useRef(0)
  const path = `/threads?teammateId=${teammateId}`
  const reload = useCallback(async () => {
    try {
      // The newest, as many as are shown (up to the API's most): replies and states change.
      const limit = Math.min(Math.max(loaded.current, PAGE), 100)
      const page = (await api<ThreadSummary[]>(`${path}&limit=${limit}`)).reverse()
      // Whether there are earlier ones: the first page says; after it, earlier pages do.
      if (loaded.current === 0) setMore(page.length === limit)
      const ids = new Set(page.map((t) => t.id))
      const first = page[0]
      setThreads((shown) => {
        // Earlier ones beyond it stay as they were.
        const older = first
          ? (shown ?? []).filter((t) => !ids.has(t.id) && t.createdAt < first.createdAt)
          : []
        const next = [...older, ...page]
        loaded.current = next.length
        return next
      })
      setError(undefined)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [path])
  useEffect(() => {
    void reload()
  }, [reload])
  const loadOlder = useCallback(
    async (before: () => void) => {
      const oldest = threads?.[0]
      if (!oldest || loading.current) return
      loading.current = true
      setLoadingOlder(true)
      try {
        const page = await api<ThreadSummary[]>(`${path}&limit=${PAGE}&before=${oldest.id}`)
        before()
        setThreads((shown) => {
          // Never twice: a thread already shown stays where it is.
          const ids = new Set((shown ?? []).map((t) => t.id))
          const next = [...page.reverse().filter((t) => !ids.has(t.id)), ...(shown ?? [])]
          loaded.current = next.length
          return next
        })
        setMore(page.length === PAGE)
      } finally {
        loading.current = false
        setLoadingOlder(false)
      }
    },
    [threads, path],
  )
  return { threads, error, more, loadingOlder, loadOlder, reload }
}

/**
 * A teammate's threads, read as a channel (newest last), and the box to start another
 * below them. `beside` is beside an open thread: no details, and instead of the box,
 * which would be a second one beside the thread's, a link back to it.
 */
function TeammateThreads({ teammate, beside = false }: { teammate: Teammate; beside?: boolean }) {
  const {
    expanded,
    threadId,
    openThread,
    startThread,
    draft,
    focusKey,
    details,
    setDetails,
    openComputer,
  } = useThreadPanel()
  const channel = useThreadChannel(teammate.id)
  const mac = useIsMac()
  const reload = channel.reload
  useLive((message) => {
    if (message.type === 'thread.updated') void reload()
  })
  const wide = expanded && !beside
  const column = cn('mx-auto w-full', wide && 'max-w-5xl px-4 md:px-10')

  // Read from its end, as a conversation: it opens there and follows what comes in,
  // unless scrolled up to read. An earlier page goes in above without moving the view.
  const scroller = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  // Scrolled up a long way: a button goes back down to the latest.
  const [farUp, setFarUp] = useState(false)
  useEffect(() => {
    const view = scroller.current
    if (!view) return
    const measure = () => {
      const fromEnd = view.scrollHeight - view.clientHeight - view.scrollTop
      following.current = fromEnd < 48
      setFarUp(fromEnd > view.clientHeight)
    }
    view.addEventListener('scroll', measure, { passive: true })
    return () => view.removeEventListener('scroll', measure)
  }, [])
  const anchor = useRef<number>(undefined)
  const list = channel.threads
  useLayoutEffect(() => {
    const view = scroller.current
    if (!view || !list) return
    const fromEnd = anchor.current
    anchor.current = undefined
    if (fromEnd !== undefined) view.scrollTop = view.scrollHeight - fromEnd
    else if (following.current) view.scrollTop = view.scrollHeight
  }, [list])
  // Beside a thread, the list shows that one: brought into view as it opens (once loaded),
  // and loaded first if it is further back than the pages in.
  const selected = beside ? threadId : null
  const shownFor = useRef<string | null>(null)
  const loaded = !!list?.some((t) => t.id === selected)
  useLayoutEffect(() => {
    // Back on the list: the next thread opened is brought into view again, even this one.
    if (!selected) shownFor.current = null
    if (!selected || !loaded || shownFor.current === selected) return
    shownFor.current = selected
    const view = scroller.current
    const row = view?.querySelector<HTMLElement>('[aria-current]')
    if (!view || !row) return
    const box = view.getBoundingClientRect()
    const at = row.getBoundingClientRect()
    if (at.top < box.top || at.bottom > box.bottom) row.scrollIntoView({ block: 'center' })
  }, [selected, loaded])
  const searched = useRef({ for: null as string | null, pages: 0 })
  useEffect(() => {
    if (searched.current.for !== selected) searched.current = { for: selected, pages: 0 }
    if (!selected || loaded || !list || !channel.more || channel.loadingOlder) return
    // Ten pages back at most: further than that, it shows without its place in the list.
    if (searched.current.pages >= 10) return
    searched.current.pages++
    void loadEarlier()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, loaded, list, channel.more, channel.loadingOlder])
  const loadEarlier = () =>
    channel.loadOlder(() => {
      const view = scroller.current
      anchor.current = view ? view.scrollHeight - view.scrollTop : undefined
    })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {expanded && !beside && details && (
        <TeammatePanel
          teammate={teammate}
          threads={list && [...list].reverse()}
          onOpenThread={openThread}
          onOpenComputer={() => openComputer(teammate.id)}
          onClose={() => setDetails(false)}
        />
      )}
      <div ref={scroller} className="scroll-fade min-h-0 flex-1 overflow-y-auto">
        <div className={cn(column, 'flex min-h-full flex-col justify-end pb-12', wide && 'pt-6')}>
          {list ? (
            <>
              {channel.more && (
                <div className="pt-4">
                  <EarlierMessages
                    key={list[0]?.id}
                    root={scroller}
                    loading={channel.loadingOlder}
                    onLoad={loadEarlier}
                    noun="threads"
                  />
                </div>
              )}
              <ThreadChannel
                threads={list}
                selectedId={beside ? threadId : undefined}
                onSelect={(t) => openThread(t.id)}
                empty={`No threads with ${teammate.name} yet. Ask below to start one.`}
              />
            </>
          ) : (
            <p
              className={cn(
                'p-4 text-sm',
                channel.error ? 'text-destructive-text' : 'text-muted-foreground',
              )}
            >
              {channel.error ?? 'Loading…'}
            </p>
          )}
        </div>
      </div>
      <div className={cn(column, 'relative shrink-0 px-4 pt-2 pb-4')}>
        {farUp && (
          <JumpToEnd
            onClick={() =>
              scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
            }
          />
        )}
        {beside ? (
          // The thread beside has the box: this one starts another, in its place. Quiet, its
          // own width, with the shortcut that does the same from anywhere.
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="group/new text-muted-foreground hover:text-foreground"
            onClick={startThread}
            aria-keyshortcuts={mac ? 'Meta+Shift+K' : 'Control+Shift+K'}
          >
            <Plus aria-hidden />
            New thread with {teammate.name}
            {/* At rest the label alone; pointing at it (or tabbing to it) shows the shortcut. */}
            <span className="hidden text-[0.6875rem] font-normal tracking-widest text-muted-foreground group-hover/new:inline group-focus-visible/new:inline">
              {mac ? '⌘⇧K' : 'Ctrl+Shift+K'}
            </span>
          </Button>
        ) : (
          // A new key each time it should take the cursor: it focuses as it mounts.
          <NewThread
            key={focusKey}
            teammate={teammate}
            rows={2}
            draft={draft}
            autoFocus={focusKey > 0}
            placeholder={`Ask ${teammate.name} to… @ to bring in another teammate, a repository, connection or secret`}
            onStarted={(thread) => openThread(thread.id)}
          />
        )}
      </div>
    </div>
  )
}
