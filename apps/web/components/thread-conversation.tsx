'use client'
// A thread: its messages, what it asks for, and the box to answer it. Shown by
// the threads panel, docked beside a page or expanded in its place (the thread's
// own address). Docked it keeps to the conversation; the panels a thread opens
// beside it (a file, the preview, the computer) need the room, so asking for one
// expands it first.
import {
  Globe,
  ArrowDown,
  ArrowUp,
  CalendarClock,
  ChevronDown,
  CircleStop,
  CloudUpload,
  FolderKanban,
  Laptop,
  Reply,
  LoaderCircle,
  SquareKanban,
  UserRound,
  UsersRound,
  X,
  Zap,
} from 'lucide-react'
import {
  defaultEffort,
  type Effort,
  formatPreviewElement,
  type HarnessId,
  mentionsToText,
  type PreviewElement,
  type QueuedMessageAction,
  type ReplyTo,
  suggestionFor,
} from '@brigade/contracts'
import Link from 'next/link'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  ComposerMenu,
  ComputerIcon,
  SentAttachments,
  UploadList,
  useFileDrop,
  useUploads,
  type MoveTarget,
} from '@/components/attachments'
import { EffortButton, type EffortPick } from '@/components/effort'
import { Composer } from '@/components/composer'
import { TeammateAvatar, useDashboard } from '@/components/dashboard'
import { useTouchScreen } from '@/components/desktop-touch'
import { ComputerPanel, ExpandedComputer } from '@/components/computer-panel'
import { TeachTask } from '@/components/teach-task'
import { AskedDocument, useDocumentPanel } from '@/components/document-panel'
import { FileLinksProvider } from '@/components/file-links'
import { FilePanel } from '@/components/file-panel'
import { dropKeptPreview, KeepPreview } from '@/components/kept-previews'
import {
  PHASE,
  previewLive,
  previewPhase,
  useCheckedPreview,
  useThreadPreview,
  useThreadRepositories,
} from '@/components/preview-panel'
import { PendingEdits, type PendingEditRow } from '@/components/pending-edits'
import type { PickHandlers } from '@/components/preview-panel'
import { usePreviewStart } from '@/components/preview-start'
import { ThreadProjectMenu } from '@/components/projects'
import { QueuedMessages, type Outgoing } from '@/components/queued-messages'
import { Takeover } from '@/components/takeover'
import {
  ChildrenWaiting,
  ChildrenWorking,
  isQueuedReport,
  ParentLink,
  QueuedReports,
} from '@/components/thread-children'
import { TicketRow } from '@/components/ticket-row'
import { useThreadOutputs } from '@/components/thread-outputs'
import { ChangesPanel } from '@/components/changes-panel'
import { useThreadPanel } from '@/components/thread-panel'
import { ThreadSkeleton } from '@/components/thread-skeleton'
import { ThreadTimeline, useThreadPrompts } from '@/components/thread-timeline'
import {
  MessageBubble,
  ThreadItems,
  useThreadItems,
  type ComputerDown,
} from '@/components/thread-view'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  designEditText,
  designEditsOf,
  removeDesignEdit,
  setDesignEdits,
  setEditsSender,
  updateDesignEdit,
  useDesignEdits,
} from '@/lib/pending-edits'
import { pendingThreads, useOpenedMessage } from '@/lib/pending-threads'
import {
  api,
  computerName,
  isAdmin,
  preload,
  teammateModelLabel,
  useApi,
  type Account,
  type ComputersResponse,
  type ProjectSummary,
  type Teammate,
  type Thread,
  type Ticket,
} from '@/lib/api'
import { ThreadItemsCard } from '@/components/list-items'
import { useChangesCount } from '@/lib/code-changes'
import { openCodeTab, setCodePanel } from '@/lib/code-tabs'
import { useReplyDraft } from '@/lib/reply-drafts'
import { readThreadSide, rememberThreadSide } from '@/lib/thread-side'
import { useLive } from '@/lib/use-live'
import {
  preloadThreadEvents,
  useThreadEvents,
  type ComputerAvailability,
  type EventGap,
} from '@/lib/use-thread-events'
import { cn } from '@/lib/utils'

/** What the threads panel's bar shows of a thread: who leads it, its title and state. */
export type ThreadHeading = {
  teammate: Pick<Teammate, 'id' | 'name' | 'harness'>
  /** Everyone in it: the channel beside it is one of theirs. */
  teammateIds: string[]
  title: string
  /** The project it works in, if any. */
  project: Pick<ProjectSummary, 'id' | 'name' | 'icon'> | null
  status: string
  private: boolean
  /** Where it runs: the workspace computer, or a member's own machine. */
  computer: { kind: string; name: string }
  /** The live connection to its events holds. */
  connected: boolean
  /** Who has the computer: this member, another one, or the teammate. */
  control: 'mine' | 'other' | null
}

/**
 * An element picked in the preview, by the id its page gave it, and the upload of its
 * picture; `drawing` while its page draws it, when the message waits for the picture.
 */
type Picked = {
  id: string
  element: PreviewElement
  upload?: string
  drawing?: boolean
  /** When it was picked: the pending edits go in that order, with the design comments. */
  at: number
  /** What should change on it, written in its row. */
  note?: string
}

/** Elements picked in each thread's preview, kept when another thread opens. */
const keptElements = new Map<string, Picked[]>()

const editsCount = (n: number) => (n === 1 ? '1 edit' : `${n} edits`)

/** How long a message waits for a picture its page is drawing (it may have gone away). */
const DRAWING_MS = 15_000

/** Sends ahead what a thread's conversation asks for as it opens (lib/api.ts's `preload`). */
export function preloadConversation(id: string) {
  preload(`/threads/${id}`)
  preloadThreadEvents(id)
}

/** How long the mouse rests on a thread's link before it is sent ahead: passing over a list sends nothing. */
const HOVER_MS = 80
let hovering: ReturnType<typeof setTimeout> | undefined

/**
 * A link to a thread sends it ahead (`preloadConversation`) as the mouse rests on it, and as
 * it is pressed (a touch, or a click quicker than that): it has often come back by the click.
 * None for the thread open already, which has it.
 */
export function preloadOnPoint(id: string, open = false): ComponentProps<'a'> {
  if (open) return {}
  return {
    onPointerEnter: (e) => {
      if (e.pointerType !== 'mouse') return
      clearTimeout(hovering)
      hovering = setTimeout(() => preloadConversation(id), HOVER_MS)
    },
    onPointerLeave: () => clearTimeout(hovering),
    onPointerDown: (e) => {
      if (e.button !== 0) return
      clearTimeout(hovering)
      preloadConversation(id)
    },
  }
}

export function ThreadConversation({
  id,
  expanded,
  onExpand,
  onHeading,
  top,
}: {
  id: string
  /** In the page's place, with room for panels beside it; else docked beside a page. */
  expanded: boolean
  onExpand: () => void
  /**
   * Its title and status, for the bar above: there they stay in sight while the
   * conversation scrolls. Again on each change.
   */
  onHeading: (heading: ThreadHeading) => void
  /** Floats over the top of the conversation, which scrolls under it. */
  top?: ReactNode
}) {
  const { me, projects } = useDashboard()
  const thread = useApi<Thread>(`/threads/${id}`)
  const computers = useApi<ComputersResponse>('/computers')
  const accounts = useApi<Account[]>('/accounts')
  // Since when its updates have not reached Brigade, as the thread and then the API say.
  const [eventsWaitingSince, setEventsWaitingSince] = useState<string | null>()
  useEffect(() => setEventsWaitingSince(undefined), [id])
  // The thread moved, or a computer came or went: where it runs, and where it could, change.
  useLive((message) => {
    if (message.type === 'thread.updated' && message.sessionId === id && message.moved)
      void thread.reload()
    // Its children's lines follow them; a child started or reported tells it too.
    if (
      message.type === 'thread.updated' &&
      (message.sessionId === id || thread.data?.children.some((c) => c.id === message.sessionId))
    )
      void thread.reload()
    if (
      message.type === 'thread.updated' &&
      message.sessionId === id &&
      message.eventsWaitingSince !== undefined
    )
      setEventsWaitingSince(message.eventsWaitingSince)
    if (message.type === 'computer.updated') {
      void computers.reload()
      // Its own computer, also another member's: whether it is there, as the message says.
      if (message.computerId === thread.data?.computer.id)
        setAvailability((was) => ({
          id: message.computerId,
          online: message.online,
          restarting: message.restarting ?? false,
          status: message.status ?? was?.status,
        }))
    }
  })
  // Keyed by the thread: when it started loading, for its placeholder's delays.
  const [openedAt] = useState(() => Date.now())
  const [status, setStatus] = useState<string>()
  // Its computer's availability since the thread loaded, from its sockets: newer than the thread's.
  const [availability, setAvailability] = useState<ComputerAvailability>()
  useEffect(() => setAvailability(undefined), [id])
  const {
    events,
    connected,
    firstSeq,
    gaps,
    loadOlder,
    loadingOlder,
    jumpTo,
    fillGap,
    loaded: eventsLoaded,
    reconnect,
  } = useThreadEvents(id, (status, computer) => {
    setStatus(status)
    if (!computer) return
    setAvailability(computer)
    // It moved while this page was away: the thread again, for its new computer's name and move.
    if (thread.data && computer.id !== thread.data.computer.id) void thread.reload()
  })
  const { items, queued, seen, turnId, background } = useThreadItems(events, firstSeq, gaps)
  // Opened at once (lib/pending-threads.ts): its first message shows until an event has it.
  const opened = useOpenedMessage(id)
  const delivered = events.some((e) => e.event.type === 'message.user')
  useEffect(() => {
    if (opened && delivered) pendingThreads.delivered(id)
  }, [opened, delivered, id])
  const outputs = useThreadOutputs(events)
  const preview = useCheckedPreview(id, useThreadPreview(events))
  // Preview is offered once there is something to preview: a preview it had, or code it checked out.
  const repositories = useThreadRepositories(events)
  const offersPreview = !!preview || repositories.length > 0
  // Whose code its Changes show: the teammate that last checked out code here.
  const codeTeammateId = useMemo(() => {
    const event = events.findLast(
      (e) => e.event.type === 'repositories.changed' && e.event.repositories.length > 0,
    )?.event
    return event?.type === 'repositories.changed' ? event.teammateId : undefined
  }, [events])
  const [error, setError] = useState<string>()
  // The turn asked to stop, until it ends: a tool can take a moment to give up.
  const [stopping, setStopping] = useState<string>()
  // Text added from elsewhere (a document's Ask) lands here with the cursor after it.
  const [text, setText] = useReplyDraft(id, () => focusComposer())
  // The teammate's guess at this member's next message, while it stands (suggestionFor).
  const guess = useMemo(
    () =>
      suggestionFor(
        events.map((e) => e.event),
        me.suggestions ? me.memberId : null,
      ),
    [events, me.memberId, me.suggestions],
  )
  const guessSeq = guess ? events[guess.index]?.seq : undefined
  // Typing writes over it for good, even once the box is empty again; so does taking it.
  const [dismissed, setDismissed] = useState<number>()
  useEffect(() => {
    if (guessSeq !== undefined && text !== '') setDismissed(guessSeq)
  }, [guessSeq, text])
  // The message the next one replies to, quoted above the composer.
  const [replyTo, setReplyTo] = useState<ReplyTo>()
  useEffect(() => setReplyTo(undefined), [id])
  // The computer the next message moves the thread to, as a chip above it (+ › Continue on…).
  const [moveTo, setMoveTo] = useState<MoveTarget>()
  useEffect(() => setMoveTo(undefined), [id])
  // The effort just picked, until the thread comes back with it.
  const [effortPicked, setEffortPicked] = useState<{ value: Effort | null }>()
  // The turn running when it was picked: that turn keeps the effort it started with.
  const [effortTurn, setEffortTurn] = useState<string>()
  useEffect(() => {
    setEffortPicked(undefined)
    setEffortTurn(undefined)
  }, [id])
  // Its machine went offline: Wait keeps the card offering the cloud computer away.
  const [waitForMachine, setWaitForMachine] = useState(false)
  useEffect(() => setWaitForMachine(false), [id])
  // Its files stay with the thread, like its text, when another thread opens.
  const files = useUploads(id)
  // Elements picked in the preview, as chips above it; the message carries them, and their
  // pictures as files of its own that show in their chips rather than with the other files.
  // Kept with the thread's files: a picture's file shows in its chip.
  const [elements, setElements] = useState<Picked[]>(() =>
    (keptElements.get(id) ?? []).map(({ drawing: _drawing, ...e }) => e),
  )
  useEffect(() => {
    if (elements.length) keptElements.set(id, elements)
    else keptElements.delete(id)
  }, [id, elements])
  const elementsRef = useRef(elements)
  elementsRef.current = elements
  const pickElement = useMemo<PickHandlers>(() => {
    const drawn = (pickId: string, change: Partial<Picked> = {}) =>
      setElements((list) =>
        list.map((e) => (e.id === pickId ? { ...e, ...change, drawing: false } : e)),
      )
    return {
      element: (pickId, element) => {
        setElements((list) =>
          list.some(
            (e) => e.element.page === element.page && e.element.selector === element.selector,
          )
            ? list
            : [...list, { id: pickId, element, drawing: true, at: Date.now() }],
        )
        setFocusEdit(pickId)
        setTimeout(() => drawn(pickId), DRAWING_MS)
      },
      picture: (pickId, image) => {
        const picked = elementsRef.current.find((e) => e.id === pickId)
        if (!picked?.drawing) return
        if (!image) return drawn(pickId)
        const name = `element-${pickId}.png`
        const [upload] = files.add([new File([image], name, { type: 'image/png' })])
        drawn(pickId, { ...(upload && { upload }), element: { ...picked.element, image: name } })
      },
    }
  }, [files.add])
  // A picture that did not upload is left out: the element goes without it.
  const removeUpload = files.remove
  useEffect(() => {
    const failed = elements.filter(
      (e) => e.upload && files.uploads.some((u) => u.key === e.upload && u.error),
    )
    if (!failed.length) return
    for (const e of failed) removeUpload(e.upload!)
    setElements((list) =>
      list.map((e) => {
        if (!failed.some((f) => f.id === e.id)) return e
        const { image: _image, ...element } = e.element
        return { id: e.id, element, at: e.at, ...(e.note !== undefined && { note: e.note }) }
      }),
    )
  }, [elements, files.uploads, removeUpload])
  const pictureKeys = new Set(elements.flatMap((e) => (e.upload ? [e.upload] : [])))
  const removeElement = (pickId: string) => {
    const upload = elements.find((e) => e.id === pickId)?.upload
    if (upload) files.remove(upload)
    setElements((list) => list.filter((e) => e.id !== pickId))
  }
  // Comments made on a design's canvas beside the thread wait here too, with the elements:
  // one numbered list, in the order they were made, sent in one message.
  const designEdits = useDesignEdits(id)
  const [focusEdit, setFocusEdit] = useState<string>()
  const lastDesignEdit = designEdits.at(-1)?.id
  useEffect(() => {
    if (lastDesignEdit) setFocusEdit(undefined)
  }, [lastDesignEdit])
  const pendingEdits = [
    ...elements.map((e) => ({ at: e.at, element: e, design: undefined })),
    ...designEdits.map((d) => ({ at: d.at, element: undefined, design: d })),
  ].sort((a, b) => a.at - b.at)
  const editRows: PendingEditRow[] = pendingEdits.map(({ element: e, design: d }) =>
    e
      ? {
          kind: 'element',
          key: e.id,
          picked: {
            element: e.element,
            ...(e.drawing && { drawing: true }),
            ...(e.upload && {
              picture: files.uploads.find((u) => u.key === e.upload)?.preview,
            }),
          },
          where: e.element.page || '/',
          note: e.note ?? '',
          onNote: (note: string) =>
            setElements((list) => list.map((x) => (x.id === e.id ? { ...x, note } : x))),
          onRemove: () => removeElement(e.id),
        }
      : {
          kind: 'design',
          key: d!.id,
          label: d!.label,
          where: d!.folder,
          note: d!.note,
          onNote: (note: string) => updateDesignEdit(id, d!.id, note),
          onRemove: () => removeDesignEdit(id, d!.id),
        },
  )
  const drop = useFileDrop(files.add)
  const root = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  // The teammate's panel (its computer, routines, profile): opened from the threads panel's bar.
  const {
    details: watching,
    setDetails: setWatching,
    revealKey,
    setCovered,
    openComputer,
    computerPage,
    previewRequest,
    takePreviewRequest,
    computerRequest,
    takeComputerRequest,
  } = useThreadPanel()
  // Beside the thread as it was left in this tab: back from another thread, the same one shows.
  const [side] = useState(() => readThreadSide(id))
  // A file a message names, open beside the thread in the desktop's place.
  const [file, setFile] = useState<{ path: string; teammateId?: string } | undefined>(() =>
    side?.kind === 'file'
      ? { path: side.path, ...(side.teammateId && { teammateId: side.teammateId }) }
      : undefined,
  )
  // The app the teammate runs, beside the thread in the desktop's place.
  const [previewing, setPreviewing] = useState(side?.kind === 'preview')
  // The files it changed, beside the thread in the desktop's place, without a preview.
  const [changesOpen, setChangesOpen] = useState(side?.kind === 'changes')
  // Closed, or something else beside it: its kept frame goes too.
  useEffect(() => {
    if (!previewing) dropKeptPreview(id)
  }, [id, previewing])
  useEffect(() => {
    rememberThreadSide(
      id,
      file
        ? { kind: 'file', ...file }
        : previewing
          ? { kind: 'preview' }
          : changesOpen
            ? { kind: 'changes' }
            : undefined,
    )
  }, [id, file, previewing, changesOpen])
  // The computer expanded over the thread from its details, which it hides until it closes.
  const [computerOpen, setComputerOpen] = useState(false)
  // Teach a task: the computer over the window, recording the person doing it.
  const [teaching, setTeaching] = useState(false)
  // Recording a task needs a desktop to do it on: not offered on phones.
  const phone = useIsMobile()
  // Asked of the API only for a thread not loaded from its start, shown wide.
  const prompts = useThreadPrompts(
    id,
    items,
    firstSeq <= 1 && gaps.length === 0,
    expanded && !phone,
  )
  // No Tab key to take a suggestion: a Use button beside the box instead.
  const touch = useTouchScreen()
  // One panel beside the thread: a document opened anywhere replaces the file, preview or computer.
  const documents = useDocumentPanel()
  const openFile = (f: { path: string; teammateId?: string }) => {
    if (!expanded) onExpand()
    documents.close()
    setPreviewing(false)
    setChangesOpen(false)
    setFile(f)
  }
  const openPreview = () => {
    if (!expanded) onExpand()
    documents.close()
    setFile(undefined)
    setChangesOpen(false)
    setPreviewing(true)
  }
  useEffect(() => {
    if (documents.current) {
      setFile(undefined)
      setPreviewing(false)
      setChangesOpen(false)
    }
  }, [documents.current])
  // The bar's computer button brings the teammate's panel back in front of a file or preview:
  // a click since this thread opened, not one made on another thread.
  const revealedAt = useRef(revealKey)
  useEffect(() => {
    if (revealKey === revealedAt.current) return
    revealedAt.current = revealKey
    setFile(undefined)
    setPreviewing(false)
    setChangesOpen(false)
  }, [revealKey])
  // And it shows pressed only while the panel is the one in front.
  useEffect(() => {
    setCovered(!!file || previewing || changesOpen)
    return () => setCovered(false)
  }, [file, previewing, changesOpen, setCovered])
  // A preview a person started, or asked the teammate for: its panel opens once it starts.
  const [awaitingPreview, setAwaitingPreview] = useState(false)
  const live = previewLive(preview)
  // Opened from the sidebar's preview icon: its panel opens once the preview shows as up.
  useEffect(() => {
    if (previewRequest?.threadId !== id) return
    takePreviewRequest()
    setAwaitingPreview(true)
  }, [previewRequest, id, takePreviewRequest])
  // Opened from Home's ticket once the member took control: its computer, over the window.
  useEffect(() => {
    if (computerRequest?.threadId !== id) return
    takeComputerRequest()
    setComputerOpen(true)
  }, [computerRequest, id, takeComputerRequest])
  useEffect(() => {
    if (!awaitingPreview || !live) return
    setAwaitingPreview(false)
    openPreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingPreview, live])
  const previewTeammate =
    thread.data?.teammates.find((p) => p.teammate.id === preview?.teammateId)?.teammate ??
    thread.data?.teammate
  const previewStart = usePreviewStart({
    threadId: thread.data?.id,
    teammateName: previewTeammate?.name ?? 'The teammate',
    ...(thread.data
      ? {
          computer: {
            name: thread.data.computer.name,
            cloud: thread.data.computer.kind === 'cloud',
          },
        }
      : {}),
    ask: (text) => deliver(text),
    onStarting: () => (live ? openPreview() : setAwaitingPreview(true)),
    onAsked: () => setAwaitingPreview(true),
  })
  useEffect(() => {
    if (previewStart.error) setError(previewStart.error)
  }, [previewStart.error])
  const focusComposer = () =>
    requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLElement>(
          '[data-composer-frame] [contenteditable="true"], [data-composer-frame] textarea',
        )
        ?.focus(),
    )
  /** A message for the teammate, in the composer for the person to send. */
  const askInComposer = (message: string) => {
    setText(message)
    focusComposer()
  }
  const replyToMessage = (reply: ReplyTo) => {
    setReplyTo(reply)
    focusComposer()
  }
  // Messages sent from here that the thread has not shown yet (queued, read or cancelled).
  const [outgoing, setOutgoing] = useState<Outgoing[]>([])
  const pendingOut = useMemo(() => {
    // A runner too old for message ids shows the message without one: matched by its text.
    const plain = events.filter((e) => e.event.type === 'message.user' && !e.event.messageId)
    return outgoing.filter(
      (o) =>
        !seen.has(o.messageId) &&
        !plain.some(
          (e) => e.seq > o.afterSeq && e.event.type === 'message.user' && e.event.text === o.text,
        ),
    )
  }, [outgoing, seen, events])
  const pendingRef = useRef(pendingOut)
  pendingRef.current = pendingOut

  // At the end, the thread follows what comes in, streamed words included. Scrolled up to
  // read, nothing moves: a button goes back down. An older page above does not move the view.
  const following = useRef(true)
  const [atEnd, setAtEnd] = useState(true)
  const loaded = !!thread.data
  useEffect(() => {
    const view = scroller.current
    if (!view) return
    const measure = () => {
      const end = view.scrollHeight - view.clientHeight - view.scrollTop < END_SLACK
      following.current = end
      setAtEnd(end)
    }
    // Opening or closing a fold moves the end too, without a scroll.
    const afterClick = () => requestAnimationFrame(measure)
    view.addEventListener('scroll', measure, { passive: true })
    view.addEventListener('click', afterClick)
    return () => {
      view.removeEventListener('scroll', measure)
      view.removeEventListener('click', afterClick)
    }
  }, [loaded])
  const toEnd = (behavior: ScrollBehavior = 'instant') => {
    following.current = true
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior })
  }
  const lastKey = items.at(-1)?.key
  const lastSeq = events.at(-1)?.seq
  useEffect(() => {
    if (following.current) toEnd()
  }, [lastKey, lastSeq, pendingOut.length, loaded])
  // An older page goes in above what is on screen: keep that where it was.
  const anchor = useRef<number>(undefined)
  const loadEarlier = () =>
    loadOlder(() => {
      const view = scroller.current
      anchor.current = view ? view.scrollHeight - view.scrollTop : undefined
    })
  useLayoutEffect(() => {
    const fromEnd = anchor.current
    anchor.current = undefined
    const view = scroller.current
    if (fromEnd !== undefined && view) view.scrollTop = view.scrollHeight - fromEnd
  }, [firstSeq, gaps])
  // A gap's page goes in where it is: read up into it, what is on screen stays where it was.
  const loadGap = (gap: EventGap, line: HTMLElement) => {
    const view = scroller.current
    const fromBelow =
      !!view &&
      line.getBoundingClientRect().top < view.getBoundingClientRect().top + view.clientHeight / 2
    return fillGap(gap, fromBelow ? 'last' : 'first', () => {
      if (fromBelow && view) anchor.current = view.scrollHeight - view.scrollTop
    })
  }

  // The timeline: a message it went to, once it shows, comes to the top of the view. Pages
  // near it then wait for a scroll of the person's own, rather than loading at once.
  const [jumping, setJumping] = useState<number>()
  const [settled, setSettled] = useState(true)
  useEffect(() => {
    setJumping(undefined)
    setSettled(true)
  }, [id])
  const jump = (seq: number) => {
    setSettled(false)
    setJumping(seq)
    // Only this message's own failure: a newer click keeps its place.
    void jumpTo(seq).catch(() => setJumping((was) => (was === seq ? undefined : was)))
  }
  useLayoutEffect(() => {
    const view = scroller.current
    const node =
      jumping !== undefined && view?.querySelector<HTMLElement>(`[data-seq="${jumping}"]`)
    if (!view || !node) return
    setJumping(undefined)
    following.current = false
    // Below the bar floating over the top of the conversation.
    const top = node.getBoundingClientRect().top - view.getBoundingClientRect().top
    view.scrollTo({ top: view.scrollTop + top - JUMP_MARGIN })
  }, [jumping, events, gaps])
  useEffect(() => {
    const view = scroller.current
    if (!view || settled) return
    const scrolled = () => setSettled(true)
    view.addEventListener('wheel', scrolled, { passive: true })
    view.addEventListener('touchmove', scrolled, { passive: true })
    view.addEventListener('keydown', scrolled)
    return () => {
      view.removeEventListener('wheel', scrolled)
      view.removeEventListener('touchmove', scrolled)
      view.removeEventListener('keydown', scrolled)
    }
  }, [settled])
  useEffect(() => {
    if (thread.data) setStatus(thread.data.status)
    if (thread.data) setEventsWaitingSince(thread.data.eventsWaitingSince)
  }, [thread.data])
  useEffect(() => {
    const t = thread.data
    if (!t) return
    onHeading({
      teammate: { ...t.teammate, harness: t.teammate.harness as Teammate['harness'] },
      teammateIds: t.teammates.length ? t.teammates.map((p) => p.teammate.id) : [t.teammate.id],
      title: t.title,
      project: t.project,
      computer: { kind: t.computer.kind, name: t.computer.name },
      status: status ?? t.status,
      private: t.private,
      connected,
      control: !t.controlledByMemberId
        ? null
        : t.controlledByMemberId === me.memberId
          ? 'mine'
          : 'other',
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.data, status, connected])
  // Status changes can open or close tickets (a cap, an empty account): refetch them. Not
  // for the first status: it came with them.
  const reload = thread.reload
  const statusWas = useRef<string>(undefined)
  useEffect(() => {
    const was = statusWas.current
    statusWas.current = status
    if (was && status !== was) void reload()
  }, [status, reload])

  // The conversation's column: the page's width expanded, the panel's docked.
  const column = cn('mx-auto w-full', expanded ? 'max-w-5xl px-4 md:px-10' : 'px-4')
  // Loading, the conversation's shape shows in the column its messages will fill; slow, it can try again.
  const retry = () => {
    reconnect()
    void thread.reload()
  }
  // Outputs' changed files: of the teammate that checked out code, read again as its status
  // changes (a turn starts or ends).
  const changesTeammate = repositories.length
    ? (codeTeammateId ?? thread.data?.teammate.id)
    : undefined
  const changedFiles = useChangesCount(thread.data?.id, changesTeammate, status)
  if (!thread.data)
    return thread.error ? (
      <p className={cn(column, 'pt-6 text-sm text-destructive-text')}>{thread.error.message}</p>
    ) : (
      <div className={cn(column, expanded ? 'pt-6 md:pt-8' : 'pt-4')}>
        <ThreadSkeleton since={openedAt} onRetry={retry} />
      </div>
    )
  const t = thread.data
  const current = status ?? t.status
  const busy = current === 'running' || current === 'starting'
  // Its teammate's call waits on a decision: a message waits for it too. Waiting only on a
  // ticket or question it opened, the teammate reads a message at once and the ask stays open.
  const deciding = current === 'waiting' && t.tickets.some(holdsCall)
  // In an empty box only, with nothing attached or quoted, and once the teammate is done.
  const suggestion =
    guess &&
    guessSeq !== dismissed &&
    !busy &&
    current !== 'waiting' &&
    !replyTo &&
    files.uploads.length === 0
      ? guess.text
      : undefined
  const effort: EffortPick = {
    value: effortPicked ? effortPicked.value : t.effort,
    // The starting teammate's model: where Default sits.
    fallback: defaultEffort(t.teammate.harness as HarnessId, t.teammate.model),
    onPick: (value) => {
      setEffortPicked({ value })
      setEffortTurn(busy ? turnId : undefined)
      setError(undefined)
      api(`/threads/${id}`, { method: 'PATCH', body: { effort: value } })
        .then(() => thread.reload())
        .catch((e: Error) => setError(e.message))
        .finally(() => setEffortPicked(undefined))
    },
  }
  const effortLater = busy && !!turnId && effortTurn === turnId
  const people = t.teammates.length ? t.teammates.map((p) => p.teammate) : [t.teammate]
  // Who is answering now: the last turn that started, else whoever was asked last.
  const lastTurn = events.findLast((e) => e.event.type === 'turn.started')?.event.teammateId
  const answering =
    people.find((p) => p.id === lastTurn) ??
    t.teammates.reduce<(typeof t.teammates)[number] | undefined>(
      (a, b) => (!a || b.lastTurnAt > a.lastTurnAt ? b : a),
      undefined,
    )?.teammate ??
    t.teammate
  // Approvals, questions, the teammate's own tickets and caps on a connector call show in the thread itself; other open tickets above it.
  const notices = t.tickets.filter(
    (ticket) =>
      ticket.type !== 'approval' &&
      !(ticket.type === 'question' && ticket.payload.source === 'harness') &&
      !(ticket.type === 'request' && ticket.payload.source === 'harness') &&
      !(ticket.type === 'cap' && ticket.payload.connectionId),
  )
  // A skill the teammate proposed has no event in the thread: its ticket shows at the end, where the reply that mentions it is.
  // So does Brigade's proposal to let a playbook's action act on its own, after the decision that earned it.
  const proposals = t.tickets.filter(
    (ticket) =>
      ticket.type === 'approval' &&
      (ticket.payload.skillAction ||
        ticket.payload.playbookActivation ||
        ticket.payload.playbookPromotion),
  )
  const ticketCard = (tickets: typeof t.tickets, className: string) => (
    <Card className={cn('gap-0 overflow-hidden py-0', className)}>
      <ul className="divide-y">
        {tickets.map((ticket) => (
          <TicketRow
            key={ticket.id}
            me={me}
            ticket={{
              ...ticket,
              status: 'open',
              resolvedAt: null,
              session: {
                id: t.id,
                title: t.title,
                origin: t.origin,
                startedByMemberId: t.startedByMemberId,
                projectId: t.project?.id ?? null,
                parentId: t.parent?.id ?? null,
                archivedAt: t.archivedAt ?? null,
                teammate: t.teammate,
              },
            }}
            onResolve={async (ticketId, approved, _always, edited) => {
              setError(undefined)
              try {
                await api(`/tickets/${ticketId}/resolve`, {
                  body: { approved, ...(edited ? { edited } : {}) },
                })
              } catch (e) {
                setError((e as Error).message)
              }
              await thread.reload()
            }}
          />
        ))}
      </ul>
    </Card>
  )

  // Where the thread can continue: its starter moves it, it runs on their accounts. The cloud
  // computer or a machine of theirs, with an account for each of its teammates.
  const harnesses = new Set(people.map((p) => p.harness))
  const hasAccounts = (computerId: string) =>
    [...harnesses].every((harness) =>
      (accounts.data ?? []).some(
        (a) =>
          a.computer.id === computerId &&
          a.provider === harness &&
          (a.status === 'ready' || a.status === 'unverified'),
      ),
    )
  const movable = t.startedByMemberId === me.memberId && !t.controlledByMemberId && !t.move
  const moveTargets: MoveTarget[] = movable
    ? (computers.data?.computers ?? [])
        .filter((c) => c.status !== 'destroyed')
        .map((c) => ({
          id: c.id,
          name: computerName(c),
          cloud: c.kind === 'cloud',
          current: c.id === t.computer.id,
          ...(c.id !== t.computer.id && !hasAccounts(c.id) ? { unavailable: 'No account' } : {}),
          ...(c.kind !== 'cloud' && !c.online ? { offline: true } : {}),
        }))
        .sort((a, b) => Number(!!b.current) - Number(!!a.current))
    : []
  // What the sockets said, once about the computer the thread is on (after a move, not yet reloaded: not).
  const liveComputer = availability?.id === t.computer.id ? availability : undefined
  const machine = {
    ...t.computer,
    ...liveComputer,
    status: liveComputer?.status ?? t.computer.status,
  }
  const machineOnline = machine.online
  // Its computer went away during a turn: said where the answer would show, by the machine's name.
  const machineDown: ComputerDown | undefined = machine.restarting
    ? { name: machine.name, cloud: machine.kind === 'cloud', state: 'restarting' }
    : machine.online
      ? undefined
      : machine.kind === 'cloud'
        ? machine.status === 'error' || machine.status === 'destroyed'
          ? undefined
          : // Stopped from its menu, it waits for someone to start it; else it is coming back.
            {
              name: machine.name,
              cloud: true,
              state: machine.status === 'stopped' ? 'offline' : 'restarting',
            }
        : { name: machine.name, cloud: false, state: 'offline' }
  // Its machine is offline: offer the cloud computer, where its teammates can pick up.
  const cloudTarget = moveTargets.find((c) => c.cloud && !c.current && !c.unavailable)
  const offerCloud =
    t.computer.kind !== 'cloud' && machineOnline === false && !!cloudTarget && !waitForMachine
  const movingTo =
    t.move &&
    computerName(
      computers.data?.computers.find((c) => c.id === t.move!.to) ?? {
        kind: 'member_machine',
        name: 'the other computer',
      },
    )
  // A move with a message shows on the message itself, unless it waits on the new computer.
  const moveStatus =
    t.move && (t.move.waitingFor || !pendingOut.some((o) => o.state === 'moving'))
      ? t.move.phase === 'waiting'
        ? `Moves to ${movingTo} once this turn ends`
        : t.move.waitingFor === 'update'
          ? `Moves to ${movingTo} once its runner has updated`
          : t.move.waitingFor === 'online'
            ? `Moves to ${movingTo} once it is online`
            : `Moving to ${movingTo}…`
      : undefined
  // Expanded, its computer over the window, to act there (its details' screen is to watch);
  // docked, the computer's own page, the thread beside it.
  const showComputer = () => {
    if (!expanded) return openComputer(t.teammate.id, { threadId: id })
    setComputerOpen(true)
  }

  async function call(path: string, body?: unknown) {
    setError(undefined)
    try {
      await api(`/threads/${id}${path}`, { method: 'POST', body: body ?? {} })
    } catch (e) {
      setError((e as Error).message)
      throw e
    }
  }

  const ready =
    (text.trim() ||
      files.ids.length > 0 ||
      elements.length > 0 ||
      designEdits.length > 0 ||
      moveTo) &&
    !files.busy &&
    !elements.some((e) => e.drawing) &&
    !files.failed

  /**
   * Send the composer's message; it shows above the composer until the thread shows it.
   * Queued while a turn runs. With a computer to continue on, the thread moves there
   * first and the message goes with it; with nothing written, it just moves.
   */
  async function send(e?: React.FormEvent) {
    e?.preventDefault()
    if (!ready || deciding) return
    const written = text.trim()
    const replying = replyTo
    const moving = moveTo
    const picked = elements
    const commented = designEdits
    if (
      moving &&
      !written &&
      files.ids.length === 0 &&
      picked.length === 0 &&
      commented.length === 0
    ) {
      setMoveTo(undefined)
      return moveThread(moving.id).catch(() => setMoveTo((current) => current ?? moving))
    }
    // The edits after what the person wrote, so a preview of the message starts with it,
    // in the order they were made.
    const sending = [
      written,
      ...pendingEdits.map(({ element: e, design: d }) =>
        e
          ? formatPreviewElement({ ...e.element, ...(e.note?.trim() && { note: e.note }) })
          : designEditText(d!),
      ),
    ]
      .filter(Boolean)
      .join('\n\n')
    setText('')
    setReplyTo(undefined)
    setMoveTo(undefined)
    setElements([])
    setDesignEdits(id, [])
    try {
      await deliver(sending, files.ids, undefined, replying, moving)
      files.clear()
    } catch (err) {
      // Not sent: back in the composer, as it was.
      setText((current) => current || written)
      setReplyTo((current) => current ?? replying)
      setMoveTo((current) => current ?? moving)
      setElements((current) => (current.length ? current : picked))
      if (!designEditsOf(id).length) setDesignEdits(id, commented)
      setError((err as Error).message)
    }
  }

  // The canvas of a design beside the thread adds its comments here while this composer can take
  // them; over the page, it hides the composer and sends the edits from there.
  const sendRef = useRef(send)
  sendRef.current = send
  const sendEdits = useCallback(() => void sendRef.current().catch(() => undefined), [])
  const editsDisabled = deciding
    ? 'Approve or deny the request above first'
    : !ready
      ? 'Wait for the pictures to finish'
      : undefined
  useEffect(() => {
    setEditsSender(
      id,
      // Without the right to write here, no composer takes them: the canvas sends at once.
      t.mayPrompt
        ? {
            count: editRows.length,
            order: editRows.map((r) => r.key),
            send: sendEdits,
            ...(editsDisabled && { disabled: editsDisabled }),
          }
        : undefined,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the order by its keys
  }, [id, t.mayPrompt, editRows.map((r) => r.key).join('\n'), sendEdits, editsDisabled])
  useEffect(() => () => setEditsSender(id, undefined), [id])

  /** Continue the thread on another computer without a message: its teammate picks up where it was. */
  async function moveThread(computerId: string) {
    await call('/move', { computerId })
    await thread.reload()
  }

  /** Send a message to the thread: the composer's, or a choice someone clicked. Throws when it is not sent. */
  async function deliver(
    sending: string,
    attachmentIds: string[] = [],
    pick?: string,
    replyTo?: ReplyTo,
    moveTo?: MoveTarget,
  ) {
    const message: Outgoing = {
      messageId: newMessageId(),
      text: sending,
      files: attachmentIds.length,
      afterSeq: events.at(-1)?.seq ?? 0,
      state: 'sending',
      ...(moveTo ? { movingTo: moveTo.name } : {}),
    }
    const update = (state: Outgoing['state']) =>
      setOutgoing((list) =>
        list.map((o) => (o.messageId === message.messageId ? { ...o, state } : o)),
      )
    setOutgoing((list) => [...list, message])
    // Sending goes back to the end, to see the answer come.
    following.current = true
    try {
      const sent = await api<{ delivery?: string }>(`/threads/${id}/messages`, {
        body: {
          text: message.text,
          attachmentIds,
          messageId: message.messageId,
          pick,
          replyTo,
          ...(moveTo ? { moveTo: moveTo.id } : {}),
        },
      })
      setError(undefined)
      const starting = sent.delivery === 'starting'
      const moving = sent.delivery === 'moving'
      update(moving ? 'moving' : starting ? 'starting' : 'sent')
      if (moving) void thread.reload()
      // The computer says it got a message within seconds, or a few minutes when it starts
      // first. A move waits for the turn, then for the files to be handed over: longer.
      setTimeout(
        () => {
          if (pendingRef.current.some((o) => o.messageId === message.messageId)) update('failed')
        },
        moving ? 30 * 60_000 : starting ? 10 * 60_000 : 20_000,
      )
    } catch (err) {
      setOutgoing((list) => list.filter((o) => o.messageId !== message.messageId))
      throw err
    }
  }

  const queueAction = (messageId: string, action: QueuedMessageAction) =>
    call(`/messages/${messageId}`, action).catch(() => undefined)

  const peopleLinks = people.map((p, i) => (
    <span key={p.id} className="flex items-center gap-1.5">
      <TeammateAvatar teammate={p} className="size-5" />
      <span>
        <Link
          href={`/app/teammates/${p.id}`}
          className="font-semibold text-foreground hover:underline"
        >
          {p.name}
        </Link>
        {i < people.length - 1 && ','}
      </span>
    </span>
  ))
  const projectMenu = (
    <ThreadProjectMenu threadId={t.id} project={t.project} onMoved={() => void thread.reload()} />
  )

  // Expanded, what is not the conversation sits in the panel beside it: the thread's
  // computer (with Preview), its details, then what it made.
  // Its name first, on one line that opens when it is cut, as the pill is out of sight on a
  // phone. Then one row per fact, an icon for its kind: who is in it, where it runs, its project,
  // its task, who started it. Not its teammate and the cloud computer: the panel's header says them.
  const fact = 'flex min-w-0 items-center gap-2.5'
  const factIcon = 'size-4 shrink-0 text-muted-foreground'
  const details = (
    <div className="flex flex-col gap-2 text-sm">
      {t.title && <ThreadName title={t.title} />}
      {people.length > 1 && (
        <div className={fact}>
          <UsersRound aria-label="Teammates" className={factIcon} />
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">{peopleLinks}</div>
        </div>
      )}
      {/* A member's machine: whether its runner is there, which the header does not say. */}
      {t.computer.kind !== 'cloud' && (
        <div className={fact}>
          <Laptop aria-label="Computer" className={factIcon} />
          <span className="min-w-0 truncate" title={computerName(t.computer)}>
            {computerName(t.computer)}
          </span>
          {machineOnline !== undefined && (
            <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
              <span
                aria-hidden
                className={cn(
                  'size-1.5 rounded-full',
                  machineOnline ? 'bg-success' : 'bg-muted-foreground/50',
                )}
              />
              {machineOnline ? 'online' : 'offline'}
            </span>
          )}
        </div>
      )}
      {/* The menu stays away while there is no project to move it to. */}
      {(t.project || projects.some((p) => !p.archivedAt)) && (
        <div className={fact}>
          <FolderKanban aria-label="Project" className={factIcon} />
          {projectMenu}
        </div>
      )}
      {t.task && (
        <div className={fact}>
          <SquareKanban aria-label="Task" className={factIcon} />
          <Link href={`/app/tasks?task=${t.task.id}`} className="truncate hover:underline">
            {t.task.title}
          </Link>
        </div>
      )}
      <div className={cn(fact, 'text-muted-foreground')}>
        {t.origin === 'trigger' ? (
          <Zap aria-label="Started by a trigger" className={factIcon} />
        ) : t.origin === 'schedule' ? (
          <CalendarClock aria-label="Started by a schedule" className={factIcon} />
        ) : (
          <UserRound aria-label="Started by" className={factIcon} />
        )}
        <span className="min-w-0">
          {t.origin === 'trigger' ? (
            `Trigger "${t.trigger?.label ?? 'deleted'}", on ${t.startedBy.user.name}'s accounts`
          ) : t.origin === 'schedule' ? (
            <>
              Schedule{' '}
              {t.schedule ? (
                <Link href="/app/routines" className="hover:underline">
                  &ldquo;{t.schedule.title}&rdquo;
                </Link>
              ) : (
                '(deleted)'
              )}
              , on {t.startedBy.user.name}&rsquo;s accounts
            </>
          ) : (
            `Started by ${t.startedBy.user.name}`
          )}
        </span>
      </div>
    </div>
  )
  // Top right of the expanded thread, across from the sidebar's toggle and round like it: the
  // app it builds is the thread's, not its computer's, and stays in reach with the details closed.
  // What a click does, not only what it is about: its label, on hover and for screen readers.
  // As far in as the toggle (left-2), so the pill bar's px-12 leaves the same gap on each side.
  const openChanges = () => {
    if (!changesTeammate) return
    // A preview running this copy: the code beside it, on Changes.
    if (live && preview?.teammateId === changesTeammate) {
      setCodePanel(t.id, { open: true, side: 'changes', tree: true })
      return openPreview()
    }
    if (!expanded) onExpand()
    documents.close()
    setFile(undefined)
    setPreviewing(false)
    setChangesOpen(true)
  }
  const previewLabel = previewStart.busy
    ? 'Starting the preview…'
    : previewing
      ? 'Hide preview'
      : live
        ? 'Open preview'
        : 'Start preview'
  const previewButton = offersPreview && top && (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex h-14 items-center justify-end px-2">
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="pointer-events-auto relative rounded-full bg-card/90 shadow-sm backdrop-blur"
        aria-pressed={previewing}
        aria-label={previewLabel}
        disabled={previewStart.busy}
        onClick={() => {
          if (previewing) return setPreviewing(false)
          if (live) return openPreview()
          // Stopped: the panel says what happens while it starts again.
          if (preview) openPreview()
          void previewStart.start()
        }}
        tooltip={
          previewStart.busy || previewing
            ? previewLabel
            : live
              ? `${previewLabel}: the app ${previewTeammate?.name ?? answering.name} runs, to try it`
              : `${previewLabel}: runs the app this thread builds, to try it`
        }
      >
        {previewStart.busy ? (
          <LoaderCircle aria-hidden className="animate-spin" />
        ) : (
          <Globe aria-hidden />
        )}
        {preview && live && (
          <span
            className={cn(
              'absolute top-0.5 right-0.5 size-2 rounded-full ring-2 ring-card',
              PHASE[previewPhase(preview)].dot,
            )}
            aria-label={PHASE[previewPhase(preview)].label}
            role="img"
          />
        )}
      </Button>
    </div>
  )

  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col">
      {/* Beside the thread, so only expanded: docked, opening one expands it first. Outside
          what scrolls: its fade would hide them. */}
      {expanded && file && (
        <FilePanel
          key={`${file.teammateId ?? ''}:${file.path}`}
          threadId={t.id}
          path={file.path}
          teammateId={file.teammateId}
          teammateName={(teammateId) =>
            people.find((p) => p.id === teammateId)?.name ?? t.teammate.name
          }
          mayEdit={t.mayPrompt}
          previewCopy={
            live && preview?.teammateId
              ? {
                  teammateId: preview.teammateId,
                  name: people.find((p) => p.id === preview.teammateId)?.name ?? answering.name,
                  // In the code beside the preview, the file of the copy it runs.
                  open: (path) => {
                    openCodeTab(t.id, { teammateId: preview.teammateId!, path })
                    openPreview()
                  },
                }
              : undefined
          }
          onOpen={openFile}
          onClose={() => setFile(undefined)}
        />
      )}

      {/* Rendered by the dashboard, so its frame stays as it was while another thread shows. */}
      {previewing && preview && (
        <KeepPreview
          shown={expanded && !file && !documents.current}
          threadId={t.id}
          preview={preview}
          teammateName={people.find((p) => p.id === preview.teammateId)?.name ?? answering.name}
          computerName={t.computer.name}
          mayControl={t.mayPrompt}
          onClose={() => setPreviewing(false)}
          onStart={() => void previewStart.start()}
          starting={previewStart.busy}
          waking={previewStart.waking}
          onAsk={t.mayPrompt ? askInComposer : undefined}
          code={{
            mayEdit: t.mayPrompt,
            teammateName: (teammateId) =>
              people.find((p) => p.id === teammateId)?.name ?? t.teammate.name,
          }}
          {...(t.mayPrompt ? { onPick: pickElement, picked: elements.length } : {})}
        />
      )}
      {expanded && !file && !documents.current && !previewing && changesOpen && changesTeammate && (
        <ChangesPanel
          threadId={t.id}
          teammateId={changesTeammate}
          teammateName={(teammateId) =>
            people.find((p) => p.id === teammateId)?.name ?? t.teammate.name
          }
          mayEdit={t.mayPrompt}
          onClose={() => setChangesOpen(false)}
        />
      )}
      {expanded && computerOpen && t.computer.kind === 'cloud' && (
        <ExpandedComputer
          thread={t}
          memberId={me.memberId ?? ''}
          onChange={() => void thread.reload()}
          onClose={() => setComputerOpen(false)}
        />
      )}
      {teaching && t.computer.kind === 'cloud' && (
        <TeachTask
          teammate={t.teammate}
          thread={t}
          memberId={me.memberId ?? ''}
          status={status ?? t.status}
          onChange={() => void thread.reload()}
          onSend={(sending, ids) => deliver(sending, ids)}
          onClose={() => setTeaching(false)}
        />
      )}
      {expanded &&
        !computerOpen &&
        !file &&
        !documents.current &&
        !previewing &&
        !changesOpen &&
        watching && (
          <ComputerPanel
            thread={t}
            memberId={me.memberId ?? ''}
            // Expanded where it is: the thread stays the page.
            onOpenComputer={() => setComputerOpen(true)}
            onClose={() => setWatching(false)}
            outputs={outputs}
            onOpenFile={openFile}
            changes={
              changesTeammate && !changedFiles.unsupported
                ? { data: changedFiles.data, error: changedFiles.error, onOpen: openChanges }
                : undefined
            }
            details={details}
            onChange={() => void thread.reload()}
          />
        )}

      <div
        className="relative flex min-h-0 flex-1 flex-col"
        // Files dropped anywhere on the conversation go with the next message.
        {...(t.mayPrompt && !t.controlledByMemberId ? drop.props : {})}
      >
        {drop.dragging && <DropOverlay />}
        {top}
        {previewButton}
        {expanded && eventsLoaded && (
          <ThreadTimeline
            scroller={scroller}
            prompts={prompts}
            long={firstSeq > 1 || gaps.length > 0}
            onJump={jump}
          />
        )}
        <div ref={scroller} className="scroll-fade scroll-fade-y min-h-0 flex-1 overflow-y-auto">
          <div className={cn(column, top ? 'pt-16' : expanded ? 'pt-6 md:pt-8' : 'pt-4', 'pb-12')}>
            {t.parent && (
              <ParentLink
                threadId={t.id}
                parent={t.parent}
                followers={t.followers}
                reportDueAt={t.mayPrompt ? t.reportDueAt : null}
              />
            )}
            <ThreadItemsCard threadId={t.id} />

            {notices.length > 0 && ticketCard(notices, 'mb-4')}

            {previewStart.dialog}

            {!eventsLoaded ? (
              <ThreadSkeleton since={openedAt} onRetry={retry} />
            ) : (
              // In with a quick fade, in the column the placeholder held.
              <div className="animate-in duration-200 fade-in motion-reduce:animate-none">
                <FileLinksProvider value={{ open: openFile, threadId: t.id }}>
                  {/* Once its page is in and shown at its end, not before: it would load one at once. */}
                  {firstSeq > 1 && (events.at(-1)?.seq ?? 0) >= firstSeq && (
                    <EarlierMessages
                      key={firstSeq}
                      root={scroller}
                      loading={loadingOlder}
                      onLoad={loadEarlier}
                      auto={settled}
                    />
                  )}
                  {/* Opened at once: the message it started with, until its runner has it here. */}
                  {opened && !delivered && (
                    <div className="mb-4 ml-auto flex max-w-[85%] flex-col items-end gap-1.5">
                      {opened.text && <MessageBubble text={opened.text} />}
                      {opened.files.length > 0 && (
                        <SentAttachments uploads={opened.files} className="justify-end" />
                      )}
                    </div>
                  )}
                  <ThreadItems
                    threadId={t.id}
                    items={items}
                    teammate={t.teammate}
                    teammates={people}
                    drafting={text.trim() !== ''}
                    canApprove={t.mayPrompt}
                    admin={isAdmin(me)}
                    working={busy}
                    starting={current === 'starting'}
                    background={background}
                    eventsWaitingSince={eventsWaitingSince}
                    computerDown={machineDown}
                    gapLine={(gap) => (
                      <MessagesBetween
                        key={`${gap.from}-${gap.to}`}
                        root={scroller}
                        auto={settled}
                        onLoad={(line) => loadGap(gap, line)}
                      />
                    )}
                    childThreads={t.children}
                    onOpenPreview={previewLive(preview) ? openPreview : undefined}
                    previewStart={{
                      live,
                      busy: previewStart.busy,
                      start: (words) => void previewStart.start(words),
                    }}
                    onApproval={(approvalId, approved, always, edited) =>
                      void call('/approvals', {
                        approvalId,
                        approved,
                        ...(always ? { always: true } : {}),
                        ...(edited ? { edited } : {}),
                      }).catch(() => undefined)
                    }
                    onAnswer={(questionId, answer) =>
                      api(`/threads/${id}/answers`, { body: { questionId, answer } }).then(
                        () => undefined,
                      )
                    }
                    onChoose={
                      t.mayPrompt && !deciding ? (text, pick) => deliver(text, [], pick) : undefined
                    }
                    onReply={t.mayPrompt && !t.controlledByMemberId ? replyToMessage : undefined}
                    onRetry={
                      t.mayPrompt && !t.controlledByMemberId ? () => call('/retry') : undefined
                    }
                    onTicket={(requestId, answer) =>
                      // Answering may hand control back: show the composer again.
                      api(`/threads/${id}/tickets`, { body: { requestId, answer } }).then(
                        () => void thread.reload(),
                      )
                    }
                    takeover={
                      t.computer.kind === 'cloud' &&
                      me.memberId &&
                      (!t.controlledByMemberId || t.controlledByMemberId === me.memberId)
                        ? {
                            mine: t.controlledByMemberId === me.memberId,
                            open: async () => {
                              if (t.controlledByMemberId !== me.memberId)
                                await api(`/threads/${id}/takeover`, { body: { interrupt: false } })
                              showComputer()
                            },
                          }
                        : undefined
                    }
                  />
                  {t.mayPrompt && !t.controlledByMemberId && (
                    <QueuedReports
                      queued={queued}
                      teammateName={answering.name}
                      canSteer={busy}
                      onAction={queueAction}
                    />
                  )}
                  {proposals.length > 0 && ticketCard(proposals, 'mt-4')}
                  <ChildrenWorking children={t.children} />
                  <ChildrenWaiting children={t.children} />
                </FileLinksProvider>
              </div>
            )}
          </div>
        </div>

        <div className={cn(column, 'relative shrink-0 pt-2 pb-4')}>
          {t.controlledByMemberId ? (
            <>
              {!atEnd && <JumpToEnd onClick={() => toEnd('smooth')} />}
              <Takeover
                thread={t}
                memberId={me.memberId ?? ''}
                onChange={() => void thread.reload()}
                onOpenComputer={computerPage ? undefined : () => showComputer()}
              />
            </>
          ) : t.mayPrompt ? (
            <>
              {!atEnd && <JumpToEnd onClick={() => toEnd('smooth')} />}
              <QueuedMessages
                queued={queued.filter((m) => !isQueuedReport(m))}
                outgoing={pendingOut}
                teammateName={answering.name}
                canSteer={busy}
                canParallel={!t.parent}
                onAction={queueAction}
                onResend={(m) => {
                  setOutgoing((list) => list.filter((o) => o.messageId !== m.messageId))
                  setText((current) => current || m.text)
                }}
                onDiscard={(messageId) =>
                  setOutgoing((list) => list.filter((o) => o.messageId !== messageId))
                }
              />
              {offerCloud && (
                <Card className="mb-2 gap-2 rounded-xl p-3 text-sm shadow-sm">
                  <p className="flex items-center gap-2 font-medium">
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full bg-muted-foreground/50"
                    />
                    {computerName(t.computer)} is offline
                  </p>
                  <p className="text-muted-foreground">
                    {answering.name} can pick up on the cloud computer from what is on GitHub. Files
                    only on {computerName(t.computer)} stay there.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void moveThread(cloudTarget!.id).catch(() => undefined)}
                    >
                      Continue on the cloud computer
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setWaitForMachine(true)}
                    >
                      Wait
                    </Button>
                  </div>
                </Card>
              )}
              {moveStatus && (
                <p className="mb-2 flex items-center gap-2 px-2 text-sm text-muted-foreground">
                  <span aria-hidden className="size-2 shrink-0 rounded-full bg-primary" />
                  {moveStatus}
                </p>
              )}
              <form onSubmit={(e) => void send(e).catch(() => undefined)}>
                {/* One line, like Claude's: attach, the message, then stop while the teammate
                    works and the send button once there is something to send. Files drop
                    anywhere on the conversation, not just here. */}
                <Card
                  data-composer-frame
                  className={cn(
                    'relative gap-2 rounded-xl p-2 shadow-md focus-within:border-ring',
                    drop.dragging && 'border-primary',
                  )}
                >
                  {replyTo && (
                    <div className="flex items-center gap-2 pl-2 text-sm text-muted-foreground">
                      <Reply className="size-4 shrink-0" aria-hidden />
                      <span className="min-w-0 flex-1 truncate" title={replyTo.text}>
                        {replyTo.teammateId && (
                          <span className="font-medium text-foreground">
                            {people.find((p) => p.id === replyTo.teammateId)?.name ??
                              t.teammate.name}
                            :{' '}
                          </span>
                        )}
                        “{mentionsToText(replyTo.text).replace(/\s+/g, ' ')}”
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="shrink-0 rounded-full"
                        onClick={() => setReplyTo(undefined)}
                        aria-label="Don’t reply to this message"
                        tooltip="Don’t reply to this message"
                      >
                        <X aria-hidden />
                      </Button>
                    </div>
                  )}
                  {moveTo && (
                    <div className="flex items-center gap-1 pl-1">
                      <span className="flex min-w-0 items-center gap-1.5 rounded-full border border-primary/40 py-0.5 pr-1 pl-2.5 text-sm text-primary">
                        <ComputerIcon cloud={moveTo.cloud} className="size-3.5 shrink-0" />
                        <span className="min-w-0 truncate">
                          Continue on {moveTo.name}
                          {moveTo.offline && (
                            <span className="text-muted-foreground"> · offline</span>
                          )}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="shrink-0 rounded-full"
                          onClick={() => setMoveTo(undefined)}
                          aria-label={`Don’t move to ${moveTo.name}`}
                          tooltip="Stay on this computer"
                        >
                          <X aria-hidden />
                        </Button>
                      </span>
                    </div>
                  )}
                  <AskedDocument text={text} />
                  <PendingEdits rows={editRows} focus={focusEdit} onDone={focusComposer} />
                  <UploadList
                    uploads={files.uploads.filter((u) => !pictureKeys.has(u.key))}
                    onRemove={files.remove}
                  />
                  <div className="flex items-end gap-1">
                    <div className="mb-1">
                      {/* The + on phones too: teaching needs a desktop, so not there. */}
                      <ComposerMenu
                        onFiles={files.add}
                        effort={effort}
                        effortLater={effortLater}
                        {...(phone
                          ? {}
                          : {
                              teach:
                                t.computer.kind === 'cloud'
                                  ? () => setTeaching(true)
                                  : 'Not yet on threads that run on a member’s machine',
                            })}
                        {...(moveTargets.length > 1
                          ? {
                              move: {
                                targets: moveTargets,
                                onPick: (target: MoveTarget) => {
                                  setMoveTo(target)
                                  focusComposer()
                                },
                              },
                            }
                          : {})}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <Composer
                        bare
                        threadId={id}
                        value={text}
                        onChange={setText}
                        onSubmit={() => void send().catch(() => undefined)}
                        rows={1}
                        typeToFocus
                        placeholder={
                          editRows.length
                            ? 'Add a note for all the edits'
                            : `Chat with ${answering.name}`
                        }
                        suggestion={suggestion}
                      />
                    </div>
                    <EffortButton effort={effort} later={effortLater} className="mb-1" />
                    {busy && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="mb-1 rounded-full [&_svg:not([class*='size-'])]:size-5"
                        disabled={stopping === (turnId ?? '')}
                        onClick={() => {
                          setStopping(turnId ?? '')
                          void call('/interrupt', turnId ? { turnId } : {}).catch(() =>
                            setStopping(undefined),
                          )
                        }}
                        aria-label={`Stop ${answering.name}`}
                        tooltip={
                          stopping === (turnId ?? '')
                            ? 'Stopping…'
                            : queued.length
                              ? `Stop ${answering.name} now; the queued messages run next`
                              : `Stop ${answering.name}`
                        }
                      >
                        <CircleStop aria-hidden />
                      </Button>
                    )}
                    {/* No Tab key on a touch screen: Use puts the suggestion in the box, the
                        keyboard staying down, and the send button takes its place. */}
                    {suggestion && touch && !text && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mb-1 rounded-full"
                        onClick={() => setText(suggestion)}
                        aria-label={`Use the suggested message: ${suggestion}`}
                      >
                        Use
                      </Button>
                    )}
                    {(text.trim() || files.uploads.length > 0 || editRows.length > 0 || moveTo) && (
                      <Button
                        size="icon-sm"
                        className="mb-1 rounded-full [&_svg:not([class*='size-'])]:size-5"
                        disabled={!ready || deciding}
                        aria-label={
                          moveTo
                            ? `Continue on ${moveTo.name}`
                            : editRows.length
                              ? `${busy ? 'Queue' : 'Send'} ${editsCount(editRows.length)}`
                              : busy
                                ? 'Queue for after this turn'
                                : 'Send'
                        }
                        tooltip={
                          deciding
                            ? 'Approve or deny the request above first'
                            : moveTo
                              ? busy
                                ? `Continue on ${moveTo.name} after this turn (↵)`
                                : `Continue on ${moveTo.name} (↵)`
                              : editRows.length
                                ? busy
                                  ? `Queue ${editsCount(editRows.length)} for after this turn (↵)`
                                  : `Send ${editsCount(editRows.length)} (↵)`
                                : busy
                                  ? 'Queue for after this turn (↵)'
                                  : 'Send (↵) · New line (⇧↵)'
                        }
                      >
                        <ArrowUp aria-hidden />
                      </Button>
                    )}
                  </div>
                  {error && <p className="px-2 pb-1 text-sm text-destructive-text">{error}</p>}
                </Card>
              </form>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {!atEnd && <JumpToEnd onClick={() => toEnd('smooth')} />}
              {t.startedBy.user.name} started this thread and writes in it. You can watch it live.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

/** crypto.randomUUID needs a secure context; a dashboard on a plain-http address has none. */
/**
 * Above the messages of a thread opened by its latest page: loads the page
 * before as it comes near the screen, or on a click.
 */
/** How near the end still counts as there: a reader this close keeps following. */
const END_SLACK = 48

/** Back down to the latest, while reading higher up. */
/** Over the whole conversation while files are dragged on it: dropping attaches them. */
// The thread's name in its details: one line, cut with an ellipsis; when cut, a tap anywhere on
// it shows it whole, and the chevron after it says so.
function ThreadName({ title }: { title: string }) {
  const [open, setOpen] = useState(false)
  const [cut, setCut] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || open) return
    const measure = () => setCut(el.scrollWidth > el.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [open, title])
  return (
    <button
      type="button"
      disabled={!cut && !open}
      aria-expanded={cut || open ? open : undefined}
      onClick={() => setOpen((o) => !o)}
      className="flex min-w-0 items-start gap-1.5 text-left text-base font-semibold text-foreground disabled:cursor-default"
    >
      <span ref={ref} className={cn('min-w-0 flex-1', open ? 'break-words' : 'truncate')}>
        {title}
      </span>
      {(cut || open) && (
        <ChevronDown
          aria-hidden
          className={cn(
            'mt-1 size-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      )}
    </button>
  )
}

function DropOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center bg-background/80 backdrop-blur-[2px]">
      <div className="absolute inset-3 rounded-xl border-2 border-dashed border-primary bg-primary/10" />
      <div className="relative text-center">
        <div className="mx-auto mb-3 grid size-14 place-items-center rounded-full bg-primary text-primary-foreground">
          <CloudUpload aria-hidden className="size-6" />
        </div>
        <p className="text-lg font-bold">Drop to attach</p>
        <p className="text-xs text-muted-foreground">
          Anywhere in the chat. Images, PDFs, code and docs.
        </p>
      </div>
    </div>
  )
}

/** Back down to the end of a list read from it, once scrolled up. */
export function JumpToEnd({ onClick }: { onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      onClick={onClick}
      aria-label="Scroll to the latest"
      tooltip="Scroll to the latest"
      className="absolute -top-8 left-1/2 z-10 size-8 -translate-x-1/2 rounded-full bg-background shadow-md"
    >
      <ArrowDown aria-hidden />
    </Button>
  )
}

/** Above a list read from its end: loads the page before it as it comes near. */
export function EarlierMessages({
  root,
  loading,
  onLoad,
  noun = 'messages',
  auto = true,
}: {
  /** What scrolls the thread: "near" is near its top. */
  root: RefObject<HTMLElement | null>
  loading: boolean
  onLoad: () => Promise<void>
  /** What it loads: messages, or threads in the threads panel. */
  noun?: string
  /** Loads as it comes near; else only on a click. */
  auto?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  const load = useRef(onLoad)
  load.current = onLoad
  // Keyed by the page: a new observer per page, which loads the next one if this is still near.
  useEffect(() => {
    const node = ref.current
    if (!node || failed || !auto) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void load.current().catch(() => setFailed(true))
      },
      { root: root.current, rootMargin: '800px 0px 0px 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [failed, root, auto])
  return (
    <div ref={ref} className="mb-4 flex justify-center text-sm text-muted-foreground">
      {loading ? (
        <span className="flex items-center gap-2">
          <LoaderCircle aria-hidden className="size-4 animate-spin" /> Loading earlier {noun}…
        </span>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setFailed(false)
            void onLoad().catch(() => setFailed(true))
          }}
        >
          {failed ? `Could not load earlier ${noun}. Try again` : `Show earlier ${noun}`}
        </Button>
      )}
    </div>
  )
}

/** Where the timeline left messages out: loads them as it comes in sight, from the side it is read. */
function MessagesBetween({
  root,
  auto,
  onLoad,
}: {
  root: RefObject<HTMLElement | null>
  /** Loads as it comes in sight; else only on a click. */
  auto: boolean
  onLoad: (line: HTMLElement) => Promise<void>
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const load = useRef(onLoad)
  load.current = onLoad
  const run = () => {
    const node = ref.current
    if (!node) return
    setLoading(true)
    setFailed(false)
    void load
      .current(node)
      .catch(() => setFailed(true))
      .finally(() => setLoading(false))
  }
  const runRef = useRef(run)
  runRef.current = run
  useEffect(() => {
    const node = ref.current
    if (!node || failed || !auto) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) runRef.current()
      },
      { root: root.current, rootMargin: '400px 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [failed, root, auto])
  return (
    <div ref={ref} className="flex items-center gap-3 text-sm text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      {loading ? (
        <span className="flex items-center gap-2">
          <LoaderCircle aria-hidden className="size-4 animate-spin" /> Loading messages…
        </span>
      ) : (
        <Button variant="ghost" size="sm" onClick={run}>
          {failed ? 'Could not load these messages. Try again' : 'Show messages in between'}
        </Button>
      )}
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}

/** Room above a message the timeline went to: the bar over the conversation's top. */
const JUMP_MARGIN = 72

/**
 * An open ticket whose call waits on a decision: an approval before a built-in tool call, an
 * App write or its cap, a credential or a trigger. The API refuses a message until then.
 */
const holdsCall = ({ type, payload }: Pick<Ticket, 'type' | 'payload'>) =>
  type === 'cap'
    ? !!payload.connectionId
    : type === 'approval' &&
      (payload.source === 'harness' ||
        !!payload.connectionId ||
        !!payload.credentialAction ||
        !!payload.triggerAction)

const newMessageId = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('')
