'use client'
import { RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  api,
  useApi,
  type Caps,
  type ConnectionsResponse,
  type Teammate,
  type Timeline,
  type TimelineState,
} from '@/lib/api'

const WINDOWS = [
  { label: 'Last hour', hours: 1 },
  { label: 'Last 8 hours', hours: 8 },
  { label: 'Last 24 hours', hours: 24 },
  { label: 'Last 7 days', hours: 24 * 7 },
]

const stateLabel: Record<TimelineState, string> = {
  working: 'Working',
  waiting: 'Waiting for approval',
  blocked: 'Blocked',
  done: 'Done',
}

const hours = (seconds: number) =>
  seconds < 60
    ? `${Math.round(seconds)}s`
    : seconds < 3600
      ? `${Math.round(seconds / 60)}m`
      : `${(seconds / 3600).toFixed(1)}h`

const segColor: Record<TimelineState, string> = {
  working: 'bg-primary',
  waiting: 'bg-warning',
  blocked: 'bg-destructive',
  done: 'bg-muted-foreground/30',
}

/** The teammate's status timeline and today's usage, for a chosen window ending now. */
export function useTeammateTimeline(teammateId: string) {
  const [hoursBack, setHoursBack] = useState(8)
  // The window ends now, fixed until a refresh so the request stays stable.
  const [now, setNow] = useState(() => Date.now())
  const from = new Date(now - hoursBack * 3600_000).toISOString()
  const timeline = useApi<Timeline>(
    `/teammates/${teammateId}/timeline?from=${encodeURIComponent(from)}&to=${encodeURIComponent(new Date(now).toISOString())}`,
  )
  return {
    timeline,
    hoursBack,
    setWindow: (hours: number) => {
      setHoursBack(hours)
      setNow(Date.now())
    },
    refresh: () => setNow(Date.now()),
  }
}

/** The status timeline card, from the teammate's event and call logs. */
export function TeammateStatus({
  timeline,
  hoursBack,
  setWindow,
  refresh,
}: ReturnType<typeof useTeammateTimeline>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-bold">Status</h2>
        </CardTitle>
        <CardAction>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh"
            title="Refresh"
            onClick={refresh}
          >
            <RefreshCw />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Select value={String(hoursBack)} onValueChange={(v) => setWindow(Number(v))}>
          <SelectTrigger size="sm" aria-label="Window" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WINDOWS.map((w) => (
              <SelectItem key={w.hours} value={String(w.hours)}>
                {w.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {timeline.data ? (
          <TimelineChart data={timeline.data} />
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </CardContent>
    </Card>
  )
}

function TimelineChart({ data }: { data: Timeline }) {
  const start = Date.parse(data.from)
  const span = Date.parse(data.to) - start
  const pct = (iso: string) => ((Date.parse(iso) - start) / span) * 100
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => new Date(start + f * span))
  const short = span <= 48 * 3600_000

  return (
    <>
      <ul className="flex flex-col gap-2 text-sm">
        {(['working', 'waiting', 'blocked'] as const).map((s) => (
          <li key={s} className="flex items-center gap-2.5">
            <span aria-hidden className={cn('size-2.5 shrink-0 rounded-sm', segColor[s])} />
            <span className="flex-1">{stateLabel[s]}</span>
            <span className="font-mono">{hours(data.totals[s])}</span>
          </li>
        ))}
        <li className="flex items-center gap-2.5">
          <span aria-hidden className={cn('size-2.5 shrink-0 rounded-sm', segColor.done)} />
          <span className="flex-1">Idle between turns</span>
        </li>
      </ul>
      {data.threads.length === 0 ? (
        <p className="text-sm text-muted-foreground">No activity in this window.</p>
      ) : (
        <div className="grid grid-cols-[minmax(4rem,8rem)_1fr] items-center gap-x-3 gap-y-1.5 text-xs">
          {data.threads.map((t) => (
            <div key={t.id} className="contents">
              <Link
                className="truncate hover:text-primary hover:underline"
                href={`/app/threads/${t.id}`}
                title={t.title}
              >
                {t.origin === 'trigger' ? '↪ ' : ''}
                {t.title}
              </Link>
              <div className="relative h-3.5 overflow-hidden rounded-sm bg-muted">
                {t.segments.map((s, i) => (
                  <div
                    key={i}
                    className={cn('absolute inset-y-0 min-w-0.5', segColor[s.state])}
                    title={`${stateLabel[s.state]}${s.note ? ` (${s.note})` : ''}: ${new Date(s.from).toLocaleString()} to ${new Date(s.to).toLocaleTimeString()}`}
                    style={{
                      left: `${pct(s.from)}%`,
                      width: `${Math.max(pct(s.to) - pct(s.from), 0.2)}%`,
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
          <div />
          <div className="flex justify-between font-mono text-[0.65rem] text-muted-foreground">
            {ticks.map((d) => (
              <span key={d.getTime()}>
                {short
                  ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                  : d.toLocaleDateString([], { weekday: 'short', day: 'numeric' })}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

/** Daily caps and today's usage against them. */
export function TeammateCaps({
  teammate,
  usage,
  editable,
  onSaved,
}: {
  teammate: Teammate
  usage: Timeline['usage'] | undefined
  editable: boolean
  onSaved: () => void
}) {
  const connections = useApi<ConnectionsResponse>('/connections')
  const caps = teammate.caps ?? {}
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string>()

  async function save(form: FormData) {
    setError(undefined)
    const value = (name: keyof Caps) => {
      const raw = String(form.get(name) ?? '').trim()
      return raw === '' ? null : Number(raw)
    }
    try {
      await api(`/teammates/${teammate.id}`, {
        method: 'PATCH',
        body: {
          caps: {
            threadsPerDay: value('threadsPerDay'),
            computerHoursPerDay: value('computerHoursPerDay'),
            writeCallsPerConnectionPerDay: value('writeCallsPerConnectionPerDay'),
          },
        },
      })
      setEditing(false)
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const label = (id: string) => {
    const c = connections.data?.connections.find((c) => c.id === id)
    return c ? (c.externalAccount ?? c.label) : 'a removed connection'
  }
  const of = (limit: number | null | undefined) => (typeof limit === 'number' ? ` of ${limit}` : '')
  const writes = Object.entries(usage?.writeCalls ?? {})

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-bold">Daily caps</h2>
        </CardTitle>
        <CardDescription className="leading-relaxed">
          Reaching a cap pauses {teammate.name}&apos;s new work and opens a ticket for an admin.
          Days start at midnight UTC. Empty means no cap.
        </CardDescription>
        {editable && !editing && (
          <CardAction>
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              Edit caps
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {editing ? (
          <form action={save} className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-3">
              <CapField name="threadsPerDay" label="Threads started" value={caps.threadsPerDay} />
              <CapField
                name="computerHoursPerDay"
                label="Computer hours"
                value={caps.computerHoursPerDay}
                step="0.25"
                max={24}
              />
              <CapField
                name="writeCallsPerConnectionPerDay"
                label="Write calls per connection"
                value={caps.writeCallsPerConnectionPerDay}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {error && <span className="text-sm text-destructive-text">{error}</span>}
              <div className="flex-1" />
              <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button type="submit">Save caps</Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
              <StatTile
                label="Threads started today"
                value={usage?.threads}
                limit={of(caps.threadsPerDay)}
              />
              <StatTile
                label="Computer hours today"
                value={usage?.computerHours}
                limit={of(caps.computerHoursPerDay)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-muted-foreground">
                Write calls per connection today
              </span>
              <div className="flex flex-wrap gap-2">
                {writes.length === 0 ? (
                  <Badge variant="secondary">0{of(caps.writeCallsPerConnectionPerDay)}</Badge>
                ) : (
                  writes.map(([id, n]) => (
                    <Badge key={id} variant="secondary">
                      {label(id)}: {n}
                      {of(caps.writeCallsPerConnectionPerDay)}
                    </Badge>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function StatTile({
  label,
  value,
  limit,
}: {
  label: string
  value: number | undefined
  limit: string
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md bg-secondary px-4 py-3.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl font-extrabold">
        {value ?? '…'}
        {limit && (
          <span className="ml-1 text-sm font-medium text-muted-foreground">{limit.trim()}</span>
        )}
      </span>
    </div>
  )
}

function CapField({
  name,
  label,
  value,
  step = '1',
  max,
}: {
  name: string
  label: string
  value: number | null | undefined
  step?: string
  max?: number
}) {
  return (
    <div className="flex flex-[1_1_10rem] flex-col gap-2">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        name={name}
        type="number"
        min={0}
        max={max}
        step={step}
        defaultValue={value ?? ''}
        placeholder="No cap"
      />
    </div>
  )
}
