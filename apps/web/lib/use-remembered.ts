'use client'
import { useCallback, useEffect, useState } from 'react'

/** An on/off choice remembered in this browser under `key`; `initial` until it is read. */
export function useRememberedFlag(key: string, initial: boolean) {
  const [on, setOn] = useState(initial)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(key)
      if (saved !== null) setOn(saved === '1')
    } catch {}
  }, [key])
  const remember = useCallback(
    (next: boolean) => {
      setOn(next)
      try {
        localStorage.setItem(key, next ? '1' : '0')
      } catch {}
    },
    [key],
  )
  return [on, remember] as const
}
