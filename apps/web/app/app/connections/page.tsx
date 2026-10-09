'use client'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'
import { isAdmin, timeAgo, useDashboard } from '@/components/dashboard'
import { api, useApi, type ConnectionCall, type ConnectionsResponse } from '@/lib/api'

export default function ConnectionsPage() {
  return (
    <Suspense>
      <Connections />
    </Suspense>
  )
}

function Connections() {
  const { me, teammates } = useDashboard()
  const params = useSearchParams()
  const data = useApi<ConnectionsResponse>('/connections')
  const [open, setOpen] = useState<string>()
  const [error, setError] = useState<string>()
  const admin = isAdmin(me)
  const name = (teammateId: string) =>
    teammates.find((t) => t.id === teammateId)?.name ?? 'a former teammate'

  async function connectGmail() {
    setError(undefined)
    try {
      const { url } = await api<{ url: string }>('/connections/google', { method: 'POST' })
      window.location.href = url
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function remove(id: string, label: string) {
    if (!confirm(`Disconnect ${label}? Teammates lose access; the call log is kept.`)) return
    await api(`/connections/${id}`, { method: 'DELETE' }).catch((e) =>
      setError((e as Error).message),
    )
    await data.reload()
  }

  return (
    <div className="stack">
      <h1>Connections</h1>
      <p className="hint">
        External accounts your teammates can use. The credential stays in Brigade&apos;s vault and
        never reaches a computer: every call goes through Brigade, which checks the teammate&apos;s
        grant, asks a person before changes when its policy says so, and logs the call. Grant access
        on each teammate&apos;s page.
      </p>
      {params.get('connected') && <p className="badge ok">Connected.</p>}
      {params.get('error') && (
        <p className="error">The connection was not created ({params.get('error')}).</p>
      )}
      {error && <p className="error">{error}</p>}

      {(data.data?.connections ?? []).length === 0 ? (
        <p className="hint">No connections yet.</p>
      ) : (
        <ul className="list">
          {data.data!.connections.map((c) => (
            <li key={c.id} style={{ display: 'block' }}>
              <div className="row">
                <div style={{ flex: 1 }}>
                  <div>
                    {c.label}{' '}
                    {c.externalAccount && <span className="hint">· {c.externalAccount}</span>}
                  </div>
                  <div className="hint">
                    {c.grants.length === 0
                      ? 'No teammate has access'
                      : c.grants
                          .map(
                            (g) =>
                              `${name(g.teammateId)} (${g.scope === 'read' ? 'read' : 'read and write'})`,
                          )
                          .join(', ')}
                  </div>
                </div>
                {c.status === 'needs_reauth' ? (
                  <span className="badge danger">reconnect needed</span>
                ) : (
                  <span className="badge ok">active</span>
                )}
                <button onClick={() => setOpen(open === c.id ? undefined : c.id)}>
                  {open === c.id ? 'Hide log' : 'Call log'}
                </button>
                {admin && (
                  <button
                    className="danger"
                    onClick={() => void remove(c.id, c.externalAccount ?? c.label)}
                  >
                    Disconnect
                  </button>
                )}
              </div>
              {open === c.id && <CallLog connectionId={c.id} />}
            </li>
          ))}
        </ul>
      )}

      {admin && (
        <div className="card">
          <h2>Connect an account</h2>
          {data.data?.available.gmail ? (
            <button className="primary" onClick={() => void connectGmail()}>
              Connect Gmail
            </button>
          ) : (
            <p className="hint">
              Gmail needs Google OAuth configured on this Brigade server (GOOGLE_CLIENT_ID and
              GOOGLE_CLIENT_SECRET).
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function CallLog({ connectionId }: { connectionId: string }) {
  const calls = useApi<ConnectionCall[]>(`/connections/${connectionId}/calls`)
  if (!calls.data) return <p className="hint">Loading…</p>
  if (calls.data.length === 0)
    return (
      <p className="hint" style={{ marginTop: 8 }}>
        No calls yet.
      </p>
    )
  return (
    <table style={{ width: '100%', marginTop: 10, fontSize: 13, borderCollapse: 'collapse' }}>
      <tbody>
        {calls.data.map((call) => (
          <tr key={call.id} style={{ borderTop: '1px solid var(--border)' }}>
            <td className="hint" style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
              {timeAgo(call.createdAt)}
            </td>
            <td style={{ padding: '4px 6px' }}>{call.teammate.name}</td>
            <td style={{ padding: '4px 6px' }}>
              <code>{call.operation}</code>{' '}
              {call.write && <span className="badge warn">write</span>}
            </td>
            <td style={{ padding: '4px 6px' }}>{call.target}</td>
            <td style={{ padding: '4px 6px' }}>
              <span
                className={`badge ${call.result === 'ok' ? 'ok' : call.result === 'denied' ? 'warn' : 'danger'}`}
              >
                {call.result}
              </span>
              {call.error && <span className="hint"> {call.error}</span>}
            </td>
            <td style={{ padding: '4px 6px' }}>
              <Link href={`/app/threads/${call.sessionId}`}>thread</Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
