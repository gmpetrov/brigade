'use client'
// Preferences: what each member sets for themselves, never for the workspace: next-message
// suggestions, auto-merge of their threads' pull requests (owners and admins, who may merge),
// what Chief answers in their name, and deleting their own account. Notifications have their own section; the theme is
// picked in the member's menu, in the sidebar.
import { CHIEF_KIND_LABELS, type ChiefSettings, type SetChief } from '@brigade/contracts'
import Link from 'next/link'
import { useEffect, useState, type ReactNode } from 'react'
import { DeleteAccount } from '@/components/danger-zone'
import { useDashboard } from '@/components/dashboard'
import { NewThread, useThreadDraft } from '@/components/new-thread'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
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

      <ChiefSection />

      <DeleteAccount />
    </div>
  )
}

/** "9 of your last 10": how often the person took Chief's pick, for a kind it suggests. */
function trustLine(k: ChiefSettings['kinds'][number]) {
  if (k.alone) return 'Answers on its own'
  if (!k.decided) return 'Suggests'
  return `Suggests · you took its pick ${k.agreed} of your last ${k.decided}`
}

/**
 * Chief answers for them (docs/chief-answers.md): on or off, the kinds it answers alone, their
 * mandate, and its numbers. Theirs alone: it answers in their name.
 */
function ChiefSection() {
  const { data, setData } = useApi<ChiefSettings>('/me/chief', ['thread.updated'])
  const [writing, setWriting] = useState(false)
  const [error, setError] = useState<string>()

  /** Shown at once, then saved; put back as it was if it fails. */
  function change(body: SetChief, next: ChiefSettings) {
    const before = data
    setData(next)
    setError(undefined)
    api<ChiefSettings>('/me/chief', { method: 'PUT', body })
      .then(setData)
      .catch((e: Error) => {
        setData(before)
        setError(e.message)
      })
  }

  if (!data) return null
  const s = data.stats
  return (
    <Section title="Chief" detail="Your chief of staff answers your teammates' questions for you.">
      <div className="flex flex-col gap-5">
        <div className="flex items-start justify-between gap-4">
          <Label htmlFor="chief-answers" className="grid gap-1 font-normal">
            <span className="font-medium">Answer my teammates&apos; questions</span>
            <span className="text-muted-foreground text-xs">
              When a teammate ends its reply on buttons or choices, Chief reads them first and, from
              your mandate, suggests the one it would pick, or answers for you in the kinds you let
              it. Merging, sending, publishing or paying still waits for you. Off, every question
              waits for you.
            </span>
          </Label>
          <Switch
            id="chief-answers"
            checked={data.on}
            onCheckedChange={(on) => change({ on }, { ...data, on })}
          />
        </div>
        {data.on && (
          <>
            <ul className="flex flex-col gap-4">
              {data.kinds.map((k) => (
                <li key={k.kind} className="flex items-start justify-between gap-4">
                  <Label htmlFor={`chief-${k.kind}`} className="grid gap-1 font-normal">
                    <span className="font-medium">{CHIEF_KIND_LABELS[k.kind].label}</span>
                    <span className="text-muted-foreground text-xs">
                      {CHIEF_KIND_LABELS[k.kind].hint}. {trustLine(k)}.
                    </span>
                  </Label>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground text-xs">On its own</span>
                    <Switch
                      id={`chief-${k.kind}`}
                      checked={k.alone}
                      onCheckedChange={(on) =>
                        change(
                          { alone: { kind: k.kind, on } },
                          {
                            ...data,
                            kinds: data.kinds.map((x) =>
                              x.kind === k.kind ? { ...x, alone: on } : x,
                            ),
                          },
                        )
                      }
                    />
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex items-start justify-between gap-4">
              <div className="grid gap-1 text-sm">
                <span className="font-medium">Your mandate</span>
                <span className="text-muted-foreground text-xs">
                  What you aim for, the decisions that hold, and what you always decide yourself:
                  what Chief answers by.
                </span>
              </div>
              {data.mandate ? (
                <Button size="sm" variant="outline" asChild>
                  <Link href={`/app/library?file=${data.mandate.id}`}>Open</Link>
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setWriting(true)}>
                  Write it with Chief
                </Button>
              )}
            </div>
            {s.questions > 0 && (
              <p className="text-muted-foreground text-xs">
                Last {s.days} days: {s.questions} {s.questions === 1 ? 'question' : 'questions'},{' '}
                {s.answered} answered on its own
                {s.overruled ? ` (${s.overruled} marked wrong)` : ''}, {s.suggested} suggested
                {s.agreed + s.disagreed
                  ? ` (you took ${s.agreed} of ${s.agreed + s.disagreed})`
                  : ''}
                , {s.escalated} left to you.
              </p>
            )}
          </>
        )}
        {error && <p className="text-sm text-destructive-text">{error}</p>}
      </div>
      {writing && <MandateDialog onClose={() => setWriting(false)} />}
    </Section>
  )
}

/** Writing the mandate happens in a chat with Chief, its message ready to send. */
function MandateDialog({ onClose }: { onClose: () => void }) {
  const { teammates } = useDashboard()
  const chief = teammates.find((t) => t.kind === 'chief')
  const draft = useThreadDraft()
  const { setText } = draft
  useEffect(() => {
    setText('Help me write my mandate: what I aim for now, and what I always decide myself.')
  }, [setText])
  if (!chief) return null
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="top-[20%] translate-y-0 gap-0 p-0 sm:max-w-2xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">Write your mandate with Chief</DialogTitle>
        <DialogDescription className="sr-only">
          Chief writes it with you in a new thread, from what you tell it.
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
