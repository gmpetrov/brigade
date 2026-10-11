'use client'
import { mentionsToText } from '@brigade/contracts'
import { Clock, CornerDownRight, Pencil, RotateCcw, X } from 'lucide-react'
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
  /** starting: the computer starts first. failed: the computer never said it got it. */
  state: 'sending' | 'sent' | 'starting' | 'failed'
}

/**
 * Messages waiting to be read, above the composer: queued behind the running
 * turn or held until a person answers. Each can be steered into the running
 * turn, edited or cancelled until its teammate reads it.
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

  return (
    <ul aria-label="Queued messages" className="mb-2 flex flex-col gap-1.5">
      {queued.map((m) => {
        const files = m.attachments.length
        return (
          <li key={m.messageId} className="rounded-lg border bg-card px-3 py-2 text-sm shadow-sm">
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
                  onChange={(e) => setEditing({ messageId: m.messageId, text: e.target.value })}
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
              <div className="flex items-start gap-2">
                <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="line-clamp-2 wrap-anywhere whitespace-pre-wrap">
                    {mentionsToText(m.text) || `${files} file${files === 1 ? '' : 's'}`}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {m.waitingFor === 'person'
                      ? `Queued · runs once the pending request is answered`
                      : `Queued · ${teammateName} reads it after the current turn`}
                    {files > 0 && m.text && ` · ${files} file${files === 1 ? '' : 's'}`}
                  </span>
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
                      Steer now
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
      {outgoing.map((m) => (
        <li
          key={m.messageId}
          className={cn(
            'flex items-start gap-2 rounded-lg border bg-card px-3 py-2 text-sm shadow-sm',
            m.state === 'failed' && 'border-destructive/50',
          )}
        >
          <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
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
  )
}
