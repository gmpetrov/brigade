'use client'
// A repository's preview variables: values people give its preview (API keys,
// settings) beside the setup a teammate saved. Set in the ticket a teammate
// opens when it needs them, or on the Saved previews list. A secret's value is
// never shown again, and the teammate never sees it: each start of the
// preview gives it to the app. Pasting a .env file into any field fills in
// each of its variables, as on Vercel.
import {
  reservedPreviewVariable,
  type Ask,
  type AskReply,
  type PreviewVariable,
  type PreviewVariableKind,
} from '@brigade/contracts'
import { KeyRound, LoaderCircle, Plus, Sparkles, Trash2, X } from 'lucide-react'
import { useState, type ClipboardEvent } from 'react'
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
import { pastedEnv, type EnvEntry } from '@/lib/dotenv'

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

/** A variable being added, before it is saved. */
type Row = { key: number; name: string; kind: PreviewVariableKind; value: string }

let rowKeys = 0
/**
 * A new row: a secret, unless it comes from a pasted file and is empty (a
 * secret cannot be) or one browsers read anyway (NEXT_PUBLIC_…): a setting.
 */
const newRow = (name = '', value = '', pasted = false): Row => ({
  key: ++rowKeys,
  name,
  kind: pasted && (value === '' || PUBLIC_PREFIX.test(name)) ? 'setting' : 'secret',
  value,
})

/** Why a name cannot be saved, if it cannot. */
function nameProblem(name: string) {
  if (!ENV_NAME.test(name)) return 'Letters, digits and _, not starting with a digit'
  if (reservedPreviewVariable(name)) return 'The preview sets this one itself'
}

/** A pasted .env file's variables, split into those a preview may have and the names left out. */
function usable(entries: EnvEntry[]) {
  const left = entries.filter((e) => reservedPreviewVariable(e.name)).map((e) => e.name)
  return { entries: entries.filter((e) => !left.includes(e.name)), left }
}

const leftOutNote = (names: string[]) =>
  names.length
    ? `Left out ${names.join(', ')}: the preview sets ${names.length === 1 ? 'it' : 'them'} itself.`
    : undefined

/**
 * Pasted variables into rows: the row pasted into is replaced unless it is
 * filled in, a row of the same name takes the new value, the rest are added
 * where the paste was.
 */
function mergeRows(rows: Row[], into: number | undefined, entries: EnvEntry[]) {
  const at = rows.findIndex((r) => r.key === into)
  const target = rows[at]
  const keep = !target || (target.name !== '' && target.value !== '')
  const next = keep ? [...rows] : rows.filter((r) => r.key !== into)
  const added: Row[] = []
  for (const { name, value } of entries) {
    const same = next.findIndex((r) => r.name === name)
    if (same >= 0)
      next[same] = {
        ...next[same]!,
        value,
        kind: next[same]!.kind === 'generated' ? 'secret' : next[same]!.kind,
      }
    else added.push(newRow(name, value, true))
  }
  next.splice(keep ? next.length : at, 0, ...added)
  return next.length ? next : [newRow()]
}

/** Rows that say something: a row with neither name nor value is left out. */
const filled = (rows: Row[]) => rows.filter((r) => r.name !== '' || r.value !== '')

const rowProblem = (row: Row, rows: Row[]) =>
  nameProblem(row.name) ??
  (rows.filter((r) => r.name === row.name).length > 1 ? 'Twice in the list' : undefined) ??
  (row.kind === 'secret' && !row.value.trim() ? 'Give it a value' : undefined)

/** Rows as the API takes them. */
const asVariables = (rows: Row[]) =>
  filled(rows).map((r) =>
    r.kind === 'generated'
      ? { name: r.name, kind: r.kind }
      : { name: r.name, kind: r.kind, value: r.kind === 'secret' ? r.value.trim() : r.value },
  )

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
  // Other variables of a pasted .env file, saved with these.
  const [extra, setExtra] = useState<Row[]>([])
  const [leftOut, setLeftOut] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const asked = ask.variables.map((v) => v.name)

  /** A .env file pasted into a field: the values asked for go in their fields, the rest below. */
  function paste(e: ClipboardEvent<HTMLInputElement>, name: string) {
    const pasted = pastedEnv(e.clipboardData.getData('text'), { value: true, name })
    if (!pasted) return
    e.preventDefault()
    const { entries: found, left } = usable(pasted)
    setLeftOut(left)
    setEntries((current) => {
      const next = { ...current }
      for (const entry of found)
        if (asked.includes(entry.name)) next[entry.name] = { mode: 'value', value: entry.value }
      return next
    })
    const others = found.filter((entry) => !asked.includes(entry.name))
    if (others.length) setExtra((rows) => filled(mergeRows(rows, undefined, others)))
  }

  const isSet = (name: string) => existing.data?.some((v) => v.name === name) ?? false
  const entryOf = (name: string): Entry =>
    entries[name] ?? (isSet(name) ? { mode: 'keep' } : { mode: 'value', value: '' })
  const set = (name: string, entry: Entry) => setEntries((e) => ({ ...e, [name]: entry }))
  const extraRows = filled(extra)
  const ready =
    existing.data !== undefined &&
    ask.variables.every((v) => {
      const entry = entryOf(v.name)
      return entry.mode !== 'value' || entry.value.trim() !== ''
    }) &&
    extraRows.every((r) => !rowProblem(r, [...extraRows, ...asked.map((n) => newRow(n))]))

  async function save() {
    setBusy(true)
    setError(undefined)
    try {
      const variables: object[] = ask.variables.flatMap((v) => {
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
      variables.push(...asVariables(extra))
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
                      onPaste={(e) => paste(e, v.name)}
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
      {extra.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Also in the file</span>
          <DraftRows
            rows={extra}
            onChange={(rows) => setExtra(filled(rows))}
            taken={existing.data?.map((v) => v.name) ?? []}
            others={asked}
            onLeftOut={setLeftOut}
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Paste a .env file into any field to fill in each variable it has.
        </p>
      )}
      {leftOutNote(leftOut) && (
        <p className="text-xs text-muted-foreground">{leftOutNote(leftOut)}</p>
      )}
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
        <span className="text-sm font-medium">Environment Variables</span>
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
        <NewVariables
          taken={variables.map((v) => v.name)}
          busy={busy}
          onCancel={() => setAdding(false)}
          onSave={async (rows) => {
            const saved = await run(() =>
              api(path(repository), { method: 'PUT', body: { variables: asVariables(rows) } }),
            )
            if (saved) setAdding(false)
          }}
        />
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
          Add variables
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

/** Replace or edit one variable that is set: its name stays. */
function VariableForm({
  initial,
  busy,
  onCancel,
  onSave,
}: {
  initial: { name: string; kind: PreviewVariableKind; value: string }
  busy: boolean
  onCancel: () => void
  onSave: (kind: PreviewVariableKind, value: string) => Promise<void>
}) {
  const { name } = initial
  // A secret is replaced, never shown: its field starts empty.
  const [kind, setKind] = useState<PreviewVariableKind>(initial.kind)
  const [value, setValue] = useState(initial.kind === 'setting' ? initial.value : '')
  const warning = kind === 'generated' ? undefined : variableWarning(name, kind, value)
  const ready = kind !== 'secret' || value.trim() !== ''

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) void onSave(kind, kind === 'secret' ? value.trim() : value)
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <code className="basis-48 font-mono text-xs font-semibold break-all">{name}</code>
        <KindSelect kind={kind} onChange={setKind} />
        {kind === 'generated' ? (
          <span className="min-w-0 flex-1 basis-56 text-sm text-muted-foreground">
            Brigade makes a new random value.
          </span>
        ) : (
          <Input
            autoFocus
            type={kind === 'secret' ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            aria-label="Value"
            placeholder={kind === 'secret' ? 'Paste the value' : 'Value'}
            className="min-w-0 flex-1 basis-56 font-mono text-sm"
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
      {warning && <p className="text-sm text-warning">{warning}</p>}
    </form>
  )
}

function KindSelect({
  kind,
  onChange,
}: {
  kind: PreviewVariableKind
  onChange: (kind: PreviewVariableKind) => void
}) {
  return (
    <Select value={kind} onValueChange={(k) => onChange(k as PreviewVariableKind)}>
      <SelectTrigger size="sm" aria-label="Kind" className="w-32">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="secret">Secret</SelectItem>
        <SelectItem value="setting">Setting</SelectItem>
        <SelectItem value="generated">Generated</SelectItem>
      </SelectContent>
    </Select>
  )
}

/** New variables for the list: one row to start, a row each for a pasted .env file's. */
function NewVariables({
  taken,
  busy,
  onCancel,
  onSave,
}: {
  taken: string[]
  busy: boolean
  onCancel: () => void
  onSave: (rows: Row[]) => Promise<void>
}) {
  const [rows, setRows] = useState<Row[]>(() => [newRow()])
  const [leftOut, setLeftOut] = useState<string[]>([])
  const list = filled(rows)
  const ready = list.length > 0 && list.every((r) => !rowProblem(r, list))

  return (
    <form
      className="flex flex-col gap-2 rounded-md border px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) void onSave(list)
      }}
    >
      <DraftRows rows={rows} onChange={setRows} taken={taken} onLeftOut={setLeftOut} autoFocus />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={!ready || busy}>
          {busy && <LoaderCircle aria-hidden className="animate-spin" />}
          {list.length > 1 ? `Save ${list.length} variables` : 'Save'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setRows((r) => [...r, newRow()])}
        >
          <Plus aria-hidden />
          Another
        </Button>
        <span className="text-xs text-muted-foreground">
          {leftOutNote(leftOut) ?? 'Paste a .env file into a field to add each of its variables.'}
        </span>
      </div>
    </form>
  )
}

/**
 * Rows of variables being added: name, kind, value. A .env file pasted into
 * a field becomes a row per variable.
 */
function DraftRows({
  rows,
  onChange,
  taken,
  others = [],
  onLeftOut,
  autoFocus,
}: {
  rows: Row[]
  onChange: (rows: Row[]) => void
  /** Already set for the preview: a row of that name replaces it. */
  taken: string[]
  /** Names set elsewhere in the same form. */
  others?: string[]
  onLeftOut: (names: string[]) => void
  autoFocus?: boolean
}) {
  const update = (key: number, change: Partial<Row>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...change } : r)))

  function paste(e: ClipboardEvent<HTMLInputElement>, row: Row, field: 'name' | 'value') {
    const pasted = pastedEnv(
      e.clipboardData.getData('text'),
      field === 'name' ? { value: false } : { value: true, name: row.name },
    )
    if (!pasted) return
    e.preventDefault()
    const { entries, left } = usable(pasted)
    onLeftOut(left)
    if (entries.length) onChange(mergeRows(rows, row.key, entries))
  }

  const all = [...rows, ...others.map((n) => newRow(n))]
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row, i) => {
        const empty = row.name === '' && row.value === ''
        const problem = empty || row.name === '' ? undefined : rowProblem(row, filled(all))
        const warning =
          row.kind === 'generated' ? undefined : variableWarning(row.name, row.kind, row.value)
        return (
          <li key={row.key} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                autoFocus={autoFocus && i === 0}
                aria-label="Name"
                placeholder="NAME"
                spellCheck={false}
                className="min-w-0 basis-48 font-mono text-sm"
                value={row.name}
                onChange={(e) => update(row.key, { name: e.target.value.trim() })}
                onPaste={(e) => paste(e, row, 'name')}
              />
              <KindSelect kind={row.kind} onChange={(kind) => update(row.key, { kind })} />
              {/* The value and its remove button wrap together. */}
              <div className="flex min-w-0 flex-1 basis-56 items-center gap-2">
                {row.kind === 'generated' ? (
                  <span className="min-w-0 flex-1 text-sm text-muted-foreground">
                    Brigade makes a random value.
                  </span>
                ) : (
                  <Input
                    type={row.kind === 'secret' ? 'password' : 'text'}
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={row.name ? `Value of ${row.name}` : 'Value'}
                    placeholder={row.kind === 'secret' ? 'Paste the value' : 'Value'}
                    className="min-w-0 flex-1 font-mono text-sm"
                    value={row.value}
                    onChange={(e) => update(row.key, { value: e.target.value })}
                    onPaste={(e) => paste(e, row, 'value')}
                  />
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={row.name ? `Remove ${row.name}` : 'Remove this row'}
                  title="Remove this row"
                  onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
                >
                  <X aria-hidden />
                </Button>
              </div>
            </div>
            {problem ? (
              <p className="text-sm text-destructive-text">{problem}</p>
            ) : warning ? (
              <p className="text-sm text-warning">{warning}</p>
            ) : taken.includes(row.name) ? (
              <p className="text-xs text-muted-foreground">Replaces the value set now.</p>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
