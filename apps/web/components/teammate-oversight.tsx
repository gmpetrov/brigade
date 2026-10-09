'use client'
import Link from 'next/link'
import { useState } from 'react'
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

/** Daily caps and the status timeline, from the teammate's event and call logs. */
export function TeammateOversight({
  teammate,
  editable,
  onCapsChange,
}: {
  teammate: Teammate
  editable: boolean
  onCapsChange: () => void
}) {
  const [hoursBack, setHoursBack] = useState(8)
  // The window ends now, fixed until a refresh so the request stays stable.
  const [now, setNow] = useState(() => Date.now())
  const from = new Date(now - hoursBack * 3600_000).toISOString()
  const timeline = useApi<Timeline>(
    `/teammates/${teammate.id}/timeline?from=${encodeURIComponent(from)}&to=${encodeURIComponent(new Date(now).toISOString())}`,
  )

  return (
    <>
      <CapsCard
        teammate={teammate}
        usage={timeline.data?.usage}
        editable={editable}
        onSaved={() => {
          onCapsChange()
          setNow(Date.now())
        }}
      />
      <div className="card">
        <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>Status</h2>
          <div className="spacer" />
          <select
            aria-label="Window"
            style={{ width: 'auto' }}
            value={hoursBack}
            onChange={(e) => {
              setHoursBack(Number(e.target.value))
              setNow(Date.now())
            }}
          >
            {WINDOWS.map((w) => (
              <option key={w.hours} value={w.hours}>
                {w.label}
              </option>
            ))}
          </select>
          <button onClick={() => setNow(Date.now())}>Refresh</button>
        </div>
        {timeline.data ? <TimelineChart data={timeline.data} /> : <p className="hint">Loading…</p>}
      </div>
    </>
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
      <p className="hint" style={{ marginTop: 0 }}>
        {(['working', 'waiting', 'blocked'] as const).map((s) => (
          <span key={s} style={{ marginRight: 14 }}>
            <span className={`swatch ${s}`} />
            {stateLabel[s]} {hours(data.totals[s])}
          </span>
        ))}
        <span>
          <span className="swatch done" />
          Idle between turns
        </span>
      </p>
      {data.threads.length === 0 ? (
        <p className="hint">No activity in this window.</p>
      ) : (
        <div className="timeline">
          {data.threads.map((t) => (
            <div key={t.id} style={{ display: 'contents' }}>
              <Link className="label" href={`/app/threads/${t.id}`} title={t.title}>
                {t.origin === 'webhook' ? '↪ ' : ''}
                {t.title}
              </Link>
              <div className="track">
                {t.segments.map((s, i) => (
                  <div
                    key={i}
                    className={`seg ${s.state}`}
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
          <div className="axis">
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

function CapsCard({
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
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Daily caps</h2>
        <div className="spacer" />
        {editable && !editing && <button onClick={() => setEditing(true)}>Edit caps</button>}
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        Reaching a cap pauses {teammate.name}&apos;s new work and opens a ticket for an admin. Days
        start at midnight UTC. Empty means no cap.
      </p>
      {editing ? (
        <form action={save} className="stack">
          <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
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
          <div className="row">
            {error && <span className="error">{error}</span>}
            <div className="spacer" />
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="primary">Save caps</button>
          </div>
        </form>
      ) : (
        <ul className="list">
          <li>
            <span style={{ flex: 1 }}>Threads started today</span>
            <span>
              {usage?.threads ?? '…'}
              {of(caps.threadsPerDay)}
            </span>
          </li>
          <li>
            <span style={{ flex: 1 }}>Computer hours today</span>
            <span>
              {usage?.computerHours ?? '…'}
              {of(caps.computerHoursPerDay)}
            </span>
          </li>
          <li>
            <span style={{ flex: 1 }}>Write calls per connection today</span>
            <span>
              {writes.length === 0
                ? `0${of(caps.writeCallsPerConnectionPerDay)}`
                : writes
                    .map(([id, n]) => `${label(id)}: ${n}${of(caps.writeCallsPerConnectionPerDay)}`)
                    .join(', ')}
            </span>
          </li>
        </ul>
      )}
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
    <div className="field" style={{ flex: '1 1 160px', margin: 0 }}>
      <label htmlFor={name}>{label}</label>
      <input
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
