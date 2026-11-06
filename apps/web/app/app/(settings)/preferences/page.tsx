'use client'
// Preferences: what each member sets for themselves, never for the workspace: next-message
// suggestions, auto-merge of their threads' pull requests (owners and admins, who may merge),
// where their threads' previews and heavy commands run (members with the preview_machines
// feature), their rules
// and Chief's daily pass, and deleting their own account. Notifications have their own section;
// the theme is picked in the member's menu, in the sidebar.
import { CHIEF_RULES_MAX, type ChiefSettings, type SetChief } from '@brigade/contracts'
import { useEffect, useState, type ReactNode } from 'react'
import { DeleteAccount } from '@/components/danger-zone'
import { useDashboard } from '@/components/dashboard'
import { NewThread, useThreadDraft } from '@/components/new-thread'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api, useApi } from '@/lib/api'

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
  // Only for members with the feature (docs/feature-flags.md): the API refuses the others too.
  const hasMachines = me.features?.includes('preview_machines') ?? false
  const [machines, setMachines] = useState(me.previewMachines ?? false)
  useEffect(() => setMachines(me.previewMachines ?? false), [me.previewMachines])

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

  function previewOnMachine(on: boolean) {
    setMachines(on)
    api('/me/preview-machines', { method: 'PUT', body: { previewMachines: on } })
      .then(reloadMe)
      .catch(() => setMachines(me.previewMachines ?? false))
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
                and its checks pass, Brigade merges it. One that conflicts goes back to that
                teammate to resolve, and its reviewer looks again if resolving did more than bring
                in the base branch&apos;s changes. One with failed checks or changes asked for waits
                for you.
              </span>
            </Label>
            <Switch id="auto-merge" checked={autoMerge} onCheckedChange={merge} />
          </div>
        </Section>
      )}

      {hasMachines && (
        <Section title="Machines" detail="Where your threads' previews and heavy work run.">
          <div className="flex items-start justify-between gap-4">
            <Label htmlFor="preview-machines" className="grid gap-1 font-normal">
              <span className="font-medium">Run previews and heavy work on their own machine</span>
              <span className="text-muted-foreground text-xs">
                A thread you start gets a machine of its own (8 vCPU, 16 GB), not the cloud computer
                your teammates work on: its preview runs there, and its teammates run heavy commands
                there (video renders, builds, test suites). Its code stays on the cloud computer and
                reaches the machine as it changes; what a command makes comes back. It sleeps when
                nobody uses it and takes about half a minute to wake. Off, all of it runs on the
                cloud computer, as before.
              </span>
            </Label>
            <Switch id="preview-machines" checked={machines} onCheckedChange={previewOnMachine} />
          </div>
        </Section>
      )}

      <ChiefSection />

      <DeleteAccount />
    </div>
  )
}

/** The browser's timezone: the person's morning, for their pass. */
const browserTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

const RULES_EXAMPLE =
  '- Brigade: go ahead on next steps of work I asked for\n- Anything visual (a design, a wording): ask me\n- Small fixes: open the pull request without asking'

/**
 * Their rules and Chief's daily pass (docs/chief-answers.md). Theirs alone: their teammates read
 * their rules, and Chief acts in their name by them.
 */
function ChiefSection() {
  const { data, setData } = useApi<ChiefSettings>('/me/chief')
  const [rules, setRules] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [writing, setWriting] = useState(false)
  const [error, setError] = useState<string>()
  const text = rules ?? data?.rules ?? ''

  function save(body: SetChief, next?: ChiefSettings) {
    const before = data
    if (next) setData(next)
    setError(undefined)
    return api<ChiefSettings>('/me/chief', { method: 'PUT', body })
      .then((after) => {
        setData(after)
        return true
      })
      .catch((e: Error) => {
        if (next) setData(before)
        setError(e.message)
        return false
      })
  }

  if (!data) return null
  const changed = text.trim() !== data.rules.trim()
  return (
    <Section
      title="Chief"
      detail="Your rules tell your teammates what to decide without asking you. Your chief of staff can go through what waits on you each morning."
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor="chief-rules" className="grid gap-1 font-normal">
            <span className="font-medium">Your rules</span>
            <span className="text-muted-foreground text-xs">
              Short lines in your words. Every teammate working for you reads them, decides what
              they settle and asks you only the rest. Merging, sending, publishing or paying still
              waits for you.
            </span>
          </Label>
          <Textarea
            id="chief-rules"
            rows={5}
            maxLength={CHIEF_RULES_MAX}
            placeholder={RULES_EXAMPLE}
            value={text}
            onChange={(e) => {
              setRules(e.target.value)
              setSaved(false)
            }}
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={!changed || saving}
              onClick={() => {
                setSaving(true)
                void save({ rules: text })
                  .then((ok) => {
                    if (ok) {
                      setRules(undefined)
                      setSaved(true)
                    }
                  })
                  .finally(() => setSaving(false))
              }}
            >
              Save
            </Button>
            <Button size="sm" variant="outline" onClick={() => setWriting(true)}>
              Write them with Chief
            </Button>
            {saved && !changed && (
              <span className="text-muted-foreground text-xs">
                Saved. Teammates read them from their next session.
              </span>
            )}
          </div>
        </div>
        <div className="flex items-start justify-between gap-4">
          <Label htmlFor="chief-pass" className="grid gap-1 font-normal">
            <span className="font-medium">Daily pass</span>
            <span className="text-muted-foreground text-xs">
              Each morning from {data.hour}:00
              {data.timezone ? ` (${data.timezone})` : ''}, when something waits on you, Chief goes
              through it: it answers in your name the questions your rules settle, tries failed
              threads again, and leaves the rest on Today with what it would do, and rules you may
              want to add. Off, nothing runs.
            </span>
          </Label>
          <Switch
            id="chief-pass"
            checked={data.pass}
            onCheckedChange={(pass) => {
              const timezone = browserTimezone()
              void save(
                { pass, ...(pass && timezone ? { timezone } : {}) },
                { ...data, pass, ...(pass && timezone ? { timezone } : {}) },
              )
            }}
          />
        </div>
        {error && <p className="text-sm text-destructive-text">{error}</p>}
      </div>
      {writing && <RulesDialog onClose={() => setWriting(false)} />}
    </Section>
  )
}

/** Writing the rules happens in a chat with Chief, its message ready to send. */
function RulesDialog({ onClose }: { onClose: () => void }) {
  const { teammates } = useDashboard()
  const chief = teammates.find((t) => t.kind === 'chief')
  const draft = useThreadDraft()
  const { setText } = draft
  useEffect(() => {
    setText(
      'Help me write my rules: what my teammates may decide without asking me, and what I always decide myself.',
    )
  }, [setText])
  if (!chief) return null
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="top-[20%] translate-y-0 gap-0 p-0 sm:max-w-2xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">Write your rules with Chief</DialogTitle>
        <DialogDescription className="sr-only">
          Chief writes them with you in a new thread, from what you tell it.
        </DialogDescription>
        <NewThread
          layout="dialog"
          teammate={chief}
          rows={3}
          draft={draft}
          autoFocus
          placeholder={`Chat with ${chief.name}`}
          openAtOnce
        />
      </DialogContent>
    </Dialog>
  )
}
