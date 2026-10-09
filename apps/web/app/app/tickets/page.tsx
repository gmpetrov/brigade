'use client'
import { useState } from 'react'
import { useDashboard } from '@/components/dashboard'
import { TicketRow } from '@/components/ticket-row'
import { api, useApi, type Ticket } from '@/lib/api'

const TYPES: { value: Ticket['type'] | ''; label: string }[] = [
  { value: '', label: 'All kinds' },
  { value: 'approval', label: 'Approvals' },
  { value: 'cap', label: 'Reached caps' },
  { value: 'sign_in', label: 'Expired logins' },
  { value: 'usage_limit', label: 'Out of usage' },
  { value: 'question', label: 'Questions' },
]

/** One inbox per workspace of everything waiting on a person. */
export default function Tickets() {
  const { me } = useDashboard()
  const [all, setAll] = useState(false)
  const [type, setType] = useState<Ticket['type'] | ''>('')
  const tickets = useApi<Ticket[]>(`/tickets${all ? '?status=all' : ''}`)
  const [error, setError] = useState<string>()

  async function resolve(id: string, approved: boolean) {
    setError(undefined)
    try {
      await api(`/tickets/${id}/resolve`, { body: { approved } })
    } catch (e) {
      setError((e as Error).message)
    }
    await tickets.reload()
  }

  const shown = (tickets.data ?? []).filter((t) => !type || t.type === type)

  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>Tickets</h1>
        <div className="spacer" />
        <select
          aria-label="Kind"
          value={type}
          onChange={(e) => setType(e.target.value as Ticket['type'] | '')}
          style={{ width: 'auto' }}
        >
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <label className="row hint" style={{ fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={all}
            onChange={(e) => setAll(e.target.checked)}
            style={{ width: 'auto' }}
          />{' '}
          Show resolved
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      {tickets.data && shown.length === 0 && <p className="hint">Nothing is waiting on you.</p>}
      <ul className="list">
        {shown.map((t) => (
          <TicketRow key={t.id} ticket={t} me={me} onResolve={resolve} />
        ))}
      </ul>
    </div>
  )
}
