'use client'
import { Maximize2, Minimize2, RotateCw, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { api, ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
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
      data-desktop-panel
      className={cn(
        'flex flex-col overflow-hidden',
        expanded
          ? 'fixed inset-0 z-50 bg-background/95 backdrop-blur-sm'
          : 'mb-4 h-[60vh] rounded-xl border bg-card shadow-sm xl:fixed xl:inset-y-0 xl:right-0 xl:z-10 xl:mb-0 xl:h-auto xl:w-(--desktop-w) xl:rounded-none xl:border-y-0 xl:border-r-0 xl:shadow-none',
      )}
      aria-label={`${teammateName}'s desktop`}
    >
      <div
        className={cn('flex flex-nowrap items-center gap-2 px-3 py-2.5', !expanded && 'border-b')}
      >
        <strong className="min-w-0 truncate text-sm font-semibold">
          {teammateName}&apos;s computer
        </strong>
        <Badge variant="secondary" className="text-muted-foreground">
          {control ? 'You have control' : 'View only'}
        </Badge>
        <div className="flex-1" />
        <Button type="button" variant="ghost" size="sm" onClick={reload} title="Reconnect">
          <RotateCw aria-hidden />
          Reload
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => onExpand(!expanded)}
          aria-label={expanded ? 'Collapse desktop' : 'Expand desktop'}
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Close desktop"
        >
          <X aria-hidden />
        </Button>
      </div>
      <div
        className={cn(
          'flex min-h-0 flex-1 items-center justify-center',
          expanded ? 'px-6 pb-6' : 'bg-muted',
        )}
      >
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
          <p
            className={cn('p-4 text-sm', error ? 'text-destructive-text' : 'text-muted-foreground')}
          >
            {error ?? waiting ?? 'Connecting to the desktop…'}
          </p>
        )}
      </div>
      {!expanded && (
        <p className="border-t px-3 py-2 text-sm text-muted-foreground">
          {control
            ? 'Click the screen to use it. Copy and paste work both ways.'
            : 'Everything on the workspace computer shows here, other teammates’ browsers included. To use it yourself, take over.'}
        </p>
      )}
    </aside>
  )
}
