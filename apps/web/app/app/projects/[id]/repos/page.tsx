'use client'
import { GitBranch, Plus, X } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { useDashboard } from '@/components/dashboard'
import { useProject } from '@/components/project-shell'
import { SavedPreviews } from '@/components/saved-previews'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { api, useApi, type RepositoryOption } from '@/lib/api'

/** The project's repositories, and how each one's app starts for people to try. */
export default function ProjectRepos() {
  const { project, reload } = useProject()
  const { reloadProjects } = useDashboard()
  const reachable = useApi<RepositoryOption[]>('/repositories')
  const [adding, setAdding] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const linked = project.repositories.map((r) => r.repository)
  const options = (reachable.data ?? []).filter((r) => !linked.includes(r.repository))

  async function save(repositories: string[]) {
    setBusy(true)
    setError(undefined)
    try {
      await api(`/projects/${project.id}/repositories`, { method: 'PUT', body: { repositories } })
      setAdding(undefined)
      await Promise.all([reload(), reloadProjects()])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="repositories" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="repositories" className="text-lg font-bold tracking-tight">
            Repositories
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            Where the project&apos;s code is. Its threads are told to work in these when a message
            names no repository, and its pull requests show on the project. A repository can be in
            several projects.
          </p>
        </div>
        {linked.length > 0 && (
          <Card className="gap-0 divide-y py-0">
            {project.repositories.map((r) => (
              <div key={r.repository} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <GitBranch className="size-4 text-muted-foreground" aria-hidden />
                <Link
                  href={`/app/pulls/${r.repository}`}
                  className="font-mono text-sm hover:underline"
                >
                  {r.repository}
                </Link>
                {r.reachable === false && <StatusBadge status="failed" label="not reachable" />}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto"
                  aria-label={`Remove ${r.repository} from the project`}
                  disabled={busy}
                  onClick={() => void save(linked.filter((x) => x !== r.repository))}
                >
                  <X aria-hidden />
                </Button>
              </div>
            ))}
          </Card>
        )}
        {project.repositories.some((r) => r.reachable === false) && (
          <p className="text-sm text-muted-foreground">
            A repository is not reachable when no GitHub connection reaches it any more: reconnect
            GitHub on Apps, or add it to the GitHub App&apos;s installation.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            list="project-repository-options"
            value={adding ?? ''}
            onChange={(e) => setAdding(e.target.value.trim().toLowerCase() || undefined)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && adding) {
                e.preventDefault()
                void save([...linked, adding])
              }
            }}
            aria-label="Repository to add"
            placeholder={
              reachable.data && options.length === 0
                ? 'No other repository is reachable'
                : 'owner/name'
            }
            className="w-full font-mono sm:w-80"
          />
          <datalist id="project-repository-options">
            {options.map((r) => (
              <option key={r.repository} value={r.repository} />
            ))}
          </datalist>
          <Button
            disabled={!adding || busy}
            onClick={() => adding && void save([...linked, adding])}
          >
            <Plus aria-hidden />
            Add
          </Button>
        </div>
        {reachable.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No GitHub connection yet.{' '}
            <Link href="/app/connections" className="font-medium text-primary hover:underline">
              Connect GitHub
            </Link>{' '}
            to add repositories.
          </p>
        )}
        {error && <p className="text-sm text-destructive-text">{error}</p>}
      </section>

      {linked.length > 0 && <SavedPreviews repositories={linked} />}
    </div>
  )
}
