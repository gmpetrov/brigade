'use client'
import { Archive, MoreHorizontal, Settings } from 'lucide-react'
import Link from 'next/link'
import { useParams, usePathname, useRouter } from 'next/navigation'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { useDashboard } from '@/components/dashboard'
import { ProjectIcon } from '@/components/projects'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
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

const TABS = [
  { path: '', label: 'Overview' },
  { path: '/threads', label: 'Threads' },
  { path: '/tasks', label: 'Tasks' },
  { path: '/pulls', label: 'Pull requests' },
  { path: '/library', label: 'Library' },
  { path: '/repos', label: 'Repos and previews' },
  { path: '/automations', label: 'Automations' },
  { path: '/settings', label: 'Settings' },
]

/** A project's page: its name and brief, then a tab per kind of thing it groups. */
export function ProjectShell({ children }: { children: ReactNode }) {
  const { id } = useParams<{ id: string }>()
  const pathname = usePathname()
  const router = useRouter()
  const { reloadProjects } = useDashboard()
  const detail = useApi<ProjectDetail>(`/projects/${id}`)
  const [error, setError] = useState<string>()
  const reload = detail.reload
  useLive((message) => {
    if (message.type === 'projects.updated') void reload()
  })
  const base = `/app/projects/${id}`

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
            <h1 className="truncate text-3xl font-extrabold tracking-tight">{project.name}</h1>
            {project.brief ? (
              <p className="line-clamp-2 max-w-prose text-muted-foreground">{project.brief}</p>
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
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Project menu">
                <MoreHorizontal aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => router.push(`${base}/settings`)}>
                <Settings aria-hidden />
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => router.push('/app/projects')}>
                <Archive aria-hidden />
                All projects
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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

        <nav aria-label="Project" className="-mb-2 overflow-x-auto border-b">
          <ul className="flex gap-5 whitespace-nowrap">
            {TABS.map((tab) => {
              const href = `${base}${tab.path}`
              const active = tab.path ? pathname.startsWith(href) : pathname === base
              return (
                <li key={tab.path}>
                  <Link
                    href={href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      '-mb-px inline-flex border-b-2 py-2 text-sm font-semibold transition-colors',
                      active
                        ? 'border-foreground text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {tab.label}
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>
        {children}
      </div>
    </Context.Provider>
  )
}
