'use client'
import { TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import type { Teammate } from '@/lib/api'

export type TeammateInput = {
  name: string
  instructions: string
  harness: 'claude_code' | 'codex'
  model: string | null
}

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

  async function submit(form: FormData) {
    setBusy(true)
    setError(undefined)
    try {
      const model = String(form.get('model') ?? '').trim()
      await onSubmit({
        name: String(form.get('name')),
        instructions: String(form.get('instructions') ?? ''),
        harness: form.get('harness') === 'codex' ? 'codex' : 'claude_code',
        model: model || null,
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
              defaultValue={initial?.harness ?? 'claude_code'}
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
            <Input
              id="model"
              name="model"
              defaultValue={initial?.model ?? ''}
              placeholder="Default for the account"
            />
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
