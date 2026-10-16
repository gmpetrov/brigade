'use client'
import { Maximize2, Minimize2, RotateCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  KeyboardField,
  TouchButtons,
  useKeyboardInset,
  useTouchScreen,
} from '@/components/desktop-touch'
import { api, ApiError } from '@/lib/api'
import type { DesktopInput } from '@/lib/desktop-input'
import { useRememberedFlag } from '@/lib/use-remembered'
import { cn } from '@/lib/utils'
import { DesktopView, type DesktopConnection } from './desktop-view'

/** Whether the computer panel is open, remembered in this browser. */
export const useDesktopPreview = () => useRememberedFlag('brigade.desktopPreview', false)

/** Reconnects in a row before giving up and showing the error. */
const RETRIES = 5

/**
 * The workspace computer's screen. In the details panel a thumbnail, view only,
 * that opens the computer on a click. Open, it fills its place: mouse and
 * keyboard once this member has taken over, its controls in a toolbar floating
 * over its foot. On a touch screen, two fingers zoom, and with control the toolbar
 * adds a keyboard and copy and paste.
 */
export function DesktopScreen({
  source,
  teammateName,
  control,
  mode,
  onOpen,
  onCollapse,
  onConnect,
  toolbar,
}: {
  /**
   * Whose view of the workspace computer: a thread's, which may take control, or
   * a teammate's, to watch or to record a task (the same screen).
   */
  source: { thread: string } | { teammate: string }
  teammateName: string
  /** This member has taken over: the screen takes the mouse and keyboard (open only). */
  control: boolean
  mode: 'thumbnail' | 'open'
  /** Thumbnail: a click opens the computer. */
  onOpen?: () => void
  /** Open: back to the thread, if there is one to go back to. */
  onCollapse?: () => void
  /** Open: what goes first in the toolbar, before Reconnect and Collapse (Take control, the shell). */
  toolbar?: ReactNode
  /** The screen shows: each time it connects, and again after a reconnect. */
  onConnect?: () => void
}) {
  const threadId = 'thread' in source ? source.thread : undefined
  const base = threadId
    ? `/threads/${threadId}`
    : `/teammates/${'teammate' in source ? source.teammate : ''}`
  const [connection, setConnection] = useState<DesktopConnection>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const [retries, setRetries] = useState(0)

  const [waiting, setWaiting] = useState<string>()
  const [input, setInput] = useState<DesktopInput>()
  const touch = useTouchScreen()
  const keys = touch && mode === 'open' && control
  const field = useRef<HTMLTextAreaElement>(null)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const frame = useRef<HTMLElement>(null)
  const inset = useKeyboardInset(frame, keyboardOpen)

  useEffect(() => {
    let live = true
    let retry: ReturnType<typeof setTimeout> | undefined
    setConnection(undefined)
    setError(undefined)
    api<DesktopConnection>(`${base}/desktop`, { method: 'POST' })
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
  }, [base, attempt])

  const onLost = useCallback(
    (reason: string) => {
      if (reason === 'refused' || retries >= RETRIES) {
        setConnection(undefined)
        setError(
          reason === 'refused'
            ? "The desktop refused the computer's password."
            : 'The desktop connection was lost.',
        )
        return
      }
      setRetries((n) => n + 1)
      setTimeout(() => setAttempt((n) => n + 1), 1000 * 2 ** retries)
    },
    [retries],
  )

  // Copy and paste come with control: a thread's, or a teammate's while recording a task.
  const clipboard = useMemo(() => {
    const path = `${base}/desktop/clipboard`
    return {
      set: (text: string) => api(path, { body: { text } }).then(() => undefined),
      get: () => api<{ text: string }>(path, { body: {} }).then((r) => r.text),
    }
  }, [base])

  const reload = () => {
    setRetries(0)
    setAttempt((n) => n + 1)
  }

  const screen = connection ? (
    <DesktopView
      connection={connection}
      control={mode === 'open' && control}
      focus={mode === 'open'}
      zoom={mode === 'open'}
      clipboard={clipboard}
      onInput={setInput}
      onConnect={() => {
        setRetries(0)
        onConnect?.()
      }}
      onLost={onLost}
    />
  ) : (
    <p
      className={cn(
        'p-4 text-center text-sm',
        error ? 'text-destructive-text' : 'text-muted-foreground',
      )}
    >
      {error ?? waiting ?? 'Connecting to the desktop…'}
    </p>
  )

  if (mode === 'thumbnail')
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${teammateName}'s computer`}
        title="Open the computer"
        className="group relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg border bg-black outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {/* The screen shows, but the click is the button's: control is once it is open. */}
        <span className="pointer-events-none flex size-full items-center justify-center">
          {screen}
        </span>
        <Badge
          variant="secondary"
          className="absolute top-2 left-2 bg-background/85 text-muted-foreground"
        >
          {control ? 'You have control' : 'View only'}
        </Badge>
        <span className="absolute inset-0 flex items-center justify-center gap-2 bg-background/60 text-sm font-semibold opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          <Maximize2 aria-hidden className="size-4" />
          Open computer
        </span>
      </button>
    )

  return (
    <section
      ref={frame}
      className="relative size-full min-h-0 overflow-hidden bg-black"
      aria-label={`${teammateName}'s screen`}
    >
      {keys && <KeyboardField input={input} fieldRef={field} onOpen={setKeyboardOpen} />}
      {/* What the on-screen keyboard leaves visible: the screen and its toolbar stay above it. */}
      <div
        className="absolute inset-x-0 flex items-center justify-center"
        style={{ top: inset.top, bottom: inset.bottom }}
      >
        {screen}
      </div>
      <div
        role="toolbar"
        aria-label="Computer"
        className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-xl border bg-background/95 p-1.5 shadow-lg backdrop-blur"
        style={{ bottom: inset.bottom + 16 }}
      >
        {toolbar}
        {keys && (
          <TouchButtons
            input={input}
            keyboardOpen={keyboardOpen}
            onKeyboard={() => {
              if (keyboardOpen) field.current?.blur()
              else field.current?.focus({ preventScroll: true })
            }}
          />
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={reload}
          aria-label="Reconnect"
          title="Reconnect"
        >
          <RotateCw aria-hidden />
        </Button>
        {onCollapse && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onCollapse}
            aria-label="Back to the thread"
            title="Back to the thread (Esc)"
          >
            <Minimize2 aria-hidden />
          </Button>
        )}
      </div>
    </section>
  )
}
