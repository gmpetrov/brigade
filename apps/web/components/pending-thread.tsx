'use client'
// A thread opened before it exists (lib/pending-threads.ts): the message sent, and its teammate
// starting up, in the column its conversation will fill. Should it not start, it says why, and
// Edit message takes the message back to the box it was sent from.
import { Paperclip } from 'lucide-react'
import { useRouter } from 'next/navigation'
import type { ReactNode } from 'react'
import { Answering, MessageBubble } from '@/components/thread-view'
import { Button } from '@/components/ui/button'
import { pendingThreads, type PendingThread as Pending } from '@/lib/pending-threads'
import { cn } from '@/lib/utils'

export function PendingThread({
  id,
  thread,
  expanded,
  top,
}: {
  id: string
  thread: Pending
  expanded: boolean
  top?: ReactNode
}) {
  const router = useRouter()
  // The conversation's column (ThreadConversation's).
  const column = cn('mx-auto w-full', expanded ? 'max-w-5xl px-4 md:px-10' : 'px-4')
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {top}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn(column, top ? 'pt-16' : expanded ? 'pt-6 md:pt-8' : 'pt-4', 'pb-12')}>
          <div className="flex flex-col gap-4">
            <div className="flex max-w-[85%] flex-col items-end gap-1.5 self-end">
              {thread.text && <MessageBubble text={thread.text} />}
              {thread.files.length > 0 && (
                <div className="flex flex-wrap justify-end gap-1.5">
                  {thread.files.map((name, i) => (
                    <span
                      key={i}
                      className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground"
                    >
                      <Paperclip className="size-3" aria-hidden />
                      {name}
                    </span>
                  ))}
                </div>
              )}
            </div>
            {thread.error ? (
              <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
                <span className="text-destructive-text">Not started: {thread.error}</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const from = pendingThreads.giveBack(id)
                    if (from) router.push(from)
                  }}
                >
                  Edit message
                </Button>
              </div>
            ) : (
              <Answering teammate={thread.teammate} phase="starting" />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
