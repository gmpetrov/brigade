'use client'
// Messages a person wrote during its teammate's turn and answered on the side (message.side):
// together, one Aside, in the thread's own card. Each is the person's message in a pale bubble,
// the teammate's reply from a copy of its conversation, and what became of the message, with how
// to change it. Open while the turn runs; after it, one line that opens it. docs/side-replies.md.
import { ChevronDown, Clock, CornerDownRight, Ellipsis, ListPlus } from 'lucide-react'
import { useState } from 'react'
import { TeammateAvatar } from '@/components/dashboard'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Hint } from '@/components/ui/tooltip'

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

export type SideAction = 'keep' | 'queue' | 'steer'

/** Still moving: its reply is coming, or it is about to go into the turn. */
const unsettled = (side: SideState) =>
  side.status === 'answering' || (side.route === 'steer' && !side.steered)

/**
 * The asides of one turn, in a row. While that turn runs they show open, under who answers;
 * after it, "Aside · 2 messages" folds them, as "Worked for" folds the turn's work.
 */
export function AsideGroup({
  sides,
  teammate,
  live,
  children,
}: {
  sides: SideState[]
  teammate?: { id: string; name: string }
  /** The turn they were written during still runs. */
  live: boolean
  children: React.ReactNode
}) {
  const [toggled, setToggled] = useState<boolean>()
  const open = live || sides.some(unsettled) || !!toggled
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
            {teammate && <TeammateAvatar teammate={teammate} className="size-5 flex-none" />}
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
      <CollapsibleTrigger className="group flex items-center gap-1.5 self-start text-left text-sm text-muted-foreground hover:text-foreground">
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

/** The teammate's reply to one message of an aside, what became of the message, and how to change it. */
export function SideReply({
  side,
  teammate,
  working,
  mayChange,
  onAction,
}: {
  side: SideState
  teammate?: { id: string; name: string }
  /** The teammate's turn still runs: a message can still go into it. */
  working: boolean
  /** The person wrote it: they may keep it for later, or have it run after all. */
  mayChange: boolean
  /** Unset when they cannot write in the thread. */
  onAction?: (action: SideAction) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const act = (action: SideAction) => {
    if (!onAction) return
    setBusy(true)
    void onAction(action).finally(() => setBusy(false))
  }
  const name = teammate?.name ?? 'The teammate'
  const pending = side.route === 'steer' && !side.steered
  if (side.status === 'answering')
    return (
      <p className="flex items-center gap-1 py-1.5" aria-label="Answering on the side">
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            className="size-1.5 animate-pulse rounded-full bg-muted-foreground/60"
            style={{ animationDelay: `${delay}ms` }}
            aria-hidden
          />
        ))}
      </p>
    )
  const caption = 'flex items-center gap-1.5 text-xs text-muted-foreground'
  const changeable = side.status === 'answered' && side.route === 'answer' && onAction
  return (
    <div className="group/side flex min-w-0 flex-col gap-1">
      {side.text && (
        <div className="flex min-w-0 items-start gap-1">
          <div className="min-w-0 flex-1 pr-[10%]">
            <Markdown text={side.text} />
          </div>
          {changeable && (working || mayChange) && (
            <DropdownMenu>
              <Hint label="More">
                <DropdownMenuTrigger
                  aria-label="More actions"
                  disabled={busy}
                  className="-mr-2 flex size-6 flex-none items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/side:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100 [&>svg]:size-4"
                >
                  <Ellipsis aria-hidden />
                </DropdownMenuTrigger>
              </Hint>
              <DropdownMenuContent align="end" className="min-w-52">
                {working && (
                  <Hint side="left" label={`Give it to ${name} now, during this turn`}>
                    <DropdownMenuItem onSelect={() => act('steer')}>
                      <CornerDownRight aria-hidden />
                      Steer
                    </DropdownMenuItem>
                  </Hint>
                )}
                {mayChange && (
                  <Hint side="left" label={`${name} answers it in a turn of its own`}>
                    <DropdownMenuItem onSelect={() => act('queue')}>
                      <ListPlus aria-hidden />
                      {working ? 'Queue for after this turn' : 'Run in its own turn'}
                    </DropdownMenuItem>
                  </Hint>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
      {side.steered ? (
        <p className={caption}>
          <CornerDownRight className="size-3 flex-none" aria-hidden />
          Given to the current turn
        </p>
      ) : pending ? (
        <div className={caption}>
          <CornerDownRight className="size-3 flex-none" aria-hidden />
          Giving to the current turn
          {mayChange && onAction && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => act('keep')}
              tooltip="Keep it for after this turn instead"
              className="text-foreground"
            >
              Undo
            </Button>
          )}
        </div>
      ) : side.route === 'queue' ? (
        <p className={caption}>
          <Clock className="size-3 flex-none" aria-hidden />
          Queued for after this turn
        </p>
      ) : null}
    </div>
  )
}
