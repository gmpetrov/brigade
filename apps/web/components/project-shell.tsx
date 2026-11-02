'use client'
import { Folder, Settings } from 'lucide-react'
import Link from 'next/link'
import { useParams, usePathname } from 'next/navigation'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { useDashboard } from '@/components/dashboard'
import { ProjectIcon } from '@/components/projects'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Hint } from '@/components/ui/tooltip'
import { api, useApi, type ProjectDetail } from '@/lib/api'
import { useLive } from '@/lib/use-live'
import { cn } from '@/lib/utils'

type ProjectPage = { project: ProjectDetail; reload: () => Promise<void> }
const Context = createContext<ProjectPage | null>(null)

/** The project whose page this is, and a way to fetch it again. */
export function useProject() {
  const value = useContext(Context)
  if (!value) throw new Error('useProject outside a project page')
  return value
}

/**
 * A project's page: its name, brief and library folder, and its settings a click away. No tabs:
 * its threads are in the sidebar (a click on the project filters them), and its pull requests,
 * library and routines are the workspace's pages filtered on it (docs/projects.md).
 */
export function ProjectShell({ children }: { children: ReactNode }) {
  const { id } = useParams<{ id: string }>()
  const pathname = usePathname()
  const { reloadProjects } = useDashboard()
  const detail = useApi<ProjectDetail>(`/projects/${id}`)
  const [error, setError] = useState<string>()
  const reload = detail.reload
  useLive((message) => {
    if (message.type === 'projects.updated') void reload()
  })
  const base = `/app/projects/${id}`
  const settings = pathname.startsWith(`${base}/settings`)

  if (detail.error)
    return (
      <div className="flex flex-col items-start gap-3">
        <h1 className="text-2xl font-bold">Project not found</h1>
        <p className="text-muted-foreground">It may have been deleted.</p>
        <Button asChild variant="outline">
          <Link href="/app/projects">All projects</Link>
        </Button>
      </div>
    )
  const project = detail.data
  if (!project || project.id !== id)
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )

  async function unarchive() {
    setError(undefined)
    try {
      await api(`/projects/${id}/unarchive`, { method: 'POST', body: {} })
      await Promise.all([reload(), reloadProjects()])
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <Context.Provider value={{ project, reload }}>
      <div className="flex flex-col gap-6">
        <header className="flex items-start gap-4">
          <ProjectIcon project={project} className="size-11 rounded-lg text-lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h1 className="truncate text-3xl font-extrabold tracking-tight">
              <Link href={base}>{project.name}</Link>
            </h1>
            {project.brief ? (
              <p className="truncate text-muted-foreground">{project.brief}</p>
            ) : (
              <p className="text-muted-foreground">
                <Link
                  href={`${base}/settings`}
                  className="font-medium text-primary hover:underline"
                >
                  Write a brief
                </Link>{' '}
                so its threads know what it is.
              </p>
            )}
            {project.folder && (
              <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <Folder className="size-3.5 shrink-0" aria-hidden />
                <Link
                  href={`/app/library?folder=${encodeURIComponent(project.folder)}`}
                  className="truncate font-mono text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
                >
                  {project.folder}
                </Link>
                <span className="shrink-0">
                  · {project.files} file{project.files === 1 ? '' : 's'}
                </span>
              </p>
            )}
          </div>
          {/* On its settings, the same button goes back to the project. */}
          <Hint label={settings ? 'Back to the project' : 'Project settings'}>
            <Button
              asChild
              variant="ghost"
              size="icon-sm"
              className={cn(settings && 'bg-accent text-foreground')}
            >
              <Link
                href={settings ? base : `${base}/settings`}
                aria-label={settings ? 'Back to the project' : 'Project settings'}
                aria-current={settings ? 'page' : undefined}
              >
                <Settings aria-hidden />
              </Link>
            </Button>
          </Hint>
        </header>

        {project.archivedAt && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-3 text-sm">
            <span className="flex-1 text-muted-foreground">
              This project is archived: it is off the sidebar and nothing new starts in it. Its
              schedules and triggers still run.
            </span>
            <Button size="sm" variant="outline" onClick={() => void unarchive()}>
              Unarchive
            </Button>
          </div>
        )}
        {error && <p className="text-sm text-destructive-text">{error}</p>}

        {children}
      </div>
    </Context.Provider>
  )
}
