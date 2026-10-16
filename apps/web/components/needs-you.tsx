'use client'
// Home's "waiting on you": each ticket and pull request with the card that decides it,
// the same as in its thread, so a person with enough context answers without opening it.
import type { Ask, Question, QuestionAnswer, TicketAnswer } from '@brigade/contracts'
import Link from 'next/link'
import { useState } from 'react'
import { TeammateAvatar, useDashboard } from '@/components/dashboard'
import { PullCard } from '@/components/pull-card'
import { QuestionCard, TicketCard } from '@/components/thread-view'
import { TicketRow } from '@/components/ticket-row'
import { Card } from '@/components/ui/card'
import { api, type Me, type PullWaiting, type Ticket } from '@/lib/api'

/** Cards shown at once; the rest are a link away. */
const SHOWN = 5

/** Why a pull request waits on a person, by where its review stands. */
const PULL_WAITS: Record<string, string> = {
  none: 'ready for review',
  approved: 'approved, ready to merge',
  changes_requested: 'changes requested',
  stuck: 'review stopped',
}

/** Who asks and in which thread, above a card. */
function From({
  teammate,
  thread,
  note,
}: {
  teammate?: { id: string; name: string } | null
  thread?: { id: string; title: string } | null
  note?: string
}) {
  return (
    <p className="flex min-w-0 items-center gap-1.5 px-1 text-xs text-muted-foreground">
      {teammate && (
        <>
          <TeammateAvatar teammate={teammate} className="size-4 shrink-0 text-[0.5rem]" />
          <span className="shrink-0 font-semibold text-foreground">{teammate.name}</span>
        </>
      )}
      {thread && (
        <>
          {teammate && <span aria-hidden>·</span>}
          <Link
            href={`/app/threads/${thread.id}`}
            className="truncate underline-offset-4 hover:text-foreground hover:underline"
          >
            {thread.title}
          </Link>
        </>
      )}
      {note && (
        <>
          <span aria-hidden>·</span>
          <span className="shrink-0">{note}</span>
        </>
      )}
    </p>
  )
}

/** A ticket a teammate opened or a question it asked, answered as in its thread. */
function HarnessTicket({ ticket: t, onDone }: { ticket: Ticket; onDone: () => Promise<void> }) {
  const { teammates } = useDashboard()
  const session = t.session!
  const asker = t.payload.teammateId ?? session.teammate.id
  const askerName = teammates.find((m) => m.id === asker)?.name ?? session.teammate.name
  const from = <From teammate={{ id: asker, name: askerName }} thread={session} />

  if (t.type === 'question') {
    const questionId = t.payload.questionId!
    return (
      <div className="flex flex-col gap-1.5">
        {from}
        <QuestionCard
          item={{
            kind: 'question',
            key: t.id,
            questionId,
            questions: t.payload.questions as Question[],
          }}
          canAnswer
          onAnswer={(answer: QuestionAnswer) =>
            api(`/threads/${session.id}/answers`, { body: { questionId, answer } }).then(onDone)
          }
        />
      </div>
    )
  }

  const requestId = t.payload.requestId!
  return (
    <div className="flex flex-col gap-1.5">
      {from}
      <TicketCard
        item={{
          kind: 'ticket',
          key: t.id,
          requestId,
          // Titles start with the teammate's name; it is shown just above.
          title: t.title.replace(`${askerName}: `, ''),
          asks: t.payload.asks as Ask[],
          teammateId: asker,
        }}
        canAnswer
        takeover={undefined}
        teammates={teammates}
        askerId={asker}
        askerName={askerName}
        onAnswer={(answer: TicketAnswer) =>
          api(`/threads/${session.id}/tickets`, { body: { requestId, answer } }).then(onDone)
        }
      />
    </div>
  )
}

/**
 * Answered here, by a member who may prompt its thread: a question, or a ticket unless one
 * of its asks is done in the teammate's browser, which takes over its computer from the thread.
 */
const answersHere = (t: Ticket, me: Me) =>
  t.payload.source === 'harness' &&
  !!t.session &&
  (t.session.startedByMemberId === me.memberId || !!t.session.othersMayPrompt) &&
  ((t.type === 'question' && !!t.payload.questions) ||
    (t.type === 'request' &&
      !!t.payload.asks &&
      !(t.payload.asks as Ask[]).some((a) => a.type === 'action' && a.browser)))

export function NeedsYou({
  tickets,
  pulls,
  onChange,
}: {
  /** Open tickets waiting on this member. */
  tickets: Ticket[]
  pulls: PullWaiting[]
  onChange: () => Promise<void>
}) {
  const { me } = useDashboard()
  const [error, setError] = useState<string>()

  async function resolve(id: string, approved: boolean, always?: boolean) {
    setError(undefined)
    try {
      await api(`/tickets/${id}/resolve`, { body: { approved, ...(always ? { always } : {}) } })
    } catch (e) {
      setError((e as Error).message)
    }
    await onChange()
  }

  if (tickets.length === 0 && pulls.length === 0)
    return (
      <p className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
        <span aria-hidden className="size-1.5 rounded-full bg-success" />
        Nothing is waiting on you.
      </p>
    )

  const shownTickets = tickets.slice(0, SHOWN)
  const shownPulls = pulls.slice(0, Math.max(0, SHOWN - shownTickets.length))
  // Approvals, caps and logins keep their row, which has their buttons.
  const rows = shownTickets.filter((t) => !answersHere(t, me))
  const moreTickets = tickets.length - shownTickets.length
  const morePulls = pulls.length - shownPulls.length

  return (
    <section aria-labelledby="needs-you" className="flex flex-col gap-3">
      <h2 id="needs-you" className="flex items-baseline gap-2 text-lg font-bold">
        Waiting on you
        <span className="text-sm font-medium text-muted-foreground">
          {tickets.length + pulls.length}
        </span>
      </h2>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      {shownTickets
        .filter((t) => answersHere(t, me))
        .map((t) => (
          <HarnessTicket key={t.id} ticket={t} onDone={onChange} />
        ))}
      {rows.length > 0 && (
        <Card className="gap-0 overflow-hidden py-0">
          <ul className="divide-y">
            {rows.map((t) => (
              <TicketRow key={t.id} ticket={t} me={me} onResolve={resolve} />
            ))}
          </ul>
        </Card>
      )}
      {shownPulls.map((p) => (
        <div key={`${p.repository}#${p.number}`} className="flex flex-col gap-1.5">
          <From teammate={p.authorTeammate} thread={p.session} note={PULL_WAITS[p.reviewStatus]} />
          <PullCard repository={p.repository} number={p.number} title={p.title} />
        </div>
      ))}
      {(moreTickets > 0 || morePulls > 0) && (
        <p className="flex flex-wrap gap-x-4 px-1 text-sm">
          {moreTickets > 0 && (
            <Link href="/app/tickets" className="font-medium text-primary hover:underline">
              {moreTickets} more {moreTickets === 1 ? 'ticket' : 'tickets'}
            </Link>
          )}
          {morePulls > 0 && (
            <Link href="/app/pulls" className="font-medium text-primary hover:underline">
              {morePulls} more pull {morePulls === 1 ? 'request' : 'requests'}
            </Link>
          )}
        </p>
      )}
    </section>
  )
}
