'use client'
// Dictation in the composers, as in ChatGPT: the microphone turns the box into a live waveform
// with ✕ (throw it away), stop (its words go in the box, to read and edit) and send (its words
// are sent at once). The recording goes to the API, which has Groq's Whisper hear it
// (apps/api/src/dictation.ts); nothing is kept. It comes with Brigade Cloud.
import {
  DICTATION_MAX_BYTES,
  DICTATION_MAX_SECONDS,
  type DictationResult,
  type DictationStatus,
} from '@brigade/contracts'
import { ArrowUp, LoaderCircle, Mic, X } from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ApiError, useApi } from '@/lib/api'
import { API_URL } from '@/lib/config'
import { cn } from '@/lib/utils'

/** How often the waveform takes the microphone's level, in ms: one bar each time. */
const STEP_MS = 60
/** A level (0–1) above which the recording holds something worth sending. */
const HEARD = 0.12

/** The types to record in, the first a browser can: Opus where it can, AAC on Safari. */
const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']

export type DictationPhase = 'idle' | 'starting' | 'recording' | 'transcribing'

/** Whether this browser can record at all (not over plain http, nor in an old browser). */
const canRecord = () =>
  typeof window !== 'undefined' &&
  typeof MediaRecorder !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia

/** The microphone's level, 0 to 1, from its samples' loudness, eased so speech fills the bar. */
export function levelOf(samples: Float32Array) {
  let sum = 0
  for (const s of samples) sum += s * s
  const rms = Math.sqrt(sum / (samples.length || 1))
  return Math.min(1, Math.sqrt(rms) * 1.8)
}

/** What the API said went wrong, in words for the person. */
function problem(e: unknown) {
  if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError'))
    return 'Brigade may not use the microphone: allow it in your browser’s or system’s settings'
  if (e instanceof DOMException && e.name === 'NotFoundError') return 'No microphone was found'
  if (e instanceof ApiError) return e.message
  return 'Dictation failed, try again'
}

async function post(audio: Blob, signal: AbortSignal) {
  const form = new FormData()
  form.append('audio', audio, 'dictation')
  const response = await fetch(`${API_URL}/api/dictation`, {
    method: 'POST',
    credentials: 'include',
    body: form,
    signal,
  })
  const body = (await response.json().catch(() => ({}))) as Partial<DictationResult> & {
    error?: string
  }
  if (!response.ok) throw new ApiError(body.error ?? response.statusText, response.status, body)
  return body.text ?? ''
}

/**
 * Records the microphone and hands back its words. `onText(words, send)`: `send` when the
 * person pressed send while recording, to send the message as soon as the words are in.
 */
export function useDictation(onText: (text: string, send: boolean) => void) {
  const [phase, setPhase] = useState<DictationPhase>('idle')
  const [error, setError] = useState<string>()
  /** The levels heard so far, newest last: the waveform reads them as it draws. */
  const levels = useRef<number[]>([])
  const live = useRef<{
    stream: MediaStream
    recorder: MediaRecorder
    audio: AudioContext
    timer: ReturnType<typeof setInterval>
    limit: ReturnType<typeof setTimeout>
    chunks: Blob[]
    heard: boolean
  } | null>(null)
  const request = useRef<AbortController | null>(null)
  /** Counts cancels: a start still waiting for the microphone when one comes gives up. */
  const session = useRef(0)
  const latest = useRef(onText)
  latest.current = onText

  /** Lets go of the microphone; what was recorded stays in `chunks` until dropped. */
  const release = useCallback(() => {
    const now = live.current
    if (!now) return
    clearInterval(now.timer)
    clearTimeout(now.limit)
    now.stream.getTracks().forEach((t) => t.stop())
    void now.audio.close().catch(() => undefined)
  }, [])

  const cancel = useCallback(() => {
    session.current++
    request.current?.abort()
    request.current = null
    const now = live.current
    if (now && now.recorder.state !== 'inactive') {
      now.recorder.ondataavailable = null
      now.recorder.onstop = null
      now.recorder.stop()
    }
    release()
    live.current = null
    levels.current = []
    setPhase('idle')
  }, [release])

  /** Stops recording and has its words heard: in the box, or sent with `send`. */
  const finish = useCallback(
    (send: boolean) => {
      const now = live.current
      if (!now || now.recorder.state === 'inactive') return
      setPhase('transcribing')
      now.recorder.onstop = () => {
        release()
        live.current = null
        const type = now.recorder.mimeType || now.chunks[0]?.type || 'audio/webm'
        const audio = new Blob(now.chunks, { type })
        if (!now.heard || audio.size === 0) {
          levels.current = []
          setPhase('idle')
          setError('Nothing was heard')
          return
        }
        if (audio.size > DICTATION_MAX_BYTES) {
          levels.current = []
          setPhase('idle')
          setError('That recording is too long to transcribe')
          return
        }
        const controller = new AbortController()
        request.current = controller
        post(audio, controller.signal)
          .then((text) => {
            if (controller.signal.aborted) return
            if (text) latest.current(text, send)
            else setError('Nothing was heard')
          })
          .catch((e: unknown) => {
            if (!controller.signal.aborted) setError(problem(e))
          })
          .finally(() => {
            if (request.current !== controller) return
            request.current = null
            levels.current = []
            setPhase('idle')
          })
      }
      now.recorder.stop()
    },
    [release],
  )

  const start = useCallback(async () => {
    if (live.current || request.current) return
    const mine = ++session.current
    setError(undefined)
    setPhase('starting')
    levels.current = []
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
    } catch (e) {
      if (mine !== session.current) return
      setPhase('idle')
      setError(problem(e))
      return
    }
    // Cancelled (✕, or the box gone) while the browser asked for the microphone: let it go.
    if (mine !== session.current) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    try {
      const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t))
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      const audio = new AudioContext()
      const analyser = audio.createAnalyser()
      analyser.fftSize = 1024
      audio.createMediaStreamSource(stream).connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      const chunks: Blob[] = []
      const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples)
        const level = levelOf(samples)
        if (level > HEARD && live.current) live.current.heard = true
        levels.current.push(level)
        // A few screens' worth is all the waveform shows.
        if (levels.current.length > 600) levels.current.splice(0, levels.current.length - 600)
      }, STEP_MS)
      // At the longest, it stops by itself and its words go in the box.
      const limit = setTimeout(() => finish(false), DICTATION_MAX_SECONDS * 1000)
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      live.current = { stream, recorder, audio, timer, limit, chunks, heard: false }
      recorder.start(1000)
      setPhase('recording')
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop())
      live.current = null
      setPhase('idle')
      setError(problem(e))
    }
  }, [finish])

  // Leaving the page (or the thread) lets go of the microphone and throws the recording away.
  useEffect(() => cancel, [cancel])

  return {
    phase,
    /** Recording or transcribing: the box shows the dictation bar in place of the message. */
    active: phase !== 'idle',
    error,
    clearError: () => setError(undefined),
    levels,
    start,
    cancel,
    finish,
  }
}

export type Dictation = ReturnType<typeof useDictation>

/** Whether the microphone shows in the composers, and why it would not record. */
export function useDictationStatus() {
  const [supported, setSupported] = useState(false)
  useEffect(() => setSupported(canRecord()), [])
  const { data } = useApi<DictationStatus>(supported ? '/dictation' : null)
  if (!supported || !data || (!data.available && data.reason === 'off')) return null
  return data
}

/** The microphone button beside send. Without the plan, it says so and opens Billing. */
export function DictationButton({
  status,
  dictation,
  className,
}: {
  status: DictationStatus | null
  dictation: Dictation
  className?: string
}) {
  if (!status) return null
  const style = cn('rounded-full [&_svg:not([class*="size-"])]:size-[1.125rem]', className)
  if (!status.available)
    return (
      <Button
        asChild
        variant="ghost"
        size="icon-sm"
        className={cn(style, 'text-muted-foreground')}
        tooltip="Dictation comes with Brigade Cloud"
      >
        <Link href="/app/billing" aria-label="Dictation comes with Brigade Cloud">
          <Mic aria-hidden />
        </Link>
      </Button>
    )
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={style}
      disabled={dictation.phase === 'starting'}
      onClick={() => void dictation.start()}
      aria-label="Dictate"
      tooltip="Dictate"
    >
      <Mic aria-hidden />
    </Button>
  )
}

/** The levels as a waveform that scrolls left as it records: a dot for silence, a bar for sound. */
function Waveform({ levels }: { levels: React.RefObject<number[]> }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    let frame = 0
    const draw = () => {
      frame = requestAnimationFrame(draw)
      const ratio = window.devicePixelRatio || 1
      const width = el.clientWidth
      const height = el.clientHeight
      if (el.width !== Math.round(width * ratio) || el.height !== Math.round(height * ratio)) {
        el.width = Math.round(width * ratio)
        el.height = Math.round(height * ratio)
      }
      const ctx = el.getContext('2d')
      if (!ctx) return
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = getComputedStyle(el).color
      const gap = 4
      const bar = 2
      const count = Math.floor(width / gap)
      const heard = levels.current ?? []
      const middle = height / 2
      // Newest at the right; before anything was heard, dots all the way.
      for (let i = 0; i < count; i++) {
        const level = heard[heard.length - count + i] ?? 0
        const h = Math.max(bar, level * height)
        const x = width - (count - i) * gap + (gap - bar) / 2
        ctx.globalAlpha = level * height > bar ? 1 : 0.5
        ctx.beginPath()
        ctx.roundRect(x, middle - h / 2, bar, h, bar / 2)
        ctx.fill()
      }
    }
    draw()
    return () => cancelAnimationFrame(frame)
  }, [levels])
  return <canvas ref={canvas} aria-hidden className="h-6 w-full text-muted-foreground" />
}

/** The box while dictating: ✕, the waveform (or Transcribing), stop and send. */
export function DictationBar({ dictation }: { dictation: Dictation }) {
  const transcribing = dictation.phase === 'transcribing'
  const round = "rounded-full [&_svg:not([class*='size-'])]:size-4"
  return (
    <div className="flex min-h-9 items-center gap-2" role="group" aria-label="Dictation">
      <Button
        type="button"
        variant="secondary"
        size="icon-sm"
        className={round}
        onClick={dictation.cancel}
        aria-label="Cancel dictation"
        tooltip="Cancel"
      >
        <X aria-hidden />
      </Button>
      <div className="flex min-w-0 flex-1 items-center justify-center">
        {transcribing ? (
          <span className="text-sm text-muted-foreground" aria-live="polite">
            Transcribing
          </span>
        ) : (
          <Waveform levels={dictation.levels} />
        )}
      </div>
      <Button
        type="button"
        variant="secondary"
        size="icon-sm"
        className={round}
        disabled={transcribing}
        onClick={() => dictation.finish(false)}
        aria-label={transcribing ? 'Transcribing…' : 'Stop and edit the text'}
        tooltip={transcribing ? 'Transcribing…' : 'Stop and edit the text'}
      >
        {transcribing ? (
          <LoaderCircle aria-hidden className="animate-spin" />
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="size-3!">
            <rect x="3" y="3" width="18" height="18" rx="4" />
          </svg>
        )}
      </Button>
      <Button
        type="button"
        size="icon-sm"
        className="rounded-full [&_svg:not([class*='size-'])]:size-5"
        disabled={transcribing}
        onClick={() => dictation.finish(true)}
        aria-label="Stop and send"
        tooltip="Stop and send"
      >
        <ArrowUp aria-hidden />
      </Button>
    </div>
  )
}

/** Words heard, after what is in the box already, on a line of their own when it ends with one. */
export function withDictated(text: string, words: string) {
  if (!text.trim()) return words
  return /\s$/.test(text) ? `${text}${words}` : `${text} ${words}`
}
