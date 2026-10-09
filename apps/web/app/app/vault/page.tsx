'use client'
import Link from 'next/link'
import { useState, type InputHTMLAttributes } from 'react'
import { isAdmin, timeAgo, useDashboard } from '@/components/dashboard'
import { credentialHint, MentionIcon } from '@/components/mention'
import { api, useApi, type Credential, type CredentialKind, type CredentialUse } from '@/lib/api'

const KINDS: { kind: CredentialKind; label: string; hint: string }[] = [
  {
    kind: 'website',
    label: 'Website login',
    hint: 'Typed into the teammate’s browser on this site only. The teammate never sees the password.',
  },
  {
    kind: 'database',
    label: 'Database',
    hint: 'Given to the thread as a private env file (DATABASE_URL, PG* for Postgres).',
  },
  {
    kind: 'api_key',
    label: 'API key',
    hint: 'Given to the thread as a private env file (API_KEY, API_URL).',
  },
  {
    kind: 'other',
    label: 'Other secret',
    hint: 'Given to the thread as a private env file (SECRET).',
  },
]

const SECRET_LABEL: Record<CredentialKind, string> = {
  website: 'Password',
  database: 'Password',
  api_key: 'API key',
  other: 'Secret',
}
const SECRET_FIELD = {
  website: 'password',
  database: 'password',
  api_key: 'apiKey',
  other: 'value',
}

export default function VaultPage() {
  const { me } = useDashboard()
  const credentials = useApi<Credential[]>('/credentials')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string>()
  const [uses, setUses] = useState<string>()
  const [error, setError] = useState<string>()
  const mayEdit = (c: Credential) => isAdmin(me) || c.createdByMemberId === me.memberId

  async function remove(c: Credential) {
    if (
      !confirm(
        `Delete ${c.name}? Its secret is erased from the vault; teammates can no longer use it.`,
      )
    )
      return
    setError(undefined)
    await api(`/credentials/${c.id}`, { method: 'DELETE' }).catch((e) =>
      setError((e as Error).message),
    )
    await credentials.reload()
  }

  return (
    <div className="stack">
      <div className="row">
        <h1 style={{ margin: 0 }}>Vault</h1>
        <div className="spacer" />
        {!adding && (
          <button className="primary" onClick={() => setAdding(true)}>
            Add a credential
          </button>
        )}
      </div>
      <p className="hint">
        Logins, databases and keys your teammates can use. A secret is encrypted the moment you save
        it and is never shown again, here or to a teammate&apos;s model. Type <code>@</code> and its
        name in a thread to let that thread&apos;s teammate use it; anywhere else, it has to ask and
        a person approves.
      </p>
      {error && <p className="error">{error}</p>}

      {adding && (
        <CredentialForm
          onCancel={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false)
            await credentials.reload()
          }}
        />
      )}

      {credentials.data?.length === 0 && !adding ? (
        <p className="hint">Nothing in the vault yet.</p>
      ) : (
        <ul className="list">
          {(credentials.data ?? []).map((c) => (
            <li key={c.id} style={{ display: 'block' }}>
              <div className="row">
                <span className="mention-option-icon" aria-hidden>
                  <MentionIcon kind="credential" />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div>{c.name}</div>
                  <div className="hint">
                    {credentialHint(c)} · updated {timeAgo(c.updatedAt)}
                  </div>
                </div>
                <button onClick={() => setUses(uses === c.id ? undefined : c.id)}>
                  {uses === c.id ? 'Hide uses' : 'Uses'}
                </button>
                {mayEdit(c) && (
                  <>
                    <button onClick={() => setEditing(editing === c.id ? undefined : c.id)}>
                      Edit
                    </button>
                    <button className="danger" onClick={() => void remove(c)}>
                      Delete
                    </button>
                  </>
                )}
              </div>
              {editing === c.id && (
                <CredentialForm
                  credential={c}
                  onCancel={() => setEditing(undefined)}
                  onSaved={async () => {
                    setEditing(undefined)
                    await credentials.reload()
                  }}
                />
              )}
              {uses === c.id && <Uses credentialId={c.id} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Add a credential, or edit one: its secret is only replaced when typed again. */
function CredentialForm({
  credential,
  onCancel,
  onSaved,
}: {
  credential?: Credential
  onCancel: () => void
  onSaved: () => Promise<void>
}) {
  const [kind, setKind] = useState<CredentialKind>(credential?.kind ?? 'website')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const d = credential?.details ?? {}

  async function save(form: FormData) {
    setError(undefined)
    setBusy(true)
    const text = (key: string) => String(form.get(key) ?? '').trim() || undefined
    const port = text('port')
    const details = {
      ...(text('url') ? { url: text('url') } : {}),
      ...(text('username') ? { username: text('username') } : {}),
      ...(kind === 'database'
        ? {
            engine: text('engine'),
            ...(text('host') ? { host: text('host') } : {}),
            ...(port ? { port: Number(port) } : {}),
            ...(text('database') ? { database: text('database') } : {}),
          }
        : {}),
      ...(text('notes') ? { notes: text('notes') } : {}),
    }
    // Not trimmed: a secret is kept exactly as typed.
    const value = String(form.get('secret') ?? '')
    const secret = value ? { secret: { [SECRET_FIELD[kind]]: value } } : {}
    try {
      if (credential)
        await api(`/credentials/${credential.id}`, {
          method: 'PATCH',
          body: { name: text('name'), details, ...secret },
        })
      else await api('/credentials', { body: { kind, name: text('name'), details, ...secret } })
      await onSaved()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const field = (key: string, label: string, props: InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="field">
      <label htmlFor={`cred-${key}`}>{label}</label>
      <input id={`cred-${key}`} name={key} {...props} />
    </div>
  )

  return (
    <form action={save} className="card stack" style={{ marginTop: credential ? 10 : 0 }}>
      {!credential && (
        <div className="field">
          <label htmlFor="cred-kind">Kind</label>
          <select
            id="cred-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as CredentialKind)}
          >
            {KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
          <p className="hint">{KINDS.find((k) => k.kind === kind)!.hint}</p>
        </div>
      )}
      {field('name', 'Name', {
        required: true,
        maxLength: 80,
        defaultValue: credential?.name,
        placeholder:
          kind === 'website'
            ? 'GitHub (support bot)'
            : kind === 'database'
              ? 'Production database (read-only)'
              : 'OpenWeather API',
      })}
      {kind === 'website' &&
        field('url', 'Sign-in page', {
          type: 'url',
          required: true,
          defaultValue: d.url,
          placeholder: 'https://github.com/login',
        })}
      {kind === 'api_key' &&
        field('url', 'API base URL (optional)', {
          type: 'url',
          defaultValue: d.url,
          placeholder: 'https://api.example.com',
        })}
      {kind === 'database' && (
        <>
          <div className="field">
            <label htmlFor="cred-engine">Engine</label>
            <select id="cred-engine" name="engine" defaultValue={d.engine ?? 'postgres'}>
              <option value="postgres">PostgreSQL</option>
              <option value="mysql">MySQL</option>
              <option value="mongodb">MongoDB</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: 3 }}>
              {field('host', 'Host', {
                required: true,
                defaultValue: d.host,
                placeholder: 'db.internal',
              })}
            </div>
            <div style={{ flex: 1 }}>
              {field('port', 'Port', {
                type: 'number',
                min: 1,
                max: 65535,
                defaultValue: d.port,
                placeholder: '5432',
              })}
            </div>
          </div>
          {field('database', 'Database', { defaultValue: d.database, placeholder: 'app' })}
        </>
      )}
      {(kind === 'website' || kind === 'database') &&
        field('username', kind === 'website' ? 'Username or email' : 'User', {
          defaultValue: d.username,
          autoComplete: 'off',
        })}
      {field('secret', SECRET_LABEL[kind], {
        type: 'password',
        autoComplete: 'new-password',
        required: !credential,
        placeholder: credential ? 'Leave empty to keep the saved one' : '',
      })}
      <div className="field">
        <label htmlFor="cred-notes">Notes for teammates (optional)</label>
        <textarea
          id="cred-notes"
          name="notes"
          rows={2}
          maxLength={2000}
          defaultValue={d.notes}
          placeholder="Read-only replica. Ask before running anything heavy."
        />
      </div>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <div className="spacer" />
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary" disabled={busy}>
          {credential ? 'Save' : 'Add to vault'}
        </button>
      </div>
    </form>
  )
}

function Uses({ credentialId }: { credentialId: string }) {
  const uses = useApi<CredentialUse[]>(`/credentials/${credentialId}/uses`)
  if (!uses.data) return <p className="hint">Loading…</p>
  if (uses.data.length === 0)
    return (
      <p className="hint" style={{ marginTop: 8 }}>
        No teammate has used it yet.
      </p>
    )
  return (
    <table style={{ width: '100%', marginTop: 10, fontSize: 13, borderCollapse: 'collapse' }}>
      <tbody>
        {uses.data.map((u) => (
          <tr key={u.id} style={{ borderTop: '1px solid var(--border)' }}>
            <td className="hint" style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
              {timeAgo(u.at)}
            </td>
            <td style={{ padding: '4px 6px' }}>{u.teammate}</td>
            <td style={{ padding: '4px 6px' }}>
              {u.use === 'browser' ? 'signed in with it' : 'loaded it as an env file'}
            </td>
            <td style={{ padding: '4px 6px' }}>
              <span className={`badge ${u.via === 'mention' ? 'ok' : 'warn'}`}>
                {u.via === 'mention' ? 'mentioned' : 'approved'}
              </span>
            </td>
            <td style={{ padding: '4px 6px' }}>
              {u.sessionId && <Link href={`/app/threads/${u.sessionId}`}>thread</Link>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
