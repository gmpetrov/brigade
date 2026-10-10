'use client'
import { MessagesSquare } from 'lucide-react'
import Link from 'next/link'
import { Card } from '@/components/ui/card'
import type { ThreadSummary } from '@/lib/api'
import { StatusBadge, timeAgo } from './dashboard'

export function ThreadList({
  threads,
  showTeammate = true,
}: {
  threads: ThreadSummary[]
  showTeammate?: boolean
}) {
  if (threads.length === 0)
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card px-6 py-10 text-center">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
          <MessagesSquare className="size-5" aria-hidden />
        </span>
        <p className="text-sm text-muted-foreground">No threads yet.</p>
      </div>
    )
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <ul className="divide-y">
        {threads.map((t) => (
          <li key={t.id}>
            <Link
              href={`/app/threads/${t.id}`}
              className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-accent/50"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{t.title}</div>
                <div className="truncate text-sm text-muted-foreground">
                  {showTeammate && (
                    <>
                      {(t.teammates?.length ? t.teammates.map((p) => p.teammate) : [t.teammate])
                        .map((p) => p.name)
                        .join(', ')}{' '}
                      ·{' '}
                    </>
                  )}
                  started by {t.startedBy.user.name} · {timeAgo(t.updatedAt)}
                </div>
              </div>
              <StatusBadge status={t.status} />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  )
}
