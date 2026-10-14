'use client'
// A thread: its messages, what it asks for, and the box to answer it. Shown by
// the threads panel, docked beside a page or expanded in its place (the thread's
// own address). Docked it keeps to the conversation; the panels a thread opens
// beside it (a file, the preview, the computer) need the room, so asking for one
// expands it first.
import {
  AppWindow,
  ArrowDown,
  ArrowRight,
  CalendarClock,
  FolderKanban,
  ListOrdered,
  LoaderCircle,
  SquareKanban,
  SquareTerminal,
  UserRound,
  UsersRound,
  Zap,
} from 'lucide-react'
import Link from 'next/link'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { AttachButton, UploadList, useFileDrop, useUploads } from '@/components/attachments'
import { Composer } from '@/components/composer'
import { TeammateAvatar, useDashboard } from '@/components/dashboard'
import { ComputerPanel } from '@/components/computer-panel'
import { useDocumentPanel } from '@/components/document-panel'
import { FileLinksProvider } from '@/components/file-links'
import { FilePanel } from '@/components/file-panel'
import {
  PHASE,
  PreviewPanel,
  previewLive,
  previewPhase,
  useCheckedPreview,
  useThreadPreview,
  useThreadRepositories,
} from '@/components/preview-panel'
import { usePreviewStart } from '@/components/preview-start'
import { ThreadProjectMenu } from '@/components/projects'
import { QueuedMessages, type Outgoing } from '@/components/queued-messages'
import { Takeover } from '@/components/takeover'
import { ThreadTaskBar } from '@/components/tasks'
import { TicketRow } from '@/components/ticket-row'
import { useThreadOutputs } from '@/components/thread-outputs'
import { useThreadPanel } from '@/components/thread-panel'
import { ThreadSkeleton } from '@/components/thread-skeleton'
import { ThreadItems, useThreadItems } from '@/components/thread-view'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { api, teammateModelLabel, useApi, type Teammate, type Thread } from '@/lib/api'
import { useThreadEvents } from '@/lib/use-thread-events'
import { cn } from '@/lib/utils'

/** What the threads panel's bar shows of a thread: who leads it, its title and state. */
export type ThreadHeading = {
  teammate: Pick<Teammate, 'id' | 'name' | 'harness'>
  /** Everyone in it: the channel beside it is one of theirs. */
  teammateIds: string[]
  title: string
  status: string
  private: boolean
  /** The live connection to its events holds. */
  connected: boolean
  /** Who has the computer: this member, another one, or the teammate. */
  control: 'mine' | 'other' | null
}

/** Replies being written, per thread: closing the panel or opening another thread keeps them. */
const replyDrafts = new Map<string, string>()

function useReplyDraft(id: string) {
  const [text, setText] = useState(() => replyDrafts.get(id) ?? '')
  useEffect(() => {
    if (text) replyDrafts.set(id, text)
    else replyDrafts.delete(id)
  }, [id, text])
  return [text, setText] as const
}

export function ThreadConversation({
  id,
  expanded,
  onExpand,
  onHeading,
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
}) {
  const { me, projects } = useDashboard()
  const thread = useApi<Thread>(`/threads/${id}`)
  // Keyed by the thread: when it started loading, for its placeholder's delays.
  const [openedAt] = useState(() => Date.now())
  const [status, setStatus] = useState<string>()
  const {
    events,
    connected,
    firstSeq,
    loadOlder,
    loadingOlder,
    loaded: eventsLoaded,
    reconnect,
  } = useThreadEvents(id, setStatus)
  const { items, queued, seen, turnId } = useThreadItems(events, firstSeq)
  const outputs = useThreadOutputs(events)
  const preview = useCheckedPreview(id, useThreadPreview(events))
  // Preview is offered once there is something to preview: a preview it had, or code it checked out.
  const repositories = useThreadRepositories(events)
  const offersPreview = !!preview || repositories.length > 0
  const [error, setError] = useState<string>()
  // The turn asked to stop, until it ends: a tool can take a moment to give up.
  const [stopping, setStopping] = useState<string>()
  const [text, setText] = useReplyDraft(id)
  const files = useUploads()
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
  } = useThreadPanel()
  // A file a message names, open beside the thread in the desktop's place.
  const [file, setFile] = useState<{ path: string; teammateId?: string }>()
  // The app the teammate runs, beside the thread in the desktop's place.
  const [previewing, setPreviewing] = useState(false)
  // One panel beside the thread: a document opened anywhere replaces the file, preview or computer.
  const documents = useDocumentPanel()
  const openFile = (f: { path: string; teammateId?: string }) => {
    if (!expanded) onExpand()
    documents.close()
    setPreviewing(false)
    setFile(f)
  }
  const openPreview = () => {
    if (!expanded) onExpand()
    documents.close()
    setFile(undefined)
    setPreviewing(true)
  }
  useEffect(() => {
    if (documents.current) {
      setFile(undefined)
      setPreviewing(false)
    }
  }, [documents.current])
  // The bar's computer button brings the teammate's panel back in front of a file or preview.
  useEffect(() => {
    if (!revealKey) return
    setFile(undefined)
    setPreviewing(false)
  }, [revealKey])
  // And it shows pressed only while the panel is the one in front.
  useEffect(() => {
    setCovered(!!file || previewing)
    return () => setCovered(false)
  }, [file, previewing, setCovered])
  // A preview a person started, or asked the teammate for: its panel opens once it starts.
  const [awaitingPreview, setAwaitingPreview] = useState(false)
  const live = previewLive(preview)
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
  /** A message for the teammate, in the composer for the person to send. */
  const askInComposer = (message: string) => {
    setText(message)
    requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLElement>(
          '[data-composer-frame] [contenteditable="true"], [data-composer-frame] textarea',
        )
        ?.focus(),
    )
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
  }, [firstSeq])
  useEffect(() => {
    if (thread.data) setStatus(thread.data.status)
  }, [thread.data])
  useEffect(() => {
    const t = thread.data
    if (!t) return
    onHeading({
      teammate: { ...t.teammate, harness: t.teammate.harness as Teammate['harness'] },
      teammateIds: t.teammates.length ? t.teammates.map((p) => p.teammate.id) : [t.teammate.id],
      title: t.title,
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
  // Status changes can open or close tickets (a cap, an empty account): refetch them.
  const reload = thread.reload
  useEffect(() => {
    if (status) void reload()
  }, [status, reload])

  // The conversation's column: the page's width expanded, the panel's docked.
  const column = cn('mx-auto w-full', expanded ? 'max-w-5xl px-4 md:px-10' : 'px-4')
  // Loading, the conversation's shape shows in the column its messages will fill; slow, it can try again.
  const retry = () => {
    reconnect()
    void thread.reload()
  }
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

  const mine = !!me.memberId && t.controlledByMemberId === me.memberId
  // The computer's own page, the thread docked beside it.
  const showComputer = (shell = false) => openComputer(t.teammate.id, { threadId: id, shell })
  async function openShell() {
    setError(undefined)
    try {
      if (!mine) await api(`/threads/${id}/takeover`, { body: { interrupt: false } })
      showComputer(true)
    } catch (e) {
      setError((e as Error).message)
    }
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

  const ready = (text.trim() || files.ids.length > 0) && !files.busy && !files.failed

  /** Send the composer's message; it shows above the composer until the thread shows it. Queued while a turn runs. */
  async function send(e?: React.FormEvent) {
    e?.preventDefault()
    if (!ready || current === 'waiting') return
    const sending = text.trim()
    setText('')
    try {
      await deliver(sending, files.ids)
      files.clear()
    } catch (err) {
      // Not sent: back in the composer, as it was.
      setText((current) => current || sending)
      setError((err as Error).message)
    }
  }

  /** Send a message to the thread: the composer's, or a choice someone clicked. Throws when it is not sent. */
  async function deliver(sending: string, attachmentIds: string[] = [], pick?: string) {
    const message: Outgoing = {
      messageId: newMessageId(),
      text: sending,
      files: attachmentIds.length,
      afterSeq: events.at(-1)?.seq ?? 0,
      state: 'sending',
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
        body: { text: message.text, attachmentIds, messageId: message.messageId, pick },
      })
      setError(undefined)
      const starting = sent.delivery === 'starting'
      update(starting ? 'starting' : 'sent')
      // The computer says it got a message within seconds, or a few minutes when it starts first.
      setTimeout(
        () => {
          if (pendingRef.current.some((o) => o.messageId === message.messageId)) update('failed')
        },
        starting ? 10 * 60_000 : 20_000,
      )
    } catch (err) {
      setOutgoing((list) => list.filter((o) => o.messageId !== message.messageId))
      throw err
    }
  }

  const queueAction = (
    messageId: string,
    action: { action: 'cancel' } | { action: 'steer' } | { action: 'edit'; text: string },
  ) => call(`/messages/${messageId}`, action).catch(() => undefined)

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
  // computer (with Preview, the shell and the run log), its details, then what it made.
  // One row per fact, an icon for its kind: who is in it, its project, its task, who started it.
  const fact = 'flex min-w-0 items-center gap-2.5'
  const factIcon = 'size-4 shrink-0 text-muted-foreground'
  const details = (
    <div className="flex flex-col gap-2 text-sm">
      <div className={fact}>
        <UsersRound aria-label="Teammates" className={factIcon} />
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">{peopleLinks}</div>
      </div>
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
                <Link href="/app/automations" className="hover:underline">
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
  const computerActions = (
    <div className="flex flex-wrap gap-2">
      {offersPreview && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-pressed={previewing}
          disabled={previewStart.busy}
          onClick={() => {
            if (previewing) return setPreviewing(false)
            if (live) return openPreview()
            // Stopped: the panel says what happens while it starts again.
            if (preview) openPreview()
            void previewStart.start()
          }}
          title={
            live
              ? `Try the app ${previewTeammate?.name ?? answering.name} runs`
              : 'Run the app to try it here'
          }
        >
          {previewStart.busy ? (
            <LoaderCircle aria-hidden className="animate-spin" />
          ) : (
            <AppWindow aria-hidden />
          )}
          Preview
          {preview && live && (
            <span
              className={cn('size-1.5 rounded-full', PHASE[previewPhase(preview)].dot)}
              aria-label={PHASE[previewPhase(preview)].label}
              role="img"
            />
          )}
        </Button>
      )}
      {t.computer.kind === 'cloud' && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!me.memberId || (!!t.controlledByMemberId && !mine)}
          onClick={() => void openShell()}
          title={
            t.controlledByMemberId && !mine
              ? 'Another member has control of this thread'
              : mine
                ? `A shell on the workspace computer, as ${t.teammate.name}`
                : `Take control and open a shell, as ${t.teammate.name}. ${t.teammate.name} waits until you hand back`
          }
        >
          <SquareTerminal aria-hidden />
          Shell
        </Button>
      )}
      <Button asChild variant="outline" size="sm">
        <Link href={`/app/threads/${id}/log`}>
          <ListOrdered aria-hidden />
          Run log
        </Link>
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
          onOpen={openFile}
          onClose={() => setFile(undefined)}
        />
      )}

      {expanded && !file && !documents.current && previewing && preview && (
        <PreviewPanel
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
        />
      )}
      {expanded && !file && !documents.current && !previewing && watching && (
        <ComputerPanel
          thread={t}
          memberId={me.memberId ?? ''}
          onOpenComputer={() => showComputer()}
          onClose={() => setWatching(false)}
          outputs={outputs}
          onOpenFile={openFile}
          details={details}
          actions={computerActions}
        />
      )}

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scroller} className="scroll-fade min-h-0 flex-1 overflow-y-auto">
          <div className={cn(column, expanded ? 'pt-6 md:pt-8' : 'pt-4', 'pb-12')}>
            {t.task && (
              <ThreadTaskBar
                taskId={t.task.id}
                status={current}
                onChanged={() => void thread.reload()}
              />
            )}

            {notices.length > 0 && (
              <Card className="mb-4 gap-0 overflow-hidden py-0">
                <ul className="divide-y">
                  {notices.map((ticket) => (
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
                          teammate: t.teammate,
                        },
                      }}
                      onResolve={async (ticketId, approved) => {
                        setError(undefined)
                        try {
                          await api(`/tickets/${ticketId}/resolve`, { body: { approved } })
                        } catch (e) {
                          setError((e as Error).message)
                        }
                        await thread.reload()
                      }}
                    />
                  ))}
                </ul>
              </Card>
            )}

            {previewStart.dialog}

            {!eventsLoaded ? (
              <ThreadSkeleton since={openedAt} onRetry={retry} />
            ) : (
              // In with a quick fade, in the column the placeholder held.
              <div className="animate-in duration-200 fade-in motion-reduce:animate-none">
                <FileLinksProvider value={{ open: openFile }}>
                  {/* Once its page is in and shown at its end, not before: it would load one at once. */}
                  {firstSeq > 1 && (events.at(-1)?.seq ?? 0) >= firstSeq && (
                    <EarlierMessages
                      key={firstSeq}
                      root={scroller}
                      loading={loadingOlder}
                      onLoad={loadEarlier}
                    />
                  )}
                  <ThreadItems
                    threadId={t.id}
                    items={items}
                    teammate={t.teammate}
                    teammates={people}
                    canApprove={t.mayPrompt}
                    working={busy}
                    starting={current === 'starting'}
                    onOpenPreview={previewLive(preview) ? openPreview : undefined}
                    onApproval={(approvalId, approved, always) =>
                      void call('/approvals', {
                        approvalId,
                        approved,
                        ...(always ? { always: true } : {}),
                      }).catch(() => undefined)
                    }
                    onAnswer={(questionId, answer) =>
                      api(`/threads/${id}/answers`, { body: { questionId, answer } }).then(
                        () => undefined,
                      )
                    }
                    onChoose={
                      t.mayPrompt && current !== 'waiting'
                        ? (text, pick) => deliver(text, [], pick)
                        : undefined
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
                queued={queued}
                outgoing={pendingOut}
                teammateName={answering.name}
                canSteer={busy}
                onAction={queueAction}
                onResend={(m) => {
                  setOutgoing((list) => list.filter((o) => o.messageId !== m.messageId))
                  setText((current) => current || m.text)
                }}
                onDiscard={(messageId) =>
                  setOutgoing((list) => list.filter((o) => o.messageId !== messageId))
                }
              />
              <form onSubmit={(e) => void send(e).catch(() => undefined)}>
                <Card
                  data-composer-frame
                  className={cn(
                    'relative gap-2 rounded-xl p-3 shadow-md focus-within:border-ring',
                    drop.dragging && 'border-primary ring-[3px] ring-primary/30',
                  )}
                  {...drop.props}
                >
                  <UploadList uploads={files.uploads} onRemove={files.remove} />
                  <Composer
                    bare
                    threadId={id}
                    value={text}
                    onChange={setText}
                    onSubmit={() => void send().catch(() => undefined)}
                    rows={2}
                    placeholder={
                      busy
                        ? `${answering.name} is working. Messages you send now are queued for after this turn`
                        : people.length > 1
                          ? `Reply to ${answering.name}, or @ a teammate to ask them`
                          : 'Reply. @ a teammate to bring them in, or a connection, secret or thread; / for a visual or a design'
                    }
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <AttachButton onFiles={files.add} />
                    {error ? (
                      <span className="min-w-0 flex-1 pl-2 text-sm text-destructive-text">
                        {error}
                      </span>
                    ) : expanded ? (
                      <span className="flex min-w-0 flex-1 items-center gap-1.5 pl-2 text-xs text-muted-foreground">
                        <kbd className="rounded-md bg-secondary px-1.5 font-mono text-foreground">
                          @
                        </kbd>
                        a teammate to bring them in, or a connection or thread
                        <kbd className="ml-1.5 rounded-md bg-secondary px-1.5 font-mono text-foreground">
                          /
                        </kbd>
                        a visual or a design
                      </span>
                    ) : (
                      // Docked there is no room for the hint; the placeholder says it.
                      <span className="flex-1" />
                    )}
                    {busy && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={stopping === (turnId ?? '')}
                        onClick={() => {
                          setStopping(turnId ?? '')
                          void call('/interrupt', turnId ? { turnId } : {}).catch(() =>
                            setStopping(undefined),
                          )
                        }}
                        title={
                          queued.length
                            ? `Stop ${answering.name} now; the queued messages run next`
                            : `Stop ${answering.name} now`
                        }
                      >
                        {stopping === (turnId ?? '') ? 'Stopping…' : 'Interrupt'}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      disabled={!ready || current === 'waiting'}
                      title={
                        busy ? `Queued until ${answering.name}'s turn ends (⌘Enter)` : '⌘Enter'
                      }
                    >
                      Send
                      <ArrowRight aria-hidden />
                    </Button>
                  </div>
                </Card>
              </form>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {!atEnd && <JumpToEnd onClick={() => toEnd('smooth')} />}
              This thread runs on {t.startedBy.user.name}&apos;s subscription. You can watch it
              live.
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
/** Back down to the end of a list read from it, once scrolled up. */
export function JumpToEnd({ onClick }: { onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      onClick={onClick}
      aria-label="Scroll to the latest"
      title="Scroll to the latest"
      className="absolute -top-6 left-1/2 z-10 size-8 -translate-x-1/2 rounded-full bg-background shadow-md"
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
}: {
  /** What scrolls the thread: "near" is near its top. */
  root: RefObject<HTMLElement | null>
  loading: boolean
  onLoad: () => Promise<void>
  /** What it loads: messages, or threads in the threads panel. */
  noun?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  const load = useRef(onLoad)
  load.current = onLoad
  // Keyed by the page: a new observer per page, which loads the next one if this is still near.
  useEffect(() => {
    const node = ref.current
    if (!node || failed) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void load.current().catch(() => setFailed(true))
      },
      { root: root.current, rootMargin: '800px 0px 0px 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [failed, root])
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

const newMessageId = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('')
