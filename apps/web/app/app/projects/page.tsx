'use client'
import { FolderKanban, Plus } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { useDashboard } from '@/components/dashboard'
import { NewProjectDialog, ProjectIcon } from '@/components/projects'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import type { ProjectSummary } from '@/lib/api'

function ProjectRows({ projects }: { projects: ProjectSummary[] }) {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <ul className="divide-y">
        {projects.map((p) => (
          <li key={p.id}>
            <Link
              href={`/app/projects/${p.id}`}
              className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-accent/50"
            >
              <ProjectIcon project={p} className="size-7 rounded-md text-sm" />
              <span className="font-semibold">{p.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  )
}

/** Every project, the archived ones too: the sidebar lists only the others. */
export default function Projects() {
  const { projects } = useDashboard()
  const [creating, setCreating] = useState(false)
  const active = projects.filter((p) => !p.archivedAt)
  const archived = projects.filter((p) => p.archivedAt)
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-extrabold tracking-tight">Projects</h1>
          <p className="max-w-prose text-muted-foreground">
            Each groups the threads, tasks, library folder and repositories of one line of work.
            Teammates, connections and computers stay shared across all of them.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus aria-hidden />
          New project
        </Button>
      </header>
      {active.length === 0 && archived.length === 0 ? (
        <section className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card px-6 py-16 text-center">
          <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/15 text-primary">
            <FolderKanban className="size-6" aria-hidden />
          </span>
          <h2 className="text-lg font-bold">Start your first project</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            Running several things at once? Give each a project: its threads get its brief and
            memory, and its work stays together.
          </p>
          <Button className="mt-1" onClick={() => setCreating(true)}>
            New project
          </Button>
        </section>
      ) : (
        <>
          {active.length > 0 && <ProjectRows projects={active} />}
          {archived.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-bold text-muted-foreground">Archived</h2>
              <ProjectRows projects={archived} />
            </section>
          )}
        </>
      )}
      <NewProjectDialog open={creating} onOpenChange={setCreating} />
    </div>
  )
}
