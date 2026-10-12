'use client'
// A repository's preview variables: values people give its preview (API keys,
// settings) beside the setup a teammate saved. Set in the ticket a teammate
// opens when it needs them, or on the Saved previews list. A secret's value is
// never shown again, and the teammate never sees it: each start of the
// preview gives it to the app.
import type { Ask, AskReply, PreviewVariable, PreviewVariableKind } from '@brigade/contracts'
import { KeyRound, LoaderCircle, Sparkles, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { timeAgo, useDashboard } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, isAdmin, useApi } from '@/lib/api'
import { cn } from '@/lib/utils'

/** Prefixes frameworks build into the pages browsers download. */
const PUBLIC_PREFIX = /^(NEXT_PUBLIC_|VITE_|PUBLIC_|REACT_APP_|EXPO_PUBLIC_|NUXT_PUBLIC_|GATSBY_)/
/** Keys that act on real accounts: Stripe live keys, AWS, Slack, GitHub tokens. */
const LIVE_KEY = /^(sk|rk)_live_|^AKIA[0-9A-Z]{16}$|^xox[abp]-|^gh[pousr]_|^github_pat_/

const KIND_LABEL: Record<PreviewVariableKind, string> = {
  secret: 'Secret',
  setting: 'Setting',
  generated: 'Generated',
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** What to warn about a value before it is saved, if anything. */
export function variableWarning(name: string, kind: PreviewVariableKind, value: string) {
  const prefix = PUBLIC_PREFIX.exec(name)?.[1]
  if (prefix && kind !== 'setting')
    return `${prefix} variables are built into the pages browsers download: anyone who opens the preview can read this value.`
  if (LIVE_KEY.test(value.trim()))
    return "This looks like a live key: anyone with the preview's link uses the app with it. Prefer a test key."
}

const path = (repository: string) => `/repositories/${repository.toLowerCase()}/preview/variables`

type Entry =
  | { mode: 'value'; value: string }
  | { mode: 'generate' }
  | { mode: 'skip' }
  /** Already set for the preview: kept as it is. */
  | { mode: 'keep' }

/**
 * A ticket's variables ask: a field for each value the preview needs. Saving
 * stores them for the preview first; the ticket's reply names them only.
 */
export function VariablesAsk({
  ask,
  askerName,
  onReply,
}: {
  ask: Extract<Ask, { type: 'variables' }>
  askerName: string
  onReply: (reply: AskReply) => void
}) {
  const existing = useApi<PreviewVariable[]>(path(ask.repository))
  const [entries, setEntries] = useState<Record<string, Entry>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const isSet = (name: string) => existing.data?.some((v) => v.name === name) ?? false
  const entryOf = (name: string): Entry =>
    entries[name] ?? (isSet(name) ? { mode: 'keep' } : { mode: 'value', value: '' })
  const set = (name: string, entry: Entry) => setEntries((e) => ({ ...e, [name]: entry }))
  const ready =
    existing.data !== undefined &&
    ask.variables.every((v) => {
      const entry = entryOf(v.name)
      return entry.mode !== 'value' || entry.value.trim() !== ''
    })

  async function save() {
    setBusy(true)
    setError(undefined)
    try {
      const variables = ask.variables.flatMap((v) => {
        const entry = entryOf(v.name)
        const description = v.description ? { description: v.description } : {}
        if (entry.mode === 'generate') return [{ name: v.name, kind: 'generated', ...description }]
        if (entry.mode !== 'value') return []
        return [
          {
            name: v.name,
            kind: v.secret === false ? 'setting' : 'secret',
            value: v.secret === false ? entry.value : entry.value.trim(),
            ...description,
          },
        ]
      })
      if (variables.length) await api(path(ask.repository), { method: 'PUT', body: { variables } })
      const skipped = ask.variables
        .filter((v) => entryOf(v.name).mode === 'skip')
        .map((v) => v.name)
      onReply({
        type: 'variables',
        set: ask.variables.map((v) => v.name).filter((n) => !skipped.includes(n)),
        skipped,
      })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Kept with the preview of <span className="font-mono">{ask.repository}</span> and given to
        the app each time it starts. {askerName} sees their names, never their values.
      </p>
      <ul className="flex flex-col gap-3">
        {ask.variables.map((v) => {
          const entry = entryOf(v.name)
          const secret = v.secret !== false
          const warning =
            entry.mode === 'value'
              ? variableWarning(v.name, secret ? 'secret' : 'setting', entry.value)
              : undefined
          return (
            <li key={v.name} className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <code className="font-mono text-sm font-semibold break-all">{v.name}</code>
                <span className="text-xs text-muted-foreground">
                  {secret ? 'Secret' : 'Setting'}
                </span>
              </div>
              {v.description && <p className="text-sm text-muted-foreground">{v.description}</p>}
              {entry.mode === 'keep' ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Already set for the preview.</span>
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0"
                    onClick={() => set(v.name, { mode: 'value', value: '' })}
                  >
                    Replace
                  </Button>
                </div>
              ) : entry.mode === 'skip' || entry.mode === 'generate' ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted-foreground">
                    {entry.mode === 'skip'
                      ? `Skipped: ${askerName} carries on without it.`
                      : 'Brigade makes a random value.'}
                  </span>
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0"
                    onClick={() =>
                      set(v.name, isSet(v.name) ? { mode: 'keep' } : { mode: 'value', value: '' })
                    }
                  >
                    Undo
                  </Button>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      type={secret ? 'password' : 'text'}
                      autoComplete="off"
                      spellCheck={false}
                      aria-label={v.name}
                      placeholder={secret ? 'Paste the value' : 'Value'}
                      className="min-w-0 flex-1 basis-56 font-mono text-sm"
                      value={entry.value}
                      onChange={(e) => set(v.name, { mode: 'value', value: e.target.value })}
                    />
                    {secret && (
                      <Button
                        size="sm"
                        variant="outline"
                        title="For a session or signing secret the app only needs to keep"
                        onClick={() => set(v.name, { mode: 'generate' })}
                      >
                        <Sparkles aria-hidden />
                        Generate
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => set(v.name, { mode: 'skip' })}>
                      Skip
                    </Button>
                  </div>
                  {warning && <p className="text-sm text-warning">{warning}</p>}
                </>
              )}
            </li>
          )
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!ready || busy} onClick={() => void save()}>
          {busy && <LoaderCircle aria-hidden className="animate-spin" />}
          Save for the preview
        </Button>
        {(error ?? existing.error?.message) && (
          <span className="text-sm text-destructive-text">{error ?? existing.error?.message}</span>
        )}
      </div>
    </div>
  )
}

/**
 * A repository's preview variables on the Saved previews list: add, replace,
 * remove. Any member adds and replaces; whoever set one last, an owner or an
 * admin removes it.
 */
export function PreviewVariables({
  repository,
  variables,
  onChange,
}: {
  repository: string
  variables: PreviewVariable[]
  onChange: () => Promise<unknown>
}) {
  const { me } = useDashboard()
  const [editing, setEditing] = useState<string>()
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(undefined)
    try {
      await action()
      await onChange()
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }

  const save = (name: string, kind: PreviewVariableKind, value: string) =>
    run(() =>
      api(path(repository), {
        method: 'PUT',
        body: {
          variables: [kind === 'generated' ? { name, kind } : { name, kind, value }],
        },
      }),
    )

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">Variables</span>
        <span className="text-xs text-muted-foreground">
          Given to the app each time it starts; the teammate sees their names only.
        </span>
      </div>
      {variables.length > 0 && (
        <ul className="flex flex-col divide-y rounded-md border">
          {variables.map((v) =>
            editing === v.name ? (
              <li key={v.name} className="px-3 py-2">
                <VariableForm
                  initial={{ name: v.name, kind: v.kind, value: v.value ?? '' }}
                  fixedName
                  busy={busy}
                  onCancel={() => setEditing(undefined)}
                  onSave={async (kind, value) => {
                    if (await save(v.name, kind, value)) setEditing(undefined)
                  }}
                />
              </li>
            ) : (
              <li key={v.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <code className="min-w-0 basis-48 font-mono text-xs font-semibold break-all">
                  {v.name}
                </code>
                <span className="text-xs text-muted-foreground">{KIND_LABEL[v.kind]}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                  {v.kind === 'setting' ? v.value || '(empty)' : '••••••••'}
                </span>
                <span className="text-xs text-muted-foreground">
                  {v.updatedBy ? `${v.updatedBy.name}, ` : ''}
                  {timeAgo(v.updatedAt)}
                </span>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setAdding(false)
                      setEditing(v.name)
                    }}
                  >
                    {v.kind === 'setting' ? 'Edit' : 'Replace'}
                  </Button>
                  {(isAdmin(me) || v.updatedBy?.id === me.memberId) && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy}
                      aria-label={`Remove ${v.name}`}
                      title={`Remove ${v.name}`}
                      onClick={() => {
                        if (
                          !confirm(
                            `Remove ${v.name}? The next start of the preview goes without it.`,
                          )
                        )
                          return
                        void run(() =>
                          api(`${path(repository)}/${encodeURIComponent(v.name)}`, {
                            method: 'DELETE',
                          }),
                        )
                      }}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  )}
                </div>
              </li>
            ),
          )}
        </ul>
      )}
      {adding ? (
        <div className="rounded-md border px-3 py-2">
          <VariableForm
            initial={{ name: '', kind: 'secret', value: '' }}
            taken={variables.map((v) => v.name)}
            busy={busy}
            onCancel={() => setAdding(false)}
            onSave={async (kind, value, name) => {
              if (await save(name, kind, value)) setAdding(false)
            }}
          />
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={busy}
          onClick={() => {
            setEditing(undefined)
            setAdding(true)
          }}
        >
          <KeyRound aria-hidden />
          Add a variable
        </Button>
      )}
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      {variables.length > 0 && (
        <p className="text-xs text-muted-foreground">
          A preview that is running gets new values when it starts again.
        </p>
      )}
    </div>
  )
}

function VariableForm({
  initial,
  fixedName,
  taken = [],
  busy,
  onCancel,
  onSave,
}: {
  initial: { name: string; kind: PreviewVariableKind; value: string }
  fixedName?: boolean
  taken?: string[]
  busy: boolean
  onCancel: () => void
  onSave: (kind: PreviewVariableKind, value: string, name: string) => Promise<void>
}) {
  const [name, setName] = useState(initial.name)
  // A secret is replaced, never shown: its field starts empty.
  const [kind, setKind] = useState<PreviewVariableKind>(initial.kind)
  const [value, setValue] = useState(initial.kind === 'setting' ? initial.value : '')
  const nameProblem = !name
    ? undefined
    : !ENV_NAME.test(name)
      ? 'Letters, digits and _, not starting with a digit'
      : !fixedName && taken.includes(name)
        ? 'Already set: replace it in the list'
        : undefined
  const warning = kind === 'generated' ? undefined : variableWarning(name, kind, value)
  const ready =
    name !== '' &&
    !nameProblem &&
    (kind === 'generated' || kind === 'setting' || value.trim() !== '')

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) void onSave(kind, kind === 'secret' ? value.trim() : value, name)
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        {fixedName ? (
          <code className="basis-48 font-mono text-xs font-semibold break-all">{name}</code>
        ) : (
          <Input
            autoFocus
            aria-label="Name"
            placeholder="NAME"
            spellCheck={false}
            className="min-w-0 basis-48 font-mono text-sm"
            value={name}
            onChange={(e) => setName(e.target.value.trim())}
          />
        )}
        <Select value={kind} onValueChange={(k) => setKind(k as PreviewVariableKind)}>
          <SelectTrigger size="sm" aria-label="Kind" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="secret">Secret</SelectItem>
            <SelectItem value="setting">Setting</SelectItem>
            <SelectItem value="generated">Generated</SelectItem>
          </SelectContent>
        </Select>
        {kind === 'generated' ? (
          <span className="min-w-0 flex-1 basis-56 text-sm text-muted-foreground">
            {fixedName ? 'Brigade makes a new random value.' : 'Brigade makes a random value.'}
          </span>
        ) : (
          <Input
            autoFocus={fixedName}
            type={kind === 'secret' ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            aria-label="Value"
            placeholder={kind === 'secret' ? 'Paste the value' : 'Value'}
            className={cn('min-w-0 flex-1 basis-56 font-mono text-sm')}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        <Button type="submit" size="sm" disabled={!ready || busy}>
          {busy && <LoaderCircle aria-hidden className="animate-spin" />}
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {nameProblem && <p className="text-sm text-destructive-text">{nameProblem}</p>}
      {warning && <p className="text-sm text-warning">{warning}</p>}
    </form>
  )
}
