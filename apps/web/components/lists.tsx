'use client'
// What the Lists pages share (docs/lists.md): a list's progress, and its filters.
import type { ListSummary } from '@brigade/contracts'
import { useCallback, useEffect, useState } from 'react'

export type ListFilter = 'all' | 'open' | 'in_progress' | 'needs_you' | 'done'

/** The list's filters; the CSS that hides the other lines reads `list-filter-<value>`. */
export const LIST_FILTERS: { value: ListFilter; label: string; dot?: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress', dot: 'bg-primary' },
  { value: 'needs_you', label: 'Needs you', dot: 'bg-warning' },
  { value: 'done', label: 'Done' },
]

const FILTER_KEY = 'brigade.lists.filter'

/** The filter the member last chose, kept in this browser for every list; `all` until it is read. */
export function useListFilter() {
  const [filter, setFilter] = useState<ListFilter>('all')
  useEffect(() => {
    try {
      const saved = localStorage.getItem(FILTER_KEY)
      if (LIST_FILTERS.some((f) => f.value === saved)) setFilter(saved as ListFilter)
    } catch {}
  }, [])
  const choose = useCallback((next: ListFilter) => {
    setFilter(next)
    try {
      localStorage.setItem(FILTER_KEY, next)
    } catch {}
  }, [])
  return [filter, choose] as const
}

/** How far a list is: ticked of all, what waits on a person, what is in progress. */
export function ListProgress({
  list,
}: {
  list: Pick<ListSummary, 'done' | 'total' | 'needsYou' | 'inProgress'>
}) {
  const share = list.total ? Math.round((list.done / list.total) * 100) : 0
  const notStarted = list.total - list.done - list.needsYou - list.inProgress
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
      <div
        role="progressbar"
        aria-label="Done"
        aria-valuenow={share}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 w-48 overflow-hidden rounded-full bg-secondary"
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${share}%` }} />
      </div>
      <span className="font-mono text-muted-foreground">
        {list.done} / {list.total}
      </span>
      {list.needsYou > 0 && (
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="size-1.5 rounded-full bg-warning" />
          <b className="font-semibold">{list.needsYou}</b> need you
        </span>
      )}
      {list.inProgress > 0 && (
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="size-1.5 rounded-full bg-primary" />
          <b className="font-semibold">{list.inProgress}</b> in progress
        </span>
      )}
      {notStarted > 0 && <span className="text-muted-foreground">{notStarted} not started</span>}
    </div>
  )
}
