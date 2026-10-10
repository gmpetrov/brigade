'use client'
import { ArrowRight, ListOrdered, Lock, Monitor } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { AttachButton, UploadList, useFileDrop, useUploads } from '@/components/attachments'
import { Composer } from '@/components/composer'
import { StatusBadge, TeammateAvatar, useDashboard } from '@/components/dashboard'
import { DesktopPreview, useDesktopPreview } from '@/components/desktop-preview'
import { FileLinksProvider } from '@/components/file-links'
import { FilePanel } from '@/components/file-panel'
import { Takeover } from '@/components/takeover'
import { MakeTaskButton, ThreadTaskBar } from '@/components/tasks'
import { TicketRow } from '@/components/ticket-row'
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
  const { events, connected } = useThreadEvents(id, setStatus)
  const { items, limits } = useThreadItems(events)
  const [error, setError] = useState<string>()
  const [text, setText] = useState('')
  const files = useUploads()
  const drop = useFileDrop(files.add)
  const bottom = useRef<HTMLDivElement>(null)
  const [watching, setWatching] = useDesktopPreview()
  const [expanded, setExpanded] = useState(false)
  // A file a message names, open beside the thread in the desktop's place.
  const [file, setFile] = useState<{ path: string; teammateId?: string }>()

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end', inline: 'nearest' })
  }, [items.length])
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

  async function send(e?: React.FormEvent) {
    e?.preventDefault()
    if (!ready || current === 'waiting') return
    await call('/messages', { text, attachmentIds: files.ids })
    setText('')
    files.clear()
  }

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
                {t.origin === 'trigger'
                  ? `started by trigger "${t.trigger?.label ?? 'deleted'}" on ${t.startedBy.user.name}'s accounts`
                  : `started by ${t.startedBy.user.name}`}
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
            {t.computer.kind === 'cloud' && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={watching}
                onClick={() => {
                  setFile(undefined)
                  setWatching(!watching || Boolean(file))
                }}
                title="Watch the workspace computer's desktop"
              >
                <Monitor aria-hidden />
                {watching ? 'Hide desktop' : 'Desktop'}
              </Button>
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

      <div className="mb-4 empty:hidden">
        <Takeover
          thread={t}
          memberId={me.memberId ?? ''}
          onChange={() => void thread.reload()}
          onOpenDesktop={() => {
            setWatching(true)
            setExpanded(true)
          }}
        />
      </div>

      {file && (
        <FilePanel
          key={`${file.teammateId ?? ''}:${file.path}`}
          threadId={t.id}
          path={file.path}
          teammateId={file.teammateId}
          teammateName={(teammateId) =>
            people.find((p) => p.id === teammateId)?.name ?? t.teammate.name
          }
          onOpen={setFile}
          onClose={() => setFile(undefined)}
        />
      )}

      {!file && watching && t.computer.kind === 'cloud' && (
        <DesktopPreview
          threadId={t.id}
          teammateName={t.teammate.name}
          control={!!me.memberId && t.controlledByMemberId === me.memberId}
          expanded={expanded}
          onExpand={setExpanded}
          onClose={() => {
            setWatching(false)
            setExpanded(false)
          }}
        />
      )}

      <FileLinksProvider value={{ open: setFile }}>
        <ThreadItems
          threadId={t.id}
          items={items}
          teammate={t.teammate}
          teammates={people}
          canApprove={t.mayPrompt}
          onApproval={(approvalId, approved) =>
            void call('/approvals', { approvalId, approved }).catch(() => undefined)
          }
          onAnswer={(questionId, answer) =>
            api(`/threads/${id}/answers`, { body: { questionId, answer } }).then(() => undefined)
          }
          onTicket={(requestId, answer) =>
            api(`/threads/${id}/tickets`, { body: { requestId, answer } }).then(() => undefined)
          }
        />
      </FileLinksProvider>

      {t.controlledByMemberId ? null : t.mayPrompt ? (
        // Sticks to the bottom of the content column while the thread scrolls under it; the
        // negative margin takes up the column's bottom padding so it never jumps at the end.
        <div className="sticky bottom-0 z-10 mt-6 -mb-16 bg-linear-to-t from-background from-75% to-transparent pt-6 pb-4 md:pb-6">
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
                    ? `${answering.name} is working. Your message will run next. @ to mention`
                    : people.length > 1
                      ? `Reply to ${answering.name}, or @ a teammate to ask them`
                      : 'Reply. @ a teammate to bring them in, or a connection, credential or thread'
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
                    onClick={() => void call('/interrupt').catch(() => undefined)}
                  >
                    Interrupt
                  </Button>
                )}
                <Button size="sm" disabled={!ready || current === 'waiting'}>
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
