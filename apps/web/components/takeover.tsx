'use client'
import { useState } from 'react'
import { api, type Thread } from '@/lib/api'
import { Terminal } from './terminal'

/** Take over the workspace computer for a thread, then hand back. */
export function Takeover({
  thread,
  memberId,
  onChange,
}: {
  thread: Thread
  memberId: string
  onChange: () => void
}) {
  const [note, setNote] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const mine = thread.controlledByMemberId === memberId

  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(undefined)
    try {
      await fn()
      onChange()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (thread.computer.kind !== 'cloud') return null

  if (thread.controlledByMemberId && !mine) {
    return (
      <p className="hint">
        Another member has control of this thread. The teammate continues when they hand it back.
      </p>
    )
  }

  if (!mine) {
    return (
      <div className="row">
        <button
          disabled={busy}
          onClick={() =>
            void act(() => api(`/threads/${thread.id}/takeover`, { body: { interrupt: false } }))
          }
        >
          Take over
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void act(() => api(`/threads/${thread.id}/takeover`, { body: { interrupt: true } }))
          }
        >
          Take over now
        </button>
        <span className="hint">
          Use the computer yourself. The teammate waits until you hand back.
        </span>
        {error && <span className="error">{error}</span>}
      </div>
    )
  }

  return (
    <div className="card stack" style={{ borderColor: 'var(--warn)' }}>
      <div className="row">
        <strong>You have control</strong>
        <span className="hint">
          {thread.teammate.name} waits. Commands you run are recorded in the run log.
        </span>
        <div className="spacer" />
        <button
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const { url } = await api<{ url: string }>(
                `/computers/${thread.computer.id}/desktop`,
                { method: 'POST' },
              )
              window.open(url, '_blank', 'noopener')
            })
          }
        >
          Open desktop
        </button>
      </div>
      <Terminal sessionId={thread.id} />
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          void act(() => api(`/threads/${thread.id}/handback`, { body: { note } }))
        }}
      >
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note for the teammate (optional)"
          style={{ flex: 1, width: 'auto' }}
        />
        <button className="primary" disabled={busy}>
          Hand back
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  )
}
