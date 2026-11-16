'use client'
// next-themes' light and dark, which a worn theme's canvas overrides (docs/themes.md): a dark
// canvas makes the dashboard dark whatever the person picked, until the theme comes off.
import { ThemeProvider } from 'next-themes'
import { useSyncExternalStore, type ReactNode } from 'react'
import { serverThemeState, subscribeTheme, themeState } from '@/lib/theme-runtime'

export function LookProvider({ children }: { children: ReactNode }) {
  const { mode, safe } = useSyncExternalStore(subscribeTheme, themeState, serverThemeState)
  const forced = !safe && mode ? mode : undefined
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
      {...(forced ? { forcedTheme: forced } : {})}
    >
      {children}
    </ThemeProvider>
  )
}
