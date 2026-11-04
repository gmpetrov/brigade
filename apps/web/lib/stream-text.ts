// A reply as it streams in reads smoothly: its text arrives in bursts (the runner sends what came
// every 200 ms, DELTA_EVERY_MS), and the thread reveals it word by word at a steady pace that
// keeps up with what came (useSmoothText), its Markdown closed early so no `**` or backtick shows
// on its own while the rest of the line is on its way (closeOpenMarkdown).
import { useEffect, useRef, useState } from 'react'

/** Characters a second it reveals at least, however little waits. */
const MIN_RATE = 60
/** What waits is revealed in about this many seconds, however much came at once. */
const CATCH_UP_S = 0.35
/** Once the reply is done, the rest goes in about this long. */
const DONE_CATCH_UP_S = 0.15

/**
 * Where to cut `text` to show about `chars` of it: at the end of a word, never inside one. All
 * of it once `chars` reaches its end.
 */
export function wordCut(text: string, chars: number) {
  if (chars >= text.length) return text.length
  if (chars <= 0) return 0
  // Up to the last space within reach, with that space: the next word shows whole, later.
  const space = text.slice(0, chars + 1).search(/\s\S*$/)
  return space < 0 ? 0 : space + 1
}

/** How many characters to reveal in `dt` seconds while `waiting` of them wait. */
export function revealStep(waiting: number, dt: number, done: boolean) {
  const rate = Math.max(MIN_RATE, waiting / (done ? DONE_CATCH_UP_S : CATCH_UP_S))
  return rate * dt
}

/** How much of `a` and `b` is the same from their start. */
function sharedStart(a: string, b: string) {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

/**
 * The part of `text` to show while it streams in: word by word, at a pace that catches up with
 * what came within a third of a second. A message done when it first shows (an older one, or a
 * thread opened after it ended) shows whole at once, and so does what had come before it showed.
 * Text that changes rather than grows (the done message masks a secret, say) shows from where the
 * two still agree.
 */
export function useSmoothText(text: string, streaming: boolean) {
  const [shown, setShown] = useState(text.length)
  const target = useRef(text)
  const done = useRef(!streaming)
  // How far it got, in characters, fractions included: the cut shown rounds to a word.
  const at = useRef(text.length)
  const frame = useRef<number>(undefined)
  const last = useRef(0)

  useEffect(() => {
    const before = target.current
    target.current = text
    done.current = !streaming
    if (!text.startsWith(before.slice(0, Math.floor(at.current))))
      at.current = Math.min(at.current, sharedStart(before, text))
    if (at.current >= text.length) {
      at.current = text.length
      setShown(text.length)
      return
    }
    if (frame.current !== undefined) return
    last.current = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last.current) / 1000)
      last.current = now
      const full = target.current
      at.current = Math.min(
        full.length,
        at.current + revealStep(full.length - at.current, dt, done.current),
      )
      setShown(wordCut(full, Math.floor(at.current)))
      frame.current = at.current < full.length ? requestAnimationFrame(tick) : undefined
    }
    frame.current = requestAnimationFrame(tick)
  }, [text, streaming])

  useEffect(
    () => () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current)
      frame.current = undefined
    },
    [],
  )

  return text.slice(0, Math.min(shown, text.length))
}

/** Whether `text` ends inside a fenced code block (``` or ~~~ opened and not closed yet). */
function inFence(text: string) {
  let fence: string | undefined
  for (const line of text.split('\n')) {
    const mark = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1]
    if (!mark) continue
    if (!fence) fence = mark
    else if (mark[0] === fence[0] && mark.length >= fence.length && !line.trim().slice(mark.length))
      fence = undefined
  }
  return !!fence
}

/** `marker` closed at the end of `text`, before its trailing spaces; dropped when nothing follows it yet. */
function closeMarker(text: string, marker: string) {
  const body = text.trimEnd()
  if (body.endsWith(marker)) return body.slice(0, -marker.length)
  return body + marker + text.slice(body.length)
}

/**
 * `text` cut in the middle of a stream, its last paragraph's open Markdown closed: an inline code
 * span, bold or struck text runs to the end of what came, and a link whose address is still on
 * its way shows as its words. So nothing shows as markup and then turns into it. Inside a fenced
 * code block there is nothing to close: it runs to the end already. Italics with a single `*` or
 * `_` stay as they are: they read the same as a list's bullet or a word's underscore.
 */
export function closeOpenMarkdown(text: string) {
  if (inFence(text)) return text
  const cut = text.lastIndexOf('\n\n') + 1
  const head = text.slice(0, cut)
  let tail = text.slice(cut)
  // A link: its words while its address comes, nothing yet while they do.
  tail = tail.replace(/!?\[([^\]\n]*)\]\([^)\s]*$/, '$1').replace(/!?\[([^\]\n]*)$/, '$1')
  // Inline code: an odd number of backticks (not a fence) leaves one open.
  const ticks = tail.match(/`+/g) ?? []
  if (ticks.filter((t) => t.length === 1).length % 2) tail = closeMarker(tail, '`')
  // Bold and struck text, outside code spans.
  const prose = tail.replace(/`[^`]*`/g, '')
  if ((prose.match(/\*\*/g) ?? []).length % 2) tail = closeMarker(tail, '**')
  if ((prose.match(/__/g) ?? []).length % 2) tail = closeMarker(tail, '__')
  if ((prose.match(/~~/g) ?? []).length % 2) tail = closeMarker(tail, '~~')
  return head + tail
}
