'use client'
import { useEffect, useState } from 'react'

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** Whether shortcuts read ⌘ or Ctrl here; ⌘ until the browser says otherwise. */
export function useIsMac() {
  const [mac, setMac] = useState(true)
  useEffect(() => setMac(isMac()), [])
  return mac
}
