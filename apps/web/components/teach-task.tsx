'use client'
// Teach a task: the computer over the whole window, as "Open computer" shows it,
// with a bar at the top to record the person doing a task there. Start takes
// control; Pause leaves out what they do until Resume (a sign-in); Done asks
// for an optional note, then sends the recording to the teammate as `/teach`,
// which it learns as a skill of its own (the brigade-teach skill).
import { ATTACHMENT_MAX } from '@brigade/contracts'
import { Circle, Pause, Play, Send, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CloseButton } from '@/components/computer-panel'
import { DesktopScreen } from '@/components/desktop-preview'
import { useEscapeToClose } from '@/components/side-panel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, uploadAttachment, type Thread } from '@/lib/api'
import { canRecord, DemoRecorder } from '@/lib/demo-recorder'
import { cn } from '@/lib/utils'

/** Longest recording: its video stays under an attachment's 25 MB. */
const MAX_MS = 10 * 60_000

type Phase = 'ready' | 'starting' | 'recording' | 'paused' | 'note' | 'sending'

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function TeachTask({
  thread,
  memberId,
  status,
  onChange,
  onSend,
  onClose,
}: {
  thread: Thread
  memberId: string
  status: string
  onChange: () => void
  /** Send the message to the thread, with its files: as the composer sends one. */
  onSend: (text: string, attachmentIds: string[]) => Promise<void>
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const recorder = useRef<DemoRecorder | null>(null)
  // Control taken for this recording: given back when it ends, however it ends.
  const took = useRef(false)
  const [phase, setPhase] = useState<Phase>('ready')
  const [elapsed, setElapsed] = useState(0)
  const [note, setNote] = useState('')
  const [hint, setHint] = useState<string>()
  const [error, setError] = useState<string>()
  const name = thread.teammate.name
  const mine = !!memberId && thread.controlledByMemberId === memberId
  const otherHasControl = !!thread.controlledByMemberId && !mine
  const working = status === 'running' || status === 'starting'
  const recording = phase === 'recording' || phase === 'paused'

  // The timer, and the end of a recording that reaches the longest.
  useEffect(() => {
    if (phase !== 'recording') return
    const tick = setInterval(() => {
      const ms = recorder.current?.elapsed ?? 0
      setElapsed(ms)
      if (ms >= MAX_MS) {
        recorder.current?.pause()
        setHint(`Recordings stop at ${MAX_MS / 60_000} minutes.`)
        setPhase('note')
      }
    }, 250)
    return () => clearInterval(tick)
  }, [phase])

  useEffect(() => {
    if (!hint) return
    const timer = setTimeout(() => setHint(undefined), 6000)
    return () => clearTimeout(timer)
  }, [hint])

  // Leaving the page drops the recording; never keep control for it.
  useEffect(
    () => () => {
      recorder.current?.discard()
      if (took.current)
        void api(`/threads/${thread.id}/handback`, { body: { note: '' } }).catch(() => undefined)
    },
    [thread.id],
  )

  function close() {
    if (
      (recording || phase === 'note') &&
      !confirm('Discard this recording? Nothing is sent to ' + name + '.')
    )
      return
    recorder.current?.discard()
    recorder.current = null
    if (took.current) {
      took.current = false
      void api(`/threads/${thread.id}/handback`, { body: { note: '' } })
        .then(onChange)
        .catch(() => undefined)
    }
    onClose()
  }
  // Not while the screen has the keyboard: its Escape goes to the computer (data-keyboard).
  useEscapeToClose(ref, close)

  async function start() {
    setError(undefined)
    const canvas = stage.current?.querySelector('canvas')
    if (!stage.current || !canvas) {
      setError('The screen is not connected yet. Try again in a moment.')
      return
    }
    setPhase('starting')
    try {
      if (!mine) {
        // Working: its turn stops first, so it doesn't move the mouse in the recording.
        await api(`/threads/${thread.id}/takeover`, { body: { interrupt: working } })
        took.current = true
        onChange()
      }
      recorder.current = new DemoRecorder(stage.current, canvas)
      setElapsed(0)
      setPhase('recording')
      canvas.focus({ preventScroll: true })
    } catch (e) {
      setError((e as Error).message)
      setPhase('ready')
    }
  }

  function pause() {
    recorder.current?.pause()
    setPhase('paused')
  }

  function resume() {
    recorder.current?.resume()
    setPhase('recording')
  }

  function done() {
    const r = recorder.current
    if (!r) return
    if (r.actions === 0) {
      setHint('Nothing recorded yet: open the app or site and do the task, then click Done.')
      return
    }
    r.pause()
    setElapsed(r.elapsed)
    setPhase('note')
  }

  async function send() {
    const r = recorder.current
    if (!r) return
    setPhase('sending')
    setError(undefined)
    try {
      const demo = await r.finish(note)
      recorder.current = null
      // The steps are what the teammate learns from; the video is for people, when it fits.
      const files = demo.video.size <= ATTACHMENT_MAX ? [demo.video, demo.steps] : [demo.steps]
      const uploaded = await Promise.all(files.map((f) => uploadAttachment(f, () => undefined)))
      if (took.current || mine) {
        took.current = false
        await api(`/threads/${thread.id}/handback`, { body: { note: '' } })
      }
      await onSend(
        ['/teach', note.trim()].filter(Boolean).join(' '),
        uploaded.map((u) => u.id),
      )
      onChange()
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setPhase('note')
    }
  }

  const message = otherHasControl
    ? 'Another member has control of this computer: teach a task once they hand it back.'
    : !canRecord()
      ? 'This browser can’t record the screen. Try Chrome, Edge or Firefox.'
      : phase === 'ready' || phase === 'starting'
        ? `Record yourself doing a task. ${name} learns the steps and can do them again on its own.` +
          (working ? ` Starting stops what ${name} is doing.` : '')
        : phase === 'recording'
          ? `${name} is watching and learning`
          : phase === 'paused'
            ? `Paused: ${name} isn’t watching. Resume when you’re back on the task.`
            : phase === 'sending'
              ? `Sending the recording to ${name}…`
              : null

  return createPortal(
    <div
      ref={ref}
      className="fixed inset-0 z-50 flex flex-col bg-black"
      aria-label={`Teach ${name} a task`}
      role="region"
    >
      <div className="flex min-h-14 shrink-0 items-center gap-3 bg-background px-4 py-2">
        {phase === 'note' ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void send()
            }}
          >
            <Input
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={`What were you doing? Optional, it helps ${name}`}
              aria-label="What the task is"
              className="min-w-0 flex-1"
              maxLength={2000}
            />
            <Button type="submit" size="sm">
              <Send aria-hidden />
              Send to {name}
            </Button>
          </form>
        ) : (
          <p className="min-w-0 flex-1 truncate text-sm" title={message ?? undefined}>
            {hint ? <span className="text-destructive-text">{hint}</span> : message}
          </p>
        )}
        {error && <p className="max-w-80 truncate text-sm text-destructive-text">{error}</p>}
        {(phase === 'ready' || phase === 'starting') && (
          <Button
            size="sm"
            variant="destructive"
            disabled={phase === 'starting' || otherHasControl || !canRecord()}
            onClick={() => void start()}
          >
            <Circle aria-hidden className="fill-current" />
            Start recording
          </Button>
        )}
        {recording && (
          <>
            <span
              className="flex items-center gap-1.5 text-sm text-destructive-text tabular-nums"
              aria-label={`Recorded ${clock(elapsed)}`}
            >
              <span
                aria-hidden
                className={cn(
                  'size-2.5 rounded-full bg-destructive',
                  phase === 'recording' && 'animate-pulse',
                )}
              />
              {clock(elapsed)}
            </span>
            {phase === 'recording' ? (
              <Button
                size="sm"
                variant="outline"
                onClick={pause}
                title="Leave out what you do until you resume, such as signing in"
              >
                <Pause aria-hidden />
                Pause
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={resume}>
                <Play aria-hidden />
                Resume
              </Button>
            )}
            <Button size="sm" onClick={done} title={`Stop and send it to ${name}`}>
              <Square aria-hidden className="fill-current" />
              Done
            </Button>
          </>
        )}
        <CloseButton
          label={recording || phase === 'note' ? 'Discard the recording' : 'Close'}
          title={recording || phase === 'note' ? 'Discard (Esc)' : 'Close (Esc)'}
          onClick={close}
        />
      </div>
      <div
        ref={stage}
        className={cn(
          'relative m-2 mt-0 min-h-0 flex-1 overflow-hidden rounded-lg',
          phase === 'recording' && 'ring-2 ring-destructive',
        )}
      >
        <DesktopScreen
          source={{ thread: thread.id }}
          teammateName={name}
          control={mine && (phase === 'recording' || phase === 'paused')}
          mode="open"
        />
      </div>
    </div>,
    document.body,
  )
}
