import { usePathname } from 'next/navigation'
import { useEffect, useRef, useSyncExternalStore, type MouseEvent } from 'react'

/**
 * Whether an address is the threads panel expanded (the threads' list, or a thread): its
 * pages are empty (app/app/threads), the panel in the layout shows it.
 */
export const isPanelAddress = (href: string) => /^\/app\/threads(?:\/[^/?#]+)?\/?$/.test(href)

/**
 * Open the threads panel's address without asking the server for its page, which has nothing
 * in it: the URL changes at once (Next follows `history.pushState`, usePathname with it) and
 * the panel shows the thread on the next frame. A navigation would wait for the dashboard's
 * Worker first, a moment the member sees as a click that does nothing when it is slow.
 * Returns false for any other address, left to the router.
 */
export function openInPlace(href: string) {
  if (!isPanelAddress(href)) return false
  if (location.pathname !== href || location.search) {
    history.pushState(null, '', href)
    open(href)
  }
  return true
}

/**
 * The panel's address opened in place (or by Back and Forward), until Next's own pathname moves.
 * Next follows `history.pushState` in a transition, which React starts over each time something
 * more urgent renders (a working thread's events, the sidebar): a long thread then took more than
 * a second to show, the click doing nothing meanwhile. The panel reads this instead
 * (usePanelPathname), so the thread clicked renders at once.
 */
let opening: string | null = null
const listeners = new Set<() => void>()
function open(path: string | null) {
  if (opening === path) return
  opening = path
  listeners.forEach((l) => l())
}
// Back and Forward to a panel address: the same, at once.
const popped = () => open(isPanelAddress(location.pathname) ? location.pathname : null)

/** The address opened in place that Next has not caught up with, if any; `subscribe` follows it. */
export const openedInPlace = () => opening

export function subscribe(listener: () => void) {
  if (!listeners.size) addEventListener('popstate', popped)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) removeEventListener('popstate', popped)
  }
}

/**
 * The pathname, as usePathname, but a panel address opened in place shows at once, before
 * Next's transition to it ends. Once Next's pathname moves (there, or anywhere else since),
 * it is Next's again.
 */
export function usePanelPathname() {
  const pathname = usePathname()
  const path = useSyncExternalStore(subscribe, openedInPlace, () => null)
  const seen = useRef(pathname)
  useEffect(() => {
    if (seen.current === pathname) return
    seen.current = pathname
    open(null)
  }, [pathname])
  return path ?? pathname
}

/**
 * A link's onClick to the panel's address: a plain click opens it in place, one that opens a
 * new tab or window (or that a child already took, like a row's caret) is left as it is.
 */
export function clickInPlace(e: MouseEvent<HTMLAnchorElement>, href: string) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
    return
  if (openInPlace(href)) e.preventDefault()
}
