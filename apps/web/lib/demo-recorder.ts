import { zipFiles } from '@/lib/zip'

/**
 * Teach a task: records a person doing a task on the computer, from the
 * dashboard's own view of it. Everything they do there goes through this
 * page (the screen is a noVNC canvas; their clicks and keys are its events),
 * so it needs nothing on the computer: the video is the canvas's stream, and
 * each click, key and scroll is logged with the screen at that moment.
 *
 * A teammate can't watch a video, so it learns from the log and the frames
 * (`demonstration.zip`: steps.md and frames/); the video is for people. Typed
 * text is never logged, only how many characters: the frame after typing shows
 * what was typed, and a password field shows dots there.
 */

export type DemoStep = {
  /** Milliseconds into the recording, pauses left out. */
  at: number
  text: string
  /** Its frame in the zip, once taken. */
  frame?: string
}

export type Demonstration = { video: File; steps: File; count: number; duration: number }

/** Frames kept at most: a long demonstration logs its later steps without one. */
const MAX_FRAMES = 120
/** Widest frame, in pixels: enough to read a screen's text. */
const FRAME_WIDTH = 1600
/** Typing pauses this long before it counts as one step. */
const TYPING_IDLE = 1200
/** The screen a moment after a key or a scroll: what it did. */
const SETTLE = 800
/** Video bits per second: about 20 MB for ten minutes, under an attachment's 25 MB. */
const BITRATE = 250_000

const VIDEO_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']

/** Keys logged by name: what they do on the screen matters, unlike letters. */
const NAMED_KEYS = new Set([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Whether this browser can record the screen at all. */
export const canRecord = () =>
  typeof MediaRecorder !== 'undefined' &&
  typeof HTMLCanvasElement !== 'undefined' &&
  'captureStream' in HTMLCanvasElement.prototype

export class DemoRecorder {
  readonly steps: DemoStep[] = []
  private frames = new Map<string, Promise<Blob | null>>()
  private recorder: MediaRecorder
  private chunks: Blob[] = []
  private type: string
  private elapsedBefore = 0
  private since = 0
  private state: 'recording' | 'paused' | 'stopped' = 'recording'
  private typing: { count: number; started: number } | null = null
  private typingTimer: ReturnType<typeof setTimeout> | undefined
  private settleTimers = new Set<ReturnType<typeof setTimeout>>()
  private lastClick: { step: DemoStep; x: number; y: number; time: number } | null = null
  private down: { x: number; y: number; step: DemoStep } | null = null
  private scrolling: { step: DemoStep; until: number } | null = null
  private detach: () => void
  private readonly startedAt = new Date()
  private acted = 0

  /** `stage` holds the screen; its canvas is the computer's. */
  constructor(
    private stage: HTMLElement,
    private canvas: HTMLCanvasElement,
  ) {
    this.type = VIDEO_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
    this.recorder = new MediaRecorder(canvas.captureStream(10), {
      ...(this.type ? { mimeType: this.type } : {}),
      videoBitsPerSecond: BITRATE,
    })
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data)
    }
    this.recorder.start(1000)
    this.since = performance.now()
    this.log('Started recording', true)
    this.detach = this.listen()
  }

  /** Milliseconds recorded, pauses left out. */
  get elapsed() {
    return this.elapsedBefore + (this.state === 'recording' ? performance.now() - this.since : 0)
  }

  /** Steps the person took: clicks, keys, typing, scrolls, pastes. */
  get actions() {
    return this.acted + (this.typing ? 1 : 0)
  }

  pause() {
    if (this.state !== 'recording') return
    this.endTyping()
    this.elapsedBefore = this.elapsed
    this.state = 'paused'
    this.recorder.pause()
    this.steps.push({ at: this.elapsedBefore, text: 'Paused' })
  }

  resume() {
    if (this.state !== 'paused') return
    this.since = performance.now()
    this.state = 'recording'
    this.recorder.resume()
    // What changed while paused (a sign-in) is not in the log: show where it is now.
    this.log('Resumed', true)
  }

  /** Stop for good and hand over the video and the steps, with the person's note. */
  async finish(note: string): Promise<Demonstration> {
    this.endTyping()
    const duration = this.elapsed
    if (this.state === 'recording') this.log('Stopped recording', true)
    this.state = 'stopped'
    this.detach()
    for (const t of this.settleTimers) clearTimeout(t)
    const stopped = new Promise<void>((resolve) => {
      this.recorder.onstop = () => resolve()
    })
    if (this.recorder.state !== 'inactive') this.recorder.stop()
    await stopped
    const type = (this.type || this.chunks[0]?.type || 'video/webm').split(';')[0]!
    const video = new File(this.chunks, `demonstration.${type === 'video/mp4' ? 'mp4' : 'webm'}`, {
      type,
    })
    const frames: { path: string; data: Blob }[] = []
    for (const [path, blob] of this.frames) {
      const data = await blob
      if (data) frames.push({ path, data })
    }
    const kept = new Set(frames.map((f) => f.path))
    const zip = await zipFiles(
      [{ path: 'steps.md', data: this.markdown(duration, note, kept) }, ...frames],
      this.startedAt,
    )
    return {
      video,
      steps: new File([zip], 'demonstration.zip', { type: 'application/zip' }),
      count: this.steps.length,
      duration,
    }
  }

  /** Stop without keeping anything. */
  discard() {
    this.state = 'stopped'
    this.detach()
    clearTimeout(this.typingTimer)
    for (const t of this.settleTimers) clearTimeout(t)
    if (this.recorder.state !== 'inactive') this.recorder.stop()
    this.chunks = []
    this.frames.clear()
  }

  private markdown(duration: number, note: string, kept: Set<string>) {
    const rows = this.steps.map((s) => {
      const frame = s.frame && kept.has(s.frame) ? s.frame : ''
      return `| ${clock(s.at)} | ${s.text} | ${frame} |`
    })
    return [
      '# Demonstration',
      '',
      `Recorded ${this.startedAt.toISOString()}, ${clock(duration)} long, pauses left out. ` +
        `The screen is ${this.canvas.width}×${this.canvas.height}; positions are in its pixels, from the top left.`,
      'Each frame is the screen at that step: before a click, with a red ring where it landed; ' +
        'after typing, a key or a scroll. Typed text is not logged, only how many characters: ' +
        'read it on the frame after the typing (a password field shows dots).',
      ...(note.trim() ? ['', '## Their note', '', note.trim()] : []),
      '',
      '## Steps',
      '',
      '| Time | Step | Frame |',
      '| --- | --- | --- |',
      ...rows,
      '',
    ].join('\n')
  }

  private log(text: string, frame = false, mark?: { x: number; y: number }) {
    const step: DemoStep = { at: this.elapsed, text }
    this.steps.push(step)
    if (frame) step.frame = this.snapshot(mark)
    return step
  }

  /** The screen now, into the zip; its name, or none past the budget. */
  private snapshot(mark?: { x: number; y: number }) {
    if (this.frames.size >= MAX_FRAMES) return undefined
    const name = `frames/${String(this.frames.size + 1).padStart(3, '0')}.jpg`
    const source = this.canvas
    const scale = Math.min(1, FRAME_WIDTH / (source.width || 1))
    const frame = document.createElement('canvas')
    frame.width = Math.round(source.width * scale)
    frame.height = Math.round(source.height * scale)
    const ctx = frame.getContext('2d')
    if (!ctx) return undefined
    ctx.drawImage(source, 0, 0, frame.width, frame.height)
    if (mark) {
      const x = mark.x * scale
      const y = mark.y * scale
      ctx.lineWidth = 6
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
      ctx.beginPath()
      ctx.arc(x, y, 18, 0, Math.PI * 2)
      ctx.stroke()
      ctx.lineWidth = 3
      ctx.strokeStyle = '#ef4444'
      ctx.stroke()
    }
    this.frames.set(name, new Promise((resolve) => frame.toBlob(resolve, 'image/jpeg', 0.8)))
    return name
  }

  /** A frame of what a step did, once the screen settles. */
  private settle(step: DemoStep) {
    const timer = setTimeout(() => {
      this.settleTimers.delete(timer)
      if (this.state === 'recording' && !step.frame) step.frame = this.snapshot()
    }, SETTLE)
    this.settleTimers.add(timer)
  }

  /** The point on the computer's screen under a pointer event. */
  private point(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect()
    return {
      x: Math.round(((e.clientX - rect.left) * this.canvas.width) / (rect.width || 1)),
      y: Math.round(((e.clientY - rect.top) * this.canvas.height) / (rect.height || 1)),
    }
  }

  private endTyping() {
    clearTimeout(this.typingTimer)
    const typing = this.typing
    if (!typing) return
    this.typing = null
    const step: DemoStep = {
      at: typing.started,
      text: `Typed ${typing.count} character${typing.count === 1 ? '' : 's'}`,
    }
    this.steps.push(step)
    this.acted++
    step.frame = this.snapshot()
  }

  private listen() {
    const stage = this.stage
    const live = () => this.state === 'recording'

    const onPointerDown = (e: PointerEvent) => {
      if (!live() || e.target !== this.canvas) return
      this.endTyping()
      const p = this.point(e)
      const now = performance.now()
      const last = this.lastClick
      const button =
        e.button === 2 ? 'Right-clicked' : e.button === 1 ? 'Middle-clicked' : 'Clicked'
      if (
        button === 'Clicked' &&
        last &&
        now - last.time < 450 &&
        Math.abs(last.x - p.x) < 8 &&
        Math.abs(last.y - p.y) < 8
      ) {
        last.step.text = `Double-clicked at (${p.x}, ${p.y})`
        this.lastClick = null
        return
      }
      this.acted++
      const step = this.log(`${button} at (${p.x}, ${p.y})`, true, p)
      this.lastClick = { step, ...p, time: now }
      this.down = { ...p, step }
    }

    const onPointerUp = (e: PointerEvent) => {
      const down = this.down
      this.down = null
      if (!live() || !down) return
      const p = this.point(e)
      if (Math.hypot(p.x - down.x, p.y - down.y) < 12) return
      down.step.text = `Dragged from (${down.x}, ${down.y}) to (${p.x}, ${p.y})`
      this.lastClick = null
      this.settle(down.step)
    }

    const onWheel = (e: WheelEvent) => {
      if (!live() || e.target !== this.canvas) return
      const now = performance.now()
      const direction =
        Math.abs(e.deltaX) > Math.abs(e.deltaY)
          ? e.deltaX > 0
            ? 'right'
            : 'left'
          : e.deltaY > 0
            ? 'down'
            : 'up'
      const scrolling = this.scrolling
      if (
        scrolling &&
        now < scrolling.until &&
        scrolling.step.text.startsWith(`Scrolled ${direction}`)
      ) {
        scrolling.until = now + 1500
        return
      }
      this.endTyping()
      const p = this.point(e)
      this.acted++
      const step = this.log(`Scrolled ${direction} at (${p.x}, ${p.y})`)
      this.scrolling = { step, until: now + 1500 }
      // Once it stops: the frame shows where it scrolled to.
      const wait = () => {
        const s = this.scrolling
        if (s?.step !== step) return
        if (performance.now() < s.until) {
          const timer = setTimeout(() => {
            this.settleTimers.delete(timer)
            wait()
          }, 300)
          this.settleTimers.add(timer)
          return
        }
        if (live() && !step.frame) step.frame = this.snapshot()
      }
      wait()
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (!live() || e.repeat || ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key))
        return
      // Cmd is Ctrl on the computer (lib/desktop-input).
      const ctrl = e.ctrlKey || e.metaKey
      if (!ctrl && !e.altKey && (e.key.length === 1 || (e.key === 'Backspace' && this.typing))) {
        if (!this.typing) this.typing = { count: 0, started: this.elapsed }
        if (e.key.length === 1) this.typing.count++
        clearTimeout(this.typingTimer)
        this.typingTimer = setTimeout(() => this.endTyping(), TYPING_IDLE)
        return
      }
      if (!ctrl && !e.altKey && !NAMED_KEYS.has(e.key) && !/^F\d+$/.test(e.key)) return
      this.endTyping()
      const name = e.key.length === 1 ? e.key.toUpperCase() : e.key
      const chord = [ctrl && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', name]
        .filter(Boolean)
        .join('+')
      this.acted++
      this.settle(this.log(`Pressed ${chord}`))
    }

    const onPaste = () => {
      if (!live() || !stage.contains(document.activeElement)) return
      this.endTyping()
      this.acted++
      this.settle(this.log('Pasted text'))
    }

    stage.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointerup', onPointerUp, true)
    stage.addEventListener('wheel', onWheel, { capture: true, passive: true })
    stage.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('paste', onPaste, true)
    return () => {
      stage.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointerup', onPointerUp, true)
      stage.removeEventListener('wheel', onWheel, { capture: true })
      stage.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('paste', onPaste, true)
    }
  }
}
