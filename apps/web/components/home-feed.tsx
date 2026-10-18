'use client'
// Home under Waiting on you: loose ends (nobody is blocked, but nothing moves on its own),
// then what came back since the member last looked. Each section shows only when it has
// something, so a quiet day leaves the composer alone on the page.
import { CircleAlert, Clock, GitMerge, MessageCircleQuestion, Ticket, X } from 'lucide-react'
import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import { StatusBadge, TeammateAvatar } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { api, type HomeFeed, type HomeResult, type LooseEnd } from '@/lib/api'
import { cn } from '@/lib/utils'

/** "49m", "3h", then the day. */
function since(iso: string) {
  const minutes = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
  if (minutes < 60) return `${minutes}m`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / (24 * 60))}d`
}

/** "14:02" today, else the day. */
function when(iso: string) {
  const at = new Date(iso)
  return at.toDateString() === new Date().toDateString()
    ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleDateString([], { weekday: 'short' })
}

function Row({
  icon,
  title,
  meta,
  href,
  children,
}: {
  icon: ReactNode
  title: ReactNode
  meta: ReactNode
  href: string
  children?: ReactNode
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      {icon}
      <Link href={href} className="min-w-0 flex-1 rounded-sm">
        <p className="truncate text-sm font-semibold">{title}</p>
        <p className="truncate text-xs text-muted-foreground">{meta}</p>
      </Link>
      {children}
    </li>
  )
}

function Icon({ children, tone }: { children: ReactNode; tone?: 'bad' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-8 flex-none items-center justify-center rounded-full bg-secondary text-muted-foreground [&>svg]:size-4',
        tone === 'bad' && 'bg-destructive/15 text-destructive-text',
      )}
    >
      {children}
    </span>
  )
}

function SectionTitle({
  id,
  children,
  aside,
}: {
  id: string
  children: ReactNode
  aside?: ReactNode
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 id={id} className="text-lg font-bold">
        {children}
      </h2>
      {aside}
    </div>
  )
}

function LooseEndRow({ item, onChange }: { item: LooseEnd; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(undefined)
    try {
      await action()
      await onChange()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
      setBusy(false)
    }
  }

  const dismiss = (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Dismiss"
      title="Dismiss"
      disabled={busy}
      onClick={() => run(() => api('/home/dismiss', { body: { key: item.key } }))}
    >
      <X aria-hidden />
    </Button>
  )
  const meta = (text: string) =>
    error ? <span className="text-destructive-text">{error}</span> : text

  if (item.kind === 'proposal') {
    const href = `/app/threads/${item.thread.id}`
    const offered = item.offers.map((o) => `“${o}”`).join(' · ')
    return (
      <Row
        icon={
          <Icon>
            <MessageCircleQuestion />
          </Icon>
        }
        title={item.thread.title}
        meta={meta(`${item.teammate.name} offered ${offered} · no answer for ${since(item.at)}`)}
        href={href}
      >
        {item.reply ? (
          // A click is the member's own message, as the button in the thread.
          <Button
            variant="outline"
            size="sm"
            className="max-w-48 rounded-full"
            disabled={busy}
            onClick={() =>
              run(() => api(`/threads/${item.thread.id}/messages`, { body: { text: item.reply } }))
            }
          >
            <span className="truncate">{item.reply}</span>
          </Button>
        ) : (
          <Button variant="outline" size="sm" className="rounded-full" asChild>
            <Link href={href}>Choose</Link>
          </Button>
        )}
        {dismiss}
      </Row>
    )
  }

  if (item.kind === 'stalled') {
    const href = `/app/threads/${item.thread.id}`
    return (
      <Row
        icon={
          <Icon>
            <Clock />
          </Icon>
        }
        title={item.thread.title}
        meta={meta(
          item.offline
            ? `Running · its computer hasn't sent anything for ${since(item.quietSince)}`
            : `Running · no update from ${item.teammate.name} for ${since(item.quietSince)}`,
        )}
        href={href}
      >
        <Button variant="outline" size="sm" className="rounded-full" asChild>
          <Link href={href}>Open</Link>
        </Button>
        {dismiss}
      </Row>
    )
  }

  const href = item.run ? `/app/threads/${item.run.id}` : '/app/automations'
  return (
    <Row
      icon={
        <Icon tone="bad">
          <CircleAlert />
        </Icon>
      }
      title={item.schedule.title}
      meta={meta(
        item.error
          ? `Automation · couldn't start: ${item.error}`
          : `Automation · last run failed · ${when(item.at)}`,
      )}
      href={href}
    >
      <Button variant="outline" size="sm" className="rounded-full" asChild>
        <Link href={href}>Open</Link>
      </Button>
      {dismiss}
    </Row>
  )
}

export function LooseEnds({
  items,
  onChange,
}: {
  items: LooseEnd[]
  onChange: () => Promise<void>
}) {
  if (!items.length) return null
  return (
    <section aria-labelledby="loose-ends" className="flex flex-col gap-3">
      <SectionTitle
        id="loose-ends"
        aside={
          <span className="hidden text-xs text-muted-foreground sm:block">
            Nobody is blocked, but these won&apos;t move on their own.
          </span>
        }
      >
        Loose ends
      </SectionTitle>
      <Card className="gap-0 overflow-hidden py-0 shadow-none">
        <ul className="divide-y">
          {items.map((item) => (
            <LooseEndRow key={item.key} item={item} onChange={onChange} />
          ))}
        </ul>
      </Card>
    </section>
  )
}

const pullLabel = (p: { repository: string; number: number }) => `#${p.number}`

function ResultRow({ item }: { item: HomeResult }) {
  const time = (
    <span className="w-12 flex-none text-right text-xs text-muted-foreground">{when(item.at)}</span>
  )

  if (item.kind === 'thread') {
    const { pull } = item
    return (
      <Row
        icon={<TeammateAvatar teammate={item.teammate} className="size-8 flex-none text-xs" />}
        title={item.thread.title}
        meta={
          pull
            ? `${item.teammate.name} opened PR ${pullLabel(pull)}`
            : item.thread.status === 'failed'
              ? `${item.teammate.name} ran into a problem`
              : `${item.teammate.name} replied`
        }
        href={`/app/threads/${item.thread.id}`}
      >
        {pull ? (
          <StatusBadge
            status={pull.state === 'merged' ? 'merged' : 'pr opened'}
            tone={pull.state === 'merged' ? 'success' : 'neutral'}
          />
        ) : item.thread.status === 'failed' ? (
          <StatusBadge status="failed" />
        ) : (
          <StatusBadge status="reply" tone="neutral" />
        )}
        {time}
      </Row>
    )
  }

  if (item.kind === 'merged') {
    return (
      <Row
        icon={
          <Icon>
            <GitMerge />
          </Icon>
        }
        title={
          <>
            {item.byYou ? 'You merged' : 'Merged'} PR {pullLabel(item.pull)}{' '}
            <span className="font-normal text-muted-foreground">· {item.pull.title}</span>
          </>
        }
        meta={item.thread ? item.thread.title : item.pull.repository}
        href={item.thread ? `/app/threads/${item.thread.id}` : '/app/pulls'}
      >
        <StatusBadge status="merged" tone="success" />
        {time}
      </Row>
    )
  }

  const verdict = { approved: 'You approved', denied: 'You declined', resolved: 'You answered' }[
    item.verdict
  ]
  return (
    <Row
      icon={
        <Icon>
          <Ticket />
        </Icon>
      }
      title={
        <>
          {verdict} <span className="font-normal text-muted-foreground">· {item.title}</span>
        </>
      }
      meta={item.thread ? `Your decision · ${item.thread.title}` : 'Your decision'}
      href={item.thread ? `/app/threads/${item.thread.id}` : '/app/tickets'}
    >
      <StatusBadge
        status={item.verdict === 'denied' ? 'declined' : 'done'}
        tone={item.verdict === 'denied' ? 'neutral' : 'success'}
      />
      {time}
    </Row>
  )
}

export function SinceAway({ feed }: { feed: HomeFeed }) {
  if (!feed.results.length) return null
  return (
    <section aria-labelledby="since-away" className="flex flex-col gap-3">
      <SectionTitle
        id="since-away"
        aside={
          <Link
            href="/app/threads"
            className="text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            All threads
          </Link>
        }
      >
        Since you were away
      </SectionTitle>
      <Card className="gap-0 overflow-hidden py-0">
        <ul className="divide-y">
          {feed.results.map((item, i) => (
            <ResultRow key={`${item.kind}:${item.at}:${i}`} item={item} />
          ))}
        </ul>
      </Card>
    </section>
  )
}
