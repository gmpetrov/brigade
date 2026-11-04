'use client'
import { useLayoutEffect, useRef, type RefObject } from 'react'

const MOVE = 'flip-move'
const ENTER = 'flip-enter'
/** Quick out, slowing into place, without overshoot: a list settling, not bouncing. */
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
const DURATION = 320
/** A row lifted over the others as it climbs past them, so the eye follows it. */
const LIFT = 380

/** Where the row is laid out in the list, without any transform: an animation does not move it. */
function layoutTop(row: HTMLElement, list: HTMLElement) {
  return row.offsetParent === list ? row.offsetTop : row.offsetTop - list.offsetTop
}

/** How far a slide moves the row from its place at this moment. */
function slideOffset(row: Element) {
  const t = getComputedStyle(row).transform
  return t && t !== 'none' ? new DOMMatrixReadOnly(t).m42 : 0
}

/**
 * Animates a list's rows when their order changes (FLIP): each row slides from where it showed
 * to its new place, the one that climbed most is lifted over the others, and a row new to the
 * list fades in while the others make room. Its rows are `list`'s children, followed as DOM
 * elements, so React must keep them (one keyed array, not one per section).
 *
 * Nothing moves when only sizes change (a thread's children unfolding), on the first rows, when
 * `reset` changes (a filter: another list, not the same one moving), in a hidden tab, or with
 * reduced motion. A change mid-slide starts from where the row shows, so a burst of updates
 * flows instead of jumping.
 */
export function useFlip<T extends HTMLElement>(ref: RefObject<T | null>, reset: string) {
  const tops = useRef(new WeakMap<Element, number>())
  const order = useRef<Element[]>([])
  const lastReset = useRef(reset)
  // The lift each row is on, if any: a row lifted again keeps its own.
  const lifts = useRef(new WeakMap<Element, Animation>())
  useLayoutEffect(() => {
    const list = ref.current
    if (!list) {
      order.current = []
      return
    }
    const rows = [...list.children].filter((r): r is HTMLElement => r instanceof HTMLElement)
    const before = order.current
    const same = rows.length === before.length && rows.every((r, i) => r === before[i])
    const still =
      same ||
      !before.length ||
      lastReset.current !== reset ||
      document.hidden ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    lastReset.current = reset
    order.current = rows

    // Where each row shows now: its last place, plus a slide still under way.
    const shown = new Map<Element, number>()
    for (const r of rows) {
      const was = tops.current.get(r)
      if (was === undefined) continue
      const sliding = r.getAnimations().filter((a) => a.id === MOVE)
      shown.set(r, was + (sliding.length ? slideOffset(r) : 0))
      for (const a of sliding) a.cancel()
      if (sliding.length) {
        lifts.current.delete(r)
        r.style.zIndex = ''
      }
    }
    const now = new Map(rows.map((r) => [r, layoutTop(r, list)]))
    for (const [r, top] of now) tops.current.set(r, top)
    if (still) return

    const moves = rows.flatMap((r) => {
      const from = shown.get(r)
      const dy = from === undefined ? 0 : from - now.get(r)!
      return Math.abs(dy) >= 1 ? [{ r, dy }] : []
    })
    // The row that climbed past the others: a row further than any other, not all of them
    // moving up together (a row removed above them).
    const climbs = moves.toSorted((a, b) => b.dy - a.dy)
    const climber = climbs[0]
    const passed =
      climber && climber.dy - Math.max(0, climbs[1]?.dy ?? 0) >= climber.r.offsetHeight
        ? climber.r
        : undefined
    for (const { r, dy } of moves) {
      if (r === passed) {
        r.style.zIndex = '1'
        const lift = r.animate(
          [
            { transform: `translateY(${dy}px) scale(1.015)`, backgroundColor: 'var(--sidebar)' },
            { transform: 'scale(1.015)', backgroundColor: 'var(--sidebar)', offset: 0.75 },
            { transform: 'none', backgroundColor: 'var(--sidebar)' },
          ],
          { id: MOVE, duration: LIFT, easing: EASE },
        )
        lifts.current.set(r, lift)
        const done = () => {
          if (lifts.current.get(r) !== lift) return
          lifts.current.delete(r)
          r.style.zIndex = ''
        }
        lift.onfinish = done
        lift.oncancel = done
      } else {
        r.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], {
          id: MOVE,
          duration: DURATION,
          easing: EASE,
        })
      }
    }
    // New to the list: fades in once the others start making room.
    for (const r of rows)
      if (!shown.has(r))
        r.animate(
          [
            { opacity: 0, transform: 'translateY(-4px)' },
            { opacity: 1, transform: 'none' },
          ],
          { id: ENTER, duration: 260, delay: 60, easing: EASE, fill: 'backwards' },
        )
  })
}
