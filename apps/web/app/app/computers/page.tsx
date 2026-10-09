'use client'
import { useState } from 'react'
import { isAdmin, timeAgo, useDashboard } from '@/components/dashboard'
import { api, useApi, type Computer, type ComputersResponse } from '@/lib/api'
import { useLive } from '@/lib/use-live'

type LinkCode = { code: string; expiresAt: string; command: string }

const STATUS: Record<Computer['status'], { label: string; tone: string }> = {
  pending: { label: 'waiting for its runner', tone: '' },
  creating: { label: 'setting up', tone: 'warn' },
  starting: { label: 'starting', tone: 'warn' },
  running: { label: 'running', tone: 'ok' },
  stopped: { label: 'stopped, starts on demand', tone: '' },
  error: { label: 'error', tone: 'danger' },
  destroyed: { label: 'removed', tone: '' },
}

export default function Computers() {
  const { me } = useDashboard()
  const computers = useApi<ComputersResponse>('/computers')
  const [link, setLink] = useState<LinkCode>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  useLive((message) => {
    if (message.type === 'computer.updated') void computers.reload()
  })

  async function act<T>(fn: () => Promise<T>) {
    setBusy(true)
    setError(undefined)
    try {
      return await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
      void computers.reload()
    }
  }

  const all = computers.data?.computers ?? []
  const cloud = all.find((c) => c.kind === 'cloud')
  const mine = all.filter((c) => c.kind === 'member_machine')

  return (
    <div className="stack">
      <h1>Computers</h1>
      {error && <p className="error">{error}</p>}

      <section className="card stack">
        <h2>Workspace computer</h2>
        <p className="hint">
          The workspace&apos;s own cloud computer. Any member can run threads on it. It stops after
          a while with nothing to do, and starts again on the next message. A workspace is one trust
          zone: its teammates are separated by Linux user, which is weaker than separate machines,
          so keep sensitive work in its own workspace.
        </p>
        {cloud ? (
          <div className="row">
            <span className={`dot ${cloud.online ? 'on' : ''}`} />
            <span>{cloud.online ? 'Connected' : 'Not connected'}</span>
            <span className={`badge ${STATUS[cloud.status].tone}`}>
              {STATUS[cloud.status].label}
            </span>
            <div className="spacer" />
            {cloud.status === 'stopped' && (
              <button
                disabled={busy}
                onClick={() =>
                  void act(() => api(`/computers/${cloud.id}/start`, { method: 'POST' }))
                }
              >
                Start
              </button>
            )}
            {cloud.status === 'running' && (
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const { url } = await api<{ url: string }>(`/computers/${cloud.id}/desktop`, {
                      method: 'POST',
                    })
                    window.open(url, '_blank', 'noopener')
                  })
                }
              >
                Open desktop
              </button>
            )}
            {isAdmin(me) && cloud.status === 'running' && (
              <button
                disabled={busy}
                onClick={() =>
                  void act(() => api(`/computers/${cloud.id}/stop`, { method: 'POST' }))
                }
              >
                Stop
              </button>
            )}
          </div>
        ) : computers.data?.cloudAvailable ? (
          isAdmin(me) ? (
            <button
              className="primary"
              disabled={busy}
              onClick={() => void act(() => api('/computers/cloud', { method: 'POST' }))}
            >
              Create the workspace computer
            </button>
          ) : (
            <p className="hint">Ask an owner or admin to create it.</p>
          )
        ) : (
          <p className="hint">Cloud computers are not configured on this Brigade server.</p>
        )}
      </section>

      <section className="stack">
        <h2 style={{ marginTop: 16 }}>Your machines</h2>
        <p className="hint">
          On your own machine, a teammate acts as you: it uses your files, your logins and your
          browser, so it asks before every write and every command. Only you can run threads on it.
        </p>
        {mine.length > 0 && (
          <ul className="list">
            {mine.map((c) => (
              <li key={c.id}>
                <span className={`dot ${c.online ? 'on' : ''}`} />
                <div style={{ flex: 1 }}>
                  <div>{c.name}</div>
                  <div className="hint">
                    {[
                      c.runner?.platform,
                      c.runner?.version && `runner ${c.runner.version}`,
                      !c.online &&
                        c.runner?.lastSeenAt &&
                        `last seen ${timeAgo(c.runner.lastSeenAt)}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                <span className={`badge ${c.online ? 'ok' : ''}`}>
                  {c.online ? 'online' : 'offline'}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="card">
          <h2>Link your machine</h2>
          {link ? (
            <>
              <p className="hint">
                Run this in a terminal on your Mac or Linux machine. The code works once and expires
                at {new Date(link.expiresAt).toLocaleTimeString()}.
              </p>
              <pre
                className="card"
                style={{
                  background: 'var(--sunken)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                {link.command}
              </pre>
            </>
          ) : (
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void act(async () =>
                  setLink(await api<LinkCode>('/computers/link-code', { method: 'POST' })),
                )
              }
            >
              Get the install command
            </button>
          )}
        </div>
      </section>
    </div>
  )
}
