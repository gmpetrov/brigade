'use client'
import {
  asksParallel,
  childNote,
  forPeople,
  mayChangeQueued,
  mentionsToText,
  type QueuedMessageAction,
} from '@brigade/contracts'
import {
  ChevronDown,
  Clock,
  CornerDownRight,
  Ellipsis,
  Pencil,
  RotateCcw,
  Split,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { brigadeNote, notePreview } from '@/components/brigade-notes'
import type { QueuedMessage } from '@/components/thread-view'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

/** A message sent from this tab that the thread has not shown yet. */
export type Outgoing = {
  messageId: string
  text: string
  files: number
  /** The thread's last event when it was sent: a message without an id after it may be this one. */
  afterSeq: number
  /**
   * starting: the computer starts first. moving: the thread moves to another
   * computer first (movingTo). failed: the computer never said it got it.
   */
  state: 'sending' | 'sent' | 'starting' | 'moving' | 'failed'
  /** The computer it goes with the thread to, by name. */
  movingTo?: string
}

/**
 * Messages waiting to be read, above the composer: queued behind the running
 * turn or held until a person answers, in one collapsible list. Each can be
 * steered into the running turn until its teammate reads it, and edited,
 * cancelled or sent to run in parallel (handed to a child thread) when a person
 * wrote it: Brigade's own, such as a child's report, goes as it is.
 */
export function QueuedMessages({
  queued,
  outgoing,
  teammateName,
  canSteer,
  canParallel,
  onAction,
  onResend,
  onDiscard,
}: {
  queued: QueuedMessage[]
  outgoing: Outgoing[]
  /** Who reads them next. */
  teammateName: string
  /** A turn runs that a message could be steered into. */
  canSteer: boolean
  /** The thread may start child threads: it is not one. */
  canParallel: boolean
  onAction: (messageId: string, action: QueuedMessageAction) => Promise<void>
  /** Put a message that never arrived back in the composer. */
  onResend: (message: Outgoing) => void
  onDiscard: (messageId: string) => void
}) {
  const [editing, setEditing] = useState<{ messageId: string; text: string }>()
  const [busy, setBusy] = useState<string>()
  const [open, setOpen] = useState(true)
  if (queued.length === 0 && outgoing.length === 0) return null

  const act = async (messageId: string, action: Parameters<typeof onAction>[1]) => {
    setBusy(messageId)
    try {
      await onAction(messageId, action)
      if (action.action === 'edit') setEditing(undefined)
    } finally {
      setBusy(undefined)
    }
  }
  const preview = (m: QueuedMessage) => {
    const files = m.attachments.length
    const note = m.memberId === null && !childNote(m.text) ? brigadeNote(m.text, true) : null
    if (note) return notePreview(note)
    return mentionsToText(forPeople(m.text)) || `${files} file${files === 1 ? '' : 's'}`
  }
  const cancellable = queued.filter((m) => mayChangeQueued(m.memberId, 'cancel'))
  // One message needs no header: it sits on a single line, marked Queued.
  const single = queued.length === 1
  const shown = open || single

  return (
    <div className="mb-2 flex flex-col gap-1.5">
      {queued.length > 0 && (
        <section
          aria-label="Queued messages"
          className="overflow-hidden rounded-xl border bg-card text-sm shadow-sm"
        >
          {!single && (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className="flex w-full items-center gap-2 px-5 py-2.5 text-left"
              title={`${teammateName} reads them in order, after the current turn`}
            >
              <span className="shrink-0 font-medium">
                {queued.length} message{queued.length === 1 ? '' : 's'} queued
              </span>
              {!open && (
                <span className="min-w-0 truncate text-muted-foreground">
                  Next: {preview(queued[0]!)}
                </span>
              )}
              <ChevronDown
                aria-hidden
                className={cn(
                  'ml-auto size-4 shrink-0 text-muted-foreground transition-transform',
                  open && 'rotate-180',
                )}
              />
            </button>
          )}
          {shown && (
            <ul className={cn('divide-y', single ? 'mx-4' : 'mx-5 border-t')}>
              {queued.map((m) => {
                const files = m.attachments.length
                const from =
                  m.memberId === null &&
                  (childNote(m.text) === 'report'
                    ? 'Reports from child threads'
                    : childNote(m.text) === 'task' || childNote(m.text) === 'parent'
                      ? 'From the parent thread'
                      : (brigadeNote(m.text, true)?.label ?? 'From Brigade'))
                const parallel =
                  canSteer &&
                  canParallel &&
                  m.waitingFor === 'turn' &&
                  mayChangeQueued(m.memberId, 'parallel') &&
                  !asksParallel(m.text)
                const editable = mayChangeQueued(m.memberId, 'edit')
                const removable = mayChangeQueued(m.memberId, 'cancel')
                return (
                  <li key={m.messageId} className={single ? 'py-2' : 'py-2.5'}>
                    {editing?.messageId === m.messageId ? (
                      <form
                        className="flex flex-col gap-2"
                        onSubmit={(e) => {
                          e.preventDefault()
                          if (editing.text.trim())
                            void act(m.messageId, { action: 'edit', text: editing.text })
                        }}
                      >
                        <Textarea
                          autoFocus
                          rows={2}
                          value={editing.text}
                          onChange={(e) =>
                            setEditing({ messageId: m.messageId, text: e.target.value })
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') setEditing(undefined)
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey))
                              e.currentTarget.form?.requestSubmit()
                          }}
                          aria-label="Queued message"
                        />
                        <div className="flex justify-end gap-2">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditing(undefined)}
                          >
                            Cancel
                          </Button>
                          <Button size="sm" disabled={!editing.text.trim() || busy === m.messageId}>
                            Save
                          </Button>
                        </div>
                      </form>
                    ) : (
                      <div className="flex items-center gap-2">
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="line-clamp-2 wrap-anywhere whitespace-pre-wrap">
                            {/* Inline, so the chip stays on the first line of text */}
                            {single && (
                              <span
                                className="mr-2 inline-block rounded-md border px-1.5 align-[1px] text-xs leading-[18px] text-muted-foreground"
                                title={`${teammateName} reads it after the current turn`}
                              >
                                Queued
                              </span>
                            )}
                            {preview(m)}
                          </span>
                          {(from || m.waitingFor === 'person' || (files > 0 && m.text)) && (
                            <span className="text-xs text-muted-foreground">
                              {[
                                from,
                                m.waitingFor === 'person' &&
                                  'Runs once the pending request is answered',
                                files > 0 && m.text && `${files} file${files === 1 ? '' : 's'}`,
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </span>
                          )}
                          {m.note && <span className="text-xs text-warning">{m.note}</span>}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {canSteer && m.waitingFor === 'turn' && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 text-muted-foreground"
                              disabled={busy === m.messageId}
                              onClick={() => void act(m.messageId, { action: 'steer' })}
                              title={`Give it to ${teammateName} now, during this turn`}
                            >
                              <CornerDownRight aria-hidden />
                              Steer
                            </Button>
                          )}
                          {(parallel || editable || removable) && (
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                aria-label="More actions"
                                title="More"
                                disabled={busy === m.messageId}
                                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 data-[state=open]:bg-accent data-[state=open]:text-foreground [&>svg]:size-4"
                              >
                                <Ellipsis aria-hidden />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent
                                align="end"
                                className="min-w-44"
                                // Edit replaces the row: focus stays in its text box.
                                onCloseAutoFocus={(e) => e.preventDefault()}
                              >
                                {parallel && (
                                  <DropdownMenuItem
                                    onSelect={() => void act(m.messageId, { action: 'parallel' })}
                                    title={`${teammateName} starts a child thread for it now and carries on with this turn`}
                                  >
                                    <Split aria-hidden />
                                    Run in parallel
                                  </DropdownMenuItem>
                                )}
                                {editable && (
                                  <DropdownMenuItem
                                    onSelect={() =>
                                      setEditing({
                                        messageId: m.messageId,
                                        text: forPeople(m.text),
                                      })
                                    }
                                  >
                                    <Pencil aria-hidden />
                                    Edit
                                  </DropdownMenuItem>
                                )}
                                {removable && (
                                  <DropdownMenuItem
                                    variant="destructive"
                                    onSelect={() => void act(m.messageId, { action: 'cancel' })}
                                    title="It will not be sent"
                                  >
                                    <X aria-hidden />
                                    Remove
                                  </DropdownMenuItem>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {open && cancellable.length > 1 && (
            <div className="mx-5 flex justify-end border-t py-1">
              <Button
                type="button"
                variant="danger"
                size="xs"
                disabled={busy !== undefined}
                onClick={() =>
                  void Promise.all(
                    cancellable.map((m) => onAction(m.messageId, { action: 'cancel' })),
                  )
                }
              >
                Clear all
              </Button>
            </div>
          )}
        </section>
      )}
      <ul aria-label="Messages being sent" className="contents">
        {outgoing.map((m) => (
          <li
            key={m.messageId}
            className={cn(
              'flex items-start gap-2 rounded-lg border bg-card px-3 py-2 text-sm shadow-sm',
              m.state === 'failed' && 'border-destructive/50',
            )}
          >
            {m.state === 'moving' ? (
              // A status dot, not a spinner: the thread is on its way.
              <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-hidden />
            ) : (
              <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="line-clamp-2 wrap-anywhere whitespace-pre-wrap">
                {mentionsToText(m.text) || `${m.files} file${m.files === 1 ? '' : 's'}`}
              </span>
              <span
                className={cn(
                  'text-xs',
                  m.state === 'failed' ? 'text-destructive-text' : 'text-muted-foreground',
                )}
              >
                {m.state === 'failed'
                  ? 'Not delivered: the computer did not confirm it got this message.'
                  : m.state === 'starting'
                    ? 'Waiting for the computer to start…'
                    : m.state === 'moving'
                      ? `Goes with the thread to ${m.movingTo ?? 'the other computer'}…`
                      : 'Sending…'}
              </span>
            </div>
            {m.state === 'failed' && (
              <div className="flex shrink-0 items-center gap-1">
                <Button type="button" variant="outline" size="sm" onClick={() => onResend(m)}>
                  <RotateCcw aria-hidden />
                  Edit and resend
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onDiscard(m.messageId)}
                  aria-label="Discard message"
                  title="Discard"
                >
                  <X aria-hidden />
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
