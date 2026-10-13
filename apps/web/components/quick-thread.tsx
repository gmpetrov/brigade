'use client'
// Start a thread without leaving where you are: ⌘⇧K (Ctrl+Shift+K) opens the
// new-thread box in a dialog. It is the threads panel's box: the same draft and
// teammate, so closing it by mistake loses nothing. Sending closes it and says
// so in the corner; Open there shows the thread in the panel beside the page.
import { ArrowRight, CircleCheck, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useDashboard } from '@/components/dashboard'
import { NewThread } from '@/components/new-thread'
import { useThreadPanel } from '@/components/thread-panel'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { isMac } from '@/lib/platform'

export function QuickThread() {
  const [open, onOpenChange] = useState(false)
  const { teammates } = useDashboard()
  const { draft, teammateId, chooseTeammate, openThread, activity } = useThreadPanel()
  const teammate = teammates.find((t) => t.id === teammateId) ?? teammates[0]
  const [started, setStarted] = useState<{ id: string; teammate: string }>()

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

  // The note that it started fades on its own.
  useEffect(() => {
    if (!started) return
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
                ? { teammates, onChange: chooseTeammate, activity, numbered: true }
                : undefined
            }
            placeholder={`Ask ${teammate.name} to… @ to bring in another teammate, a repository, connection or secret`}
            onStarted={(thread) => {
              onOpenChange(false)
              setStarted({ id: thread.id, teammate: teammate.name })
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
        {started && (
          <div className="pointer-events-auto flex items-center gap-3 rounded-xl border bg-card py-2 pr-2 pl-3 text-sm shadow-lg animate-in fade-in-0 slide-in-from-bottom-2">
            <CircleCheck className="size-4 shrink-0 text-success" aria-hidden />
            <span>Thread started with {started.teammate}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                openThread(started.id)
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
        )}
      </div>
    </>
  )
}
