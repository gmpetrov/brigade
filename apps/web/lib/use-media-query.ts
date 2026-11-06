import { useSyncExternalStore } from 'react'

/** Matches a media query, as the window changes; `server` while rendered on the server. */
export function useMediaQuery(query: string, server = true) {
  return useSyncExternalStore(
    (change) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', change)
      return () => list.removeEventListener('change', change)
    },
    () => window.matchMedia(query).matches,
    () => server,
  )
}
