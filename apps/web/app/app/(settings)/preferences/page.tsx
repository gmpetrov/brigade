'use client'
// Preferences: what each member sets for themselves, never for the workspace: next-message
// suggestions, auto-merge of their threads' pull requests (owners and admins, who may merge),
// notifications (theirs), and deleting their own account. The theme is
// picked in the member's menu, in the sidebar.
import { useEffect, useState, type ReactNode } from 'react'
import { DeleteAccount } from '@/components/danger-zone'
import { useDashboard } from '@/components/dashboard'
import { NotificationsPanel } from '@/components/notifications'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'

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
  const [suggestions, setSuggestions] = useState(me.suggestions)
  useEffect(() => setSuggestions(me.suggestions), [me.suggestions])
  const [autoMerge, setAutoMerge] = useState(me.autoMerge)
  useEffect(() => setAutoMerge(me.autoMerge), [me.autoMerge])
  const mayMerge = me.role === 'owner' || me.role === 'admin'

  /** Shown at once, then saved; put back as it was if it fails. */
  function suggest(on: boolean) {
    setSuggestions(on)
    api('/me/suggestions', { method: 'PUT', body: { suggestions: on } })
      .then(reloadMe)
      .catch(() => setSuggestions(me.suggestions))
  }

  function merge(on: boolean) {
    setAutoMerge(on)
    api('/me/auto-merge', { method: 'PUT', body: { autoMerge: on } })
      .then(reloadMe)
      .catch(() => setAutoMerge(me.autoMerge))
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-extrabold tracking-tight">Preferences</h1>
        <p className="text-muted-foreground max-w-prose">
          Yours alone: the rest of the workspace keeps its own.
        </p>
      </header>

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

      {mayMerge && (
        <Section title="Pull requests" detail="What teammates open in your threads.">
          <div className="flex items-start justify-between gap-4">
            <Label htmlFor="auto-merge" className="grid gap-1 font-normal">
              <span className="font-medium">Auto-merge when ready</span>
              <span className="text-muted-foreground text-xs">
                Once a teammate is done with a pull request, no review is under way or asked for,
                and its checks pass, Brigade merges it. One with failed checks, conflicts or changes
                asked for waits for you.
              </span>
            </Label>
            <Switch id="auto-merge" checked={autoMerge} onCheckedChange={merge} />
          </div>
        </Section>
      )}

      <Section
        title="Notifications"
        detail="Brigade tells you when something needs you, and otherwise stays quiet."
      >
        <NotificationsPanel />
      </Section>

      <DeleteAccount />
    </div>
  )
}
