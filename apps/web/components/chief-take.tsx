'use client'
// Chief's take on a question a teammate ended its reply on (docs/chief-answers.md), under its
// buttons or choices while nobody answered: reading it, the answer it would pick (one click takes
// it), or why it leaves the question to the person. Its answers given on its own show where they
// reached the thread, as Brigade's note (brigade-notes.tsx). A quiet line, as folded work is.
import { chiefKindWords, type ChiefDecisionView } from '@brigade/contracts'
import { ChevronRight, Crown } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

/** The decision on the question shown at `seq`, while it shows something: none once answered. */
export const takeOn = (decisions: ChiefDecisionView[] | undefined, seq: number | undefined) =>
  seq === undefined
    ? undefined
    : decisions?.find(
        (d) =>
          d.askSeq === seq &&
          (d.status === 'pending' || d.status === 'suggested' || d.status === 'escalated'),
      )

export function ChiefTake({
  decision,
  open,
  onUse,
}: {
  decision: ChiefDecisionView
  /** Nobody answered the question yet: Chief's pick can still be taken. */
  open: boolean
  /** Sends Chief's pick as the person's message. Unset when they cannot (a design to pick on its card). */
  onUse?: (text: string) => Promise<void>
}) {
  const [sending, setSending] = useState(false)
  if (!open) return null
  if (decision.status === 'pending')
    return (
      <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Crown aria-hidden className="size-4 shrink-0" />
        <span className="text-shimmer">Chief is reading this for you</span>
      </div>
    )
  const option = decision.option
  const label =
    decision.status === 'suggested' && option
      ? `Chief would pick “${option.label}”`
      : decision.kind === 'taste' || decision.kind === 'outside'
        ? `Chief leaves this one to you, as ${chiefKindWords(decision.kind)}`
        : 'Chief leaves this one to you'
  const leaning = decision.status === 'escalated' && option ? `It leans to “${option.label}”.` : ''
  return (
    <Collapsible className="text-sm text-muted-foreground">
      <div className="flex min-w-0 items-center gap-2">
        <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-2 text-left hover:text-foreground">
          <Crown aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0 truncate font-medium">{label}</span>
          <ChevronRight
            aria-hidden
            className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-90"
          />
        </CollapsibleTrigger>
        {decision.status === 'suggested' && option && onUse && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0"
            disabled={sending}
            onClick={() => {
              setSending(true)
              void onUse(option.message).finally(() => setSending(false))
            }}
          >
            Use it
          </Button>
        )}
      </div>
      <CollapsibleContent className="mt-2 flex flex-col gap-1 border-l-2 pl-4 text-foreground">
        {decision.reason && <p>{decision.reason}</p>}
        {leaning && <p>{leaning}</p>}
        {decision.basis && (
          <p className="text-muted-foreground">From your mandate: {decision.basis}</p>
        )}
        {decision.childSessionId && (
          <Link
            href={`/app/threads/${decision.childSessionId}`}
            className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            How Chief read it
          </Link>
        )}
        <Link
          href="/app/preferences"
          className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          What Chief answers for you
        </Link>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Under an answer Chief gave in the person's name: they mark it wrong, and its teammate stops. */
export function MarkWrong({ onMark }: { onMark: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  return (
    <div className="flex flex-col gap-1">
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setError(undefined)
          void onMark()
            .catch((e: Error) => setError(e.message))
            .finally(() => setBusy(false))
        }}
      >
        Mark as wrong
      </Button>
      <p className="text-xs text-muted-foreground">
        Its teammate stops what it started on it, and Chief suggests this kind of question to you
        again.
      </p>
      {error && <p className="text-xs text-destructive-text">{error}</p>}
    </div>
  )
}
