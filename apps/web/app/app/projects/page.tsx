'use client'
import Link from 'next/link'
import { useState } from 'react'
import { FolderGit2, Plus } from 'lucide-react'
import { isAdmin, timeAgo, useDashboard } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { api, useApi, type Project, type RepositoryOption } from '@/lib/api'

export default function ProjectsPage() {
  const { me } = useDashboard()
  const admin = isAdmin(me)
  const projects = useApi<Project[]>('/projects')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string>()
  const [error, setError] = useState<string>()

  async function remove(p: Project) {
    if (
      !confirm(
        `Remove ${p.repository} from projects? Teammates can still check it out, without its setup script and notes.`,
      )
    )
      return
    setError(undefined)
    await api(`/projects/${p.id}`, { method: 'DELETE' }).catch((e) =>
      setError((e as Error).message),
    )
    await projects.reload()
  }

  const addButton = admin && !adding && (
    <Button onClick={() => setAdding(true)}>
      <Plus />
      Add a project
    </Button>
  )

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <h1 className="text-3xl font-extrabold tracking-tight">Projects</h1>
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
        <ProjectForm
          onCancel={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false)
            await projects.reload()
          }}
        />
      )}

      {projects.data?.length === 0 && !adding ? (
        <Card className="items-center gap-3 border-dashed px-6 py-12 text-center shadow-none">
          <span
            aria-hidden
            className="flex size-11 items-center justify-center rounded-md bg-primary/15 text-primary"
          >
            <FolderGit2 className="size-5" />
          </span>
          <p className="font-semibold">No projects yet.</p>
          <p className="max-w-prose text-sm text-muted-foreground">
            Teammates with a{' '}
            <Link
              href="/app/connections"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              GitHub connection
            </Link>{' '}
            can already check out its repositories. Add a project to give one a setup script and
            notes.
          </p>
          {addButton}
        </Card>
      ) : (projects.data ?? []).length > 0 ? (
        <Card className="gap-0 divide-y py-0">
          {(projects.data ?? []).map((p) => (
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
                <ProjectForm
                  project={p}
                  onCancel={() => setEditing(undefined)}
                  onSaved={async () => {
                    setEditing(undefined)
                    await projects.reload()
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

/** Add a project, or edit one's setup script and notes. */
function ProjectForm({
  project,
  onCancel,
  onSaved,
}: {
  project?: Project
  onCancel: () => void
  onSaved: () => Promise<void>
}) {
  const repositories = useApi<RepositoryOption[]>(project ? null : '/projects/repositories')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const prefix = project ? `project-${project.id}` : 'project'

  async function save(form: FormData) {
    setError(undefined)
    setBusy(true)
    try {
      await api('/projects', {
        method: 'PUT',
        body: {
          repository: project?.repository ?? String(form.get('repository') ?? ''),
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

  const options = repositories.data ?? []
  return (
    <form
      action={save}
      className={cn(
        'flex flex-col gap-4',
        project ? 'rounded-lg border bg-muted/50 p-4' : 'rounded-xl border bg-card p-5 shadow-sm',
      )}
    >
      {!project && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${prefix}-repository`}>Repository</Label>
          <Input
            id={`${prefix}-repository`}
            name="repository"
            required
            list={`${prefix}-repositories`}
            placeholder="acme/web"
            autoComplete="off"
            spellCheck={false}
            className="font-mono sm:w-96"
          />
          <datalist id={`${prefix}-repositories`}>
            {options.map((r) => (
              <option key={r.repository} value={r.repository}>
                {r.connection}
                {r.private ? ' · private' : ''}
              </option>
            ))}
          </datalist>
          <p className="text-sm text-muted-foreground">
            {repositories.data === undefined
              ? 'Loading what your GitHub connections reach…'
              : options.length > 0
                ? `owner/name. Your GitHub connections reach ${options.length} ${options.length === 1 ? 'repository' : 'repositories'}.`
                : 'owner/name. No GitHub connection reaches any repository yet: add one under Connections.'}
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
          defaultValue={project?.setupScript ?? ''}
          placeholder={'pnpm install\ncp .env.example .env'}
          spellCheck={false}
          className={cn('font-mono text-sm', project && 'bg-card')}
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
          defaultValue={project?.notes}
          placeholder="Run pnpm test before pushing. Never touch the migrations folder."
          className={cn(project && 'bg-card')}
        />
      </div>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={busy}>{project ? 'Save' : 'Add project'}</Button>
      </div>
    </form>
  )
}
