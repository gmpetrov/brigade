'use client'
// Home's "waiting on you": one ticket or pull request at a time, with the card that decides
// it, the same as in its thread, so a person with enough context answers without opening it.
// Answering stops on what was sent; the next one comes when they ask for it, so a ticket's
// second ask is never mistaken for another ticket. A playbook's approvals are one item,
// opened to decide each (PlaybookApprovals); a push about them opens Home on it (?approvals=).
import {
  playbookApprovalOf,
  toApprove,
  type Ask,
  type Question,
  type QuestionAnswer,
  type TicketAnswer,
} from '@brigade/contracts'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { TeammateAvatar, useDashboard } from '@/components/dashboard'
import { PlaybookApprovals } from '@/components/playbook-approvals'
import { PullCard } from '@/components/pull-card'
import { QuestionCard, TicketCard } from '@/components/thread-view'
import { TicketRow } from '@/components/ticket-row'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { api, waitingItemKey, type PullWaiting, type Ticket } from '@/lib/api'

/** Others listed under the one shown; the rest are a link away. */
const LISTED = 4

/** Why a pull request waits on a person: a merge that stopped, else where its review stands. */
function pullWaits(pull: PullWaiting) {
  if (pull.mergeStatus === 'stuck') return 'merge stopped'
  const review = pull.review
  switch (review?.state) {
    case 'approved':
      return `approved by ${review.reviewer?.name ?? 'a teammate'}, ready to merge`
    case 'changes_requested':
      return `${review.reviewer?.name ?? 'a teammate'} asked for changes`
    case 'skipped':
      return `ready to merge, no review: ${review.reason}`
  }
  return 'ready for review'
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
function HarnessTicket({
  ticket: t,
  onDone,
}: {
  ticket: Ticket
  /** Answered: what to say it did, before the next one. */
  onDone: (sent: string) => Promise<void>
}) {
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
            api(`/tickets/${t.id}/answer`, { body: { answer } }).then(() =>
              onDone(`Sent to ${askerName}`),
            )
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
          api(`/tickets/${t.id}/answer`, { body: { answer } }).then(() =>
            onDone(
              answer.action === 'declined' && !answer.note ? 'Declined' : `Sent to ${askerName}`,
            ),
          )
        }
      />
    </div>
  )
}

/**
 * Answered here: a question, or a ticket unless one of its asks is done in the teammate's
 * browser, which takes over its computer from the thread.
 */
const answersHere = (t: Ticket) =>
  t.payload.source === 'harness' &&
  !!t.session &&
  ((t.type === 'question' && !!t.payload.questions) ||
    (t.type === 'request' &&
      !!t.payload.asks &&
      !(t.payload.asks as Ask[]).some((a) => a.type === 'action' && a.browser)))

/** A ticket's title without the "Sam: " or "Sam asks: " it starts with. */
const withoutAsker = (title: string, name: string) =>
  [`${name}: `, `${name} asks: `].reduce(
    (t, prefix) => (t.startsWith(prefix) ? t.slice(prefix.length) : t),
    title,
  )

/** A playbook's approvals, as one item. */
type Queue = {
  id: string
  name: string
  count: number
  teammate: { id: string; name: string } | null
}

/** One thing waiting: a ticket answered here, a ticket's row, a playbook's approvals, or a pull request. */
type Waiting = { key: string; title: string; from?: string } & (
  | { ticket: Ticket; pull?: undefined; queue?: undefined }
  | { ticket?: undefined; pull: PullWaiting; queue?: undefined }
  | { ticket?: undefined; pull?: undefined; queue: Queue }
)

/** Shown in place of the one just answered, until the person moves on. */
type Sent = { label: string; next: string | undefined }

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
  const { me, teammates } = useDashboard()
  const [error, setError] = useState<string>()
  const [currentKey, setCurrentKey] = useState<string>()
  const [sent, setSent] = useState<Sent>()
  // Opened from a push about a playbook's approvals: those first.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('approvals')
    if (id) setCurrentKey(`playbook:${id}`)
  }, [])

  // A playbook's approvals, by the item they are together.
  const queues = new Map<string, Ticket[]>()
  for (const t of tickets) {
    if (!playbookApprovalOf(t)) continue
    const key = waitingItemKey(t)
    queues.set(key, [...(queues.get(key) ?? []), t])
  }

  const items: Waiting[] = [
    ...tickets.flatMap((t): Waiting[] => {
      const key = waitingItemKey(t)
      const queue = queues.get(key)
      if (queue) {
        // Once, where its latest approval would be.
        if (queue[0] !== t) return []
        const name = t.playbook?.name ?? 'Playbook'
        return [
          {
            key,
            title: `${name} · ${toApprove(t.playbook?.yours ?? queue.length)}`,
            from: t.session?.teammate.name,
            queue: {
              id: playbookApprovalOf(t)!.installationId,
              name,
              count: t.playbook?.yours ?? queue.length,
              teammate: t.session?.teammate ?? null,
            },
          },
        ]
      }
      const asker = t.payload.teammateId ?? t.session?.teammate.id
      const name = teammates.find((m) => m.id === asker)?.name ?? t.session?.teammate.name
      return [
        {
          key,
          // Titles start with the teammate's name, shown beside them.
          title: name ? withoutAsker(t.title, name) : t.title,
          from: name,
          ticket: t,
        },
      ]
    }),
    ...pulls.map((p) => ({
      key: `pull:${p.repository}#${p.number}`,
      title: p.title,
      from: p.authorTeammate?.name,
      pull: p,
    })),
  ]
  // One answered elsewhere drops out: the first one left takes its place.
  const index = Math.max(
    0,
    items.findIndex((i) => i.key === currentKey),
  )
  const current = items[index]

  /** The one shown was answered: say so, and remember which comes next. */
  async function done(label: string) {
    setSent({ label, next: (items[index + 1] ?? items[index - 1])?.key })
    await onChange()
  }

  async function resolve(id: string, approved: boolean, always?: boolean) {
    setError(undefined)
    try {
      await api(`/tickets/${id}/resolve`, { body: { approved, ...(always ? { always } : {}) } })
    } catch (e) {
      setError((e as Error).message)
      await onChange()
      return
    }
    // In the words of the button that was clicked.
    const t = tickets.find((x) => x.id === id)
    await done(
      t?.payload.skillAction
        ? approved
          ? 'Skill added'
          : 'Declined'
        : t?.payload.playbookActivation
          ? approved
            ? 'Activated'
            : 'Declined'
          : t?.payload.source === 'harness'
            ? 'Declined'
            : t?.type === 'sign_in' ||
                t?.type === 'usage_limit' ||
                t?.type === 'disk_full' ||
                t?.payload.pullRequest
              ? 'Dismissed'
              : approved
                ? 'Allowed'
                : 'Denied',
    )
  }

  function go(key: string | undefined) {
    setSent(undefined)
    setError(undefined)
    setCurrentKey(key)
  }

  // Nothing waiting: the line under Home's greeting says so.
  if (!current && !sent) return null

  const others = sent ? items : items.filter((i) => i.key !== current?.key)
  const listed = others.slice(0, LISTED)
  const moreTickets = others.slice(LISTED).filter((i) => !i.pull).length
  const morePulls = others.length - listed.length - moreTickets

  return (
    // Yellow, as needs-you is in the sidebar: what blocks a teammate comes first.
    <section
      aria-labelledby="needs-you"
      className="flex flex-col gap-3 rounded-2xl border border-warning/40 bg-warning/5 p-4 sm:p-5"
    >
      <div className="flex items-center gap-2">
        <h2 id="needs-you" className="flex items-center gap-2 text-lg font-bold">
          <span aria-hidden className="size-2 rounded-full bg-warning" />
          Waiting on you
        </h2>
        {items.length > 1 && !sent && (
          // Which one of how many: the card's own count is its asks.
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous"
              disabled={index === 0}
              onClick={() => go(items[index - 1]?.key)}
            >
              <ChevronLeft aria-hidden />
            </Button>
            <span className="text-sm font-semibold text-warning tabular-nums">
              {index + 1} of {items.length}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next"
              disabled={index === items.length - 1}
              onClick={() => go(items[index + 1]?.key)}
            >
              <ChevronRight aria-hidden />
            </Button>
          </div>
        )}
        {(items.length === 1 || sent) && items.length > 0 && (
          <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-semibold text-warning">
            {items.length}
          </span>
        )}
      </div>
      {error && <p className="text-sm text-destructive-text">{error}</p>}

      {sent ? (
        <Card className="items-center gap-3 px-5 py-6 text-center">
          <p className="flex items-center gap-2 font-semibold">
            <Check className="size-4 text-success" aria-hidden />
            {sent.label}
          </p>
          {items.length > 0 ? (
            <Button
              size="sm"
              onClick={() => go(items.some((i) => i.key === sent.next) ? sent.next : items[0]?.key)}
            >
              Next
              <ChevronRight aria-hidden />
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing else is waiting on you.</p>
          )}
        </Card>
      ) : current?.pull ? (
        <div className="flex flex-col gap-1.5">
          <From
            teammate={current.pull.authorTeammate}
            thread={current.pull.session}
            note={pullWaits(current.pull)}
          />
          <PullCard
            key={current.key}
            repository={current.pull.repository}
            number={current.pull.number}
            title={current.pull.title}
            open
          />
        </div>
      ) : current?.queue ? (
        <div className="flex flex-col gap-1.5">
          <From
            teammate={current.queue.teammate}
            note={`${current.queue.name} · ${toApprove(current.queue.count)}`}
          />
          <PlaybookApprovals
            key={current.key}
            installationId={current.queue.id}
            onDecided={onChange}
            onEmptied={done}
          />
        </div>
      ) : current?.ticket && answersHere(current.ticket) ? (
        <HarnessTicket key={current.key} ticket={current.ticket} onDone={done} />
      ) : current?.ticket ? (
        // Approvals, caps and logins keep their row, which has their buttons.
        <Card key={current.key} className="gap-0 overflow-hidden py-0">
          <ul>
            <TicketRow ticket={current.ticket} me={me} onResolve={resolve} />
          </ul>
        </Card>
      ) : null}

      {listed.length > 0 && (
        <ul className="flex flex-col">
          {listed.map((i) => (
            <li key={i.key}>
              <button
                type="button"
                onClick={() => go(i.key)}
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left text-sm text-muted-foreground hover:bg-warning/10 hover:text-foreground"
              >
                <span aria-hidden className="size-1.5 flex-none rounded-full bg-warning" />
                <span className="truncate text-foreground">{i.title}</span>
                {i.from && <span className="flex-none text-xs">· {i.from}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
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
