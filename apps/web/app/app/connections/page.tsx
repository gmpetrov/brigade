'use client'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'
import { isAdmin, timeAgo, useDashboard } from '@/components/dashboard'
import {
  api,
  useApi,
  type Connection,
  type ConnectionCall,
  type ConnectionsResponse,
  type Webhook,
} from '@/lib/api'

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
  const [open, setOpen] = useState<{ id: string; tab: 'log' | 'webhooks' }>()
  const [stripeOpen, setStripeOpen] = useState(false)
  const [error, setError] = useState<string>()
  const admin = isAdmin(me)
  const name = (teammateId: string) =>
    teammates.find((t) => t.id === teammateId)?.name ?? 'a former teammate'

  async function connectGoogle(kind: 'gmail' | 'google_calendar') {
    setError(undefined)
    try {
      const { url } = await api<{ url: string }>('/connections/google', { body: { kind } })
      window.location.href = url
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function connectStripe(form: FormData) {
    setError(undefined)
    try {
      await api('/connections/stripe', {
        body: {
          apiKey: String(form.get('apiKey')),
          ...(form.get('label') ? { label: String(form.get('label')) } : {}),
        },
      })
      setStripeOpen(false)
      await data.reload()
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
                <button
                  onClick={() =>
                    setOpen(
                      open?.id === c.id && open.tab === 'log'
                        ? undefined
                        : { id: c.id, tab: 'log' },
                    )
                  }
                >
                  {open?.id === c.id && open.tab === 'log' ? 'Hide log' : 'Call log'}
                </button>
                <button
                  onClick={() =>
                    setOpen(
                      open?.id === c.id && open.tab === 'webhooks'
                        ? undefined
                        : { id: c.id, tab: 'webhooks' },
                    )
                  }
                >
                  Webhooks
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
              {open?.id === c.id && open.tab === 'log' && <CallLog connectionId={c.id} />}
              {open?.id === c.id && open.tab === 'webhooks' && (
                <Webhooks connection={c} editable={admin} />
              )}
            </li>
          ))}
        </ul>
      )}

      {admin && (
        <div className="card">
          <h2>Connect an account</h2>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button
              className="primary"
              disabled={!data.data?.available.gmail}
              onClick={() => void connectGoogle('gmail')}
            >
              Connect Gmail
            </button>
            <button
              disabled={!data.data?.available.google_calendar}
              onClick={() => void connectGoogle('google_calendar')}
            >
              Connect Google Calendar
            </button>
            <button onClick={() => setStripeOpen(!stripeOpen)}>Connect Stripe</button>
          </div>
          {data.data && !data.data.available.gmail && (
            <p className="hint">
              Gmail and Google Calendar need Google OAuth configured on this Brigade server
              (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).
            </p>
          )}
          {stripeOpen && (
            <form action={connectStripe} className="stack" style={{ marginTop: 16 }}>
              <p className="hint" style={{ margin: 0 }}>
                Create a restricted key in Stripe&apos;s dashboard with only the access your
                teammates need, and paste it here. It goes straight into Brigade&apos;s vault and is
                never shown again.
              </p>
              <div className="field">
                <label htmlFor="apiKey">Secret or restricted key</label>
                <input
                  id="apiKey"
                  name="apiKey"
                  type="password"
                  autoComplete="off"
                  placeholder="rk_live_… or sk_test_…"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="label">Name (optional)</label>
                <input id="label" name="label" placeholder="Stripe" />
              </div>
              <div className="row">
                <div className="spacer" />
                <button className="primary">Connect</button>
              </div>
            </form>
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

function Webhooks({ connection, editable }: { connection: Connection; editable: boolean }) {
  const { teammates } = useDashboard()
  const all = useApi<Webhook[]>('/webhooks')
  const hooks = (all.data ?? []).filter((w) => w.connectionId === connection.id)
  const [adding, setAdding] = useState(false)
  const [created, setCreated] = useState<{ url: string; signingSecret?: string }>()
  const [error, setError] = useState<string>()
  const stripe = connection.kind === 'stripe'

  async function create(form: FormData) {
    setError(undefined)
    try {
      const result = await api<{ url: string; signingSecret?: string }>('/webhooks', {
        body: {
          connectionId: connection.id,
          teammateId: String(form.get('teammateId')),
          label: String(form.get('label')),
          verification: String(form.get('verification')),
          ...(form.get('signingSecret')
            ? { signingSecret: String(form.get('signingSecret')) }
            : {}),
        },
      })
      setCreated(result)
      setAdding(false)
      await all.reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function setSecret(id: string, form: FormData) {
    setError(undefined)
    try {
      await api(`/webhooks/${id}`, {
        method: 'PATCH',
        body: { signingSecret: String(form.get('signingSecret')) },
      })
      await all.reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function remove(id: string) {
    if (!confirm('Delete this webhook? Its URL stops working.')) return
    await api(`/webhooks/${id}`, { method: 'DELETE' }).catch((e) => setError((e as Error).message))
    await all.reload()
  }

  return (
    <div className="stack" style={{ marginTop: 10 }}>
      <p className="hint" style={{ margin: 0 }}>
        Each event posted to a webhook URL starts a new thread for its teammate, with the payload as
        the first message. It runs on the accounts of the admin who set it up. A payload can ask for
        anything, so every change a webhook thread makes through a connector waits for a person.
      </p>
      {created && (
        <div className="card" style={{ background: 'var(--sunken)' }}>
          <div>
            URL: <code style={{ wordBreak: 'break-all' }}>{created.url}</code>
          </div>
          {created.signingSecret && (
            <div style={{ marginTop: 6 }}>
              Signing secret (shown once):{' '}
              <code style={{ wordBreak: 'break-all' }}>{created.signingSecret}</code>
              <div className="hint">
                The sender signs each body with HMAC-SHA256 and sends{' '}
                <code>X-Brigade-Signature: sha256=&lt;hex&gt;</code>.
              </div>
            </div>
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {hooks.length > 0 && (
        <ul className="list">
          {hooks.map((w) => (
            <li key={w.id} style={{ display: 'block' }}>
              <div className="row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div>
                    {w.label} <span className="hint">→ {w.teammate.name}</span>
                  </div>
                  <code className="hint" style={{ wordBreak: 'break-all', fontSize: 12 }}>
                    {w.url}
                  </code>
                </div>
                {w.verification !== 'none' && !w.hasSecret ? (
                  <span className="badge danger">needs signing secret</span>
                ) : (
                  <span className={`badge ${w.verification === 'none' ? 'warn' : 'ok'}`}>
                    {w.verification === 'none' ? 'unsigned' : `${w.verification} signature`}
                  </span>
                )}
                {editable && (
                  <button className="danger" onClick={() => void remove(w.id)}>
                    Delete
                  </button>
                )}
              </div>
              {editable && w.verification === 'stripe' && !w.hasSecret && (
                <form
                  action={(form) => void setSecret(w.id, form)}
                  className="row"
                  style={{ marginTop: 8 }}
                >
                  <input
                    name="signingSecret"
                    type="password"
                    autoComplete="off"
                    placeholder="Add this URL as an endpoint in Stripe, then paste its whsec_… secret"
                    required
                  />
                  <button className="primary">Save</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable &&
        (adding ? (
          <form action={create} className="card stack">
            <div className="field">
              <label htmlFor="label">Name</label>
              <input
                id="label"
                name="label"
                required
                placeholder={stripe ? 'Disputes and failed payments' : 'New support request'}
              />
            </div>
            <div className="field">
              <label htmlFor="teammateId">Teammate</label>
              <select id="teammateId" name="teammateId" required>
                {teammates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="verification">Verify the sender with</label>
              <select
                id="verification"
                name="verification"
                defaultValue={stripe ? 'stripe' : 'hmac'}
              >
                {stripe && <option value="stripe">Stripe signature</option>}
                <option value="hmac">A signing secret Brigade generates</option>
                <option value="none">Nothing (the URL alone)</option>
              </select>
            </div>
            {stripe && (
              <div className="field">
                <label htmlFor="signingSecret">Stripe signing secret</label>
                <input
                  id="signingSecret"
                  name="signingSecret"
                  type="password"
                  autoComplete="off"
                  placeholder="whsec_…"
                />
                <p className="hint">
                  Leave it empty for now if you have not added the URL in Stripe yet: create the
                  webhook, add its URL as an endpoint in Stripe, then paste the secret here. Events
                  are refused until it is set.
                </p>
              </div>
            )}
            <div className="row">
              <div className="spacer" />
              <button type="button" onClick={() => setAdding(false)}>
                Cancel
              </button>
              <button className="primary">Create webhook</button>
            </div>
          </form>
        ) : (
          <div>
            <button onClick={() => setAdding(true)}>Add a webhook</button>
          </div>
        ))}
    </div>
  )
}
