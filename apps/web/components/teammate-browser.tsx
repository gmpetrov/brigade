'use client'
import { useState } from 'react'
import { openDesktop, type Computer, type Teammate } from '@/lib/api'

/**
 * The teammate's own browser on the workspace computer. A person signs it in
 * to sites here, through the computer's desktop; the sign-in stays in the
 * teammate's profile for all its threads.
 */
export function TeammateBrowser({
  teammate,
  computer,
}: {
  teammate: Teammate
  computer: Computer | undefined
}) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function open(e: React.FormEvent) {
    e.preventDefault()
    if (!computer) return
    setBusy(true)
    setError(undefined)
    try {
      await openDesktop(computer.id, {
        teammateId: teammate.id,
        ...(url.trim() ? { url: url.trim() } : {}),
      })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Browser</h2>
      {computer ? (
        <>
          <p className="hint" style={{ marginTop: 0 }}>
            {teammate.name} has its own browser on the workspace computer, shared by all its
            threads. To sign it in to a site, open it here, sign in on the desktop (including any
            second factor) and close the tab. The sign-in stays in {teammate.name}&apos;s profile
            only. Where Brigade has a connector for a service, grant that instead.
          </p>
          <form onSubmit={(e) => void open(e)} className="row" style={{ flexWrap: 'wrap' }}>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://site-to-sign-in-to.example (optional)"
              style={{ flex: '1 1 260px', width: 'auto' }}
            />
            <button className="primary" disabled={busy}>
              {busy ? 'Opening…' : `Open ${teammate.name}'s browser`}
            </button>
          </form>
          {error && (
            <p className="error" style={{ marginBottom: 0 }}>
              {error}
            </p>
          )}
        </>
      ) : (
        <p className="hint" style={{ margin: 0 }}>
          Teammate browsers live on the workspace computer. On your own machine, {teammate.name}{' '}
          uses your browser and the sign-ins already in it.
        </p>
      )}
    </div>
  )
}
