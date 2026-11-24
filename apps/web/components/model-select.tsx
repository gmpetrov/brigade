'use client'
// The model a teammate runs on, picked from every agent's models at once: a model belongs to an
// agent, so choosing it picks the agent too. Used by the teammate's settings and, as a quiet line
// under its name, by its panel beside the thread list.
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  CODEX_DEFAULT_MODEL,
  HARNESS_MODELS,
  isHarnessModel,
  modelLabel,
  PI_DEFAULT_MODEL,
  type TeammateHarness,
} from '@brigade/contracts'
import { Fragment, useState } from 'react'
import { isAdmin, useDashboard } from '@/components/dashboard'
import { HarnessLogo } from '@/components/harness-logo'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, harnessLabel, teammateModelLabel, type Teammate } from '@/lib/api'
import { cn } from '@/lib/utils'

type Harness = TeammateHarness
export type ModelChoice = { harness: Harness; model: string | null }

/** Radix Select can't hold null: this stands for "the account's default model". */
const DEFAULT_MODEL = 'default'
const HARNESSES: Harness[] = ['claude_code', 'codex']

/** A picker value is `harness:model`, with DEFAULT_MODEL for the default. */
const valueOf = ({ harness, model }: ModelChoice) => `${harness}:${model ?? DEFAULT_MODEL}`
function choiceOf(value: string): ModelChoice {
  const at = value.indexOf(':')
  const model = value.slice(at + 1)
  return { harness: value.slice(0, at) as Harness, model: model === DEFAULT_MODEL ? null : model }
}

/** What the inline picker says under an agent's name, the warning its settings field shows. */
const CAVEATS: Partial<Record<Harness, string>> = {
  codex: 'Runs commands and edits files without asking.',
  antigravity: 'Runs commands and edits files without asking.',
  pi: 'The providers may suspend accounts used through Pi.',
}

/** The Default option's line: Codex's, Pi's and Antigravity's model is Brigade's, Claude Code's the account's. */
const defaultLine = (h: Harness) =>
  h === 'codex'
    ? modelLabel(h, CODEX_DEFAULT_MODEL)
    : h === 'pi'
      ? modelLabel(h, PI_DEFAULT_MODEL)
      : h === 'antigravity'
        ? modelLabel(h, ANTIGRAVITY_DEFAULT_MODEL)
        : 'The account’s default model'

/**
 * The model picker. `saved` is what the teammate was saved with: a model saved before the list
 * existed stays selectable until it's changed, and Pi or Antigravity stay offered to a teammate
 * already on them, without their feature.
 */
export function ModelSelect({
  value,
  onChange,
  saved,
  id,
  variant = 'field',
  disabled,
}: {
  value: ModelChoice
  onChange: (next: ModelChoice) => void
  saved?: ModelChoice
  id?: string
  /** A form field, or a quiet line of text under a teammate's name. */
  variant?: 'field' | 'inline'
  disabled?: boolean
}) {
  // Pi only with the pi_harness feature (docs/harnesses.md), or for a teammate already on it.
  const { me } = useDashboard()
  // Antigravity likewise, with the antigravity_harness feature.
  const harnesses: Harness[] = [
    ...HARNESSES,
    ...(me.features?.includes('antigravity_harness') || saved?.harness === 'antigravity'
      ? (['antigravity'] as const)
      : []),
    ...(me.features?.includes('pi_harness') || saved?.harness === 'pi' ? (['pi'] as const) : []),
  ]
  const legacy = saved?.model && !isHarnessModel(saved.harness, saved.model) ? saved : null
  const inline = variant === 'inline'

  return (
    <Select
      value={valueOf(value)}
      onValueChange={(next) => onChange(choiceOf(next))}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        aria-label={inline ? 'Model' : undefined}
        className={cn(
          inline
            ? // Like the line of text it replaces: no box until hovered.
              // and no focus ring: focused from the keyboard, it takes the hover's look.
              '-ml-1 max-w-full shrink-0 gap-1 border-0 bg-transparent px-1 py-0 text-xs text-muted-foreground shadow-none hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:ring-0 data-[size=default]:h-5 dark:bg-transparent dark:hover:bg-muted [&>svg:last-child]:size-3'
            : 'w-full sm:w-80',
        )}
      >
        {/* Inline, the model's name is short and the line has room: never cut nor faded. */}
        <SelectValue
          className={cn(
            inline && 'max-h-none! gap-1.5! overflow-visible! [animation:none]! [mask-image:none]!',
          )}
        >
          <HarnessLogo harness={value.harness} className={inline ? 'size-3' : undefined} />
          <span className={inline ? 'whitespace-nowrap' : 'truncate'}>
            {modelLabel(value.harness, value.model)}
          </span>
          {!inline && (
            <span className="text-muted-foreground">· {harnessLabel(value.harness)}</span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent position="popper" align="start" className={cn('max-h-96', inline && 'w-80')}>
        {harnesses.map((h, i) => (
          <Fragment key={h}>
            {i > 0 && <SelectSeparator />}
            <SelectGroup>
              <SelectLabel className="flex items-center gap-2 font-semibold">
                <HarnessLogo harness={h} className="size-3.5" />
                {harnessLabel(h)}
              </SelectLabel>
              {/* Settings say it under the field; here, under the agent's name. */}
              {inline && CAVEATS[h] && (
                <p className="px-2 pb-1 text-xs text-warning">{CAVEATS[h]}</p>
              )}
              <ModelOption value={`${h}:${DEFAULT_MODEL}`} label="Default">
                {defaultLine(h)}
              </ModelOption>
              {HARNESS_MODELS[h].map((m) => (
                <ModelOption key={m.id} value={`${h}:${m.id}`} label={m.label}>
                  {m.description}
                </ModelOption>
              ))}
              {legacy && legacy.harness === h && (
                <ModelOption value={`${h}:${legacy.model}`} label={legacy.model!}>
                  Saved earlier; not in the current list
                </ModelOption>
              )}
            </SelectGroup>
          </Fragment>
        ))}
      </SelectContent>
    </Select>
  )
}

function ModelOption({
  value,
  label,
  children,
}: {
  value: string
  label: string
  children: string
}) {
  return (
    <SelectItem value={value} className="items-start py-2">
      <span className="flex flex-col gap-0.5">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{children}</span>
      </span>
    </SelectItem>
  )
}

/**
 * Under a teammate's name: its model, changed in place by owners and admins, saved at once (its
 * next turns use it, in every thread). Others see the model as text, as they can't change a
 * teammate. `suffix` follows it on the line (" on the cloud computer").
 */
export function TeammateModelLine({
  teammate,
  suffix,
  onSaved,
}: {
  teammate: Pick<Teammate, 'id' | 'model'> & { harness: string }
  suffix?: string
  /** Saved: what shows the teammate fetches it again (the teammates are, always). */
  onSaved?: () => void
}) {
  const { me, reloadTeammates } = useDashboard()
  const saved = { harness: teammate.harness as Harness, model: teammate.model }
  // What was just picked, shown while it saves; dropped once the saved teammate says so.
  const [picked, setPicked] = useState<ModelChoice>()
  const [error, setError] = useState<string>()
  const shown = picked ?? saved

  if (!isAdmin(me))
    return (
      <span className="block truncate text-xs text-muted-foreground">
        {teammateModelLabel(teammate)}
        {suffix}
      </span>
    )

  async function change(next: ModelChoice) {
    if (valueOf(next) === valueOf(shown)) return
    setPicked(next)
    setError(undefined)
    try {
      await api(`/teammates/${teammate.id}`, { method: 'PATCH', body: next })
      await reloadTeammates()
      onSaved?.()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPicked(undefined)
    }
  }

  return (
    <span className="flex min-w-0 flex-col items-start">
      <span className="flex max-w-full min-w-0 items-center">
        <ModelSelect
          variant="inline"
          value={shown}
          saved={saved}
          disabled={!!picked}
          onChange={(next) => void change(next)}
        />
        {suffix && <span className="truncate text-xs text-muted-foreground">{suffix}</span>}
      </span>
      {error && <span className="text-xs text-destructive-text">{error}</span>}
    </span>
  )
}
