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
const MARK_PX = 8

/**
 * The messages people wrote in the thread, oldest first. Those loaded come from its items;
 * a thread not loaded from its start (`whole` false) asks the API once for the others, and
 * only when the timeline shows (`wanted`): each one's start, cut in the database.
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
      .catch(() => (asked.current = undefined))
  }, [threadId, whole, wanted])
  return useMemo(() => {
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
  }, [fetched, threadId, items])
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
  return (
    <nav
      aria-label="Your messages in this thread"
      className="absolute top-1/2 left-2 z-10 flex -translate-y-1/2 flex-col"
      style={{ height: `min(${prompts.length * MARK_PX}px, 60vh)` }}
      onMouseLeave={() => setHovered(undefined)}
    >
      {prompts.map((p) => (
        <button
          key={p.seq}
          type="button"
          aria-label={preview(p.text) || 'Message'}
          aria-current={p.seq === current ? 'location' : undefined}
          className="group flex min-h-0 w-6 flex-1 items-center outline-none"
          onMouseEnter={() => setHovered(p.seq)}
          onFocus={() => setHovered(p.seq)}
          onBlur={() => setHovered(undefined)}
          onClick={() => onJump(p.seq)}
        >
          <span
            className={cn(
              'h-px rounded-full transition-all',
              p.seq === current
                ? 'w-3.5 bg-primary'
                : 'w-2 bg-muted-foreground/40 group-hover:bg-foreground',
              p.seq === hovered && 'w-3.5 bg-foreground',
            )}
          />
        </button>
      ))}
      {shown && (
        <div
          className="pointer-events-none absolute left-7 w-72 -translate-y-1/2 rounded-lg border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
          style={{ top: `${((at + 0.5) / prompts.length) * 100}%` }}
        >
          <p className="line-clamp-3 break-words">{preview(shown.text) || 'Attachment'}</p>
          <p className="mt-1 text-xs text-muted-foreground">{pauseLabel(Date.parse(shown.at))}</p>
        </div>
      )}
    </nav>
  )
}

/** A message's start as one line of plain text. */
const preview = (text: string) => mentionsToText(text).replace(/\s+/g, ' ').trim()
