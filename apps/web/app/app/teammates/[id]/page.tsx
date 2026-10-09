'use client'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { Composer } from '@/components/composer'
import { isAdmin, useDashboard } from '@/components/dashboard'
import { TeammateAccess } from '@/components/teammate-access'
import { TeammateBrowser } from '@/components/teammate-browser'
import { TeammateForm } from '@/components/teammate-form'
import { TeammateOversight } from '@/components/teammate-oversight'
import { ThreadList } from '@/components/thread-list'
import {
  api,
  harnessLabel,
  useApi,
  usableComputers,
  computerName,
  type Account,
  type ComputersResponse,
  type ThreadSummary,
} from '@/lib/api'

export default function TeammatePage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { me, teammates, reloadTeammates } = useDashboard()
  const teammate = teammates.find((t) => t.id === id)
  const threads = useApi<ThreadSummary[]>(`/threads?teammateId=${id}`)
  const computers = useApi<ComputersResponse>('/computers')
  const accounts = useApi<Account[]>('/accounts')
  const [computerId, setComputerId] = useState<string>()
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const formRef = useRef<HTMLFormElement>(null)

  if (!teammate) return <p className="hint">Loading…</p>
  const online = usableComputers(computers.data)
  const selectedComputer = computerId ?? online[0]?.id
  const usable = (accounts.data ?? []).filter(
    (a) =>
      a.computer.id === selectedComputer &&
      a.provider === teammate.harness &&
      (a.status === 'ready' || a.status === 'unverified') &&
      !(a.exhaustedUntil && new Date(a.exhaustedUntil) > new Date()),
  )

  async function start(form: FormData) {
    if (busy || !text.trim() || !online.length) return
    setBusy(true)
    setError(undefined)
    try {
      const thread = await api<{ id: string }>('/threads', {
        body: {
          teammateId: id,
          computerId: String(form.get('computerId')),
          text: String(form.get('text')),
          ...(form.get('accountId') ? { accountId: String(form.get('accountId')) } : {}),
        },
      })
      router.push(`/app/threads/${thread.id}`)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  async function archive() {
    if (!confirm(`Archive ${teammate!.name}? Its threads stay in the run log.`)) return
    await api(`/teammates/${id}`, { method: 'DELETE' })
    await reloadTeammates()
    router.push('/app')
  }

  return (
    <div className="stack">
      <div className="row">
        <h1 style={{ margin: 0 }}>{teammate.name}</h1>
        <span className="badge">{harnessLabel(teammate.harness)}</span>
        <div className="spacer" />
        {isAdmin(me) && (
          <>
            <button onClick={() => setEditing(!editing)}>{editing ? 'Close' : 'Edit'}</button>
            <button className="danger" onClick={archive}>
              Archive
            </button>
          </>
        )}
      </div>
      {editing ? (
        <TeammateForm
          initial={teammate}
          submitLabel="Save"
          onSubmit={async (input) => {
            await api(`/teammates/${id}`, { method: 'PATCH', body: input })
            await reloadTeammates()
            setEditing(false)
          }}
        />
      ) : (
        teammate.instructions && (
          <p className="hint" style={{ whiteSpace: 'pre-wrap' }}>
            {teammate.instructions}
          </p>
        )
      )}

      <form ref={formRef} action={start} className="card">
        <div className="field">
          <label htmlFor="text">New thread</label>
          <Composer
            id="text"
            name="text"
            rows={4}
            value={text}
            onChange={setText}
            onSubmit={() => formRef.current?.requestSubmit()}
            placeholder={`What should ${teammate.name} do? @ to mention a connection or thread`}
          />
        </div>
        {online.length === 0 ? (
          <p className="hint">
            No computer is online. <Link href="/app/computers">Link your machine</Link> to run
            threads on it.
          </p>
        ) : (
          <div className="row">
            <label htmlFor="computerId" style={{ margin: 0 }}>
              Run on
            </label>
            <select
              id="computerId"
              name="computerId"
              style={{ width: 'auto' }}
              value={computerId ?? online[0]!.id}
              onChange={(e) => setComputerId(e.target.value)}
            >
              {online.map((c) => (
                <option key={c.id} value={c.id}>
                  {computerName(c)}
                </option>
              ))}
            </select>
            {usable.length === 0 ? (
              <span className="hint">
                No {harnessLabel(teammate.harness)} account here.{' '}
                <Link href="/app/accounts">Add one</Link>
              </span>
            ) : (
              <select
                name="accountId"
                style={{ width: 'auto' }}
                aria-label="Account"
                defaultValue={usable.find((a) => a.isDefault)?.id}
              >
                {usable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                    {a.email ? ` (${a.email})` : ''}
                  </option>
                ))}
              </select>
            )}
            <div className="spacer" />
            <button className="primary" disabled={busy || !text.trim()}>
              Start thread
            </button>
          </div>
        )}
        {error && (
          <p className="error" style={{ marginTop: 12 }}>
            {error}
          </p>
        )}
      </form>

      <TeammateAccess
        teammate={teammate}
        editable={isAdmin(me)}
        onPolicyChange={() => void reloadTeammates()}
      />

      <TeammateBrowser
        teammate={teammate}
        computer={computers.data?.computers.find(
          (c) => c.kind === 'cloud' && !['destroyed', 'error'].includes(c.status),
        )}
      />

      <TeammateOversight
        teammate={teammate}
        editable={isAdmin(me)}
        onCapsChange={() => void reloadTeammates()}
      />

      <h2 style={{ marginTop: 24 }}>Threads</h2>
      {threads.data && <ThreadList threads={threads.data} showTeammate={false} />}
    </div>
  )
}
