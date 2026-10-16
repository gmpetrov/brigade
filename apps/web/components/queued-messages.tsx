'use client'
import { mentionsToText } from '@brigade/contracts'
import { ChevronDown, Clock, CornerDownRight, Pencil, RotateCcw, X } from 'lucide-react'
import { useState } from 'react'
import type { QueuedMessage } from '@/components/thread-view'
import { Button } from '@/components/ui/button'
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
 * steered into the running turn, edited or cancelled until its teammate reads it.
 */
export function QueuedMessages({
  queued,
  outgoing,
  teammateName,
  canSteer,
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
  onAction: (
    messageId: string,
    action: { action: 'cancel' } | { action: 'steer' } | { action: 'edit'; text: string },
  ) => Promise<void>
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
    return mentionsToText(m.text) || `${files} file${files === 1 ? '' : 's'}`
  }

  return (
    <div className="mb-2 flex flex-col gap-1.5">
      {queued.length > 0 && (
        <section
          aria-label="Queued messages"
          className="overflow-hidden rounded-xl border bg-card text-sm shadow-sm"
        >
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
          {open && (
            <ul className="mx-5 divide-y border-t">
              {queued.map((m) => {
                const files = m.attachments.length
                return (
                  <li key={m.messageId} className="py-2.5">
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
                            {preview(m)}
                          </span>
                          {(m.waitingFor === 'person' || (files > 0 && m.text)) && (
                            <span className="text-xs text-muted-foreground">
                              {[
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
                              variant="outline"
                              size="sm"
                              disabled={busy === m.messageId}
                              onClick={() => void act(m.messageId, { action: 'steer' })}
                              title={`Give it to ${teammateName} now, during this turn`}
                            >
                              <CornerDownRight aria-hidden />
                              Steer
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            disabled={busy === m.messageId}
                            onClick={() => setEditing({ messageId: m.messageId, text: m.text })}
                            aria-label="Edit queued message"
                            title="Edit"
                          >
                            <Pencil aria-hidden />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            disabled={busy === m.messageId}
                            onClick={() => void act(m.messageId, { action: 'cancel' })}
                            aria-label="Cancel queued message"
                            title="Cancel: it will not be sent"
                          >
                            <X aria-hidden />
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {open && queued.length > 1 && (
            <div className="mx-5 flex justify-end border-t py-1">
              <Button
                type="button"
                variant="danger"
                size="xs"
                disabled={busy !== undefined}
                onClick={() =>
                  void Promise.all(queued.map((m) => onAction(m.messageId, { action: 'cancel' })))
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
