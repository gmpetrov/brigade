'use client'
// The Security page's Activity: who used, granted, changed or approved what,
// newest first, with links to the threads it happened in. Admins only.
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { timeAgo } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, type AccessOverview, type ActivityItem, type ActivityPage } from '@/lib/api'

const CATEGORIES = [
  { value: 'all', label: 'Everything' },
  { value: 'credentials', label: 'Secrets' },
  { value: 'connections', label: 'Apps' },
  { value: 'approvals', label: 'Approvals' },
  { value: 'teammates', label: 'Teammates' },
  { value: 'members', label: 'Members' },
]

const LEVEL: Record<string, string> = {
  none: 'no access',
  read: 'read only',
  read_write: 'read and write',
  use: 'can use, asks first',
  without_asking: 'without asking',
}

/** One entry as a sentence. Unknown names read as "a former …". */
function describe(item: ActivityItem, names: ActivityPage['names']) {
  const d = item.data
  const name = (type: string, id: unknown, fallback: string) =>
    (typeof id === 'string' && names[type as keyof ActivityPage['names']]?.[id]) || fallback
  const actor =
    item.actor.type === 'member'
      ? name('member', item.actor.id, 'A former member')
      : item.actor.type === 'teammate'
        ? name('teammate', item.actor.id, 'A former teammate')
        : 'Brigade'
  const target = (fallback = 'something') =>
    name(item.target.type, item.target.id, (d.name as string | undefined) ?? fallback)
  const credential = target('a deleted secret')
  const teammate = name(
    'teammate',
    d.teammateId ?? (item.target.type === 'teammate' ? item.target.id : undefined),
    'a former teammate',
  )
  const approvedBy = d.approvedBy
    ? `, approved by ${name('member', d.approvedBy, 'a former member')}`
    : ''

  switch (item.action) {
    case 'credential.released':
      return `${actor} ${d.use === 'browser' ? 'signed in with' : 'used'} ${credential}${
        d.via === 'mention'
          ? ', mentioned in the thread'
          : d.via === 'grant'
            ? ', without asking'
            : d.via === 'thread'
              ? ', approved earlier in the thread'
              : approvedBy
      }`
    case 'credential.created':
      return item.actor.type === 'teammate'
        ? `${actor} saved the secret ${credential}${approvedBy}`
        : `${actor} added the secret ${credential}`
    case 'credential.updated':
      return `${actor} changed ${credential}${d.secretReplaced ? ' and replaced its value' : ''}${approvedBy}`
    case 'credential.deleted':
      return `${actor} deleted ${credential}`
    case 'credential.restored':
      return `${actor} restored the previous value of ${credential}`
    case 'credential.granted':
      return `${actor} let ${teammate} use ${credential}${d.level === 'without_asking' ? ' without asking' : ''}`
    case 'credential.revoked':
      return `${actor} removed ${teammate}’s access to ${credential}`
    case 'credential.access_set':
      return `${actor} shared ${credential} with ${d.access === 'all' ? 'all teammates' : 'picked teammates only'}`
    case 'grant.set':
      return `${actor} set ${target('a former teammate')}’s access to ${name('connection', d.connectionId, 'a removed connection')}: ${LEVEL[String(d.scope)] ?? d.scope}`
    case 'connection.created':
      return `${actor} connected ${target('a service')}`
    case 'connection.removed':
      return `${actor} removed ${target('a connection')}`
    case 'connection.call_denied':
      return `${actor} was refused ${String(d.operation).replace(/_/g, ' ')} on ${target('a connection')}${d.error ? ` (${d.error})` : ''}`
    case 'approval.approved':
      return `${actor} approved a request${d.always ? ' and allowed it from now on' : ''}`
    case 'approval.denied':
      return `${actor} denied a request${d.reason ? `: ${d.reason}` : ''}`
    case 'approval.expired':
      return `${actor} answered a request that was no longer waiting`
    case 'cap.reached':
      return `A teammate reached its cap`
    case 'cap.allowed':
      return `${actor} allowed work past a cap`
    case 'cap.denied':
      return `${actor} kept a cap`
    case 'teammate.created':
      return `${actor} created ${target('a teammate')}`
    case 'teammate.archived':
      return `${actor} archived ${target('a teammate')}`
    case 'teammate.updated':
      return `${actor} changed ${target('a teammate')}${
        Array.isArray(d.fields) && d.fields.length ? ` (${d.fields.join(', ')})` : ''
      }`
    case 'library.folder_access_changed':
      return `${actor} set teammate access to the library folder ${String(d.path)}/${
        d.restricted ? ' (restricted)' : ''
      }`
    default:
      return `${actor}: ${item.action.replace(/[._]/g, ' ')}`
  }
}

export function SecurityActivity({ teammates }: { teammates: AccessOverview['teammates'] }) {
  const [category, setCategory] = useState('all')
  const [teammateId, setTeammateId] = useState('all')
  const [page, setPage] = useState<ActivityPage>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const query = (before?: string) =>
    `/security/activity?${new URLSearchParams({
      ...(category !== 'all' ? { category } : {}),
      ...(teammateId !== 'all' ? { teammateId } : {}),
      ...(before ? { before } : {}),
    })}`

  useEffect(() => {
    let live = true
    setPage(undefined)
    setError(undefined)
    api<ActivityPage>(query())
      .then((p) => live && setPage(p))
      .catch((e: Error) => live && setError(e.message))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, teammateId])

  async function more() {
    if (!page?.next) return
    setBusy(true)
    try {
      const next = await api<ActivityPage>(query(page.next))
      setPage({
        items: [...page.items, ...next.items],
        names: {
          teammate: { ...page.names.teammate, ...next.names.teammate },
          member: { ...page.names.member, ...next.names.member },
          credential: { ...page.names.credential, ...next.names.credential },
          connection: { ...page.names.connection, ...next.names.connection },
        },
        next: next.next,
      })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-full sm:w-48" aria-label="What to show">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CATEGORIES.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={teammateId} onValueChange={setTeammateId}>
          <SelectTrigger className="w-full sm:w-56" aria-label="Teammate">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Every teammate</SelectItem>
            {teammates.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      {!page ? (
        !error && <p className="text-sm text-muted-foreground">Loading…</p>
      ) : page.items.length === 0 ? (
        <p className="rounded-xl border border-dashed px-6 py-10 text-center text-sm text-muted-foreground">
          Nothing here yet.
        </p>
      ) : (
        <ol className="divide-y rounded-xl border bg-card shadow-sm">
          {page.items.map((item) => {
            const sessionId = typeof item.data.sessionId === 'string' ? item.data.sessionId : null
            return (
              <li
                key={item.id}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-3 sm:px-5"
              >
                <Hint label={new Date(item.at).toLocaleString()}>
                  <time dateTime={item.at} className="w-20 shrink-0 text-xs text-muted-foreground">
                    {timeAgo(item.at)}
                  </time>
                </Hint>
                <span className="min-w-0 flex-[1_1_16rem] text-sm">
                  {describe(item, page.names)}
                </span>
                {sessionId && (
                  <Link
                    href={`/app/threads/${sessionId}`}
                    className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                  >
                    Thread
                  </Link>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {page?.next && (
        <Button
          variant="outline"
          className="self-center"
          disabled={busy}
          onClick={() => void more()}
        >
          {busy ? 'Loading…' : 'Show older'}
        </Button>
      )}
    </div>
  )
}
