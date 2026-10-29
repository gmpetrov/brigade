'use client'
import type { ListSummary } from '@brigade/contracts'
import Link from 'next/link'
import { ListProgress } from '@/components/lists'
import { LIST_LIVE } from '@/components/list-items'
import { Skeleton } from '@/components/ui/skeleton'
import { useApi } from '@/lib/api'
import { cn } from '@/lib/utils'

/** Every checklist of the library (docs/lists.md): how far each is, and what waits on a person. */
export default function ListsPage() {
  const lists = useApi<ListSummary[]>('/lists', LIST_LIVE)
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-extrabold tracking-tight">Lists</h1>
        <p className="max-w-2xl text-muted-foreground">
          Checklists in your library. Hand lines to a teammate; its threads tick them as the work
          lands.
        </p>
      </header>
      {lists.error ? (
        <p className="text-sm text-destructive-text">{lists.error.message}</p>
      ) : !lists.data ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40 rounded-3xl" />
          ))}
        </div>
      ) : lists.data.length === 0 ? (
        <p className="max-w-2xl text-sm text-muted-foreground">
          No list yet. A Markdown file of the library with checkboxes (<code>- [ ] Ship it</code>)
          shows here, and its lines can be handed to a teammate.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {lists.data.map((list) => (
            <ListCard key={list.documentId} list={list} />
          ))}
        </div>
      )}
    </div>
  )
}

function ListCard({ list }: { list: ListSummary }) {
  return (
    <Link
      href={`/app/lists/${list.documentId}`}
      className="flex flex-col gap-3 rounded-3xl border bg-card p-5 shadow-sm transition-shadow hover:shadow-md"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="text-base font-bold tracking-tight">{list.title}</h2>
        <span className="truncate font-mono text-[11.5px] text-muted-foreground">{list.path}</span>
      </div>
      <ListProgress list={list} compact />
      {list.next.length > 0 && (
        <ul className="flex flex-col gap-1.5 border-t pt-3 text-[13px]">
          {list.next.map((item) => (
            <li key={item.id} className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  item.state === 'needs_you' ? 'bg-warning' : 'bg-primary',
                )}
              />
              <span className="truncate">{item.text}</span>
            </li>
          ))}
        </ul>
      )}
    </Link>
  )
}
