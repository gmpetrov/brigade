'use client'
// The member's worn theme in this window (docs/themes.md): loaded once the member is known,
// again whenever it changes (theme.changed, sent only to them) and before its files' signed
// addresses run out. ⌘⌥⇧R (Ctrl+Alt+Shift+R) takes it off, whatever it hides.
import type { WornTheme } from '@brigade/contracts'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { api } from '@/lib/api'
import {
  invalidateThemeLoads,
  isResetLookKey,
  leaveSafeLook,
  leaveWindow,
  themeLoader,
  serverThemeState,
  subscribeTheme,
  themeState,
  wearInWindow,
} from '@/lib/theme-runtime'
import { useLive } from '@/lib/use-live'

/** The theme worn here, and whether this tab keeps the dashboard's own look. */
export const useWornTheme = () => useSyncExternalStore(subscribeTheme, themeState, serverThemeState)

/** Take the theme off: in this window at once, then for every window of the member. */
export async function takeOffTheme() {
  invalidateThemeLoads()
  wearInWindow(null)
  await api('/themes/active', { method: 'PUT', body: { id: null } }).catch(() => undefined)
}

/** `enabled`: the member has themes; undefined while that is not known yet. */
export function ThemeRuntime({ enabled }: { enabled: boolean | undefined }) {
  // One loader for this window: only its latest answer is worn (themeLoader).
  const [loader] = useState(() =>
    themeLoader({
      fetch: () => api<WornTheme>('/themes/active'),
      wear: wearInWindow,
      schedule: (run, ms) => setTimeout(run, ms),
      cancel: (timer) => clearTimeout(timer),
    }),
  )
  const load = loader.load

  useEffect(() => {
    if (enabled === undefined) return
    if (!enabled) {
      loader.stop()
      wearInWindow(null)
      return
    }
    void load()
    return () => loader.stop()
  }, [enabled, load, loader])

  // Leaving the dashboard (a public page): the site keeps its own look.
  useEffect(() => () => leaveWindow(), [])

  useLive(
    (message) => {
      if (enabled && message.type === 'theme.changed') void load()
    },
    () => {
      if (enabled) void load()
    },
  )

  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isResetLookKey(event)) return
      event.preventDefault()
      void takeOffTheme()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])

  const { worn, safe } = useWornTheme()
  if (!enabled || !safe || !worn) return null
  return (
    <div
      role="status"
      className="bg-popover text-popover-foreground fixed bottom-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border px-4 py-1.5 text-xs shadow-md"
    >
      <span>Safe look: {worn.theme.name} is off in this tab.</span>
      <button type="button" className="text-primary font-medium" onClick={leaveSafeLook}>
        Wear it again
      </button>
    </div>
  )
}
