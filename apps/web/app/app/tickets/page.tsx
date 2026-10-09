'use client'
import Link from 'next/link'
import { useState } from 'react'
import { isAdmin, timeAgo, useDashboard } from '@/components/dashboard'
import { api, useApi, type Ticket } from '@/lib/api'

/** Everything waiting on a person in this workspace. */
export default function Tickets() {
  const { me } = useDashboard()
  const [all, setAll] = useState(false)
  const tickets = useApi<Ticket[]>(`/tickets${all ? '?status=all' : ''}`)
  const [error, setError] = useState<string>()

  async function decide(id: string, approved: boolean) {
    setError(undefined)
    try {
      await api(`/tickets/${id}/resolve`, { body: { approved } })
    } catch (e) {
      setError((e as Error).message)
    }
    await tickets.reload()
  }

  const canDecide = (t: Ticket) => isAdmin(me) || t.session?.startedByMemberId === me.memberId

  return (
    <div className="stack">
      <div className="row">
        <h1 style={{ margin: 0 }}>Tickets</h1>
        <div className="spacer" />
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
      {tickets.data && tickets.data.length === 0 && (
        <p className="hint">Nothing is waiting on you.</p>
      )}
      <ul className="list">
        {(tickets.data ?? []).map((t) => (
          <li key={t.id} style={{ display: 'block' }}>
            <div className="row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>{t.title}</div>
                <div className="hint">
                  {t.type.replace('_', ' ')} · {timeAgo(t.createdAt)}
                  {t.session && (
                    <>
                      {' · '}
                      <Link href={`/app/threads/${t.session.id}`}>{t.session.title}</Link>
                    </>
                  )}
                </div>
              </div>
              {t.status === 'open' && t.type === 'approval' && canDecide(t) ? (
                <>
                  <button className="primary" onClick={() => void decide(t.id, true)}>
                    Approve
                  </button>
                  <button onClick={() => void decide(t.id, false)}>Deny</button>
                </>
              ) : (
                <span
                  className={`badge ${t.status === 'approved' ? 'ok' : t.status === 'denied' ? 'danger' : t.status === 'open' ? 'warn' : ''}`}
                >
                  {t.status}
                </span>
              )}
            </div>
            {t.type === 'approval' && t.payload.input !== undefined && (
              <details className="tool" style={{ marginTop: 8 }}>
                <summary className="hint">
                  {t.payload.operation} on {t.payload.connection}: {t.payload.target}
                </summary>
                <pre>{JSON.stringify(t.payload.input, null, 2)}</pre>
              </details>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
