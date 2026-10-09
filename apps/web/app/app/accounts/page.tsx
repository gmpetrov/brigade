'use client'
import { useState } from 'react'
import {
  api,
  harnessLabel,
  useApi,
  usableComputers,
  computerName,
  type Account,
  type AccountLogin,
  type ComputersResponse,
} from '@/lib/api'
import { useLive } from '@/lib/use-live'

const resetLabel = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
    : ''

export default function Accounts() {
  const accounts = useApi<Account[]>('/accounts')
  const computers = useApi<ComputersResponse>('/computers')
  const [logins, setLogins] = useState<Record<string, AccountLogin>>({})
  const [error, setError] = useState<string>()

  useLive((message) => {
    if (message.type !== 'account.login') return
    setLogins((current) => ({ ...current, [message.accountId]: message }))
    if (message.state === 'done' || message.state === 'failed') void accounts.reload()
  })

  async function act(promise: Promise<unknown>) {
    setError(undefined)
    try {
      await promise
      await accounts.reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function add(form: FormData) {
    await act(
      api('/accounts', {
        body: {
          computerId: String(form.get('computerId')),
          provider: String(form.get('provider')),
        },
      }),
    )
  }

  const online = usableComputers(computers.data)
  const byProvider = (provider: Account['provider']) =>
    (accounts.data ?? []).filter((a) => a.provider === provider)

  return (
    <div className="stack">
      <h1>Accounts</h1>
      <p className="hint">
        Your Claude and Codex subscriptions. Add several of each: when one runs out of usage, your
        threads continue on the next. Accounts are yours alone; nobody else&apos;s threads use them.
        Brigade never sees your password or tokens: you sign in on the vendor&apos;s own page, and
        the login stays on the computer.
      </p>
      {error && <p className="error">{error}</p>}

      {(['claude_code', 'codex'] as const).map((provider) => (
        <section key={provider} className="stack">
          <h2 style={{ marginTop: 16 }}>{provider === 'codex' ? 'Codex' : 'Claude'}</h2>
          {byProvider(provider).length === 0 ? (
            <p className="hint">No {harnessLabel(provider)} accounts yet.</p>
          ) : (
            <ul className="list">
              {byProvider(provider).map((a) => (
                <AccountRow key={a.id} account={a} login={logins[a.id] ?? a.login} onAct={act} />
              ))}
            </ul>
          )}
        </section>
      ))}

      <form action={add} className="card">
        <h2>Add an account</h2>
        {online.length === 0 ? (
          <p className="hint">No computer is online.</p>
        ) : (
          <div className="row">
            <select name="provider" style={{ width: 'auto' }} aria-label="Provider">
              <option value="claude_code">Claude</option>
              <option value="codex">Codex (ChatGPT)</option>
            </select>
            <span className="hint">on</span>
            <select name="computerId" style={{ width: 'auto' }} aria-label="Computer">
              {online.map((c) => (
                <option key={c.id} value={c.id}>
                  {computerName(c)}
                </option>
              ))}
            </select>
            <div className="spacer" />
            <button className="primary">Sign in</button>
          </div>
        )}
      </form>
    </div>
  )
}

function AccountRow({
  account: a,
  login,
  onAct,
}: {
  account: Account
  login: AccountLogin | null
  onAct: (p: Promise<unknown>) => Promise<void>
}) {
  const [code, setCode] = useState('')
  const exhausted = a.exhaustedUntil && new Date(a.exhaustedUntil) > new Date()
  const signingIn =
    a.status === 'signing_in' && login && login.state !== 'done' && login.state !== 'failed'

  return (
    <li style={{ display: 'block' }}>
      <div className="row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div>
            {a.label} {a.isDefault && <span className="badge">default</span>}
          </div>
          <div className="hint">
            {[
              a.email,
              a.plan,
              a.computer.kind === 'cloud' ? 'workspace computer' : a.computer.name,
              a.source === 'machine' && "this machine's own login",
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
          {a.lastUsage && a.lastUsage.length > 0 && (
            <div className="hint">
              {a.lastUsage
                .map(
                  (l) =>
                    `${l.window.replace('_', ' ')} ${Math.round(l.utilization * 100)}%${l.resetsAt ? ` (resets ${resetLabel(l.resetsAt)})` : ''}`,
                )
                .join(' · ')}
            </div>
          )}
        </div>
        {exhausted ? (
          <span className="badge warn">out of usage until {resetLabel(a.exhaustedUntil)}</span>
        ) : a.status === 'needs_sign_in' ? (
          <span className="badge danger">needs sign-in</span>
        ) : a.status === 'signing_in' ? (
          <span className="badge warn">signing in</span>
        ) : (
          <span className="badge ok">ready</span>
        )}
        {!a.isDefault && a.status === 'ready' && (
          <button
            onClick={() =>
              void onAct(api(`/accounts/${a.id}`, { method: 'PATCH', body: { isDefault: true } }))
            }
          >
            Make default
          </button>
        )}
        {a.source === 'brigade' &&
          (a.status === 'needs_sign_in' || (a.status === 'signing_in' && !signingIn)) && (
            <button
              onClick={() => void onAct(api(`/accounts/${a.id}/sign-in`, { method: 'POST' }))}
            >
              Sign in again
            </button>
          )}
        <button
          className="danger"
          onClick={() => {
            if (
              confirm(
                `Remove ${a.label}? ${a.source === 'brigade' ? 'Its login is deleted from the computer.' : 'The login stays on your machine.'}`,
              )
            ) {
              void onAct(api(`/accounts/${a.id}`, { method: 'DELETE' }))
            }
          }}
        >
          Remove
        </button>
      </div>

      {signingIn && (
        <div className="card" style={{ marginTop: 10, background: 'var(--sunken)' }}>
          {login.state === 'starting' && (
            <p className="hint">Starting {harnessLabel(a.provider)} sign-in on the computer…</p>
          )}
          {login.state === 'open_url' && login.flow === 'device' && (
            <>
              <p>
                1. Open{' '}
                <a href={login.url} target="_blank" rel="noreferrer">
                  {login.url}
                </a>{' '}
                and sign in to ChatGPT.
              </p>
              <p>
                2. Enter this code there: <code style={{ fontSize: 18 }}>{login.userCode}</code>
              </p>
              <p className="hint">This page updates when you are done.</p>
            </>
          )}
          {login.state === 'open_url' && login.flow === 'paste' && (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault()
                void onAct(api(`/accounts/${a.id}/code`, { body: { code } }))
              }}
            >
              <p>
                1.{' '}
                <a className="button primary" href={login.url} target="_blank" rel="noreferrer">
                  Open Claude sign-in
                </a>
              </p>
              <p>2. Sign in to the Claude account you want to add. Claude then shows a code.</p>
              <div className="row">
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="3. Paste the code here"
                  autoComplete="off"
                  style={{ flex: 1, width: 'auto' }}
                />
                <button className="primary" disabled={!code.trim()}>
                  Finish
                </button>
              </div>
            </form>
          )}
          {login.state === 'verifying' && <p className="hint">Finishing sign-in…</p>}
        </div>
      )}
      {login?.state === 'failed' && (
        <p className="error" style={{ marginTop: 6 }}>
          Sign-in failed: {login.error}
        </p>
      )}
    </li>
  )
}
