'use client'
import { ChevronRight } from 'lucide-react'
import Link from 'next/link'
import { isAdmin, timeAgo } from '@/components/dashboard'
import { StatusBadge, type StatusTone } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { pullHref, type Me, type Ticket } from '@/lib/api'

const typeLabel: Record<Ticket['type'], string> = {
  approval: 'approval',
  cap: 'reached cap',
  sign_in: 'expired login',
  usage_limit: 'out of usage',
  question: 'question',
  request: 'ticket',
}

const statusTone = (status: string): StatusTone =>
  status === 'approved'
    ? 'success'
    : status === 'denied'
      ? 'destructive'
      : status === 'open'
        ? 'warning'
        : 'neutral'

/** A collapsed block of raw detail (the pending message or a tool call's input). */
function Detail({ summary, children }: { summary: React.ReactNode; children: React.ReactNode }) {
  return (
    <Collapsible className="mt-2">
      <CollapsibleTrigger className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronRight
          className="size-4 transition-transform group-data-[state=open]:rotate-90"
          aria-hidden
        />
        {summary}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-2 max-h-80 overflow-auto rounded-md border bg-secondary p-3 font-mono text-xs whitespace-pre-wrap">
          {children}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** One ticket, with the actions its kind allows this member. */
export function TicketRow({
  ticket: t,
  me,
  onResolve,
}: {
  ticket: Ticket
  me: Me
  onResolve: (id: string, approved: boolean) => Promise<void>
}) {
  const admin = isAdmin(me)
  const starter = t.session?.startedByMemberId === me.memberId
  const open = t.status === 'open'
  const concerns = t.payload.memberId ? t.payload.memberId === me.memberId : starter

  let actions: React.ReactNode = null
  if (open && t.type === 'approval' && (admin || starter)) {
    actions = (
      <>
        <Button size="sm" onClick={() => void onResolve(t.id, true)}>
          Approve
        </Button>
        <Button size="sm" variant="outline" onClick={() => void onResolve(t.id, false)}>
          Deny
        </Button>
      </>
    )
  } else if (open && t.type === 'cap') {
    actions = admin ? (
      <>
        <Button size="sm" onClick={() => void onResolve(t.id, true)}>
          Allow once
        </Button>
        <Button size="sm" variant="outline" onClick={() => void onResolve(t.id, false)}>
          Deny
        </Button>
      </>
    ) : (
      <span className="text-sm text-muted-foreground">Waiting for an admin</span>
    )
  } else if (
    open &&
    (t.type === 'question' || t.type === 'request') &&
    t.payload.source === 'harness'
  ) {
    actions =
      admin || starter ? (
        <>
          {t.session && (
            <Button asChild size="sm">
              <Link href={`/app/threads/${t.session.id}`}>Answer in the thread</Link>
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => void onResolve(t.id, false)}>
            Decline
          </Button>
        </>
      ) : (
        <span className="text-sm text-muted-foreground">For the member who started the thread</span>
      )
  } else if (open && (admin || concerns)) {
    actions = (
      <>
        {t.type === 'sign_in' && (
          <Button asChild size="sm">
            <Link href="/app/accounts">Sign in</Link>
          </Button>
        )}
        {t.payload.pullRequest && (
          <Button asChild size="sm">
            <Link href={pullHref(t.payload.pullRequest.repository, t.payload.pullRequest.number)}>
              Open the pull request
            </Link>
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => void onResolve(t.id, true)}>
          Dismiss
        </Button>
      </>
    )
  }

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-[200px] flex-1">
          <div className="font-semibold">{t.title}</div>
          <div className="text-sm text-muted-foreground">
            {typeLabel[t.type]} · {timeAgo(t.createdAt)}
            {t.session && (
              <>
                {' · '}
                <Link
                  href={`/app/threads/${t.session.id}`}
                  className="underline-offset-4 hover:text-foreground hover:underline"
                >
                  {t.session.title}
                </Link>
                {t.session.origin === 'trigger' && ' (trigger)'}
              </>
            )}
            {t.type === 'usage_limit' && t.payload.resetsAt && (
              <> · resets {new Date(t.payload.resetsAt).toLocaleString()}</>
            )}
          </div>
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        ) : (
          <StatusBadge status={t.status} tone={statusTone(t.status)} />
        )}
      </div>
      {t.payload.reason && (
        <p className="mt-1.5 text-sm text-muted-foreground">{t.payload.reason}</p>
      )}
      {t.type === 'cap' && t.payload.pending && (
        <Detail summary="The message waiting to run">{t.payload.pending.text}</Detail>
      )}
      {t.type === 'cap' && admin && t.session && (
        <p className="mt-1.5 text-sm text-muted-foreground">
          Used {t.payload.used} of {t.payload.limit}.{' '}
          <Link
            href={`/app/teammates/${t.session.teammate.id}`}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Change the caps
          </Link>
        </p>
      )}
      {t.payload.input !== undefined && (
        <Detail
          summary={
            t.payload.source === 'harness'
              ? `${t.payload.toolName} (built-in tool)`
              : `${t.payload.operation} on ${t.payload.connection}: ${t.payload.target}`
          }
        >
          {typeof t.payload.input === 'string'
            ? t.payload.input
            : JSON.stringify(t.payload.input, null, 2)}
        </Detail>
      )}
    </li>
  )
}
