'use client'
import { Hand, Monitor } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { api, type Thread } from '@/lib/api'

/** While a member has the workspace computer for a thread: hand back. Takeover starts in the computer panel. */
export function Takeover({
  thread,
  memberId,
  onChange,
  onOpenComputer,
}: {
  thread: Thread
  memberId: string
  onChange: () => void
  /** Show the computer panel, when it is closed. */
  onOpenComputer?: () => void
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

  if (!mine) return null

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
        {onOpenComputer && (
          <Button variant="outline" size="sm" onClick={onOpenComputer}>
            <Monitor aria-hidden />
            Show computer
          </Button>
        )}
      </div>
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
