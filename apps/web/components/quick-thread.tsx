'use client'
// Start a thread from anywhere: ⌘⇧K (Ctrl+Shift+K) opens the home page's box in a
// dialog. What is written there is held here, not in the dialog, so closing it
// by mistake loses nothing; sending closes it and says so in the corner.
import { ArrowRight, CircleCheck, X } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useDashboard } from '@/components/dashboard'
import { NewThread, useLastTeammate, useThreadDraft } from '@/components/new-thread'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** Whether shortcuts read ⌘ or Ctrl here; ⌘ until the browser says otherwise. */
export function useIsMac() {
  const [mac, setMac] = useState(true)
  useEffect(() => setMac(isMac()), [])
  return mac
}

/** Straight into the message, at its end; the editor may take a frame to appear. */
function focusMessage(root: HTMLElement | null, tries = 10) {
  const editor = root?.querySelector<HTMLElement>('[contenteditable=true]')
  if (!editor) {
    if (root && tries > 0) requestAnimationFrame(() => focusMessage(root, tries - 1))
    return
  }
  editor.focus()
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.collapse(false)
  getSelection()?.removeAllRanges()
  getSelection()?.addRange(range)
}

export function QuickThread() {
  const [open, onOpenChange] = useState(false)
  const { teammates } = useDashboard()
  const [chosen, choose] = useLastTeammate()
  const teammate = teammates.find((t) => t.id === chosen) ?? teammates[0]
  const draft = useThreadDraft()
  const [started, setStarted] = useState<{ id: string; teammate: string }>()
  const content = useRef<HTMLDivElement>(null)

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
          ref={content}
          data-quick-thread
          showCloseButton={false}
          className="top-[20%] translate-y-0 gap-3 p-3 sm:max-w-2xl"
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            focusMessage(content.current)
          }}
        >
          <DialogTitle className="sr-only">New thread</DialogTitle>
          <DialogDescription className="sr-only">
            Send a message to a teammate. It runs in the background.
          </DialogDescription>
          <NewThread
            teammate={teammate}
            rows={4}
            draft={draft}
            picker={teammates.length > 1 ? { teammates, onChange: choose } : undefined}
            placeholder={`Ask ${teammate.name} to… @ to bring in another teammate, a repository, connection or credential`}
            onStarted={(thread) => {
              onOpenChange(false)
              setStarted({ id: thread.id, teammate: teammate.name })
            }}
          />
        </DialogContent>
      </Dialog>
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-4 z-50 flex justify-end"
      >
        {started && (
          <div className="pointer-events-auto flex items-center gap-3 rounded-xl border bg-card py-2 pr-2 pl-3 text-sm shadow-lg animate-in fade-in-0 slide-in-from-bottom-2">
            <CircleCheck className="size-4 shrink-0 text-success" aria-hidden />
            <span>Thread started with {started.teammate}</span>
            <Button asChild size="sm" variant="outline" onClick={() => setStarted(undefined)}>
              <Link href={`/app/threads/${started.id}`}>
                Open
                <ArrowRight aria-hidden />
              </Link>
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
