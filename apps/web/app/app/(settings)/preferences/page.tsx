'use client'
// Preferences: what each member sets for themselves, never for the workspace: the
// theme (this browser), next-message suggestions and notifications (theirs).
import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useEffect, useState, type ReactNode } from 'react'
import { useDashboard } from '@/components/dashboard'
import { NotificationsPanel } from '@/components/notifications'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

const THEMES = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const

function Section({
  title,
  detail,
  children,
}: {
  title: string
  detail: string
  children: ReactNode
}) {
  return (
    <section className="flex max-w-xl flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-muted-foreground text-sm">{detail}</p>
      </div>
      <Card className="px-6 py-5">{children}</Card>
    </section>
  )
}

export default function PreferencesPage() {
  const { me, reloadMe } = useDashboard()
  const { theme, setTheme } = useTheme()
  // The theme is known only in the browser: no pick shows until it is.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const [suggestions, setSuggestions] = useState(me.suggestions)
  useEffect(() => setSuggestions(me.suggestions), [me.suggestions])

  /** Shown at once, then saved; put back as it was if it fails. */
  function suggest(on: boolean) {
    setSuggestions(on)
    api('/me/suggestions', { method: 'PUT', body: { suggestions: on } })
      .then(reloadMe)
      .catch(() => setSuggestions(me.suggestions))
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-extrabold tracking-tight">Preferences</h1>
        <p className="text-muted-foreground max-w-prose">
          Yours alone: the rest of the workspace keeps its own.
        </p>
      </header>

      <Section title="Appearance" detail="How Brigade looks in this browser.">
        <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-2">
          {THEMES.map(({ value, label, icon: Icon }) => {
            const active = mounted && theme === value
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setTheme(value)}
                className={cn(
                  'focus-visible:ring-ring flex flex-col items-center gap-1.5 rounded-md border px-3 py-3 text-sm transition-colors outline-none focus-visible:ring-2',
                  active
                    ? 'border-primary bg-accent text-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                )}
              >
                <Icon className="size-4" aria-hidden />
                {label}
              </button>
            )
          })}
        </div>
      </Section>

      <Section title="Messages" detail="Help while you write to a teammate.">
        <div className="flex items-start justify-between gap-4">
          <Label htmlFor="suggestions" className="grid gap-1 font-normal">
            <span className="font-medium">Suggest my next message</span>
            <span className="text-muted-foreground text-xs">
              An empty message box shows what you may write next, in grey: Tab on a computer, Use on
              a phone, puts it in. Only with Claude Code teammates.
            </span>
          </Label>
          <Switch id="suggestions" checked={suggestions} onCheckedChange={suggest} />
        </div>
      </Section>

      <Section
        title="Notifications"
        detail="Brigade tells you when something needs you, and otherwise stays quiet."
      >
        <NotificationsPanel />
      </Section>
    </div>
  )
}
