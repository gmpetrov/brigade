'use client'
import Link from 'next/link'
import type { ThreadSummary } from '@/lib/api'
import { StatusBadge, timeAgo } from './dashboard'

export function ThreadList({
  threads,
  showTeammate = true,
}: {
  threads: ThreadSummary[]
  showTeammate?: boolean
}) {
  if (threads.length === 0) return <p className="hint">No threads yet.</p>
  return (
    <ul className="list">
      {threads.map((t) => (
        <li key={t.id}>
          <Link href={`/app/threads/${t.id}`} style={{ flex: 1, minWidth: 0 }}>
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t.title}
            </div>
            <div className="hint">
              {showTeammate && <>{t.teammate.name} · </>}
              started by {t.startedBy.user.name} · {timeAgo(t.updatedAt)}
            </div>
          </Link>
          <StatusBadge status={t.status} />
        </li>
      ))}
    </ul>
  )
}
