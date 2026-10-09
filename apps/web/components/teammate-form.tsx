'use client'
import { useState } from 'react'
import type { Teammate } from '@/lib/api'

export type TeammateInput = {
  name: string
  instructions: string
  harness: 'claude_code' | 'codex'
  model: string | null
}

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
    <form action={submit} className="card">
      <div className="field">
        <label htmlFor="name">Name</label>
        <input id="name" name="name" defaultValue={initial?.name} placeholder="Riley" required />
      </div>
      <div className="field">
        <label htmlFor="instructions">Role instructions</label>
        <textarea
          id="instructions"
          name="instructions"
          rows={6}
          defaultValue={initial?.instructions}
          placeholder="You handle customer support for Acme. Answer from the docs, be brief, and escalate refunds."
        />
      </div>
      <div className="field">
        <label htmlFor="harness">Agent</label>
        <select id="harness" name="harness" defaultValue={initial?.harness ?? 'claude_code'}>
          <option value="claude_code">Claude Agent</option>
          <option value="codex">Codex</option>
        </select>
        <p className="hint">
          Codex cannot ask before running commands or editing files, so its threads run them without
          asking.
        </p>
      </div>
      <div className="field">
        <label htmlFor="model">Model</label>
        <input
          id="model"
          name="model"
          defaultValue={initial?.model ?? ''}
          placeholder="Default for the account"
        />
      </div>
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={busy}>
        {submitLabel}
      </button>
    </form>
  )
}
