import type { MouseEvent } from 'react'

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
  if (location.pathname !== href || location.search) history.pushState(null, '', href)
  return true
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
