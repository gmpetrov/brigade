'use client'
// Start a thread without leaving where you are: ⌘⇧K (Ctrl+Shift+K) opens the
// new-thread box in a dialog. It is the threads panel's box: the same draft and
// teammate, so closing it by mistake loses nothing. Sending closes it at once and
// says so in the corner; Open there goes to the thread once it has started. A message
// whose thread did not start, here or from a box that opened its thread at once, is kept
// aside (lib/pending-threads.ts), never mixed with what the box holds since: Back to message
// swaps it with that, which is kept aside in its turn.
import { ArrowRight, CircleAlert, CircleCheck, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useDashboard } from '@/components/dashboard'
import { NewThread } from '@/components/new-thread'
import { useThreadPanel } from '@/components/thread-panel'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { keptMessages, useKeptMessages, type KeptMessage } from '@/lib/pending-threads'
import { isMac } from '@/lib/platform'
import { cn } from '@/lib/utils'

export function QuickThread() {
  const [open, onOpenChange] = useState(false)
  const { teammates } = useDashboard()
  const { draft, teammateId, chooseTeammate, openThread } = useThreadPanel()
  const teammate = teammates.find((t) => t.id === teammateId) ?? teammates[0]
  const [started, setStarted] = useState<{
    teammate: string
    /** Its id once it has started. */
    id?: string
  }>()
  // Only the last send's outcome updates that note.
  const last = useRef(0)
  // Newest last: the note offers it first.
  const kept = useKeptMessages().at(-1)

  /** The message kept aside in the box, and what the box held kept aside instead. */
  function backToMessage(message: KeptMessage) {
    const files = draft.files
    // A file still uploading in the box would lose its upload on the way aside: the box opens,
    // and the note offers the message once it has uploaded.
    if (files.busy) return onOpenChange(true)
    const held: KeptMessage | undefined =
      draft.text.trim() || files.uploads.length > 0
        ? {
            key: `aside-${Date.now()}`,
            teammateId: teammateId ?? teammate!.id,
            text: draft.text,
            uploads: files.take().uploads,
            effort: draft.effort,
            projectId: draft.projectId,
            computerId: draft.computerId,
            accountId: draft.accountId,
          }
        : undefined
    draft.setText(message.text)
    draft.setEffort(message.effort)
    draft.setProjectId(message.projectId)
    draft.setComputerId(message.computerId)
    draft.setAccountId(message.accountId)
    files.put(message.uploads)
    if (teammates.some((t) => t.id === message.teammateId)) chooseTeammate(message.teammateId)
    keptMessages.drop(message.key)
    if (held) keptMessages.keep(held)
    setStarted(undefined)
    onOpenChange(true)
  }
  // A thread opened at once elsewhere did not start: Edit message there brings it here.
  const takeUp = useRef(backToMessage)
  takeUp.current = backToMessage
  useEffect(() => keptMessages.handle((message) => takeUp.current(message)), [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Taken already: the terminal, the remote desktop.
      if (e.defaultPrevented || e.repeat) return
      // ⌘K alone is search.
      const command = isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      const shortcut = command && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k'
      // Not over another dialog.
      if (
        !shortcut ||
        document.querySelector('[role=dialog][data-state=open]:not([data-quick-thread])')
      )
        return
      e.preventDefault()
      onOpenChange(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // The note that it started fades on its own; one that it is starting, or failed, stays.
  useEffect(() => {
    if (!started?.id) return
    const timer = setTimeout(() => setStarted(undefined), 6000)
    return () => clearTimeout(timer)
  }, [started])

  if (!teammate) return null
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          data-quick-thread
          showCloseButton={false}
          className="top-[20%] translate-y-0 gap-0 p-0 sm:max-w-2xl"
          // Not the first button: the message box focuses itself once its editor is up.
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <DialogTitle className="sr-only">New thread</DialogTitle>
          <DialogDescription className="sr-only">
            Send a message to a teammate. It runs in the background.
          </DialogDescription>
          <NewThread
            layout="dialog"
            teammate={teammate}
            rows={4}
            draft={draft}
            autoFocus
            picker={
              teammates.length > 1
                ? { teammates, onChange: chooseTeammate, numbered: true }
                : undefined
            }
            placeholder={`Chat with ${teammate.name}`}
            onSending={(thread, sent) => {
              const send = ++last.current
              const name = teammate.name
              onOpenChange(false)
              setStarted({ teammate: name })
              thread.then(
                ({ id }) => {
                  if (send === last.current) setStarted({ id, teammate: name })
                },
                (error: Error) => {
                  if (send === last.current) setStarted(undefined)
                  keptMessages.keep({ ...sent, key: `quick-${send}`, error: error.message })
                },
              )
            }}
          />
        </DialogContent>
      </Dialog>
      {/* Centered: the threads panel's reply box is in the corner. */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex justify-center"
      >
        {kept ? (
          <div className="pointer-events-auto flex items-center gap-3 rounded-xl border bg-card py-2 pr-2 pl-3 text-sm shadow-lg animate-in fade-in-0 slide-in-from-bottom-2">
            {kept.error && (
              <CircleAlert className="size-4 shrink-0 text-destructive-text" aria-hidden />
            )}
            <span>
              {kept.error ? `Not started: ${kept.error}` : 'Your other message is kept aside'}
            </span>
            <Button
              size="sm"
              variant="outline"
              // A file still uploading in the box would lose its upload on the way aside.
              disabled={draft.files.busy}
              tooltip={draft.files.busy ? 'Once the files in the box have uploaded' : undefined}
              onClick={() => backToMessage(kept)}
            >
              {kept.error ? 'Back to message' : 'Back to it'}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Dismiss"
              tooltip="Dismiss: the message is gone"
              onClick={() => keptMessages.drop(kept.key)}
            >
              <X aria-hidden />
            </Button>
          </div>
        ) : (
          started && (
            <div className="pointer-events-auto flex items-center gap-3 rounded-xl border bg-card py-2 pr-2 pl-3 text-sm shadow-lg animate-in fade-in-0 slide-in-from-bottom-2">
              <CircleCheck
                className={cn('size-4 shrink-0 text-success', !started.id && 'opacity-50')}
                aria-hidden
              />
              <span>
                {started.id
                  ? `Thread started with ${started.teammate}`
                  : `Starting thread with ${started.teammate}…`}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={!started.id}
                onClick={() => {
                  if (started.id) openThread(started.id)
                  setStarted(undefined)
                }}
              >
                Open
                <ArrowRight aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Dismiss"
                onClick={() => setStarted(undefined)}
              >
                <X aria-hidden />
              </Button>
            </div>
          )
        )}
      </div>
    </>
  )
}
