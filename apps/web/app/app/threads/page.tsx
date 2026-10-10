'use client'
import { ThreadList } from '@/components/thread-list'
import { useApi, type ThreadSummary } from '@/lib/api'

export default function Threads() {
  const threads = useApi<ThreadSummary[]>('/threads')
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-extrabold tracking-tight">Threads</h1>
        <p className="text-muted-foreground">
          Everything your AI teammates are working on, newest first.
        </p>
      </header>
      {threads.data && <ThreadList threads={threads.data} />}
    </div>
  )
}
