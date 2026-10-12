'use client'
import {
  AppWindow,
  ArrowRight,
  ListOrdered,
  LoaderCircle,
  Lock,
  Monitor,
  SquareTerminal,
} from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AttachButton, UploadList, useFileDrop, useUploads } from '@/components/attachments'
import { Composer } from '@/components/composer'
import { StatusBadge, TeammateAvatar, useDashboard } from '@/components/dashboard'
import { ComputerPanel } from '@/components/computer-panel'
import { useDesktopPreview } from '@/components/desktop-preview'
import { useDocumentPanel } from '@/components/document-panel'
import { FileLinksProvider } from '@/components/file-links'
import { FilePanel } from '@/components/file-panel'
import {
  PHASE,
  PreviewPanel,
  previewLive,
  previewPhase,
  useThreadPreview,
} from '@/components/preview-panel'
import { usePreviewStart } from '@/components/preview-start'
import { QueuedMessages, type Outgoing } from '@/components/queued-messages'
import { Takeover } from '@/components/takeover'
import { MakeTaskButton, ThreadTaskBar } from '@/components/tasks'
import { TicketRow } from '@/components/ticket-row'
import { useThreadOutputs } from '@/components/thread-outputs'
import { ThreadItems, useThreadItems } from '@/components/thread-view'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { api, harnessLabel, useApi, type Teammate, type Thread } from '@/lib/api'
import { useThreadEvents } from '@/lib/use-thread-events'
import { cn } from '@/lib/utils'

export default function ThreadPage() {
  const { id } = useParams<{ id: string }>()
  const { me } = useDashboard()
  const thread = useApi<Thread>(`/threads/${id}`)
  const [status, setStatus] = useState<string>()
  const { events, connected, firstSeq, loadOlder, loadingOlder } = useThreadEvents(id, setStatus)
  const { items, limits, queued, seen, turnId } = useThreadItems(events, firstSeq)
  const outputs = useThreadOutputs(events)
  const preview = useThreadPreview(events)
  const [error, setError] = useState<string>()
  const [text, setText] = useState('')
  const files = useUploads()
  const drop = useFileDrop(files.add)
  const bottom = useRef<HTMLDivElement>(null)
  const [watching, setWatching] = useDesktopPreview()
  const [expanded, setExpanded] = useState(false)
  // A shell on the workspace computer, in the computer panel. Needs control.
  const [shell, setShell] = useState(false)
  // A file a message names, open beside the thread in the desktop's place.
  const [file, setFile] = useState<{ path: string; teammateId?: string }>()
  // The app the teammate runs, beside the thread in the desktop's place.
  const [previewing, setPreviewing] = useState(false)
  // One panel beside the thread: a document opened anywhere replaces the file, preview or computer.
  const documents = useDocumentPanel()
  const openFile = (f: { path: string; teammateId?: string }) => {
    documents.close()
    setPreviewing(false)
    setFile(f)
  }
  const openPreview = () => {
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
      document
        .querySelector<HTMLElement>(
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

  // Something new at the end: show it. An older page above does not move the view.
  const lastKey = items.at(-1)?.key
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end', inline: 'nearest' })
  }, [lastKey])
  // An older page goes in above what is on screen: keep that where it was.
  const anchor = useRef<number>(undefined)
  const loadEarlier = () =>
    loadOlder(() => {
      anchor.current = bottom.current?.getBoundingClientRect().top
    })
  useLayoutEffect(() => {
    const before = anchor.current
    anchor.current = undefined
    const after = bottom.current?.getBoundingClientRect().top
    if (before !== undefined && after !== undefined) window.scrollBy(0, after - before)
  }, [firstSeq])
  useEffect(() => {
    if (thread.data) setStatus(thread.data.status)
  }, [thread.data])
  // Status changes can open or close tickets (a cap, an empty account): refetch them.
  const reload = thread.reload
  useEffect(() => {
    if (status) void reload()
  }, [status, reload])

  if (!thread.data)
    return (
      <p
        className={cn('text-sm', thread.error ? 'text-destructive-text' : 'text-muted-foreground')}
      >
        {thread.error?.message ?? 'Loading…'}
      </p>
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
  const showComputer = () => {
    setFile(undefined)
    setPreviewing(false)
    documents.close()
    setWatching(true)
  }
  async function openShell() {
    setError(undefined)
    try {
      if (!mine) await api(`/threads/${id}/takeover`, { body: { interrupt: false } })
      showComputer()
      setShell(true)
      await thread.reload()
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
  async function deliver(sending: string, attachmentIds: string[] = []) {
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
    try {
      const sent = await api<{ delivery?: string }>(`/threads/${id}/messages`, {
        body: { text: message.text, attachmentIds, messageId: message.messageId },
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

  return (
    <div className="flex flex-col">
      <header className="mb-6 flex flex-col gap-4 border-b pb-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-[1_1_26rem] flex-col gap-1.5">
            <nav
              aria-label="Breadcrumb"
              className="flex items-center gap-1.5 text-sm text-muted-foreground"
            >
              <Link href="/app" className="hover:text-foreground">
                Threads
              </Link>
              <span aria-hidden>/</span>
              <Link
                href={`/app/teammates/${t.teammate.id}`}
                className="truncate hover:text-foreground"
              >
                {t.teammate.name}
              </Link>
            </nav>
            <h1 className="truncate text-2xl font-extrabold tracking-tight">{t.title}</h1>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              {people.map((p, i) => (
                <span key={p.id} className="flex items-center gap-1.5">
                  <TeammateAvatar
                    teammate={{ name: p.name, harness: p.harness as Teammate['harness'] }}
                    className="size-5"
                  />
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
              ))}
              <span aria-hidden>·</span>
              <span>
                {people.length === 1 && `${harnessLabel(people[0]!.harness)} `}on{' '}
                {t.computer.kind === 'cloud' ? 'the workspace computer' : t.computer.name}
              </span>
              <span aria-hidden>·</span>
              <span>
                {t.origin === 'trigger' ? (
                  `started by trigger "${t.trigger?.label ?? 'deleted'}" on ${t.startedBy.user.name}'s accounts`
                ) : t.origin === 'schedule' ? (
                  <>
                    started by schedule{' '}
                    {t.schedule ? (
                      <Link href="/app/automations" className="hover:underline">
                        &ldquo;{t.schedule.title}&rdquo;
                      </Link>
                    ) : (
                      '(deleted)'
                    )}{' '}
                    on {t.startedBy.user.name}&rsquo;s accounts
                  </>
                ) : (
                  `started by ${t.startedBy.user.name}`
                )}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'size-2 rounded-full',
                connected ? 'bg-success' : 'bg-muted-foreground',
              )}
              title={connected ? 'Live' : 'Reconnecting'}
              role="img"
              aria-label={connected ? 'Live' : 'Reconnecting'}
            />
            <StatusBadge status={current} />
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
                previewing
                  ? 'Hide preview'
                  : live
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
            {t.computer.kind === 'cloud' && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-pressed={watching && !file && !previewing}
                  onClick={() => {
                    const hidden = Boolean(file) || previewing
                    setFile(undefined)
                    setPreviewing(false)
                    setWatching(!watching || hidden)
                  }}
                  aria-label={watching && !file && !previewing ? 'Hide computer' : 'Show computer'}
                  title={
                    watching && !file && !previewing
                      ? 'Hide computer'
                      : "Watch the workspace computer's screen"
                  }
                >
                  <Monitor aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-pressed={watching && !file && shell && mine}
                  disabled={!me.memberId || (!!t.controlledByMemberId && !mine)}
                  onClick={() =>
                    watching && !file && shell && mine ? setShell(false) : void openShell()
                  }
                  aria-label="Shell"
                  title={
                    t.controlledByMemberId && !mine
                      ? 'Another member has control of this thread'
                      : mine
                        ? `A shell on the workspace computer, as ${t.teammate.name}`
                        : `Take control and open a shell, as ${t.teammate.name}. ${t.teammate.name} waits until you hand back`
                  }
                >
                  <SquareTerminal aria-hidden />
                </Button>
              </>
            )}
            {t.startedByMemberId === me.memberId ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={t.private}
                onClick={() =>
                  void api(`/threads/${id}`, { method: 'PATCH', body: { private: !t.private } })
                    .then(thread.reload)
                    .catch((e: Error) => setError(e.message))
                }
                title="A private thread adds nothing to workspace memory, and only you see its summary"
              >
                <Lock aria-hidden />
                {t.private ? 'Private' : 'Make private'}
              </Button>
            ) : (
              t.private && <StatusBadge status="private" tone="neutral" label="Private" />
            )}
            {!t.task && t.origin === 'member' && t.mayPrompt && (
              <MakeTaskButton thread={t} onCreated={() => void thread.reload()} />
            )}
            <Button asChild variant="outline" size="sm">
              <Link href={`/app/threads/${id}/log`}>
                <ListOrdered aria-hidden />
                Run log
              </Link>
            </Button>
          </div>
        </div>
        {limits?.length ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            {limits.map((l) => {
              const used = Math.round(l.utilization * 100)
              return (
                <div
                  key={l.window}
                  className="flex items-center gap-2.5 text-xs text-muted-foreground"
                >
                  <span className="capitalize">{l.window.replace('_', ' ')}</span>
                  <Progress
                    value={Math.min(used, 100)}
                    aria-label={`${l.window.replace('_', ' ')} usage`}
                    className="h-1.5 w-28 bg-secondary"
                  />
                  <span className="font-mono text-foreground">{used}% used</span>
                </div>
              )
            })}
          </div>
        ) : null}
      </header>

      {t.task && (
        <ThreadTaskBar taskId={t.task.id} status={current} onChanged={() => void thread.reload()} />
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

      {file && (
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

      {!file && !documents.current && previewing && preview && (
        <PreviewPanel
          threadId={t.id}
          preview={preview}
          teammateName={people.find((p) => p.id === preview.teammateId)?.name ?? answering.name}
          computerName={t.computer.name}
          mayControl={t.mayPrompt}
          onClose={() => setPreviewing(false)}
          onStart={() => void previewStart.start()}
          starting={previewStart.busy}
          onAsk={t.mayPrompt ? askInComposer : undefined}
        />
      )}
      {previewStart.dialog}

      {!file && !documents.current && !previewing && watching && t.computer.kind === 'cloud' && (
        <ComputerPanel
          thread={t}
          memberId={me.memberId ?? ''}
          status={current}
          shell={shell}
          onShell={setShell}
          expanded={expanded}
          onExpand={setExpanded}
          onChange={() => void thread.reload()}
          onClose={() => {
            setWatching(false)
            setExpanded(false)
          }}
          outputs={outputs}
          onOpenFile={openFile}
        />
      )}

      <FileLinksProvider value={{ open: openFile }}>
        {/* Once its page is in and shown at its end, not before: it would load one at once. */}
        {firstSeq > 1 && (events.at(-1)?.seq ?? 0) >= firstSeq && (
          <EarlierMessages key={firstSeq} loading={loadingOlder} onLoad={loadEarlier} />
        )}
        <ThreadItems
          threadId={t.id}
          items={items}
          teammate={t.teammate}
          teammates={people}
          canApprove={t.mayPrompt}
          onOpenPreview={previewLive(preview) ? openPreview : undefined}
          onApproval={(approvalId, approved, always) =>
            void call('/approvals', {
              approvalId,
              approved,
              ...(always ? { always: true } : {}),
            }).catch(() => undefined)
          }
          onAnswer={(questionId, answer) =>
            api(`/threads/${id}/answers`, { body: { questionId, answer } }).then(() => undefined)
          }
          onChoose={t.mayPrompt && current !== 'waiting' ? (text) => deliver(text) : undefined}
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
                    setFile(undefined)
                    documents.close()
                    setWatching(true)
                    await thread.reload()
                  },
                }
              : undefined
          }
        />
      </FileLinksProvider>

      {t.controlledByMemberId ? (
        <div className="sticky bottom-0 z-10 mt-6 -mb-16 bg-linear-to-t from-background from-75% to-transparent pt-6 pb-4 md:pb-6">
          <Takeover
            thread={t}
            memberId={me.memberId ?? ''}
            onChange={() => {
              setShell(false)
              void thread.reload()
            }}
            onOpenComputer={watching && !file ? undefined : showComputer}
          />
        </div>
      ) : t.mayPrompt ? (
        // Sticks to the bottom of the content column while the thread scrolls under it; the
        // negative margin takes up the column's bottom padding so it never jumps at the end.
        <div className="sticky bottom-0 z-10 mt-6 -mb-16 bg-linear-to-t from-background from-75% to-transparent pt-6 pb-4 md:pb-6">
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
                      : 'Reply. @ a teammate to bring them in, or a connection, secret or thread'
                }
              />
              <div className="flex flex-wrap items-center gap-2">
                <AttachButton onFiles={files.add} />
                {error ? (
                  <span className="min-w-0 flex-1 pl-2 text-sm text-destructive-text">{error}</span>
                ) : (
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 pl-2 text-xs text-muted-foreground">
                    <kbd className="rounded-md bg-secondary px-1.5 font-mono text-foreground">
                      @
                    </kbd>
                    a teammate to bring them in, or a connection or thread
                  </span>
                )}
                {busy && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void call('/interrupt', turnId ? { turnId } : {}).catch(() => undefined)
                    }
                    title={
                      queued.length
                        ? `Stop ${answering.name} now; the queued messages run next`
                        : `Stop ${answering.name} now`
                    }
                  >
                    Interrupt
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={!ready || current === 'waiting'}
                  title={busy ? `Queued until ${answering.name}'s turn ends (⌘Enter)` : '⌘Enter'}
                >
                  Send
                  <ArrowRight aria-hidden />
                </Button>
              </div>
            </Card>
          </form>
        </div>
      ) : (
        <p className="mt-6 text-sm text-muted-foreground">
          This thread runs on {t.startedBy.user.name}&apos;s subscription. You can watch it live.
        </p>
      )}
      {/* After the composer; its scroll margin covers the column's bottom padding. */}
      <div ref={bottom} className="scroll-mb-16" />
    </div>
  )
}

/** crypto.randomUUID needs a secure context; a dashboard on a plain-http address has none. */
/**
 * Above the messages of a thread opened by its latest page: loads the page
 * before as it comes near the screen, or on a click.
 */
function EarlierMessages({ loading, onLoad }: { loading: boolean; onLoad: () => Promise<void> }) {
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
      { rootMargin: '800px 0px 0px 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [failed])
  return (
    <div ref={ref} className="mb-4 flex justify-center text-sm text-muted-foreground">
      {loading ? (
        <span className="flex items-center gap-2">
          <LoaderCircle aria-hidden className="size-4 animate-spin" /> Loading earlier messages…
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
          {failed ? 'Could not load earlier messages. Try again' : 'Show earlier messages'}
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
