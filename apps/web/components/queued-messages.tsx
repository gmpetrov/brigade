'use client'
import {
  asksParallel,
  childNote,
  forPeople,
  mayChangeQueued,
  mentionsToText,
  type QueuedMessageAction,
  type ReplyTo,
} from '@brigade/contracts'
import { CornerDownRight, Ellipsis, Pencil, RotateCcw, Split, X } from 'lucide-react'
import { useState } from 'react'
import { brigadeNote, handOffNote, notePreview } from '@/components/brigade-notes'
import { useDashboard } from '@/components/dashboard'
import type { MoveTarget, Upload } from '@/components/attachments'
import type { Picked } from '@/components/thread-conversation'
import type { DesignEdit } from '@/lib/pending-edits'
import type { QueuedMessage } from '@/components/thread-view'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Textarea } from '@/components/ui/textarea'
import { useMemberNames } from '@/lib/member-names'
import { Hint } from '@/components/ui/tooltip'
import { inThread } from '@/lib/outgoing-messages'
import { cn } from '@/lib/utils'

/** A message sent from this tab that the thread has not shown yet. */
export type Outgoing = {
  messageId: string
  text: string
  files: number
  /** Its files as the composer had them: shown with it until the thread has it. */
  uploads: Upload[]
  /** The thread's last event when it was sent: a message without an id after it may be this one. */
  afterSeq: number
  /**
   * sending: on its way to the API. sent: the API took it. starting: the computer starts first.
   * moving: the thread moves to another computer first (movingTo). unsent: the API refused it
   * (error). failed: the computer never said it got it.
   */
  state: 'sending' | 'sent' | 'starting' | 'moving' | 'unsent' | 'failed'
  /** Why the API refused it. */
  error?: string
  /**
   * The teammate was working when it was sent: it waits in the queue, at the end of the thread,
   * rather than being read at once.
   */
  queues: boolean
  /** When it was sent. */
  at: number
  /** When the API took it: this attempt's wait for the computer counts from then. */
  sentAt?: number
  /** The computer it goes with the thread to, by name. */
  movingTo?: string
  /** What sending it again takes. */
  with: { attachmentIds: string[]; pick?: string; replyTo?: ReplyTo; moveTo?: MoveTarget }
  /** What the composer held, to put back there on Edit: its files are `uploads`. */
  draft?: OutgoingDraft
}

/** A composer's message as it was written: its text, quote, computer, picked elements and design edits. */
export type OutgoingDraft = {
  text: string
  replyTo?: ReplyTo
  moveTo?: MoveTarget
  elements: Picked[]
  designEdits: DesignEdit[]
}

/** Refused, or never confirmed: the person sends it again or edits it. */
export const notThrough = (m: Outgoing) => m.state === 'unsent' || m.state === 'failed'

/** Why it did not get through, for the person. */
export const notThroughText = (m: Outgoing) =>
  m.state === 'unsent'
    ? `Not sent: ${m.error ?? 'Brigade could not take this message.'}`
    : 'Not delivered: the computer did not confirm it got this message.'

/**
 * Messages waiting to be read, as the person's own messages look once read: at the end of the
 * thread, where its turn reads them, above its Working line. Nothing marks them, as in a chat:
 * a person's message written during a turn goes into it on its own (the runner steers it in),
 * and otherwise its teammate reads it next, with the others. Its menu, shown while the pointer is
 * over it (always on phones), gives it to the turn now, edits or removes it, or sends it to run
 * in parallel (handed to a child thread) when a person wrote it: Brigade's own (a wake-up, a
 * note), a quiet line, goes as it is.
 */
export function QueuedMessages({
  queued,
  teammateName,
  canSteer,
  canParallel,
  onAction,
}: {
  queued: QueuedMessage[]
  /** Who reads them next. */
  teammateName: string
  /** A turn runs that a message could be steered into. */
  canSteer: boolean
  /** The thread may start child threads: it is not one. */
  canParallel: boolean
  onAction: (messageId: string, action: QueuedMessageAction) => Promise<void>
}) {
  const { me } = useDashboard()
  // Another member's message is theirs to change: anyone who may write steers it in.
  const others = queued.some((m) => m.memberId !== null && m.memberId !== me.memberId)
  const names = useMemberNames(others)
  const mayChange = (m: QueuedMessage, action: QueuedMessageAction['action']) =>
    mayChangeQueued(m.memberId, action) && (m.memberId === null || m.memberId === me.memberId)
  const [editing, setEditing] = useState<{ messageId: string; text: string }>()
  const [busy, setBusy] = useState<string>()
  if (queued.length === 0) return null

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
    const note =
      m.memberId === null
        ? childNote(m.text)
          ? null
          : brigadeNote(m.text, true)
        : handOffNote(m.text)
    if (note) return notePreview(note)
    return mentionsToText(forPeople(m.text)) || `${files} file${files === 1 ? '' : 's'}`
  }
  // As a person's message's own actions are (MessageActions): there while the pointer is over it.
  const hover =
    '[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/message:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100 data-[state=open]:opacity-100'

  return (
    <section aria-label="Queued messages" className="flex flex-col items-end gap-4">
      {queued.map((m) => {
        const files = m.attachments.length
        const fromBrigade = m.memberId === null
        const from =
          m.memberId !== null && m.memberId !== me.memberId
            ? (names.get(m.memberId) ?? 'Another member')
            : fromBrigade &&
              (childNote(m.text) === 'report'
                ? 'Reports from sub-threads'
                : childNote(m.text) === 'task' || childNote(m.text) === 'parent'
                  ? 'From the parent thread'
                  : (brigadeNote(m.text, true)?.label ?? 'From Brigade'))
        // Anyone who may write gives a message to the turn, whoever wrote it.
        const steer = canSteer && m.waitingFor === 'turn'
        const parallel =
          canSteer &&
          canParallel &&
          m.waitingFor === 'turn' &&
          mayChange(m, 'parallel') &&
          !asksParallel(m.text)
        const editable = mayChange(m, 'edit')
        const removable = mayChange(m, 'cancel')
        const caption = [
          !fromBrigade && from,
          m.waitingFor === 'person' && 'Runs once the pending request is answered',
          files > 0 && m.text && `${files} file${files === 1 ? '' : 's'}`,
        ].filter(Boolean)
        return (
          <div
            key={m.messageId}
            data-queued={m.messageId}
            className="flex max-w-[85%] flex-col items-end gap-1.5 self-end"
          >
            {editing?.messageId === m.messageId ? (
              <form
                className="flex w-[min(28rem,80vw)] flex-col gap-2"
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
              <div className="group/message flex items-center gap-1">
                {(steer || parallel || editable || removable) && (
                  <DropdownMenu>
                    <Hint label="More">
                      <DropdownMenuTrigger
                        aria-label="More actions"
                        disabled={busy === m.messageId}
                        className={cn(
                          'flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 [&>svg]:size-3.5',
                          hover,
                        )}
                      >
                        <Ellipsis aria-hidden />
                      </DropdownMenuTrigger>
                    </Hint>
                    <DropdownMenuContent
                      align="end"
                      className="min-w-44"
                      // Edit replaces the bubble: focus stays in its text box.
                      onCloseAutoFocus={(e) => e.preventDefault()}
                    >
                      {steer && (
                        <DropdownMenuItem
                          onSelect={() => void act(m.messageId, { action: 'steer' })}
                        >
                          <CornerDownRight aria-hidden />
                          Give it to {teammateName} now
                        </DropdownMenuItem>
                      )}
                      {parallel && (
                        <Hint
                          side="left"
                          label={`${teammateName} starts a sub-thread for it now and carries on with this turn. Its report comes back here.`}
                        >
                          <DropdownMenuItem
                            onSelect={() => void act(m.messageId, { action: 'parallel' })}
                          >
                            <Split aria-hidden />
                            Send to a sub-thread
                          </DropdownMenuItem>
                        </Hint>
                      )}
                      {editable && (
                        <DropdownMenuItem
                          onSelect={() =>
                            setEditing({ messageId: m.messageId, text: forPeople(m.text) })
                          }
                        >
                          <Pencil aria-hidden />
                          Edit
                        </DropdownMenuItem>
                      )}
                      {removable && (
                        <Hint side="left" label="It will not be sent">
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => void act(m.messageId, { action: 'cancel' })}
                          >
                            <X aria-hidden />
                            Remove
                          </DropdownMenuItem>
                        </Hint>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                {fromBrigade ? (
                  <p className="rounded-xl border border-dashed px-3.5 py-2 text-sm text-muted-foreground">
                    <span className="line-clamp-2 wrap-anywhere whitespace-pre-wrap">
                      {from ? `${from}: ` : ''}
                      {preview(m)}
                    </span>
                  </p>
                ) : (
                  // The look of a person's message once read (MessageBubble): it does not change.
                  <div className="min-w-0 rounded-2xl rounded-br-md bg-primary px-4 py-2.5 leading-relaxed wrap-anywhere whitespace-pre-wrap text-primary-foreground">
                    {preview(m)}
                  </div>
                )}
              </div>
            )}
            {caption.length > 0 && (
              <span className="text-right text-xs text-muted-foreground">
                {caption.join(' · ')}
              </span>
            )}
            {m.note && <span className="text-right text-xs text-warning">{m.note}</span>}
          </div>
        )
      })}
    </section>
  )
}

/**
 * Messages going with their thread to another computer, above the composer until the thread is
 * there: the thread itself is not on this computer yet. One never confirmed can be sent again,
 * edited or discarded.
 */
export function MessagesOnTheirWay({
  outgoing,
  onRetry,
  onEdit,
  onDiscard,
}: {
  outgoing: Outgoing[]
  /** Send a message that did not get through again, as it was. */
  onRetry: (message: Outgoing) => void
  /** Put a message that did not get through back in the composer. */
  onEdit: (message: Outgoing) => void
  onDiscard: (messageId: string) => void
}) {
  // The others show in the thread, as the person's messages.
  const cards = outgoing.filter((m) => !inThread(m))
  if (cards.length === 0) return null
  return (
    <ul aria-label="Messages being sent" className="mb-2 flex flex-col gap-1.5">
      {cards.map((m) => (
        <li
          key={m.messageId}
          className={cn(
            'flex items-start gap-2 rounded-lg border bg-card px-3 py-2 text-sm shadow-sm',
            notThrough(m) && 'border-destructive/50',
          )}
        >
          {/* A status dot, not a spinner: the thread is on its way. */}
          <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-hidden />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="line-clamp-2 wrap-anywhere whitespace-pre-wrap">
              {mentionsToText(m.text) || `${m.files} file${m.files === 1 ? '' : 's'}`}
            </span>
            <span
              className={cn(
                'text-xs',
                notThrough(m) ? 'text-destructive-text' : 'text-muted-foreground',
              )}
            >
              {notThrough(m)
                ? notThroughText(m)
                : `Goes with the thread to ${m.movingTo ?? 'the other computer'}…`}
            </span>
          </div>
          {notThrough(m) && (
            <div className="flex shrink-0 items-center gap-1">
              <Button type="button" variant="outline" size="sm" onClick={() => onRetry(m)}>
                <RotateCcw aria-hidden />
                Retry
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => onEdit(m)}>
                <Pencil aria-hidden />
                Edit
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => onDiscard(m.messageId)}
                aria-label="Discard message"
                tooltip="Discard"
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
