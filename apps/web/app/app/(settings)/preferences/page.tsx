'use client'
// Preferences: what each member sets for themselves, never for the workspace: next-message
// suggestions, auto-merge of their threads' pull requests (owners and admins, who may merge),
// where their threads' previews and heavy commands run (members with the preview_machines
// feature), their rules
// and Chief's daily pass, and deleting their own account. Notifications have their own section;
// the theme is picked in the member's menu, in the sidebar.
import { Check } from 'lucide-react'
import { CHIEF_RULES_MAX, type ChiefSettings, type SetChief } from '@brigade/contracts'
import { useEffect, useState } from 'react'
import { DeleteAccount } from '@/components/danger-zone'
import { useDashboard } from '@/components/dashboard'
import { NewThread, useThreadDraft } from '@/components/new-thread'
import { SettingRow, SettingsGroup } from '@/components/settings-group'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api, useApi } from '@/lib/api'

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
          Only for you: the rest of the workspace keeps its own.
        </p>
      </header>

      <SettingsGroup title="Teammates">
        <SettingRow
          title="Suggest my next message"
          detail="An empty message box shows what you may write next, in grey. Tab on a computer, Use on a phone, puts it in."
          chips={['Claude Code teammates only']}
          control={({ id, describedBy }) => (
            <Switch
              id={id}
              aria-describedby={describedBy}
              checked={suggestions}
              onCheckedChange={suggest}
            />
          )}
        />
        {mayMerge && (
          <SettingRow
            title="Auto-merge when ready"
            detail="Brigade merges a pull request once its teammate is done, its checks pass and no review is under way or asked for."
            more={
              <>
                One that conflicts goes back to its teammate to resolve, and its reviewer looks
                again if resolving did more than bring in the base branch&apos;s changes. One with
                failed checks or changes asked for waits for you.
              </>
            }
            control={({ id, describedBy }) => (
              <Switch
                id={id}
                aria-describedby={describedBy}
                checked={autoMerge}
                onCheckedChange={merge}
              />
            )}
          />
        )}
        {hasMachines && (
          <SettingRow
            title="Keep heavy work off the shared computer"
            detail="Each thread you start runs its preview, builds and renders on a machine of its own."
            chips={['8 vCPU · 16 GB', 'Wakes in about 30 s']}
            more={
              <>
                Its code stays on the cloud computer and reaches the machine as it changes; what a
                command makes comes back. The machine sleeps when nobody uses it. Off, all of it
                runs on the cloud computer your teammates work on.
              </>
            }
            control={({ id, describedBy }) => (
              <Switch
                id={id}
                aria-describedby={describedBy}
                checked={machines}
                onCheckedChange={previewOnMachine}
              />
            )}
          />
        )}
      </SettingsGroup>

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
    <SettingsGroup title="Chief">
      <SettingRow
        title="Your rules"
        detail="What your teammates may decide without asking you. Merging, sending, publishing or paying still waits for you."
      >
        {({ id, describedBy }) => (
          <div className="flex flex-col gap-2">
            <Textarea
              id={id}
              aria-describedby={describedBy}
              rows={4}
              maxLength={CHIEF_RULES_MAX}
              placeholder={RULES_EXAMPLE}
              value={text}
              onChange={(e) => {
                setRules(e.target.value)
                setSaved(false)
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
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
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Check aria-hidden className="size-3.5 text-success" />
                  Saved for teammates&apos; next session
                </span>
              )}
            </div>
          </div>
        )}
      </SettingRow>
      <SettingRow
        title="Daily pass"
        detail="When something waits on you, Chief settles what your rules cover and leaves the rest on Today."
        chips={[`Each morning · ${data.hour}:00${data.timezone ? ` ${data.timezone}` : ''}`]}
        more={
          <>
            It answers in your name the questions your rules settle, tries failed threads again, and
            says on Today what it would do with the rest, and rules you may want to add. Off,
            nothing runs.
          </>
        }
        control={({ id, describedBy }) => (
          <Switch
            id={id}
            aria-describedby={describedBy}
            checked={data.pass}
            onCheckedChange={(pass) => {
              const timezone = browserTimezone()
              void save(
                { pass, ...(pass && timezone ? { timezone } : {}) },
                { ...data, pass, ...(pass && timezone ? { timezone } : {}) },
              )
            }}
          />
        )}
      />
      {error && <p className="px-5 py-3 text-sm text-destructive-text">{error}</p>}
      {writing && <RulesDialog onClose={() => setWriting(false)} />}
    </SettingsGroup>
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
