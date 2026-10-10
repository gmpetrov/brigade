'use client'
import Link from 'next/link'
import { useId, useState } from 'react'
import { Check, ChevronsUpDown, FolderGit2, Lock, Plus } from 'lucide-react'
import { isAdmin, timeAgo, useDashboard } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { api, useApi, type Repository, type RepositoryOption } from '@/lib/api'

export default function RepositoriesPage() {
  const { me } = useDashboard()
  const admin = isAdmin(me)
  const repositories = useApi<Repository[]>('/repositories')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string>()
  const [error, setError] = useState<string>()

  async function remove(p: Repository) {
    if (
      !confirm(
        `Remove ${p.repository}? Teammates can still check it out, without its setup script and notes.`,
      )
    )
      return
    setError(undefined)
    await api(`/repositories/${p.id}`, { method: 'DELETE' }).catch((e) =>
      setError((e as Error).message),
    )
    await repositories.reload()
  }

  const addButton = admin && !adding && (
    <Button onClick={() => setAdding(true)}>
      <Plus />
      Add a repository
    </Button>
  )

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <h1 className="text-3xl font-extrabold tracking-tight">Repositories</h1>
            <p className="max-w-prose text-muted-foreground">
              The GitHub repositories your teammates work on. A teammate checks one out on its own{' '}
              <code className="font-mono text-sm">brigade/</code> branch, runs the setup script, and
              reads your notes before it starts.
            </p>
          </div>
          {addButton}
        </div>
        {error && <p className="text-sm text-destructive-text">{error}</p>}
      </header>

      {adding && (
        <RepositoryForm
          taken={(repositories.data ?? []).map((p) => p.repository)}
          onCancel={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false)
            await repositories.reload()
          }}
        />
      )}

      {repositories.data?.length === 0 && !adding ? (
        <Card className="items-center gap-3 border-dashed px-6 py-12 text-center shadow-none">
          <span
            aria-hidden
            className="flex size-11 items-center justify-center rounded-md bg-primary/15 text-primary"
          >
            <FolderGit2 className="size-5" />
          </span>
          <p className="font-semibold">No repositories yet.</p>
          <p className="max-w-prose text-sm text-muted-foreground">
            Teammates with a{' '}
            <Link
              href="/app/connections"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              GitHub connection
            </Link>{' '}
            can already check out its repositories. Add one to give it a setup script and notes.
          </p>
          {addButton}
        </Card>
      ) : (repositories.data ?? []).length > 0 ? (
        <Card className="gap-0 divide-y py-0">
          {(repositories.data ?? []).map((p) => (
            <div key={p.id} className="flex flex-col gap-3 px-5 py-4">
              <div className="flex flex-wrap items-center gap-4">
                <span
                  aria-hidden
                  className="flex size-11 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground"
                >
                  <FolderGit2 className="size-5" />
                </span>
                <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
                  <a
                    href={`https://github.com/${p.repository}`}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate font-mono font-semibold underline-offset-4 hover:underline"
                  >
                    {p.repository}
                  </a>
                  <span className="truncate text-sm text-muted-foreground">
                    {p.setupScript ? 'Setup script' : 'No setup script'}
                    {p.notes.trim() ? ' · notes' : ''} · updated {timeAgo(p.updatedAt)}
                  </span>
                </div>
                {admin && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      aria-expanded={editing === p.id}
                      onClick={() => setEditing(editing === p.id ? undefined : p.id)}
                    >
                      Edit
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => void remove(p)}>
                      Remove
                    </Button>
                  </div>
                )}
              </div>
              {editing === p.id ? (
                <RepositoryForm
                  existing={p}
                  onCancel={() => setEditing(undefined)}
                  onSaved={async () => {
                    setEditing(undefined)
                    await repositories.reload()
                  }}
                />
              ) : (
                !admin &&
                (p.setupScript || p.notes.trim()) && (
                  <div className="flex flex-col gap-2 text-sm">
                    {p.setupScript && (
                      <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
                        {p.setupScript}
                      </pre>
                    )}
                    {p.notes.trim() && (
                      <p className="whitespace-pre-wrap text-muted-foreground">{p.notes}</p>
                    )}
                  </div>
                )
              )}
            </div>
          ))}
        </Card>
      ) : null}
    </div>
  )
}

/** Add a repository, or edit one's setup script and notes. */
function RepositoryForm({
  existing,
  taken = [],
  onCancel,
  onSaved,
}: {
  existing?: Repository
  /** Repositories added already, left out of the picker. */
  taken?: string[]
  onCancel: () => void
  onSaved: () => Promise<void>
}) {
  const available = useApi<RepositoryOption[]>(existing ? null : '/repositories/available')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [repository, setRepository] = useState<string>()
  const prefix = existing ? `repository-${existing.id}` : 'repository'

  async function save(form: FormData) {
    setError(undefined)
    const target = existing?.repository ?? repository
    if (!target) return setError('Pick a repository.')
    setBusy(true)
    try {
      await api('/repositories', {
        method: 'PUT',
        body: {
          repository: target,
          setupScript: String(form.get('setupScript') ?? ''),
          notes: String(form.get('notes') ?? ''),
        },
      })
      await onSaved()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const options = available.data ?? []
  return (
    <form
      action={save}
      className={cn(
        'flex flex-col gap-4',
        existing ? 'rounded-lg border bg-muted/50 p-4' : 'rounded-xl border bg-card p-5 shadow-sm',
      )}
    >
      {!existing && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${prefix}-repository`}>Repository</Label>
          <RepositoryPicker
            id={`${prefix}-repository`}
            options={options.filter((r) => !taken.includes(r.repository))}
            loading={available.data === undefined}
            value={repository}
            onChange={setRepository}
          />
          <p className="text-sm text-muted-foreground">
            {available.data === undefined
              ? 'Loading what your GitHub connections reach…'
              : options.length > 0
                ? `Your GitHub connections reach ${options.length} ${options.length === 1 ? 'repository' : 'repositories'}.`
                : 'No GitHub connection reaches any repository yet: add one under Connections.'}
          </p>
        </div>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${prefix}-setup`}>Setup script (optional)</Label>
        <Textarea
          id={`${prefix}-setup`}
          name="setupScript"
          rows={3}
          maxLength={20_000}
          defaultValue={existing?.setupScript ?? ''}
          placeholder={'pnpm install\ncp .env.example .env'}
          spellCheck={false}
          className={cn('font-mono text-sm', existing && 'bg-card')}
        />
        <p className="text-sm text-muted-foreground">
          Runs once in each new checkout, as the teammate, with up to 20 minutes. Its output goes to
          the teammate.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${prefix}-notes`}>Notes for teammates (optional)</Label>
        <Textarea
          id={`${prefix}-notes`}
          name="notes"
          rows={3}
          maxLength={20_000}
          defaultValue={existing?.notes}
          placeholder="Run pnpm test before pushing. Never touch the migrations folder."
          className={cn(existing && 'bg-card')}
        />
      </div>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={busy}>{existing ? 'Save' : 'Add repository'}</Button>
      </div>
    </form>
  )
}

/** A searchable list of the repositories the workspace's GitHub connections reach. */
function RepositoryPicker({
  id,
  options,
  loading,
  value,
  onChange,
}: {
  id: string
  options: RepositoryOption[]
  loading: boolean
  value?: string
  onChange: (repository: string | undefined) => void
}) {
  const listId = useId()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)

  const q = query.trim().toLowerCase()
  // Names that start with the query first, then repositories whose name does.
  const matches =
    q && q !== value?.toLowerCase()
      ? options
          .filter((r) => r.repository.toLowerCase().includes(q))
          .sort(
            (a, b) =>
              Number(!a.repository.toLowerCase().startsWith(q)) -
              Number(!b.repository.toLowerCase().startsWith(q)),
          )
      : options

  function pick(r: RepositoryOption) {
    onChange(r.repository)
    setQuery(r.repository)
    setOpen(false)
  }

  return (
    <div className="relative sm:w-96">
      <Input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
        value={query}
        disabled={loading}
        placeholder={loading ? 'Loading repositories…' : 'Search repositories'}
        autoComplete="off"
        spellCheck={false}
        className="pr-9 font-mono"
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => {
          setOpen(false)
          // Leaving with a half-typed name keeps the last pick.
          setQuery(value ?? '')
        }}
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
          setOpen(true)
          if (value) onChange(undefined)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            if (!open) return setOpen(true)
            const n = matches.length
            if (n) setActive((active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
          } else if (e.key === 'Enter') {
            // Enter picks rather than submits while the list is open.
            if (open && matches[active]) {
              e.preventDefault()
              pick(matches[active])
            }
          } else if (e.key === 'Escape' && open) {
            e.preventDefault()
            setOpen(false)
          }
        }}
      />
      <ChevronsUpDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
      {open && !loading && (
        <div
          id={listId}
          role="listbox"
          className="absolute inset-x-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {matches.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              {options.length ? `Nothing matches “${query}”` : 'No repository to add'}
            </p>
          ) : (
            matches.map((r, i) => (
              <div
                key={r.repository}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
                // Pick on mousedown, before the input blurs.
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(r)
                }}
                onMouseMove={() => i !== active && setActive(i)}
                ref={(el) => {
                  if (i === active) el?.scrollIntoView({ block: 'nearest' })
                }}
              >
                <Check
                  aria-hidden
                  className={cn('size-4 flex-none', r.repository !== value && 'invisible')}
                />
                <span className="min-w-0 flex-1 truncate font-mono">{r.repository}</span>
                {r.private && (
                  <Lock aria-label="Private" className="size-3.5 flex-none text-muted-foreground" />
                )}
                <span className="max-w-[40%] flex-none truncate text-xs text-muted-foreground">
                  {r.connection}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
