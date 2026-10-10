'use client'
import { HARNESS_MODELS, isHarnessModel, modelLabel } from '@brigade/contracts'
import { TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectGroup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { Teammate } from '@/lib/api'

export type TeammateInput = {
  name: string
  instructions: string
  harness: 'claude_code' | 'codex'
  model: string | null
}

type Harness = TeammateInput['harness']
/** Radix Select can't hold null: this stands for "the account's default model". */
const DEFAULT_MODEL = 'default'

const optionClass =
  'flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-4 leading-normal font-normal transition-colors hover:bg-secondary has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5'

export function TeammateForm({
  initial,
  submitLabel,
  onSubmit,
}: {
  initial?: Teammate
  submitLabel: string
  onSubmit: (input: TeammateInput) => Promise<void>
}) {
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [harness, setHarness] = useState<Harness>(initial?.harness ?? 'claude_code')
  const [model, setModel] = useState<string | null>(initial?.model ?? null)
  // A model saved before the list existed stays selectable until it's changed.
  const legacy =
    initial?.model && initial.harness === harness && !isHarnessModel(harness, initial.model)
      ? initial.model
      : null

  function changeHarness(next: Harness) {
    setHarness(next)
    // Each agent has its own models: keep the choice only if the new one runs it too.
    if (!isHarnessModel(next, model) && model !== legacy) setModel(null)
  }

  async function submit(form: FormData) {
    setBusy(true)
    setError(undefined)
    try {
      await onSubmit({
        name: String(form.get('name')),
        instructions: String(form.get('instructions') ?? ''),
        harness,
        model,
      })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="w-full max-w-2xl">
      <CardContent>
        <form action={submit} className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              name="name"
              defaultValue={initial?.name}
              placeholder="Riley"
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="instructions">Role instructions</Label>
            <Textarea
              id="instructions"
              name="instructions"
              rows={6}
              defaultValue={initial?.instructions}
              placeholder="You handle customer support for Acme. Answer from the docs, be brief, and escalate refunds."
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label id="harness-label">Agent</Label>
            <RadioGroup
              name="harness"
              aria-labelledby="harness-label"
              value={harness}
              onValueChange={(value) => changeHarness(value as Harness)}
              className="grid-cols-[repeat(auto-fit,minmax(13rem,1fr))]"
            >
              <Label htmlFor="harness-claude_code" className={optionClass}>
                <RadioGroupItem id="harness-claude_code" value="claude_code" className="mt-0.5" />
                <span className="font-bold">Claude Agent</span>
              </Label>
              <Label htmlFor="harness-codex" className={optionClass}>
                <RadioGroupItem id="harness-codex" value="codex" className="mt-0.5" />
                <span className="flex flex-col gap-2">
                  <span className="font-bold">Codex</span>
                  <span className="flex items-start gap-1.5 rounded-md bg-warning/10 px-2 py-1.5 text-xs text-warning">
                    <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
                    Codex cannot ask before running commands or editing files, so its threads run
                    them without asking.
                  </span>
                </span>
              </Label>
            </RadioGroup>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="model">Model</Label>
            <Select
              value={model ?? DEFAULT_MODEL}
              onValueChange={(value) => setModel(value === DEFAULT_MODEL ? null : value)}
            >
              <SelectTrigger id="model" className="w-full sm:w-80">
                <SelectValue>{modelLabel(harness, model)}</SelectValue>
              </SelectTrigger>
              <SelectContent position="popper" className="max-h-96">
                <SelectGroup>
                  <SelectLabel>Select model</SelectLabel>
                  <ModelOption value={DEFAULT_MODEL} label="Default">
                    The account’s default model
                  </ModelOption>
                  {HARNESS_MODELS[harness].map((m) => (
                    <ModelOption key={m.id} value={m.id} label={m.label}>
                      {m.description}
                    </ModelOption>
                  ))}
                  {legacy && (
                    <ModelOption value={legacy} label={legacy}>
                      Saved earlier; not in the current list
                    </ModelOption>
                  )}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          {error && <p className="text-sm text-destructive-text">{error}</p>}
          <div className="flex justify-end border-t pt-5">
            <Button type="submit" disabled={busy}>
              {submitLabel}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function ModelOption({ value, label, children }: { value: string; label: string; children: string }) {
  return (
    <SelectItem value={value} className="items-start py-2">
      <span className="flex flex-col gap-0.5">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{children}</span>
      </span>
    </SelectItem>
  )
}
