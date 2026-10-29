'use client'
import type { ListDetail } from '@brigade/contracts'
import { ChevronRight, MessageSquare } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useMemo } from 'react'
import { useDocumentDiscussion } from '@/components/document-discussion'
import { DocumentEditor } from '@/components/document-editor'
import { LIST_LIVE, useHandOff } from '@/components/list-items'
import { ListProgress, type ListFilter, LIST_FILTERS, useListFilter } from '@/components/lists'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useApi } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * A list (docs/lists.md): its file, edited as any document, each line with the threads and pull
 * requests on it; how far it is; and its lines filtered by where they stand.
 */
export default function ListPage() {
  const { id } = useParams<{ id: string }>()
  const list = useApi<ListDetail>(`/lists/${id}`, LIST_LIVE)
  const file = useMemo(
    () => (list.data ? { id: list.data.documentId, path: list.data.path } : null),
    [list.data],
  )
  const discussion = useDocumentDiscussion(file)
  const handOff = useHandOff(file, discussion?.teammate ?? null)
  const [filter, setFilter] = useListFilter()
  const ask = useMemo(
    () =>
      discussion?.teammate
        ? {
            teammate: discussion.teammate.name,
            onAsk: discussion.ask,
            onHandOff: handOff.start,
          }
        : undefined,
    [discussion, handOff.start],
  )

  if (list.error) return <p className="text-sm text-destructive-text">{list.error.message}</p>
  if (!list.data) return <Skeleton className="h-64 w-full rounded-3xl" />
  const data = list.data
  const counts: Record<ListFilter, number> = {
    all: data.total,
    open: data.total - data.done,
    in_progress: data.inProgress,
    needs_you: data.needsYou,
    done: data.done,
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav
          aria-label="Breadcrumb"
          className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground"
        >
          <Link href="/app/lists" className="hover:text-foreground">
            Lists
          </Link>
          <ChevronRight aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate font-mono">{data.path}</span>
        </nav>
        {discussion?.teammate && (
          <Button variant="outline" size="sm" onClick={() => void discussion.ask()}>
            <MessageSquare aria-hidden />
            Ask {discussion.teammate.name}
          </Button>
        )}
      </div>
      <ListProgress list={data} />
      <div
        role="radiogroup"
        aria-label="Show"
        className="flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-full bg-secondary p-[3px]"
      >
        {LIST_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            role="radio"
            aria-checked={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={cn(
              'flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-muted-foreground',
              filter === f.value && 'bg-card font-semibold text-foreground shadow-xs',
            )}
          >
            {f.dot && <span aria-hidden className={cn('size-1.5 rounded-full', f.dot)} />}
            {f.label}
            <span className="font-mono text-[11.5px]">{counts[f.value]}</span>
          </button>
        ))}
      </div>
      <div className={cn('list-view -mx-2', filter !== 'all' && `list-filter-${filter}`)}>
        <DocumentEditor
          target={{ kind: 'library', id: data.documentId }}
          label={data.title}
          ask={ask}
        />
      </div>
      {handOff.dialog}
    </div>
  )
}
