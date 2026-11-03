'use client'
// A turn's asides together (side-reply.tsx): open while the turn runs, one line once it ends.
// docs/side-replies.md.
import { ChevronDown } from 'lucide-react'
import { useLayoutEffect, useState } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Hint } from '@/components/ui/tooltip'
import { onRevealSeq } from '@/lib/reveal'

/** A message answered on the side: its latest state (message.side), and whether it went into the turn. */
export type SideState = {
  messageId: string
  status: 'answering' | 'answered' | 'failed'
  teammateId?: string
  text?: string
  route?: 'answer' | 'steer' | 'queue'
  /** With route steer: when it goes into the running turn, unless its sender keeps it. */
  steerAt?: string
  /** It went into the running turn (message.user, steered). */
  steered?: boolean
}

/** Still moving: its reply is coming, or it is about to go into the turn. */
const unsettled = (side: SideState) =>
  side.status === 'answering' || (side.route === 'steer' && !side.steered)

/**
 * The asides of one turn, in a row. While that turn runs they show open, under who answers;
 * after it, "Aside · 2 messages" folds them, as "Worked for" folds the turn's work. Folded, the
 * line stands for each message (its `data-seq`), so a reply's quote or the timeline still finds
 * it there, and going to one opens the line (revealSeq).
 */
export function AsideGroup({
  sides,
  seqs,
  teammate,
  avatar,
  live,
  children,
}: {
  sides: SideState[]
  /** Its messages' seqs, as the thread marks them (`data-seq`). */
  seqs: number[]
  teammate?: { name: string }
  /** Who answers, by its avatar. */
  avatar?: React.ReactNode
  /** The turn they were written during still runs. */
  live: boolean
  children: React.ReactNode
}) {
  const [toggled, setToggled] = useState<boolean>()
  const open = live || sides.some(unsettled) || !!toggled
  const key = seqs.join(' ')
  // Before the thread's own layout effects: going to a message of a page just loaded asks
  // in the same commit that mounts this.
  useLayoutEffect(() => {
    const mine = new Set(key.split(' ').map(Number))
    return onRevealSeq((seq) => {
      if (mine.has(seq)) setToggled(true)
    })
  }, [key])
  const card = (
    <div
      aria-label="Aside"
      className="flex max-w-xl min-w-0 flex-col gap-3 rounded-xl border bg-card px-4 py-3 text-sm"
    >
      {live && (
        <Hint
          label={`${teammate?.name ?? 'The teammate'} answers from a copy of its conversation, without stopping its turn`}
        >
          <p className="flex items-center gap-2 self-start text-xs text-muted-foreground">
            {avatar}
            <span className="font-semibold text-foreground">Aside</span>
            {teammate && <span>while {teammate.name} works</span>}
          </p>
        </Hint>
      )}
      {children}
    </div>
  )
  if (live) return card
  return (
    <Collapsible open={open} onOpenChange={setToggled} className="flex flex-col gap-2">
      <CollapsibleTrigger className="group relative flex items-center gap-1.5 self-start text-left text-sm text-muted-foreground hover:text-foreground">
        {/* Folded: where its messages are. */}
        {!open &&
          seqs.map((seq) => (
            <span key={seq} data-seq={seq} className="absolute inset-x-0 top-0" aria-hidden />
          ))}
        <span className="text-foreground">Aside</span>·{' '}
        {sides.length === 1 ? '1 message' : `${sides.length} messages`}
        <ChevronDown
          className="size-3.5 transition-transform group-data-[state=open]:rotate-180"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent>{card}</CollapsibleContent>
    </Collapsible>
  )
}
