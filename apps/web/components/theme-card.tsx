'use client'
// A teammate restyled the dashboard (theme_set, theme_undo; docs/themes.md): one line in the
// thread, with Undo for the person whose look it is.
import { Palette } from 'lucide-react'
import { useState } from 'react'
import { useDashboard } from '@/components/dashboard'
import { ActivityIndicator } from '@/components/ui/activity-indicator'
import { api } from '@/lib/api'

export type ThemeChangeItem = {
  /** The change it made: Undo goes back to the look just before it. */
  seq: number
  /** The member whose look it is. */
  member: string
  label: string
}

/** A theme tool call that changed someone's look, as the card shows it; null for any other. */
export function themeChange(item: {
  toolName: string
  bareName: string
  input: unknown
  outputText: string
  finished: boolean
  isError?: boolean
}): ThemeChangeItem | null {
  if (item.bareName !== 'theme_set' && item.bareName !== 'theme_undo') return null
  if (!item.finished || item.isError) return null
  const seq = item.outputText.match(/"seq"\s*:\s*(\d+)/)
  const member = item.outputText.match(/"member"\s*:\s*"([^"\\]+)"/)
  if (!seq || !member) return null
  const input = (item.input ?? {}) as { id?: unknown; theme?: { name?: unknown } | string }
  let label = 'Went back on the look'
  if (item.bareName === 'theme_set') {
    const theme =
      typeof input.theme === 'string'
        ? (() => {
            try {
              return JSON.parse(input.theme) as { name?: unknown }
            } catch {
              return null
            }
          })()
        : input.theme
    label =
      theme && typeof theme.name === 'string'
        ? `Restyled Brigade: ${theme.name}`
        : input.id === 'none'
          ? 'Took the theme off'
          : `Wore ${typeof input.id === 'string' ? input.id : 'a theme'}`
  }
  return { seq: Number(seq[1]), member: member[1]!, label }
}

export function ThemeChangeCard({ change }: { change: ThemeChangeItem }) {
  const { me } = useDashboard()
  const [state, setState] = useState<'idle' | 'busy' | 'undone' | 'error'>('idle')
  const mine = me.memberId === change.member
  async function undo() {
    setState('busy')
    try {
      await api('/themes/undo', { body: { seq: change.seq - 1 } })
      setState('undone')
    } catch {
      setState('error')
    }
  }
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
      <Palette className="size-3.5 flex-none" aria-hidden />
      <span className="min-w-0 truncate">{change.label}</span>
      {mine &&
        (state === 'undone' ? (
          <span className="flex-none text-xs">Undone</span>
        ) : state === 'busy' ? (
          <ActivityIndicator />
        ) : (
          <button
            type="button"
            onClick={() => void undo()}
            className="flex-none text-xs font-medium text-primary hover:underline"
          >
            {state === 'error' ? 'Try Undo again' : 'Undo'}
          </button>
        ))}
    </div>
  )
}
