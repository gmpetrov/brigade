'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { DesktopView, type DesktopConnection } from './desktop-view'

const KEY = 'brigade.desktopPreview'

/** Whether the desktop panel is open, remembered in this browser. */
export function useDesktopPreview() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    try {
      setOpen(localStorage.getItem(KEY) === '1')
    } catch {}
  }, [])
  const toggle = useCallback((next: boolean) => {
    setOpen(next)
    try {
      localStorage.setItem(KEY, next ? '1' : '0')
    } catch {}
  }, [])
  return [open, toggle] as const
}

/** Reconnects in a row before giving up and showing the error. */
const RETRIES = 5

/**
 * The workspace computer's desktop beside a thread. View only while the
 * teammate works; mouse and keyboard once this member has taken over.
 * Expanded, it fills the window.
 */
export function DesktopPreview({
  threadId,
  teammateName,
  control,
  expanded,
  onExpand,
  onClose,
}: {
  threadId: string
  teammateName: string
  control: boolean
  expanded: boolean
  onExpand: (expanded: boolean) => void
  onClose: () => void
}) {
  const [connection, setConnection] = useState<DesktopConnection>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const [retries, setRetries] = useState(0)

  const [waiting, setWaiting] = useState<string>()

  useEffect(() => {
    let live = true
    let retry: ReturnType<typeof setTimeout> | undefined
    setConnection(undefined)
    setError(undefined)
    api<DesktopConnection>(`/threads/${threadId}/desktop`, { method: 'POST' })
      .then((r) => {
        if (!live) return
        setWaiting(undefined)
        setConnection(r)
      })
      .catch((e: Error) => {
        if (!live) return
        // 503: the computer is starting for this member. Ask again until it is up.
        if (e instanceof ApiError && e.status === 503) {
          setWaiting(e.message)
          retry = setTimeout(() => setAttempt((n) => n + 1), 4000)
          return
        }
        setWaiting(undefined)
        setError(e.message)
      })
    return () => {
      live = false
      clearTimeout(retry)
    }
  }, [threadId, attempt])

  const onLost = useCallback(
    (reason: string) => {
      if (reason === 'refused' || retries >= RETRIES) {
        setConnection(undefined)
        setError('The desktop connection was lost.')
        return
      }
      setRetries((n) => n + 1)
      setTimeout(() => setAttempt((n) => n + 1), 1000 * 2 ** retries)
    },
    [retries],
  )

  const clipboard = useMemo(() => {
    const path = `/threads/${threadId}/desktop/clipboard`
    return {
      set: (text: string) => api(path, { body: { text } }).then(() => undefined),
      get: () => api<{ text: string }>(path, { body: {} }).then((r) => r.text),
    }
  }, [threadId])

  const reload = () => {
    setRetries(0)
    setAttempt((n) => n + 1)
  }

  return (
    <aside
      className={`desktop-panel${expanded ? ' expanded' : ''}`}
      aria-label={`${teammateName}'s desktop`}
    >
      <div className="row desktop-bar">
        <strong>{teammateName}&apos;s computer</strong>
        <span className="badge">{control ? 'You have control' : 'View only'}</span>
        <div className="spacer" />
        <button type="button" onClick={reload} title="Reconnect">
          Reload
        </button>
        <button
          type="button"
          onClick={() => onExpand(!expanded)}
          aria-label={expanded ? 'Collapse desktop' : 'Expand desktop'}
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? '↙' : '↗'}
        </button>
        <button type="button" onClick={onClose} aria-label="Close desktop">
          ✕
        </button>
      </div>
      <div className="desktop-screen">
        {connection ? (
          <DesktopView
            connection={connection}
            control={control}
            focus={expanded}
            clipboard={clipboard}
            onConnect={() => setRetries(0)}
            onLost={onLost}
          />
        ) : (
          <p className={error ? 'error' : 'hint'}>
            {error ?? waiting ?? 'Connecting to the desktop…'}
          </p>
        )}
      </div>
      {!expanded && (
        <p className="hint desktop-foot">
          {control
            ? 'Click the screen to use it. Copy and paste work both ways.'
            : 'Everything on the workspace computer shows here, other teammates’ browsers included. To use it yourself, take over.'}
        </p>
      )}
    </aside>
  )
}
