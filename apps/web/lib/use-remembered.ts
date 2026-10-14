'use client'
import { useCallback, useEffect, useState } from 'react'

/** The choice `useRememberedFlag` remembers under `key`, read at once: `initial` if none. */
export function rememberedFlag(key: string, initial: boolean) {
  try {
    const saved = localStorage.getItem(key)
    return saved === null ? initial : saved === '1'
  } catch {
    return initial
  }
}

/** An on/off choice remembered in this browser under `key`; `initial` until it is read. */
export function useRememberedFlag(key: string, initial: boolean) {
  const [on, setOn] = useState(initial)
  useEffect(() => setOn((on) => rememberedFlag(key, on)), [key])
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
