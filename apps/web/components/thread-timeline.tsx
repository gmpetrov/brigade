'use client'
// Beside a long thread, a mark for each message a person wrote: hover one to read its start,
// click it to go there. A message not loaded loads with its own page only (useThreadEvents'
// jumpTo), never the whole thread up to it.
import { mentionsToText, type TimelineMessage } from '@brigade/contracts'
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { Item } from '@/components/thread-view'
import { api } from '@/lib/api'
import { pauseLabel } from '@/lib/thread-times'
import { cn } from '@/lib/utils'

/** Fewer messages than this read fine by scrolling: no timeline. */
const MIN_PROMPTS = 3
/** Room for each mark, until the timeline reaches its tallest. */
const MARK_PX = 10
/** A mark's width at rest, as the message being read, and under the pointer. */
const REST_PX = 6
const CURRENT_PX = 10
const PEAK_PX = 26
/** How far, in marks, the pointer's swell reaches either side. */
const SPREAD = 1.6

/**
 * The messages people wrote in the thread, oldest first. Those loaded come from its items;
 * a thread not loaded from its start (`whole` false) asks the API once for the others, and
 * only when the timeline shows (`wanted`): each one's start, cut in the database. Until
 * that answer is in, none: the timeline shows once, with all its marks, rather than
 * growing as the rest arrives.
 */
export function useThreadPrompts(
  threadId: string,
  items: Item[],
  whole: boolean,
  wanted: boolean,
): TimelineMessage[] {
  const [fetched, setFetched] = useState<{ threadId: string; prompts: TimelineMessage[] }>()
  const asked = useRef<string>(undefined)
  useEffect(() => {
    if (whole || !wanted || asked.current === threadId) return
    asked.current = threadId
    api<TimelineMessage[]>(`/threads/${threadId}/prompts`)
      .then((prompts) => setFetched({ threadId, prompts }))
      // Without it, the timeline holds what is loaded.
      .catch(() => setFetched({ threadId, prompts: [] }))
  }, [threadId, whole, wanted])
  const ready = whole || fetched?.threadId === threadId
  return useMemo(() => {
    if (!ready) return []
    const bySeq = new Map<number, TimelineMessage>()
    if (fetched?.threadId === threadId) for (const p of fetched.prompts) bySeq.set(p.seq, p)
    for (const item of items)
      if (item.kind === 'user' && !item.note && !item.brigade && !item.email)
        bySeq.set(item.seq, {
          seq: item.seq,
          at: new Date(item.at).toISOString(),
          text: item.handed?.note ?? item.text,
        })
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  }, [ready, fetched, threadId, items])
}

/**
 * The timeline, in the conversation's left margin: shown while the conversation is wide
 * enough for it, long enough to need it, and has a few messages from people.
 */
export function ThreadTimeline({
  scroller,
  prompts,
  long,
  onJump,
}: {
  /** What scrolls the conversation: which message is in view, and whether it is long. */
  scroller: RefObject<HTMLElement | null>
  prompts: TimelineMessage[]
  /** The thread is not loaded from its start: long, whatever its height now. */
  long: boolean
  onJump: (seq: number) => void
}) {
  const [fits, setFits] = useState(false)
  const [current, setCurrent] = useState<number>()
  const [hovered, setHovered] = useState<number>()
  // Where the pointer is along the marks, in marks (fractional), while it is over them.
  const [pointer, setPointer] = useState<number>()
  const railRef = useRef<HTMLElement>(null)
  const seqs = useMemo(() => new Set(prompts.map((p) => p.seq)), [prompts])

  // Its room and its length, as the conversation resizes or grows.
  useEffect(() => {
    const view = scroller.current
    if (!view) return
    const measure = () =>
      setFits(view.clientWidth >= 768 && (long || view.scrollHeight > view.clientHeight * 2))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(view)
    if (view.firstElementChild) observer.observe(view.firstElementChild)
    return () => observer.disconnect()
  }, [scroller, long])

  // The message being read: the last one whose top is above the upper part of the view.
  useEffect(() => {
    const view = scroller.current
    if (!view || !fits) return
    let frame = 0
    const find = () => {
      frame = 0
      const line = view.getBoundingClientRect().top + view.clientHeight * 0.4
      let at: number | undefined
      for (const node of view.querySelectorAll<HTMLElement>('[data-seq]')) {
        const seq = Number(node.dataset.seq)
        if (!seqs.has(seq)) continue
        if (node.getBoundingClientRect().top > line) break
        at = seq
      }
      setCurrent(at)
    }
    const onScroll = () => {
      frame ||= requestAnimationFrame(find)
    }
    find()
    view.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      view.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
    }
  }, [scroller, fits, seqs])

  if (!fits || prompts.length < MIN_PROMPTS) return null
  const shown = prompts.find((p) => p.seq === hovered)
  const at = shown ? prompts.indexOf(shown) : -1
  // Under the pointer, marks swell like a dock: the nearest most, its neighbours less.
  const swell = (i: number) => {
    const from = pointer ?? (at >= 0 ? at : undefined)
    if (from === undefined) return 0
    const d = i - from
    return Math.exp(-(d * d) / (2 * SPREAD * SPREAD))
  }
  const toIndex = (clientY: number) => {
    const rail = railRef.current?.getBoundingClientRect()
    if (!rail) return undefined
    const f = ((clientY - rail.top) / rail.height) * prompts.length - 0.5
    return Math.min(prompts.length - 1, Math.max(0, f))
  }
  return (
    <nav
      ref={railRef}
      aria-label="Your messages in this thread"
      className="absolute top-1/2 left-3 z-10 flex -translate-y-1/2 animate-in flex-col duration-[220ms] ease-out fade-in motion-reduce:animate-none"
      style={{ height: `min(${prompts.length * MARK_PX}px, 60vh)` }}
      onPointerMove={(e) => {
        const f = toIndex(e.clientY)
        if (f === undefined) return
        setPointer(f)
        setHovered(prompts[Math.round(f)]?.seq)
      }}
      onPointerLeave={() => {
        setPointer(undefined)
        setHovered(undefined)
      }}
    >
      {prompts.map((p, i) => {
        const near = swell(i)
        const isCurrent = p.seq === current
        const width = Math.max(
          isCurrent ? CURRENT_PX : REST_PX,
          REST_PX + (PEAK_PX - REST_PX) * near,
        )
        return (
          <button
            key={p.seq}
            type="button"
            aria-label={preview(p.text) || 'Message'}
            aria-current={isCurrent ? 'location' : undefined}
            className="flex min-h-0 w-9 flex-1 items-center outline-none"
            onFocus={() => setHovered(p.seq)}
            onBlur={() => setHovered(undefined)}
            onClick={() => onJump(p.seq)}
          >
            <span
              className={cn(
                'h-0.5 rounded-full transition-[width,background-color,opacity] duration-150 ease-out motion-reduce:transition-none',
                p.seq === hovered
                  ? 'bg-foreground'
                  : isCurrent
                    ? 'bg-primary'
                    : 'bg-muted-foreground',
              )}
              style={{
                width,
                opacity: p.seq === hovered || isCurrent ? 1 : 0.35 + 0.5 * near,
              }}
            />
          </button>
        )
      })}
      {shown && (
        // Slides from mark to mark as the pointer moves along them.
        <div
          className="pointer-events-none absolute w-72 -translate-y-1/2 animate-in rounded-xl border bg-popover/95 px-3 py-2 text-[13px] leading-snug text-popover-foreground shadow-lg backdrop-blur-sm transition-[top] duration-150 ease-out fade-in slide-in-from-left-1 motion-reduce:animate-none motion-reduce:transition-none"
          style={{ top: `${((at + 0.5) / prompts.length) * 100}%`, left: PEAK_PX + 16 }}
        >
          <p className="line-clamp-2 break-words">{preview(shown.text) || 'Attachment'}</p>
          <p className="mt-1 text-xs text-muted-foreground">{pauseLabel(Date.parse(shown.at))}</p>
        </div>
      )}
    </nav>
  )
}

/** A message's start as one line of plain text. */
const preview = (text: string) => mentionsToText(text).replace(/\s+/g, ' ').trim()
