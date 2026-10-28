'use client'
// Beside a long thread, a mark for each message a person wrote: hover one to read its start,
// click it to go there. A message not loaded loads with its own page only (useThreadEvents'
// jumpTo), never the whole thread up to it.
import { groupMarks, mentionsToText, type TimelineMessage } from '@brigade/contracts'
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
/** Closer than this to the end of the conversation, it is at the end. */
const END_PX = 8

/** The timeline's marks, and the messages people wrote that are loaded, by where they are. */
export type ThreadPrompts = { marks: TimelineMessage[]; mine: Set<number> }

/**
 * The messages people wrote in the thread, as marks, oldest first: one each, or in a long
 * thread at most THREAD_TIMELINE_MARKS, each standing for several in a row. A thread
 * loaded from its start (`whole`) makes them from its items; another asks the API once,
 * only when the timeline shows (`wanted`), which groups them and cuts each mark's start in
 * the database. Messages loaded after that answer get a mark each. Until it is in, none:
 * the timeline shows once, with all its marks, rather than growing as the rest arrives.
 */
export function useThreadPrompts(
  threadId: string,
  items: Item[],
  whole: boolean,
  wanted: boolean,
): ThreadPrompts {
  const [fetched, setFetched] = useState<{ threadId: string; marks: TimelineMessage[] }>()
  const asked = useRef<string>(undefined)
  useEffect(() => {
    if (whole || !wanted || asked.current === threadId) return
    asked.current = threadId
    api<TimelineMessage[]>(`/threads/${threadId}/prompts`)
      .then((marks) => setFetched({ threadId, marks }))
      // Without it, the timeline holds what is loaded.
      .catch(() => setFetched({ threadId, marks: [] }))
  }, [threadId, whole, wanted])
  const ready = whole || fetched?.threadId === threadId
  return useMemo(() => {
    const loaded = items.flatMap((item) =>
      item.kind === 'user' && !item.note && !item.brigade && !item.email
        ? [
            {
              seq: item.seq,
              at: new Date(item.at).toISOString(),
              text: item.handed?.note ?? item.text,
            },
          ]
        : [],
    )
    const mine = new Set(loaded.map((m) => m.seq))
    if (!ready) return { marks: [], mine }
    if (whole || fetched?.threadId !== threadId) return { marks: groupMarks(loaded), mine }
    // What the answer counted: messages after it are new, a mark each.
    const through = Math.max(0, ...fetched.marks.map((m) => m.last))
    const after = loaded.filter((m) => m.seq > through)
    return {
      marks: [...fetched.marks, ...after.map((m) => ({ ...m, count: 1, last: m.seq }))],
      mine,
    }
  }, [ready, whole, fetched, threadId, items])
}

/**
 * The timeline, in the conversation's left margin: shown while the conversation is wide
 * enough for it, long enough to need it, and has a few messages from people.
 */
export function ThreadTimeline({
  scroller,
  prompts: { marks: prompts, mine },
  long,
  onJump,
}: {
  /** What scrolls the conversation: which message is in view, and whether it is long. */
  scroller: RefObject<HTMLElement | null>
  prompts: ThreadPrompts
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
  const frame = useRef(0)
  const seqs = useMemo(() => prompts.map((p) => p.seq), [prompts])

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

  // The message being read: the last one whose top is above the upper part of the view, or,
  // at the end, the last one in sight (the last messages never scroll up that far). One
  // clicked stays it until the person scrolls on their own: near the end, it cannot reach
  // that line either.
  const clicked = useRef<number>(undefined)
  useEffect(() => {
    const view = scroller.current
    if (!view || !fits) return
    let frame = 0
    const find = () => {
      frame = 0
      const box = view.getBoundingClientRect()
      // Out of sight (the scroll bar, back to the end…), it no longer says.
      const node =
        clicked.current !== undefined &&
        view.querySelector<HTMLElement>(`[data-seq="${clicked.current}"]`)
      const rect = node ? node.getBoundingClientRect() : undefined
      if (rect && rect.bottom > box.top && rect.top < box.bottom) return setCurrent(clicked.current)
      // Not in yet (its page loading): it waits.
      if (clicked.current !== undefined && !node) return setCurrent(clicked.current)
      clicked.current = undefined
      const atEnd = view.scrollHeight - view.scrollTop - view.clientHeight < END_PX
      const line = atEnd ? box.bottom : box.top + view.clientHeight * 0.4
      let at: number | undefined
      for (const node of view.querySelectorAll<HTMLElement>('[data-seq]')) {
        const seq = Number(node.dataset.seq)
        if (!mine.has(seq)) continue
        if (node.getBoundingClientRect().top > line) break
        at = seq
      }
      // The mark it is in: the last that starts at or before it.
      setCurrent(at === undefined ? undefined : seqs.findLast((s) => s <= at))
    }
    const onScroll = () => {
      frame ||= requestAnimationFrame(find)
    }
    // Scrolled by the person: what is in view says again.
    const own = () => {
      clicked.current = undefined
      onScroll()
    }
    find()
    view.addEventListener('scroll', onScroll, { passive: true })
    view.addEventListener('wheel', own, { passive: true })
    view.addEventListener('touchmove', own, { passive: true })
    view.addEventListener('keydown', own)
    return () => {
      view.removeEventListener('scroll', onScroll)
      view.removeEventListener('wheel', own)
      view.removeEventListener('touchmove', own)
      view.removeEventListener('keydown', own)
      cancelAnimationFrame(frame)
    }
  }, [scroller, fits, seqs, mine])

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
      className="absolute top-1/2 left-3 z-10 flex [contain:layout_style] -translate-y-1/2 animate-in flex-col duration-[220ms] ease-out fade-in motion-reduce:animate-none"
      style={{ height: `min(${prompts.length * MARK_PX}px, 60vh)` }}
      // Once a frame at most: a pointer reports more often than the screen draws. Its layout
      // is contained: a mark or the card moving lays out the timeline, not the whole thread.
      onPointerMove={(e) => {
        const y = e.clientY
        if (frame.current) return
        frame.current = requestAnimationFrame(() => {
          frame.current = 0
          const f = toIndex(y)
          if (f === undefined) return
          setPointer(f)
          setHovered(prompts[Math.round(f)]?.seq)
        })
      }}
      onPointerLeave={() => {
        cancelAnimationFrame(frame.current)
        frame.current = 0
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
            onClick={() => {
              clicked.current = p.seq
              setCurrent(p.seq)
              onJump(p.seq)
            }}
          >
            <span
              className={cn(
                // Drawn at its widest and scaled: only the compositor works as it swells.
                'h-0.5 origin-left rounded-full transition-[transform,background-color,opacity] duration-150 ease-out will-change-transform motion-reduce:transition-none',
                p.seq === hovered
                  ? 'bg-foreground'
                  : isCurrent
                    ? 'bg-primary'
                    : 'bg-muted-foreground',
              )}
              style={{
                width: PEAK_PX,
                transform: `scaleX(${width / PEAK_PX})`,
                opacity: p.seq === hovered || isCurrent ? 1 : 0.35 + 0.5 * near,
              }}
            />
          </button>
        )
      })}
      {shown && (
        // Slides from mark to mark as the pointer moves along them.
        <div
          className="pointer-events-none absolute w-72 -translate-y-1/2 animate-in rounded-xl border bg-popover px-3 py-2 text-[13px] leading-snug text-popover-foreground shadow-lg transition-[top] duration-150 ease-out fade-in slide-in-from-left-1 motion-reduce:animate-none motion-reduce:transition-none"
          style={{ top: `${((at + 0.5) / prompts.length) * 100}%`, left: PEAK_PX + 16 }}
        >
          <p className="line-clamp-2 break-words">{preview(shown.text) || 'Attachment'}</p>
          {shown.count > 1 && (
            <p className="mt-1 text-xs text-muted-foreground">
              and {shown.count - 1} more {shown.count === 2 ? 'message' : 'messages'} after it
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">{pauseLabel(Date.parse(shown.at))}</p>
        </div>
      )}
    </nav>
  )
}

/** A message's start as one line of plain text. */
const preview = (text: string) => mentionsToText(text).replace(/\s+/g, ' ').trim()
