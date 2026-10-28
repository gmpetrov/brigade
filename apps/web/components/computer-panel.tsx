'use client'
// Beside an expanded thread or teammate's thread list (the threads panel): the
// details. Beside a thread, the thread's own (who is in it, who started it, its
// project and task), then the computer it runs on (its screen, taking control,
// Preview, a shell, the run log) and what it made. Beside the list, what the teammate is
// on now. Both end with the teammate: routines, settings.
import { AlarmClock, ArrowRight, Globe, Hand, Settings, SquareTerminal, X } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CloseButton } from '@/components/close-button'
import { StatusBadge, TeammateAvatar } from '@/components/dashboard'
import { TeammateTitle } from '@/components/teammate-title'
import { DesktopScreen } from '@/components/desktop-preview'
import type { OpenFile } from '@/components/file-links'
import { describeCron } from '@/components/schedules'
import { Terminal } from '@/components/terminal'
import { ThreadMenu } from '@/components/thread-menu'
import { ThreadOutputs, type ChangedFiles, type ThreadOutput } from '@/components/thread-outputs'
import { ProviderLogo } from '@/components/provider-logo'
import { PanelResizeHandle, useEscapeToClose, usePanelStack } from '@/components/side-panel'
import { ChildrenList } from '@/components/thread-children'
import { Button } from '@/components/ui/button'
import {
  api,
  teammateModelLabel,
  useApi,
  type Schedule,
  type Teammate,
  type Thread,
  type ThreadSummary,
} from '@/lib/api'

function Section({
  title,
  action,
  children,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-8 items-center gap-2">
        <h2 className="flex-1 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}

/**
 * The panel itself, on the right: beside the thread on wide screens, over it on narrower
 * ones, the whole screen on phones.
 */
function Frame({
  teammate,
  subtitle,
  onClose,
  onEscape = onClose,
  children,
}: {
  teammate: Pick<Teammate, 'id' | 'name' | 'title' | 'harness'>
  subtitle: string
  onClose: () => void
  /** What Escape does: closes it, as it does the other panels beside a page, unless told else. */
  onEscape?: () => void
  children: ReactNode
}) {
  const panel = useRef<HTMLElement>(null)
  const stack = usePanelStack()
  useEscapeToClose(panel, stack.front ? onEscape : undefined)
  return (
    <aside
      ref={panel}
      data-desktop-panel
      data-details-panel
      style={stack.style}
      className="fixed inset-0 z-(--sheet-z) flex flex-col overflow-hidden bg-card md:left-auto md:w-(--desktop-w) md:border-l md:shadow-lg lg:shadow-none xl:z-(--panel-z) xl:overflow-visible"
      aria-label={`About ${teammate.name}`}
    >
      <PanelResizeHandle />
      <div className="flex h-14 shrink-0 flex-nowrap items-center gap-3 px-4">
        <TeammateAvatar teammate={teammate} className="size-7" />
        <div className="min-w-0 flex-1 leading-tight">
          <span className="flex min-w-0 items-center gap-2">
            <strong className="truncate text-sm font-semibold">{teammate.name}</strong>
            <TeammateTitle title={teammate.title} className="px-1.5 py-0 text-[11px]" />
          </span>
          <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
        </div>
        <CloseButton label={`Close ${teammate.name}'s panel`} title="Close" onClick={onClose} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-4">{children}</div>
    </aside>
  )
}

/** The teammate's routines (schedules): what it does on its own, and when. */
function Routines({ teammate }: { teammate: Pick<Teammate, 'id'> }) {
  const schedules = useApi<Schedule[]>('/schedules')
  const mine = (schedules.data ?? []).filter((s) => s.teammateId === teammate.id)
  return (
    <Section
      title="Routines"
      action={
        <Button asChild variant="outline" size="sm">
          <Link href="/app/routines">All</Link>
        </Button>
      }
    >
      {!schedules.data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : mine.length === 0 ? (
        <p className="text-sm text-muted-foreground">No routines yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {mine.map((s) => (
            <li key={s.id} className="rounded-lg border bg-background px-3 py-2">
              <p className="truncate text-sm font-semibold">{s.title}</p>
              <p className="truncate text-xs text-muted-foreground">
                {s.pausedAt ? 'Paused · ' : ''}
                {describeCron(s.cron)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

/** What the teammate is told, and where to see or change more. */
function About({ teammate, children }: { teammate: Teammate; children?: ReactNode }) {
  return (
    <Section title="About">
      {teammate.instructions && (
        <p className="line-clamp-4 text-sm whitespace-pre-wrap text-muted-foreground">
          {teammate.instructions}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <Button asChild variant="outline" className="justify-start">
          <Link href={`/app/teammates/${teammate.id}`}>
            <Settings aria-hidden />
            Settings
          </Link>
        </Button>
        {children}
      </div>
    </Section>
  )
}

const BUSY = new Set(['starting', 'running'])

/**
 * A teammate beside its thread list: what it is on now (its screen shows once a
 * thread is open), its routines, and its settings.
 */
export function TeammatePanel({
  teammate,
  threads,
  onOpenThread,
  onOpenComputer,
  onClose,
}: {
  teammate: Teammate
  /** Its threads, newest first; undefined while they load. */
  threads?: ThreadSummary[]
  onOpenThread: (id: string) => void
  /** The workspace computer open, beside the thread list. */
  onOpenComputer: () => void
  onClose: () => void
}) {
  const working = (threads ?? []).filter((t) => BUSY.has(t.status))
  const waiting = (threads ?? []).filter((t) => t.status === 'waiting')
  const on = waiting[0] ?? working[0]
  return (
    <Frame teammate={teammate} subtitle={teammateModelLabel(teammate)} onClose={onClose}>
      <Section title="Computer">
        <DesktopScreen
          source={{ teammate: teammate.id }}
          teammateName={teammate.name}
          control={false}
          mode="thumbnail"
          onOpen={onOpenComputer}
        />
        {on && (
          <button
            type="button"
            onClick={() => onOpenThread(on.id)}
            className="flex min-w-0 items-center gap-1.5 text-left text-sm text-muted-foreground hover:text-foreground"
          >
            <span className="shrink-0">Working on</span>
            <span className="truncate font-semibold text-foreground">{on.title}</span>
            <ArrowRight aria-hidden className="size-3.5 shrink-0" />
          </button>
        )}
      </Section>

      <Section title="Status">
        {!threads ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : working.length + waiting.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing running.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {working.length > 0 && (
              <StatusBadge status="running" label={`${working.length} working`} />
            )}
            {waiting.length > 0 && (
              <StatusBadge status="waiting" label={`${waiting.length} need you`} />
            )}
          </div>
        )}
      </Section>

      <Routines teammate={teammate} />
      <About teammate={teammate} />
    </Frame>
  )
}

/** Taking over the computer and handing it back, for the panel and the open computer. */
function useControl(thread: Thread, memberId: string, onChange: () => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const mine = !!memberId && thread.controlledByMemberId === memberId

  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(undefined)
    try {
      await fn()
      onChange()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return {
    busy,
    error,
    mine,
    takeOver: () =>
      void act(() => api(`/threads/${thread.id}/takeover`, { body: { interrupt: false } })),
    // No note from here: the thread's own hand back, below the conversation, takes one.
    handBack: () => void act(() => api(`/threads/${thread.id}/handback`, { body: { note: '' } })),
    openBrowser: () =>
      void act(() => api(`/teammates/${thread.teammate.id}/browser`, { body: {} })),
  }
}

/** "14:30" today, else with its day: "Fri 16 Oct, 09:00". */
const wakeTime = (at: string) => {
  const date = new Date(at)
  const today = date.toDateString() === new Date().toDateString()
  return date.toLocaleString(undefined, {
    ...(today ? {} : { weekday: 'short', day: 'numeric', month: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** When the thread's teammates will be prompted here again, to check on something. */
function Wakeups({ thread, onChange }: { thread: Thread; onChange: () => void }) {
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const cancel = async (id: string) => {
    setBusy(id)
    setError(undefined)
    try {
      await api(`/threads/${thread.id}/wakeups/${id}`, { method: 'DELETE' })
      onChange()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(undefined)
    }
  }
  const names = new Map(thread.teammates.map((t) => [t.teammate.id, t.teammate.name]))
  return (
    <Section title="Wake-ups">
      <ul className="flex flex-col">
        {thread.wakeups.map((w) => (
          <li key={w.id} className="flex items-center gap-3 rounded-md px-2 py-1.5">
            <AlarmClock className="size-4 flex-none text-muted-foreground" aria-hidden />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium" title={w.note}>
                {w.note}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {names.size > 1 && `${names.get(w.teammateId) ?? 'A teammate'} · `}
                <time dateTime={w.wakeAt}>{wakeTime(w.wakeAt)}</time>
              </span>
            </span>
            {thread.mayPrompt && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy === w.id}
                onClick={() => void cancel(w.id)}
              >
                Cancel
              </Button>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </Section>
  )
}

/** Emails a teammate sent from the thread: a reply in their conversation wakes it. */
function AwaitedReplies({ thread, onChange }: { thread: Thread; onChange: () => void }) {
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const stop = async (id: string) => {
    setBusy(id)
    setError(undefined)
    try {
      await api(`/threads/${thread.id}/replies/${id}`, { method: 'DELETE' })
      onChange()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(undefined)
    }
  }
  const names = new Map(thread.teammates.map((t) => [t.teammate.id, t.teammate.name]))
  return (
    <Section title="Waiting for replies">
      <ul className="flex flex-col">
        {thread.replyWatches.map((w) => (
          <li key={w.id} className="flex items-center gap-3 rounded-md px-2 py-1.5">
            <ProviderLogo kind={w.connection.kind} className="size-4 flex-none" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium" title={w.subject}>
                {w.subject}
              </span>
              <span
                className="truncate text-xs text-muted-foreground"
                title={`Sent from ${w.connection.externalAccount ?? w.connection.label}`}
              >
                {names.size > 1 && `${names.get(w.teammateId) ?? 'A teammate'} · `}
                To {w.to} · until <time dateTime={w.until}>{wakeTime(w.until)}</time>
              </span>
            </span>
            {thread.mayPrompt && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy === w.id}
                onClick={() => void stop(w.id)}
              >
                Stop
              </Button>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </Section>
  )
}

/** Sign-up addresses the thread made (Email App): their mail comes to it alone, for now. */
function AwaitedMail({ thread }: { thread: Thread }) {
  return (
    <Section title="Waiting for email">
      <ul className="flex flex-col">
        {thread.mailAliases.map((a) => (
          <li key={a.id} className="flex items-center gap-3 rounded-md px-2 py-1.5">
            <ProviderLogo kind="email" className="size-4 flex-none" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium" title={a.purpose}>
                {a.purpose || 'Sign-up'}
              </span>
              <span className="truncate text-xs text-muted-foreground" title={a.address}>
                {a.address} · until <time dateTime={a.waitUntil}>{wakeTime(a.waitUntil)}</time>
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Section>
  )
}

const SENT_STATUS: Record<string, string> = {
  scheduled: 'Leaving soon',
  sent: 'Sent',
  delivered: 'Delivered',
  bounced: 'Not delivered',
  cancelled: 'Cancelled',
}

/** Emails the thread sent from Brigade's addresses; one still in its window can be cancelled. */
function SentMail({ thread, onChange }: { thread: Thread; onChange: () => void }) {
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  // The window closes on its own: redrawn each second while one is open.
  const [now, setNow] = useState(() => Date.now())
  const open = thread.mailMessages.some(
    (m) => m.status === 'scheduled' && m.sendAt && Date.parse(m.sendAt) > now,
  )
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [open])
  const cancel = async (id: string) => {
    setBusy(id)
    setError(undefined)
    try {
      await api(`/email/messages/${id}/cancel`, { method: 'POST' })
      onChange()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(undefined)
    }
  }
  return (
    <Section title="Emails sent">
      <ul className="flex flex-col">
        {thread.mailMessages.map((m) => {
          const left =
            m.status === 'scheduled' && m.sendAt
              ? Math.ceil((Date.parse(m.sendAt) - now) / 1000)
              : 0
          return (
            <li key={m.id} className="flex items-center gap-3 rounded-md px-2 py-1.5">
              <ProviderLogo kind="email" className="size-4 flex-none" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium" title={m.subject}>
                  {m.subject || '(no subject)'}
                </span>
                <span
                  className={`truncate text-xs ${m.status === 'bounced' ? 'text-destructive' : 'text-muted-foreground'}`}
                  title={m.error ?? `From ${m.fromAddress}`}
                >
                  To {m.to.join(', ')} ·{' '}
                  {left > 120
                    ? // Set to leave later: its day and time.
                      `Leaves ${new Date(m.sendAt!).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
                    : left > 0
                      ? `Leaves in ${left} s`
                      : (SENT_STATUS[m.status] ?? (m.status === 'scheduled' ? 'Sent' : m.status))}
                </span>
              </span>
              {left > 0 && thread.mayPrompt && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy === m.id}
                  onClick={() => void cancel(m.id)}
                >
                  Cancel
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </Section>
  )
}

/**
 * Beside an expanded thread, everything that is not the conversation: its
 * computer (a thumbnail of the screen that opens it, Preview, the shell, the run
 * log), the thread's details, and what it made.
 */
export function ComputerPanel({
  thread,
  memberId,
  onOpenComputer,
  onClose,
  outputs,
  onOpenFile,
  changes,
  details,
  onChange,
}: {
  thread: Thread
  memberId: string
  /** The computer open, in the conversation's place. */
  onOpenComputer: () => void
  onClose: () => void
  /** What the thread made, newest first. */
  outputs: ThreadOutput[]
  onOpenFile: OpenFile
  /** The files changed in the code it checked out, first among its outputs; unset: none checked out. */
  changes?: ChangedFiles
  /** The thread's details, below its computer: who is in it, its project and task, who started it. */
  details: ReactNode
  /** Something here changed the thread (a wake-up cancelled): fetch it again. */
  onChange: () => void
}) {
  const teammate = thread.teammate
  const cloud = thread.computer.kind === 'cloud'
  const mine = !!memberId && thread.controlledByMemberId === memberId

  return (
    <Frame
      teammate={{ ...teammate, harness: teammate.harness as Teammate['harness'] }}
      subtitle={`${teammateModelLabel(teammate)} on ${cloud ? 'the cloud computer' : thread.computer.name}`}
      onClose={onClose}
    >
      <Section title="Computer">
        {cloud ? (
          <>
            <DesktopScreen
              source={{ thread: thread.id }}
              teammateName={teammate.name}
              control={mine}
              mode="thumbnail"
              onOpen={onOpenComputer}
            />
            {thread.controlledByMemberId && (
              <p className="text-sm text-muted-foreground">
                {mine
                  ? `You have control. ${teammate.name} waits until you hand back.`
                  : `Another member has control. ${teammate.name} continues when they hand it back.`}
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Runs on {thread.computer.name}, a member&apos;s machine: its screen is not shared here.
          </p>
        )}
      </Section>

      {/* The thread's own: pin, rename, archive or delete it here too, as it may be out of the
          sidebar. Its menu beside "Thread", so it is plainly not the teammate's. */}
      <Section title="Thread" action={<ThreadMenu thread={thread} onChanged={onChange} />}>
        {details}
      </Section>

      {thread.wakeups.length > 0 && <Wakeups thread={thread} onChange={onChange} />}

      {thread.replyWatches.length > 0 && <AwaitedReplies thread={thread} onChange={onChange} />}

      {thread.mailAliases?.length > 0 && <AwaitedMail thread={thread} />}

      {thread.mailMessages?.length > 0 && <SentMail thread={thread} onChange={onChange} />}

      {thread.children.length > 0 && (
        <Section title={`Child threads · ${thread.children.length}`}>
          <ChildrenList children={thread.children} />
        </Section>
      )}

      {(outputs.length > 0 || changes) && (
        <Section title={outputs.length ? `Outputs · ${outputs.length}` : 'Outputs'}>
          <ThreadOutputs outputs={outputs} onOpen={onOpenFile} changes={changes} />
        </Section>
      )}
      {/* The teammate's routines and settings are beside its thread list, not each thread. */}
    </Frame>
  )
}

/**
 * The computer's page, through a thread: its screen, and in a toolbar over its
 * foot taking control (or handing back), the teammate's browser and a shell once
 * this member has control. The shell opens below the screen.
 */
export function ComputerScreen({
  thread,
  memberId,
  shell,
  onShell,
  onChange,
  onCollapse,
}: {
  thread: Thread
  memberId: string
  shell: boolean
  onShell: (open: boolean) => void
  onChange: () => void
  /** Back to the conversation, once closed beside the screen. */
  onCollapse?: () => void
}) {
  const teammate = thread.teammate
  const control = useControl(thread, memberId, onChange)
  const { busy, mine } = control
  // The shell needs control: handing back closes it.
  const shellOpen = shell && mine
  useEffect(() => {
    if (shell && !mine) onShell(false)
  }, [shell, mine, onShell])
  const shellButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-pressed={shellOpen}
      className="aria-pressed:bg-accent aria-pressed:text-accent-foreground"
      onClick={() => onShell(!shellOpen)}
      aria-label={shellOpen ? 'Close the shell' : 'Shell'}
      title={shellOpen ? 'Close the shell' : `A shell on the computer, as ${teammate.name}`}
    >
      <SquareTerminal aria-hidden />
    </Button>
  )
  const toolbar = mine ? (
    <>
      <Button
        size="sm"
        disabled={busy}
        onClick={control.handBack}
        title={`Give the computer back to ${teammate.name}`}
      >
        <Hand aria-hidden />
        Hand back
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={busy}
        onClick={control.openBrowser}
        aria-label={`Open ${teammate.name}'s browser`}
        title={`Open ${teammate.name}'s browser`}
      >
        <Globe aria-hidden />
      </Button>
      {shellButton}
    </>
  ) : thread.controlledByMemberId ? (
    <span className="px-2 text-sm text-muted-foreground">Another member has control</span>
  ) : (
    <>
      <Button
        size="sm"
        disabled={busy}
        onClick={control.takeOver}
        title={`Use the mouse and keyboard. ${teammate.name} waits until you hand back`}
      >
        Take control
      </Button>
    </>
  )

  return (
    <div className="flex size-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        <DesktopScreen
          source={{ thread: thread.id }}
          teammateName={teammate.name}
          control={mine}
          mode="open"
          toolbar={toolbar}
          onCollapse={onCollapse}
        />
        {control.error && (
          <p className="absolute top-3 left-1/2 -translate-x-1/2 rounded-lg border bg-background px-3 py-1.5 text-sm text-destructive-text shadow-md">
            {control.error}
          </p>
        )}
      </div>
      {shellOpen && (
        <section
          aria-label="Shell"
          className="flex max-h-[45%] shrink-0 flex-col gap-2 overflow-y-auto border-t bg-card p-3"
        >
          {/* Typing exit closes it too. */}
          <Terminal
            sessionId={thread.id}
            onExit={() => onShell(false)}
            actions={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => onShell(false)}
                aria-label="Close the shell"
                title="Close the shell"
              >
                <X aria-hidden />
              </Button>
            }
          />
          <p className="text-xs text-muted-foreground">
            In the thread&apos;s directory, as {teammate.name}. Commands you run are recorded in the
            run log.
          </p>
        </section>
      )}
    </div>
  )
}

/**
 * The computer expanded over the whole window, sidebar included, in place of the thread's
 * details: opened from them, so the thread stays the page. Escape or × brings them back.
 */
export function ExpandedComputer({
  thread,
  memberId,
  onChange,
  onClose,
}: {
  thread: Thread
  memberId: string
  onChange: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [shell, setShell] = useState(false)
  // Not while the screen or the shell has the keyboard: they take Escape (data-keyboard).
  useEscapeToClose(ref, onClose)
  // On the body: nothing it sits in may hold it to the page beside the sidebar.
  return createPortal(
    <div
      ref={ref}
      className="fixed inset-0 z-50 bg-black"
      data-overlay
      aria-label={`${thread.teammate.name}'s computer`}
      role="region"
    >
      <ComputerScreen
        thread={thread}
        memberId={memberId}
        shell={shell}
        onShell={setShell}
        onChange={onChange}
      />
      <CloseButton
        label="Close the computer"
        title="Close (Esc)"
        onClick={onClose}
        className="absolute top-4 right-4 shadow-sm"
      />
    </div>,
    document.body,
  )
}
