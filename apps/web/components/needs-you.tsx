'use client'
// Home's "waiting on you": one ticket, pull request, failed thread or failing routine at a time,
// with the card that decides it, the same as in its thread, so a person with enough context
// answers without opening it.
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
import { ArrowUpRight, Check, ChevronLeft, ChevronRight } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { TeammateAvatar, useDashboard } from '@/components/dashboard'
import { PlaybookApprovals } from '@/components/playbook-approvals'
import { PullCard } from '@/components/pull-card'
import { QuestionCard, TicketCard, type TicketTakeover } from '@/components/thread-view'
import { useThreadPanel } from '@/components/thread-panel'
import { TicketRow } from '@/components/ticket-row'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Hint } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  api,
  waitingItemKey,
  type FailedThread,
  type FailingRoutine,
  type PullWaiting,
  type Ticket,
} from '@/lib/api'
import type { EditedEmail } from '@/components/email-cards'

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
            className="min-w-0 truncate underline-offset-4 hover:text-foreground hover:underline"
          >
            {thread.title}
          </Link>
        </>
      )}
      {note && (
        <>
          {(teammate || thread) && <span aria-hidden>·</span>}
          {/* Shrinks with the title, so a long note never widens the page on a phone. */}
          <span className="min-w-0 truncate" title={note}>
            {note}
          </span>
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
  const { me, teammates } = useDashboard()
  const { showComputer } = useThreadPanel()
  const session = t.session!
  const asker = t.payload.teammateId ?? session.teammate.id
  // Something to do in the teammate's browser: taken over from here as in the thread, on the
  // cloud computer unless another member has control; doing it opens the thread's computer.
  const controller = session.controlledByMemberId
  const takeover: TicketTakeover | undefined =
    session.computer?.kind === 'cloud' && me.memberId && (!controller || controller === me.memberId)
      ? {
          mine: controller === me.memberId,
          open: async () => {
            if (controller !== me.memberId)
              await api(`/threads/${session.id}/takeover`, { body: { interrupt: false } })
            showComputer(session.id)
          },
        }
      : undefined
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
        takeover={takeover}
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

/**
 * One thing waiting: a ticket answered here, a ticket's row, a playbook's approvals, a pull
 * request, a failed thread or a failing routine.
 */
type Waiting = { key: string; title: string; from?: string } & (
  | { ticket: Ticket; pull?: undefined; queue?: undefined; failed?: undefined; routine?: undefined }
  | {
      ticket?: undefined
      pull: PullWaiting
      queue?: undefined
      failed?: undefined
      routine?: undefined
    }
  | { ticket?: undefined; pull?: undefined; queue: Queue; failed?: undefined; routine?: undefined }
  | {
      ticket?: undefined
      pull?: undefined
      queue?: undefined
      failed: FailedThread
      routine?: undefined
    }
  | {
      ticket?: undefined
      pull?: undefined
      queue?: undefined
      failed?: undefined
      routine: FailingRoutine
    }
)

/**
 * A failure as one card: what it said, where to look, and the button that starts it again: Try
 * again on the turn that failed, as in its thread, or Run now for a routine that could not start.
 */
function FailureCard({
  error,
  href,
  again,
  onDone,
}: {
  error: string | null
  href: string
  /** Its button and what it calls; none for a thread that never ran (nothing to try again). */
  again: { label: string; path: string; done: string } | null
  onDone: (sent: string) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string>()
  return (
    <Card className="flex-row flex-wrap items-center gap-3 px-4 py-3">
      <p className="min-w-0 flex-1 text-sm">
        <span className="line-clamp-2 wrap-anywhere text-destructive-text">
          {failed ?? error ?? 'It stopped on an error.'}
        </span>
      </p>
      <div className="flex flex-none items-center gap-2">
        <Button variant="outline" size="sm" asChild>
          <Link href={href}>Open</Link>
        </Button>
        {again && (
          <Button
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setFailed(undefined)
              try {
                await api(again.path, { body: {} })
                await onDone(again.done)
              } catch (e) {
                setFailed(e instanceof Error ? e.message : String(e))
                setBusy(false)
              }
            }}
          >
            {again.label}
          </Button>
        )}
      </div>
    </Card>
  )
}

/**
 * Shown in place of the one just answered, until the person moves on: what was done, to
 * what, and its thread, to follow the teammate picking up.
 */
type Sent = { label: string; title: string; thread?: string; next: string | undefined }

/** What was done, then the item's title, a link to its thread when it has one. */
function SentLine({ sent }: { sent: Sent }) {
  return (
    <p className="flex min-w-0 flex-1 items-center gap-2 text-sm">
      <Check className="size-4 flex-none text-success" aria-hidden />
      <span className="flex-none font-semibold">{sent.label}</span>
      <span aria-hidden className="flex-none text-muted-foreground">
        ·
      </span>
      {sent.thread ? (
        <Hint label="Open thread">
          <Link
            href={`/app/threads/${sent.thread}`}
            className="group flex min-w-0 items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            <span className="truncate underline decoration-muted-foreground/50 underline-offset-4 group-hover:decoration-foreground">
              {sent.title}
            </span>
            <ArrowUpRight className="size-3.5 flex-none" aria-hidden />
          </Link>
        </Hint>
      ) : (
        <span className="min-w-0 truncate text-muted-foreground">{sent.title}</span>
      )}
    </p>
  )
}

export function NeedsYou({
  tickets,
  pulls,
  failed,
  onChange,
}: {
  /** Open tickets waiting on this member. */
  tickets: Ticket[]
  pulls: PullWaiting[]
  /** Failed threads and routines waiting on this member (failuresWaiting). */
  failed: { threads: FailedThread[]; routines: FailingRoutine[] }
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
    ...failed.threads.map((t) => ({
      key: `failed:${t.id}`,
      title: t.title,
      from: t.teammate.name,
      failed: t,
    })),
    ...failed.routines.map((r) => ({
      key: `routine:${r.scheduleId}`,
      title: r.title,
      from: 'Routine',
      routine: r,
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
    setSent({
      label,
      // A playbook's approvals by its name, not how many were left.
      title: current?.queue?.name ?? current?.title ?? '',
      thread:
        current?.ticket?.session?.id ??
        current?.pull?.session?.id ??
        current?.failed?.id ??
        current?.routine?.runId ??
        undefined,
      next: (items[index + 1] ?? items[index - 1])?.key,
    })
    await onChange()
  }

  async function resolve(id: string, approved: boolean, always?: boolean, edited?: EditedEmail) {
    setError(undefined)
    try {
      await api(`/tickets/${id}/resolve`, {
        body: { approved, ...(always ? { always } : {}), ...(edited ? { edited } : {}) },
      })
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
        : t?.payload.triggerAction
          ? approved
            ? 'Trigger added'
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

  // The last one decided: one calm line, no yellow. The line under Home's greeting
  // already says nothing else is waiting.
  if (sent && items.length === 0)
    return (
      <div role="status" className="flex rounded-2xl border px-4 py-3 sm:px-5">
        <SentLine sent={sent} />
      </div>
    )

  const others = sent ? items : items.filter((i) => i.key !== current?.key)
  const listed = others.slice(0, LISTED)
  const rest = others.slice(LISTED)
  const moreTickets = rest.filter((i) => i.ticket || i.queue).length
  const morePulls = rest.filter((i) => i.pull).length
  const moreFailed = rest.length - moreTickets - morePulls

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
        <Card role="status" className="flex-row items-center gap-3 px-4 py-2.5">
          <SentLine sent={sent} />
          <Button
            className="flex-none"
            size="sm"
            onClick={() => go(items.some((i) => i.key === sent.next) ? sent.next : items[0]?.key)}
          >
            Next
            <ChevronRight aria-hidden />
          </Button>
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
      ) : current?.failed ? (
        <div className="flex flex-col gap-1.5">
          <From teammate={current.failed.teammate} thread={current.failed} note="failed" />
          <FailureCard
            key={current.key}
            error={current.failed.error}
            href={`/app/threads/${current.failed.id}`}
            again={
              // Never ran (its computer was offline): no turn to try again, a message starts it.
              current.failed.error
                ? {
                    label: 'Try again',
                    path: `/threads/${current.failed.id}/retry`,
                    done: 'Tried again',
                  }
                : null
            }
            onDone={done}
          />
        </div>
      ) : current?.routine ? (
        <div className="flex flex-col gap-1.5">
          <From
            note={`Routine ${current.routine.title} · ${
              current.routine.couldNotStart ? "couldn't start" : 'last run failed'
            }`}
          />
          <FailureCard
            key={current.key}
            error={current.routine.error}
            href={current.routine.runId ? `/app/threads/${current.routine.runId}` : '/app/routines'}
            again={
              current.routine.couldNotStart
                ? {
                    label: 'Run now',
                    path: `/schedules/${current.routine.scheduleId}/run`,
                    done: 'Started',
                  }
                : current.routine.runId && current.routine.error
                  ? {
                      label: 'Try again',
                      path: `/threads/${current.routine.runId}/retry`,
                      done: 'Tried again',
                    }
                  : null
            }
            onDone={done}
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
                <span
                  aria-hidden
                  className={cn(
                    'size-1.5 flex-none rounded-full',
                    i.failed || i.routine ? 'bg-destructive' : 'bg-warning',
                  )}
                />
                <span className="truncate text-foreground">{i.title}</span>
                {i.from && <span className="flex-none text-xs">· {i.from}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {rest.length > 0 && (
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
          {/* Failed ones have no page of their own: the arrows above go through them. */}
          {moreFailed > 0 && (
            <span className="text-muted-foreground">{moreFailed} more failed</span>
          )}
        </p>
      )}
    </section>
  )
}
