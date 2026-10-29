'use client'
// Threads, from any page. The top bar's button opens a panel beside the page:
// a teammate's latest threads with a box to start another below them, and a
// thread opens in place, its conversation and reply box the same as anywhere.
// Expanded, the sidebar lists the threads: the panel is the thread alone, or with
// none open, a box to start one with the teammate picked.
// It stays open, on the same thread, while you move between pages, and across
// a reload. Expanded, it takes the page's place: that is the thread's own
// address (/app/threads/<id>, the list at /app/threads), so links to a thread
// open it there; docking it again goes back to the page you were on.
// ⌘J (Ctrl+J) shows it, brings it in front of a preview or a file, or hides it;
// ⌘⇧K starts a thread without it (components/quick-thread.tsx).
import { ArrowLeft, ChevronRight, Laptop, LoaderCircle, Maximize2, X } from 'lucide-react'
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
import { SidebarToggle, TeammateAvatar, useDashboard } from '@/components/dashboard'
import { ProjectIcon } from '@/components/projects'
import { StatusDot } from '@/components/status-badge'
import { useDesktopPreview } from '@/components/desktop-preview'
import { useDocumentPanel } from '@/components/document-panel'
import { useKeptPreviewShown } from '@/components/kept-previews'
import {
  NewThread,
  TeammatePicker,
  lastTeammate,
  useLastTeammate,
  useThreadDraft,
  type TeammateActivity,
  type ThreadDraft,
} from '@/components/new-thread'
import { panelInFront, raisePanel, SidePanel } from '@/components/side-panel'
import {
  EarlierMessages,
  JumpToEnd,
  preloadConversation,
  ThreadConversation,
  type ThreadHeading,
} from '@/components/thread-conversation'
import { TeammateTitle } from '@/components/teammate-title'
import { ThreadChannel } from '@/components/thread-list'
import { Button } from '@/components/ui/button'
import {
  api,
  preload,
  preloaded,
  useApi,
  type ProjectRef,
  type Teammate,
  type ThreadSummary,
} from '@/lib/api'
import { PendingThread } from '@/components/pending-thread'
import { usePendingThread } from '@/lib/pending-threads'
import { isMac } from '@/lib/platform'
import { StreamedTitle } from '@/components/streamed-title'
import { useLive } from '@/lib/use-live'
import { openInPlace } from '@/lib/thread-address'
import { cn } from '@/lib/utils'

type ThreadPanel = {
  /** Shown: expanded in the page's place, or docked beside a teammate's computer. */
  visible: boolean
  expanded: boolean
  /** The thread shown, or null for the list. */
  threadId: string | null
  toggle: () => void
  /** The list, with the cursor in the box for a new thread. */
  startThread: () => void
  /** The new-thread page, expanded, with the teammate picked last: the sidebar's +. */
  newThreadPage: () => void
  openThread: (id: string) => void
  /** From a thread to the list. */
  back: () => void
  expand: () => void
  close: () => void
  /** What each teammate is doing: working, or waiting on a person. */
  activity: Record<string, TeammateActivity>
  /** Threads waiting on a person: an approval or an answer. */
  waiting: number
  /** The latest active threads (up to 100), live: the sidebar lists them. */
  threads?: ThreadSummary[]
  /** Fetch them again, after a change made here (pinned, renamed, archived, deleted). */
  reloadThreads: () => Promise<unknown>
  /** The new thread being written: closing the panel keeps it. */
  draft: ThreadDraft
  /** Changes each time the box should take the cursor. */
  focusKey: number
  /**
   * The teammate's panel beside it, expanded only: its computer, routines and settings.
   * Remembered in this browser.
   */
  details: boolean
  setDetails: (open: boolean) => void
  /** Changes each time the teammate's panel should come in front of a file or preview. */
  revealKey: number
  /** Opens a thread on its preview (the sidebar's icon): the thread, then its preview once up. */
  openPreview: (threadId: string) => void
  /** The latest such request, until the thread's page takes it up: once, not on each visit. */
  previewRequest?: { threadId: string; key: number }
  takePreviewRequest: () => void
  /**
   * Opens a thread on its computer, over the whole window (from Home's ticket, once the
   * member took control): the thread, then its computer.
   */
  showComputer: (threadId: string) => void
  /** The latest such request, until the thread's page takes it up. */
  computerRequest?: { threadId: string; key: number }
  takeComputerRequest: () => void
  /** A thread's file or preview is in the teammate panel's place. */
  covered: boolean
  setCovered: (covered: boolean) => void
  /** The teammate the list shows: the one picked last, in this browser. */
  teammateId?: string
  chooseTeammate: (id: string) => void
  /**
   * Where a teammate opens from the sidebar: expanded, on the thread last open with it in
   * this browser, else its latest; its list when it has none yet.
   */
  teammateHref: (teammateId: string) => string
  /** Goes there, looking further back than the latest threads loaded here if need be. */
  openTeammate: (teammateId: string) => void
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
/** The thread last open with each teammate, by the teammate that leads it. */
const LAST_THREADS_KEY = 'brigade:teammate-threads'
/** Its name among the panels beside a page. */
const PANEL = 'threads'

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

function readLastThreads(): Record<string, string> {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_THREADS_KEY) ?? 'null') as unknown
    return saved && typeof saved === 'object' ? (saved as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export function useThreadPanel() {
  const value = useContext(Context)
  if (!value) throw new Error('useThreadPanel outside ThreadPanelProvider')
  return value
}

/** The teammate whose computer an address shows: the one page the panel docks beside. */
function routeComputer(pathname: string): string | undefined {
  return /^\/app\/teammates\/([^/]+)\/computer\/?$/.exec(pathname)?.[1]
}

/** The thread an address shows expanded: its id, null for the list, undefined for none. */
function routeThread(pathname: string): string | null | undefined {
  const match = /^\/app\/threads(?:\/([^/]+))?\/?$/.exec(pathname)
  return match ? (match[1] ?? null) : undefined
}

/**
 * Sends ahead what the panel asks for as it opens (lib/api.ts's `preload`), as the dashboard
 * starts: every thread, then as it was left in this browser, the thread it shows and the
 * channel beside it, of the teammate picked last (once the thread is in, the panel may pick
 * its lead instead).
 */
export function preloadThreadPanel(pathname: string) {
  preload('/threads')
  const routed = routeThread(pathname)
  const expanded = routed !== undefined
  const saved = readSaved()
  if (!expanded && !(saved.open && routeComputer(pathname))) return
  const threadId = expanded ? routed : saved.threadId
  if (threadId) preloadConversation(threadId)
  // Docked with no thread, the teammate's channel.
  const teammate = lastTeammate()
  if (teammate && !threadId && !expanded) preload(`${channelPath(teammate)}&limit=${PAGE}`)
}

const BUSY = new Set(['starting', 'running'])

export function ThreadPanelProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const routed = routeThread(pathname)
  const expanded = routed !== undefined
  // The panel's own addresses open in place, without a trip to the server (openInPlace).
  const go = useCallback(
    (href: string) => {
      if (!openInPlace(href)) router.push(href)
    },
    [router],
  )
  // As it was left, in this browser: read as it mounts (only in the browser, once the member
  // is in), so nothing can save the defaults over it first.
  const [saved] = useState(readSaved)
  const [open, setOpen] = useState(saved.open)
  const [docked, setDocked] = useState<string | null>(saved.threadId)
  const threadId = expanded ? (routed ?? null) : docked
  // Docked only beside a teammate's computer: anywhere else a thread is its own page, and
  // leaving it leaves the conversation behind.
  const computerPage = routeComputer(pathname)
  const [focusKey, setFocusKey] = useState(0)
  const draft = useThreadDraft()
  const [details, remember] = useDesktopPreview()
  const [revealKey, setRevealKey] = useState(0)
  const [covered, setCovered] = useState(false)
  const [teammateId, chooseTeammate] = useLastTeammate()
  const [shell, setShell] = useState(false)
  const openComputer = useCallback(
    (teammate: string, options: { threadId?: string; shell?: boolean } = {}) => {
      if (!options.threadId) chooseTeammate(teammate)
      setDocked(options.threadId ?? null)
      setOpen(true)
      raisePanel(PANEL)
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

  // The page to go back to: the last one that was not the panel itself.
  const lastPage = useRef<string>(undefined)
  useEffect(() => {
    if (!expanded) lastPage.current = pathname
  }, [expanded, pathname])

  const close = useCallback(() => {
    setOpen(false)
    if (expanded) {
      setDocked(routed ?? null)
      router.push(lastPage.current ?? '/app')
    }
  }, [expanded, routed, router])
  const openThread = useCallback(
    (id: string) => {
      if (expanded || !computerPage) go(`/app/threads/${id}`)
      else {
        setDocked(id)
        setOpen(true)
        raisePanel(PANEL)
      }
    },
    [expanded, computerPage, go],
  )
  const [previewRequest, setPreviewRequest] = useState<{ threadId: string; key: number }>()
  const openPreview = useCallback(
    (id: string) => {
      setPreviewRequest({ threadId: id, key: Date.now() })
      openThread(id)
    },
    [openThread],
  )
  const takePreviewRequest = useCallback(() => setPreviewRequest(undefined), [])
  const [computerRequest, setComputerRequest] = useState<{ threadId: string; key: number }>()
  const showComputer = useCallback(
    (id: string) => {
      setComputerRequest({ threadId: id, key: Date.now() })
      go(`/app/threads/${id}`)
    },
    [go],
  )
  const takeComputerRequest = useCallback(() => setComputerRequest(undefined), [])
  const back = useCallback(() => {
    if (expanded) go('/app/threads')
    else setDocked(null)
  }, [expanded, go])
  const expand = useCallback(() => {
    go(docked ? `/app/threads/${docked}` : '/app/threads')
  }, [docked, go])
  const newThreadPage = useCallback(() => {
    if (routed !== null) go('/app/threads')
    setFocusKey((k) => k + 1)
  }, [routed, go])
  const startThread = useCallback(() => {
    if (expanded || !computerPage) {
      if (routed !== null) go('/app/threads')
    } else {
      setDocked(null)
      setOpen(true)
      // In front of a preview or a file the page opened.
      raisePanel(PANEL)
    }
    setFocusKey((k) => k + 1)
  }, [expanded, computerPage, routed, go])
  // Open behind another panel, it comes in front instead of closing. Away from a computer,
  // the threads are a page: to the one left last.
  const toggle = useCallback(() => {
    if (!expanded && !computerPage) expand()
    else if (open && !expanded && !panelInFront(PANEL)) raisePanel(PANEL)
    else setOpen((o) => !o)
  }, [open, expanded, computerPage, expand])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Taken already: the terminal, the remote desktop.
      if (e.defaultPrevented || e.repeat) return
      const command = isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      const shortcut = command && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j'
      // Not over a dialog.
      if (!shortcut || document.querySelector('[role=dialog][data-state=open]')) return
      // Ctrl+J is the browser's downloads elsewhere.
      e.preventDefault()
      // Expanded, it hides back to the page it came from.
      if (expanded) close()
      else toggle()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [expanded, close, toggle])

  // Every thread, for what each teammate is doing and what waits; live. A pull request's
  // change moves its thread in the sidebar (waiting on a person to merge, or not).
  const threads = useApi<ThreadSummary[]>('/threads', [
    'thread.updated',
    'pulls.updated',
    'lists.updated',
  ])
  const reloadThreads = threads.reload
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

  // The thread last open with each teammate, docked or expanded, for the sidebar to go back to.
  const [lastThreads, setLastThreads] = useState(readLastThreads)
  const threadList = threads.data
  // The thread shown here is read by this member: as it opens, and again each time a reply
  // comes in while it shows in a tab in front. The sidebar then shows it read.
  const [inFront, setInFront] = useState(true)
  useEffect(() => {
    const check = () => setInFront(document.visibilityState === 'visible')
    check()
    document.addEventListener('visibilitychange', check)
    return () => document.removeEventListener('visibilitychange', check)
  }, [])
  const showing = (expanded || open) && inFront ? threadId : null
  const unreadShowing = !!threadList?.find((t) => t.id === showing)?.unread
  const readFor = useRef<string | null>(null)
  useEffect(() => {
    if (!showing || (readFor.current === showing && !unreadShowing)) return
    readFor.current = showing
    api(`/threads/${showing}/read`, { method: 'POST' })
      .then(() => reloadThreads())
      .catch(() => {})
  }, [showing, unreadShowing, reloadThreads])
  useEffect(() => {
    const lead = threadId && threadList?.find((t) => t.id === threadId)?.teammate.id
    if (!lead || lastThreads[lead] === threadId) return
    const next = { ...lastThreads, [lead]: threadId }
    setLastThreads(next)
    try {
      localStorage.setItem(LAST_THREADS_KEY, JSON.stringify(next))
    } catch {}
  }, [threadId, threadList, lastThreads])
  const teammateHref = useCallback(
    (teammate: string) => {
      // The latest active first: the remembered one while it is still there, else the latest.
      const list = (threadList ?? []).filter(
        (t) => t.teammate.id === teammate || t.teammates?.some((p) => p.teammate.id === teammate),
      )
      const last = list.find((t) => t.id === lastThreads[teammate]) ?? list[0]
      return last ? `/app/threads/${last.id}` : '/app/threads'
    },
    [threadList, lastThreads],
  )
  const openTeammate = useCallback(
    async (teammate: string) => {
      chooseTeammate(teammate)
      let href = teammateHref(teammate)
      // None among the latest loaded here: its own latest, if it has any.
      if (!routeThread(href)) {
        const [latest] = await api<ThreadSummary[]>(
          `/threads?teammateId=${teammate}&limit=1&sort=activity`,
        ).catch(() => [])
        if (latest) href = `/app/threads/${latest.id}`
      }
      go(href)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [teammateHref, go],
  )

  const value = useMemo(
    () => ({
      visible: expanded || (open && !!computerPage),
      expanded,
      threadId,
      toggle,
      startThread,
      newThreadPage,
      openThread,
      back,
      expand,
      close,
      activity,
      waiting,
      threads: threadList,
      reloadThreads,
      draft,
      focusKey,
      details,
      setDetails,
      revealKey,
      openPreview,
      previewRequest,
      takePreviewRequest,
      showComputer,
      computerRequest,
      takeComputerRequest,
      covered,
      setCovered,
      teammateId,
      chooseTeammate,
      teammateHref,
      openTeammate,
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
      newThreadPage,
      openThread,
      back,
      expand,
      close,
      activity,
      waiting,
      threadList,
      reloadThreads,
      draft,
      focusKey,
      details,
      setDetails,
      revealKey,
      openPreview,
      previewRequest,
      takePreviewRequest,
      showComputer,
      computerRequest,
      takeComputerRequest,
      covered,
      teammateId,
      chooseTeammate,
      teammateHref,
      openTeammate,
      openComputer,
      computerPage,
      shell,
    ],
  )
  return <Context.Provider value={value}>{children}</Context.Provider>
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
  const pending = usePendingThread(panel.threadId)
  // Docked, Escape closes it (SidePanel's own). Expanded it is the page: Escape leaves it be.
  if (!panel.visible) return null
  const { expanded, threadId } = panel
  // Expanded: the sidebar's toggle, and a pill saying where and who, which opens the details.
  const top = expanded ? (
    <PillBar>
      {threadId
        ? shown && (
            <DetailsPill
              project={shown.project}
              teammate={lead}
              label={shown.title}
              threadId={shown.id}
              heading
              machine={shown.computer.kind === 'cloud' ? undefined : shown.computer.name}
              details={`${lead?.name ?? 'the teammate'}'s computer, routines and more`}
              reconnecting={!shown.connected}
            />
          )
        : teammate && (
            <DetailsPill
              teammate={teammate}
              label={teammate.name}
              details={`${teammate.name}'s computer, routines and more`}
            />
          )}
    </PillBar>
  ) : undefined
  return (
    <SidePanel
      aria-label="Threads"
      name={PANEL}
      data-thread-panel
      expanded={expanded}
      onClose={expanded ? undefined : panel.close}
    >
      {/* Docked, a bar; expanded, a pill floats over the conversation instead (`top`). */}
      {!expanded && (
        <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
          {threadId ? (
            // Back · teammate · title · status: the title stays in sight while it scrolls.
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
                    compact
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
                  <h2 className="min-w-0 truncate text-sm font-semibold" title={shown.title}>
                    <StreamedTitle threadId={shown.id} text={shown.title} />
                  </h2>
                  <StatusDot status={shown.status} />
                  {!shown.connected && <Reconnecting />}
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
                withTitle
              />
            ) : (
              <span className="flex min-w-0 items-center gap-2 px-1.5 text-sm font-semibold">
                <TeammateAvatar teammate={teammate} className="size-5" />
                <span className="truncate">{teammate.name}</span>
                <TeammateTitle title={teammate.title} />
              </span>
            ))
          )}
          {!threadId && <span className="flex-1" />}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-8"
            onClick={panel.expand}
            aria-label="Expand"
            title="Expand"
          >
            <Maximize2 aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-8"
            onClick={panel.close}
            aria-label="Close threads"
            title="Close (Esc)"
          >
            <X aria-hidden />
          </Button>
        </div>
      )}
      {teammate || threadId ? (
        // A thread, else docked the teammate's channel, expanded a box to start one with it.
        <div className="flex min-h-0 flex-1">
          {teammate && !threadId && (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {expanded ? (
                <TeammateStart key={teammate.id} teammate={teammate} top={top} />
              ) : (
                <TeammateThreads key={teammate.id} teammate={teammate} />
              )}
            </div>
          )}
          {threadId && (
            <div className="flex min-w-0 flex-1 flex-col">
              {/* Opened before it exists: its message, until it has started. */}
              {pending ? (
                <PendingThread
                  key={threadId}
                  id={threadId}
                  thread={pending}
                  expanded={expanded}
                  top={top}
                />
              ) : (
                <ThreadConversation
                  key={threadId}
                  id={threadId}
                  expanded={expanded}
                  onExpand={panel.expand}
                  onHeading={(h) => setHeading({ id: threadId, ...h })}
                  top={top}
                />
              )}
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

/** Floats over the top of an expanded thread: the sidebar's toggle, and the pill centered. */
function PillBar({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex h-14 items-center justify-center px-12">
      <SidebarToggle className="pointer-events-auto absolute top-3 left-2 ml-0 max-md:top-2.5" />
      {children}
    </div>
  )
}

/**
 * Where and who: the project's icon, the teammate's avatar, then the thread's title (or
 * the teammate's name). It grows to show a › on hover; a click opens and closes the details
 * beside it: the thread's, its computer's, the teammate's.
 */
function DetailsPill({
  project,
  teammate,
  label,
  threadId,
  heading = false,
  machine,
  details,
  reconnecting = false,
}: {
  project?: Pick<ProjectRef, 'name' | 'icon'> | null
  teammate?: Pick<Teammate, 'id' | 'name' | 'harness'>
  label: string
  /** The label is this thread's title: it streams in when it changes. */
  threadId?: string
  /** The label is the page's heading. */
  heading?: boolean
  /** The member's machine the thread runs on. Unset on the workspace computer, the default. */
  machine?: string
  /** What the details show, for its label. */
  details: string
  reconnecting?: boolean
}) {
  const { details: open, setDetails, covered } = useThreadPanel()
  const documents = useDocumentPanel()
  // A file, preview or document in its place: pressing brings it back in front.
  const shown = open && !covered && !documents.current
  const Label = heading ? 'h1' : 'span'
  const pill = useSlideAcross<HTMLButtonElement>()
  return (
    <button
      ref={pill}
      type="button"
      className="group pointer-events-auto flex h-11 max-w-full min-w-0 items-center gap-2.5 rounded-full bg-card/90 pr-4 pl-2.5 text-[0.9375rem] font-semibold shadow-sm backdrop-blur transition-colors outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-pressed:bg-accent"
      aria-pressed={shown}
      title={shown ? 'Hide details' : `Details: ${details}`}
      onClick={() => {
        if (shown) return setDetails(false)
        documents.close()
        setDetails(true)
      }}
    >
      {project && (
        <span title={project.name} className="flex">
          <ProjectIcon project={project} className="size-6 rounded-md text-xs" />
          <span className="sr-only">{project.name}: </span>
        </span>
      )}
      {teammate && <TeammateAvatar teammate={teammate} className="size-6 shrink-0" />}
      {/* Capped, so a long title keeps it a pill: the whole of it on hover. */}
      <Label className="max-w-72 min-w-0 truncate" title={label}>
        {threadId ? <StreamedTitle threadId={threadId} text={label} /> : label}
      </Label>
      {machine && (
        <span title={`Runs on ${machine}`} className="-ml-0.5 flex shrink-0">
          <Laptop aria-hidden className="size-4 text-muted-foreground" />
          <span className="sr-only">, runs on {machine}</span>
        </span>
      )}
      {reconnecting && <Reconnecting />}
      {/* The pill grows to show it on hover and while open; always there on touch screens,
          which have no hover. */}
      <span
        aria-hidden
        className="-ml-1 flex w-[1.125rem] shrink-0 overflow-hidden text-muted-foreground transition-[width,margin,opacity] duration-200 ease-out [@media(hover:hover)]:-ml-2.5 [@media(hover:hover)]:w-0 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:-ml-1 [@media(hover:hover)]:group-hover:w-[1.125rem] [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-visible:-ml-1 [@media(hover:hover)]:group-focus-visible:w-[1.125rem] [@media(hover:hover)]:group-focus-visible:opacity-100 [@media(hover:hover)]:group-aria-pressed:-ml-1 [@media(hover:hover)]:group-aria-pressed:w-[1.125rem] [@media(hover:hover)]:group-aria-pressed:opacity-100"
      >
        <ChevronRight className="size-[1.125rem] shrink-0" />
      </span>
    </button>
  )
}

/** A damped spring: quick out, a slight overshoot, then settles. */
const SPRING =
  'linear(0, 0.037, 0.129, 0.25, 0.382, 0.511, 0.63, 0.734, 0.821, 0.89, 0.943, 0.982, 1.008, 1.025, 1.034, 1.038, 1.038, 1.035, 1.031, 1.026, 1.021, 1.016, 1.012, 1.008, 1.005, 1.003, 1.001, 1, 1)'

/**
 * Slides the element across when it moves sideways, from where it was to where it is: a
 * panel opening or closing beside the page narrows or widens what it is centered in.
 * Tracks its center, so growing on hover is not a move; a resize of the window is followed
 * without sliding.
 */
function useSlideAcross<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const last = useRef<number>(undefined)
  // A thread's preview opens or closes in a render of its own (components/kept-previews.tsx).
  useKeptPreviewShown()
  const center = (el: T) => {
    const r = el.getBoundingClientRect()
    return r.left + r.width / 2
  }
  // After each render: what opens a panel renders, and its room is taken in the same commit.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // Mid-slide, from where it shows now.
    const sliding = el.getAnimations().filter((a) => a.id === 'slide-across')
    const from = sliding.length ? center(el) : last.current
    for (const a of sliding) a.cancel()
    const to = center(el)
    last.current = to
    if (from === undefined || Math.abs(from - to) < 1) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    el.animate([{ transform: `translateX(${from - to}px)` }, { transform: 'none' }], {
      id: 'slide-across',
      duration: 550,
      easing: CSS.supports('transition-timing-function', SPRING)
        ? SPRING
        : 'cubic-bezier(0.34, 1.3, 0.64, 1)',
    })
  })
  // The window resized: where it is now, so the next render does not slide from before.
  useEffect(() => {
    const el = ref.current
    if (!el?.parentElement) return
    const observer = new ResizeObserver(() => {
      if (!el.getAnimations().some((a) => a.id === 'slide-across')) last.current = center(el)
    })
    observer.observe(el.parentElement)
    return () => observer.disconnect()
  }, [])
  return ref
}

function Reconnecting() {
  return (
    <LoaderCircle
      role="status"
      aria-label="Reconnecting"
      className="size-3.5 shrink-0 animate-spin text-muted-foreground"
    />
  )
}

const PAGE = 30
const channelPath = (teammateId: string) => `/threads?teammateId=${teammateId}`

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
  const path = channelPath(teammateId)
  const load = useCallback(
    async (opening: boolean) => {
      try {
        // The newest, as many as are shown (up to the API's most): replies and states change.
        const limit = Math.min(Math.max(loaded.current, PAGE), 100)
        const url = `${path}&limit=${limit}`
        const request =
          (opening ? preloaded<ThreadSummary[]>(url) : undefined) ?? api<ThreadSummary[]>(url)
        const page = (await request).reverse()
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
    },
    [path],
  )
  const reload = useCallback(() => load(false), [load])
  useEffect(() => {
    void load(true)
  }, [load])
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
 * Expanded with no thread open: a box to start one with the teammate, its details beside
 * it when asked for. The sidebar lists the threads.
 */
function TeammateStart({ teammate, top }: { teammate: Teammate; top?: ReactNode }) {
  const { openThread, draft, focusKey, details, setDetails, openComputer, threads } =
    useThreadPanel()
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {top}
      {details && (
        <TeammatePanel
          teammate={teammate}
          threads={threads?.filter(
            (t) =>
              t.teammate.id === teammate.id ||
              t.teammates?.some((p) => p.teammate.id === teammate.id),
          )}
          onOpenThread={openThread}
          onOpenComputer={() => openComputer(teammate.id)}
          onClose={() => setDetails(false)}
        />
      )}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-4 pb-16 md:px-10">
        <div className="flex flex-col items-center gap-3 text-center">
          <TeammateAvatar teammate={teammate} className="size-12" />
          <h2 className="text-2xl font-extrabold tracking-tight">
            What should {teammate.name} work on?
          </h2>
        </div>
        <div className="w-full max-w-3xl">
          {/* A new key each time it should take the cursor: it focuses as it mounts. */}
          <NewThread
            key={focusKey}
            teammate={teammate}
            rows={3}
            draft={draft}
            autoFocus
            typeToFocus
            placeholder={`Chat with ${teammate.name}`}
            onStarted={(thread) => openThread(thread.id)}
            openAtOnce
          />
        </div>
      </div>
    </div>
  )
}

/**
 * Docked with no thread open: a teammate's threads, read as a channel (newest last), and
 * the box to start another below them.
 */
function TeammateThreads({ teammate }: { teammate: Teammate }) {
  const { openThread, draft, focusKey } = useThreadPanel()
  const channel = useThreadChannel(teammate.id)
  const reload = channel.reload
  useLive((message) => {
    if (message.type === 'thread.updated') void reload()
  })
  const column = 'mx-auto w-full'

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
  const loadEarlier = () =>
    channel.loadOlder(() => {
      const view = scroller.current
      anchor.current = view ? view.scrollHeight - view.scrollTop : undefined
    })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scroller} className="scroll-fade scroll-fade-y min-h-0 flex-1 overflow-y-auto">
        <div className={cn(column, 'flex min-h-full flex-col justify-end pb-12')}>
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
        {/* A new key each time it should take the cursor: it focuses as it mounts. */}
        <NewThread
          key={focusKey}
          teammate={teammate}
          rows={2}
          draft={draft}
          autoFocus={focusKey > 0}
          typeToFocus
          placeholder={`Chat with ${teammate.name}`}
          onStarted={(thread) => openThread(thread.id)}
          openAtOnce
        />
      </div>
    </div>
  )
}
