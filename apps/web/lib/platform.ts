'use client'
import { useEffect, useState } from 'react'

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** Whether shortcuts read ⌘ or Ctrl here; ⌘ until the browser says otherwise. */
export function useIsMac() {
  const [mac, setMac] = useState(true)
  useEffect(() => setMac(isMac()), [])
  return mac
}

/**
 * A phone-sized window (below Tailwind's md), where a docked panel covers the whole page.
 * Read when acting, not to render: unset on the server.
 */
export const isNarrow = () =>
  typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches
