'use client'
import { ArrowLeft, GitPullRequest } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { timeAgo } from '@/components/dashboard'
import { ProjectIcon } from '@/components/projects'
import { PullStatus } from '@/components/pull-status'
import { SavedPreviews } from '@/components/saved-previews'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { pullHref, useApi, type ProjectSummary, type PullRequestList } from '@/lib/api'

/** One repository: its open pull requests, how its app starts, and the projects it is in. */
export default function Repository() {
  const params = useParams<{ owner: string; name: string }>()
  const repository = `${params.owner}/${params.name}`.toLowerCase()
  const pulls = useApi<PullRequestList>('/pulls?state=open', ['pulls.updated'])
  const projects = useApi<ProjectSummary[]>(
    `/projects?repository=${encodeURIComponent(repository)}`,
  )
  const open = (pulls.data?.pulls ?? []).filter((p) => p.repository === repository)

  return (
    <div className="flex flex-col gap-8">
      <Link
        href="/app/pulls"
        className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Pull requests
      </Link>
      <header className="flex flex-col gap-2">
        <h1 className="font-mono text-2xl font-extrabold tracking-tight">{repository}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {projects.data && projects.data.length === 0 && 'In no project.'}
          {(projects.data ?? []).map((p) => (
            <Link
              key={p.id}
              href={`/app/projects/${p.id}`}
              className="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 hover:bg-accent"
            >
              <ProjectIcon project={p} className="size-4 text-[0.625rem]" />
              <span className="font-medium text-foreground">{p.name}</span>
            </Link>
          ))}
        </div>
      </header>

      <section aria-labelledby="open-pulls" className="flex flex-col gap-3">
        <h2 id="open-pulls" className="text-lg font-bold tracking-tight">
          Open pull requests
        </h2>
        {!pulls.data ? (
          <Skeleton className="h-16 w-full" />
        ) : open.length === 0 ? (
          <p className="text-sm text-muted-foreground">None open.</p>
        ) : (
          <Card className="gap-0 overflow-hidden py-0">
            <ul className="divide-y">
              {open.map((p) => (
                <li key={p.number}>
                  <Link
                    href={pullHref(p.repository, p.number)}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5 hover:bg-secondary/50"
                  >
                    <GitPullRequest className="size-5 flex-none text-success" aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-semibold">
                      {p.title}{' '}
                      <span className="font-normal text-muted-foreground">#{p.number}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">{timeAgo(p.updatedAt)}</span>
                    <PullStatus pull={p} />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      <SavedPreviews repositories={[repository]} />
    </div>
  )
}
