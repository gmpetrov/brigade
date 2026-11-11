'use client'
import { Hand, Monitor } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { api, type Thread } from '@/lib/api'
import { changeControl, useControlError } from '@/lib/control'
import { savedReplies } from '@/lib/ticket-replies'

/** A note written for a hand back the API refused, while the dashboard is open. */
const notes = new Map<string, string>()

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
  // Handing back hides this card at once: undone, it comes back with its note and why.
  const [note, setNote] = useState(() => notes.get(thread.id) ?? '')
  const error = useControlError(thread.id)
  const mine = thread.controlledByMemberId === memberId

  function handBack() {
    notes.set(thread.id, note)
    void changeControl(thread.id, null, () =>
      api(`/threads/${thread.id}/handback`, { body: { note, replies: savedReplies() } }),
    ).then(
      () => {
        notes.delete(thread.id)
        onChange()
      },
      // Its error shows through useControlError.
      () => undefined,
    )
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
          handBack()
        }}
      >
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note for the teammate (optional)"
          aria-label="Note for the teammate"
          className="min-w-0 flex-[1_1_14rem]"
        />
        <Button>Hand back</Button>
      </form>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
    </Card>
  )
}
