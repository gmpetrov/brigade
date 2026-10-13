'use client'
import { useProject } from '@/components/project-shell'
import { ThreadList } from '@/components/thread-list'
import { useApi, type ThreadSummary } from '@/lib/api'

export default function ProjectThreads() {
  const { project } = useProject()
  const threads = useApi<ThreadSummary[]>(`/threads?project=${project.id}`)
  return threads.data ? (
    <ThreadList
      threads={threads.data}
      showProject={false}
      empty="No threads in this project yet. Start one from the overview."
    />
  ) : null
}
