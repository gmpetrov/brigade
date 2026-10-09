'use client'
import Link from 'next/link'
import { isAdmin, useDashboard } from '@/components/dashboard'
import { ThreadList } from '@/components/thread-list'
import { useApi, type ThreadSummary } from '@/lib/api'

export default function Home() {
  const { me, teammates } = useDashboard()
  const threads = useApi<ThreadSummary[]>('/threads')
  const workspace = me.workspaces.find((w) => w.id === me.activeWorkspaceId)

  return (
    <div className="stack">
      <h1>{workspace?.name}</h1>
      {teammates.length === 0 ? (
        <div className="card">
          <h2>Add your first AI teammate</h2>
          <p className="hint">
            A teammate is a saved identity with its own instructions. Every message to it opens a
            thread.
          </p>
          {isAdmin(me) ? (
            <Link className="button primary" href="/app/teammates/new">
              New teammate
            </Link>
          ) : (
            <p className="hint">Ask an owner or admin to add one.</p>
          )}
        </div>
      ) : (
        <div className="row">
          {teammates.map((t) => (
            <Link key={t.id} className="button" href={`/app/teammates/${t.id}`}>
              Message {t.name}
            </Link>
          ))}
        </div>
      )}
      <h2 style={{ marginTop: 24 }}>Recent threads</h2>
      {threads.data && <ThreadList threads={threads.data} />}
    </div>
  )
}
