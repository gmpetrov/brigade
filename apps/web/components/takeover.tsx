'use client'
import { Hand, Monitor, Globe } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { api, openDesktop, type Thread } from '@/lib/api'
import { Terminal } from './terminal'

/** Take over the workspace computer for a thread, then hand back. */
export function Takeover({
  thread,
  memberId,
  onChange,
  onOpenDesktop,
}: {
  thread: Thread
  memberId: string
  onChange: () => void
  /** Show the desktop in this page. Without it, the desktop opens in a new tab. */
  onOpenDesktop?: () => void
}) {
  const [note, setNote] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const mine = thread.controlledByMemberId === memberId

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

  if (thread.computer.kind !== 'cloud') return null

  if (thread.controlledByMemberId && !mine) {
    return (
      <p className="text-sm text-muted-foreground">
        Another member has control of this thread. The teammate continues when they hand it back.
      </p>
    )
  }

  if (!mine) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-accent px-4 py-3">
        <Hand className="size-5 flex-none text-accent-foreground" aria-hidden />
        <span className="min-w-0 flex-[1_1_16rem] text-sm text-muted-foreground">
          Use the computer yourself. The teammate waits until you hand back.
        </span>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              void act(() => api(`/threads/${thread.id}/takeover`, { body: { interrupt: false } }))
            }
          >
            Take over
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void act(() => api(`/threads/${thread.id}/takeover`, { body: { interrupt: true } }))
            }
          >
            Take over now
          </Button>
        </div>
        {error && <p className="basis-full text-sm text-destructive-text">{error}</p>}
      </div>
    )
  }

  return (
    <Card className="gap-4 border-warning/50 px-5 py-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Hand className="size-5 flex-none text-warning" aria-hidden />
        <div className="min-w-0 flex-[1_1_16rem]">
          <strong className="font-semibold">You have control</strong>
          <p className="text-sm text-muted-foreground">
            {thread.teammate.name} waits. Commands you run are recorded in the run log.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                if (!onOpenDesktop)
                  return openDesktop(thread.computer.id, { teammateId: thread.teammate.id })
                await api(`/teammates/${thread.teammate.id}/browser`, { body: {} })
                onOpenDesktop()
              })
            }
          >
            <Globe aria-hidden />
            Open {thread.teammate.name}&apos;s browser
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              onOpenDesktop ? onOpenDesktop() : void act(() => openDesktop(thread.computer.id))
            }
          >
            <Monitor aria-hidden />
            Open desktop
          </Button>
        </div>
      </div>
      <Terminal sessionId={thread.id} />
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void act(() => api(`/threads/${thread.id}/handback`, { body: { note } }))
        }}
      >
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note for the teammate (optional)"
          aria-label="Note for the teammate"
          className="min-w-0 flex-[1_1_14rem]"
        />
        <Button disabled={busy}>Hand back</Button>
      </form>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
    </Card>
  )
}
