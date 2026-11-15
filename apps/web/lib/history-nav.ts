'use client'
// Back and forward in the page's history, for Brigade.app, whose window has no browser buttons:
// the arrows beside the traffic lights (components/dashboard.tsx), as Claude's app has. Whether
// each way is open comes from the Navigation API (Chromium, which Brigade.app runs on); where it
// is missing, both stay open and a step with nowhere to go does nothing.
import { useSyncExternalStore } from 'react'

type NavigationLike = EventTarget & { canGoBack: boolean; canGoForward: boolean }

const navigation = () =>
  typeof window === 'undefined'
    ? undefined
    : ((window as unknown as { navigation?: NavigationLike }).navigation ?? undefined)

function subscribe(listener: () => void) {
  const nav = navigation()
  nav?.addEventListener('currententrychange', listener)
  return () => nav?.removeEventListener('currententrychange', listener)
}

const state = () => {
  const nav = navigation()
  return nav ? `${nav.canGoBack ? 1 : 0}${nav.canGoForward ? 1 : 0}` : '11'
}

/** Whether the page can go back and forward, kept up to date as it moves. */
export function useHistoryNav() {
  const value = useSyncExternalStore(subscribe, state, () => '00')
  return {
    canGoBack: value[0] === '1',
    canGoForward: value[1] === '1',
    back: () => window.history.back(),
    forward: () => window.history.forward(),
  }
}
