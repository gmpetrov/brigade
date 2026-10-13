'use client'
import { useState } from 'react'
import { ProjectFilter } from '@/components/projects'
import { ThreadList } from '@/components/thread-list'
import { projectQuery, useApi, type ThreadSummary } from '@/lib/api'

export default function Threads() {
  const [project, setProject] = useState('')
  const threads = useApi<ThreadSummary[]>(`/threads${projectQuery(project)}`)
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-extrabold tracking-tight">Threads</h1>
          <p className="text-muted-foreground">
            Everything your AI teammates are working on, newest first.
          </p>
        </div>
        <ProjectFilter value={project} onChange={setProject} />
      </header>
      {threads.data && <ThreadList threads={threads.data} />}
    </div>
  )
}
