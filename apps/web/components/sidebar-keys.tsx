'use client'
// ⌥↑ / ⌥↓ (Alt elsewhere) through the sidebar, and Enter on a row that folds others
// (lib/sidebar-keys.ts says which). The rows that are stops carry `data-nav-stop`: "link"
// opens, as a click on it does; "toggle" (a folded section, a "+N more") is only focused, and
// Enter unfolds it. Only the rows showing count: a folded section's rows are no stops.
// The keys work outside fields and in the composer, as in a chat app; another field keeps
// its own ⌥↑ / ⌥↓, and so do menus, dialogs, a remote screen and a terminal.
import { useEffect } from 'react'
import { editable, OPEN_LAYER } from '@/components/side-panel'
import { stepTo, walkKey, type Relation } from '@/lib/sidebar-keys'

const SIDEBAR = '[data-sidebar="sidebar"]'
const STOPS = `${SIDEBAR} [data-nav-stop]`
const MODIFIERS = new Set(['Alt', 'AltGraph', 'Control', 'Meta', 'Shift'])

/** Where `stop` is from `from`, in the page's order; inside it counts as after it. */
function relation(stop: Element, from: Element): Relation {
  if (stop === from || stop.contains(from)) return 'same'
  if (from.contains(stop)) return 'after'
  return from.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING ? 'after' : 'before'
}

/** The stops showing now, in the sidebar's order (a hidden one has no box). */
const shownStops = () =>
  [...document.querySelectorAll<HTMLElement>(STOPS)].filter((s) => s.getClientRects().length)

/** Whether the keys belong to something else: a field, a menu, a dialog, a remote screen. */
function elsewhere(focus: Element | null) {
  if (document.querySelector(OPEN_LAYER)) return true
  if (!focus) return false
  if (focus.closest('[data-keyboard]')) return true
  return editable(focus) && !focus.closest('[data-composer]')
}

export function useSidebarKeys() {
  useEffect(() => {
    // The row the walk goes on from while the member presses these keys in a row: the page it
    // opened takes the focus (its composer) and marks its row active a moment later. Any other
    // key or a pointer ends the run; then the focus in the sidebar, else the active row, says.
    let held: Element | null = null

    function from(stops: HTMLElement[]): Element | null {
      if (held?.isConnected) return held
      const focus = document.activeElement
      if (focus && focus.closest(SIDEBAR)) return focus
      return stops.find((s) => s.getAttribute('data-active') === 'true') ?? null
    }

    function go(stop: HTMLElement) {
      if (stop.dataset.navStop === 'link') stop.click()
      stop.focus({ preventScroll: true })
      stop.scrollIntoView({ block: 'nearest' })
      held = stop
    }

    function onKeyDown(e: KeyboardEvent) {
      if (MODIFIERS.has(e.key)) return
      const focus = document.activeElement
      const dir = walkKey(e)
      if (dir) {
        held = held?.isConnected ? held : null
        if (e.defaultPrevented || e.isComposing || elsewhere(focus)) return
        const stops = shownStops()
        if (!stops.length) return
        const start = from(stops)
        const to = stepTo(stops, start ? (s) => relation(s, start) : undefined, dir)
        // At either end, nothing; the composer's caret does not move either.
        e.preventDefault()
        if (to) go(to)
        return
      }
      // Enter on a folded row unfolds it; the next ⌥↓ goes to the first row it showed, which
      // comes right after the stop above it.
      const plain = !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey
      if (
        e.key === 'Enter' &&
        plain &&
        !e.repeat &&
        !e.defaultPrevented &&
        focus instanceof HTMLElement &&
        focus.matches(`${STOPS}[data-nav-stop="toggle"]`)
      ) {
        e.preventDefault()
        const above = stepTo(shownStops(), (s) => relation(s, focus), -1)
        focus.click()
        held = above ?? null
        return
      }
      held = null
    }
    const onPointerDown = () => {
      held = null
    }
    // A page the walk opened focuses its composer once it has loaded, which may come after
    // the walk went on to a folded row: the focus goes back to that row, so Enter unfolds it
    // rather than going to the composer. Typing ended the run first: the composer keeps it.
    const onFocusIn = (e: FocusEvent) => {
      if (
        held instanceof HTMLElement &&
        held.isConnected &&
        held.dataset.navStop === 'toggle' &&
        e.target instanceof Element &&
        e.target.closest('[data-composer]')
      )
        held.focus({ preventScroll: true })
    }
    // Before the composer's editor, which would move its caret on ⌥↑ / ⌥↓.
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('focusin', onFocusIn, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('focusin', onFocusIn, true)
    }
  }, [])
}
