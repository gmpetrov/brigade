'use client'
import { Activity, KeyRound, Zap } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { StatusBadge, TeammateAvatar, timeAgo, useDashboard } from '@/components/dashboard'
import { Card } from '@/components/ui/card'
import type { ThreadSummary, Ticket } from '@/lib/api'

type Item = {
  key: string
  at: string
  teammate?: { id: string; name: string }
  verb: string
  title: string
  href: string
  status?: string
  /** Without a teammate: what the avatar shows instead. */
  icon?: 'account' | 'event'
}

const threadVerb: Record<string, string> = {
  starting: 'is starting on',
  running: 'is working on',
  waiting: 'is waiting for approval in',
  idle: 'replied in',
  paused: 'paused',
  failed: 'ran into a problem in',
  done: 'finished',
}

const ticketVerb: Record<Ticket['type'], string> = {
  approval: 'asked for approval:',
  question: 'asked a question:',
  request: 'opened a ticket:',
  cap: 'reached a daily cap:',
  sign_in: 'needs an account signed in:',
  usage_limit: 'ran out of usage:',
}

const resolvedVerb: Record<Ticket['status'], string> = {
  open: '',
  approved: 'Approved',
  denied: 'Denied',
  resolved: 'Resolved',
}

/** What happened lately: threads as they stand, and tickets as they opened and closed. */
function itemsOf(threads: ThreadSummary[], tickets: Ticket[], limit: number): Item[] {
  // A thread held up by an open ticket shows as the ticket, not twice.
  const held = new Set(tickets.filter((t) => t.status === 'open').map((t) => t.session?.id))
  const items: Item[] = threads
    .filter((t) => !held.has(t.id))
    .map((t) => ({
      key: `thread:${t.id}`,
      at: t.updatedAt,
      teammate: t.teammate,
      verb: threadVerb[t.status] ?? 'updated',
      title: t.title,
      href: `/app/threads/${t.id}`,
      // A reply waiting to be read is the usual state: no badge for it.
      ...(t.status === 'idle' ? {} : { status: t.status }),
    }))
  for (const t of tickets) {
    const href = t.session ? `/app/threads/${t.session.id}` : '/app/tickets'
    items.push({
      key: `ticket:${t.id}`,
      at: t.createdAt,
      ...(t.session
        ? { teammate: t.session.teammate }
        : { icon: t.type === 'sign_in' ? 'account' : 'event' }),
      verb: ticketVerb[t.type],
      title: t.title,
      href: t.status === 'open' ? '/app/tickets' : href,
      ...(t.status === 'open' ? { status: 'pending' } : {}),
    })
    if (t.resolvedAt)
      items.push({
        key: `resolved:${t.id}`,
        at: t.resolvedAt,
        verb: resolvedVerb[t.status],
        title: t.title,
        href,
        icon: 'event',
      })
  }
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
}

function Who({ item }: { item: Item }) {
  const { teammates } = useDashboard()
  if (!item.teammate)
    return (
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
        {item.icon === 'account' ? (
          <KeyRound className="size-4" aria-hidden />
        ) : (
          <Zap className="size-4" aria-hidden />
        )}
      </span>
    )
  const teammate = teammates.find((t) => t.id === item.teammate!.id) ?? {
    name: item.teammate.name,
    harness: 'claude_code' as const,
  }
  return <TeammateAvatar teammate={teammate} className="size-8 shrink-0 text-sm" />
}

export function ActivityFeed({
  threads,
  tickets,
  limit = 12,
  footer,
}: {
  threads: ThreadSummary[]
  tickets: Ticket[]
  limit?: number
  footer?: ReactNode
}) {
  const items = itemsOf(threads, tickets, limit)
  if (items.length === 0)
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card px-6 py-10 text-center">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
          <Activity className="size-5" aria-hidden />
        </span>
        <p className="text-sm text-muted-foreground">
          Nothing yet. Send a teammate a task and its work shows up here.
        </p>
      </div>
    )
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <ul className="divide-y">
        {items.map((item) => (
          <li key={item.key}>
            <Link
              href={item.href}
              className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50"
            >
              <Who item={item} />
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-sm wrap-anywhere">
                  {item.teammate && <span className="font-semibold">{item.teammate.name} </span>}
                  <span className="text-muted-foreground">{item.verb} </span>
                  <span className="font-medium">{item.title}</span>
                </p>
                <p className="text-xs text-muted-foreground">{timeAgo(item.at)}</p>
              </div>
              {item.status && (
                <StatusBadge
                  status={item.status}
                  {...(item.status === 'pending' ? { label: 'needs input' } : {})}
                />
              )}
            </Link>
          </li>
        ))}
      </ul>
      {footer}
    </Card>
  )
}
