'use client'
// A person's message answered on the side during its teammate's turn (message.side): under its
// bubble, the teammate's reply from a copy of its conversation, marked Aside, with what became of
// the message and how to change it. docs/side-replies.md.
import { Clock, CornerDownRight, Ellipsis, ListPlus } from 'lucide-react'
import { useState } from 'react'
import { TeammateAvatar } from '@/components/dashboard'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
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

const chip = 'inline-flex items-center gap-1 rounded-md border px-1.5 text-xs leading-[18px]'

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
  return (
    <div className="ml-4 flex min-w-0 items-start gap-2.5 border-l-2 pl-3" aria-label="Aside">
      {teammate && <TeammateAvatar teammate={teammate} className="mt-0.5 size-6 flex-none" />}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">{name}</span>
          <Hint
            label={`${name} answers from a copy of its conversation, without stopping its turn`}
          >
            <span className={chip}>Aside</span>
          </Hint>
          {side.status === 'answered' && side.route === 'answer' && onAction && (
            <DropdownMenu>
              <Hint label="More">
                <DropdownMenuTrigger
                  aria-label="More actions"
                  disabled={busy}
                  className="ml-auto flex size-6 items-center justify-center rounded-md outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent [&>svg]:size-4"
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
        {side.status === 'answering' ? (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden />
            Answering on the side
          </p>
        ) : (
          <>
            {side.text && (
              <div className="text-sm">
                <Markdown text={side.text} />
              </div>
            )}
            {side.steered ? (
              <span className={`${chip} self-start text-muted-foreground`}>
                <CornerDownRight className="size-3" aria-hidden />
                Given to the current turn
              </span>
            ) : pending ? (
              <div className="flex items-center gap-2">
                <span className={`${chip} text-muted-foreground`}>
                  <CornerDownRight className="size-3" aria-hidden />
                  Giving to the current turn
                </span>
                {mayChange && onAction && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    onClick={() => act('keep')}
                    tooltip="Keep it for after this turn instead"
                  >
                    Undo
                  </Button>
                )}
              </div>
            ) : side.route === 'queue' ? (
              <span className={`${chip} self-start text-muted-foreground`}>
                <Clock className="size-3" aria-hidden />
                Queued for after this turn
              </span>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
