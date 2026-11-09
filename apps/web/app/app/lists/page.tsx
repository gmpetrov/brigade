'use client'
import type { ListSummary, ProjectSummary } from '@brigade/contracts'
import { ArrowDownUp, Check, Library, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useDashboard } from '@/components/dashboard'
import { ListRow } from '@/components/list-row'
import { NewList } from '@/components/new-list'
import { LIST_LIVE } from '@/components/list-items'
import { ProjectIcon } from '@/components/projects'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useApi } from '@/lib/api'
import { cn } from '@/lib/utils'

type Sort = 'recent' | 'name'
const SORTS: { value: Sort; label: string }[] = [
  { value: 'recent', label: 'Recent activity' },
  { value: 'name', label: 'Name' },
]

/**
 * Every checklist of the library (docs/lists.md), one row each, grouped by the project whose
 * folder holds it: a dot for where it stands, its count and the line that waits or runs.
 */
export default function ListsPage() {
  const lists = useApi<ListSummary[]>('/lists', LIST_LIVE)
  const { projects } = useDashboard()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('recent')

  const groups = useMemo(() => {
    const words = query.trim().toLowerCase()
    const shown = (lists.data ?? []).filter(
      (l) => !words || `${l.title} ${l.path}`.toLowerCase().includes(words),
    )
    // The API sends the last changed first.
    if (sort === 'name') shown.sort((a, b) => a.title.localeCompare(b.title))
    // Projects in the order of their first list; lists outside every project last.
    const byProject = new Map<string | null, ListSummary[]>()
    for (const list of shown) {
      const id =
        list.projectId && projects.some((p) => p.id === list.projectId) ? list.projectId : null
      byProject.set(id, [...(byProject.get(id) ?? []), list])
    }
    return [...byProject]
      .sort(([a], [b]) => Number(a === null) - Number(b === null))
      .map(([id, lists]) => ({ project: projects.find((p) => p.id === id) ?? null, lists }))
  }, [lists.data, projects, query, sort])

  const all = lists.data ?? []
  const active = all.filter((l) => l.needsYou > 0 || l.inProgress > 0).length
  const needYou = all.filter((l) => l.needsYou > 0).length

  return (
    <div className="flex flex-col gap-6">
      {/* New list stays top right; on a phone, search and sort go on a row of their own. */}
      <header className="flex flex-wrap items-end gap-x-2 gap-y-4">
        <div className="mr-auto flex flex-col gap-1">
          <h1 className="text-3xl font-extrabold tracking-tight">Lists</h1>
          {lists.data && lists.data.length > 0 && (
            <p className="text-[13.5px] text-muted-foreground">
              <b className="font-semibold text-foreground">
                {all.length} {all.length === 1 ? 'list' : 'lists'}
              </b>
              {` · ${active} in progress`}
              {needYou > 0 && (
                <>
                  {' · '}
                  <span className="font-semibold text-warning">{needYou} need you</span>
                </>
              )}
            </p>
          )}
        </div>
        {lists.data && lists.data.length > 0 && (
          <div
            data-corner-clear
            className="order-last flex w-full items-center gap-2 md:order-none md:w-auto"
          >
            <div className="relative flex-1 md:w-64 md:flex-none">
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search lists"
                aria-label="Search lists"
                className="pl-9"
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" aria-label="Sort lists">
                  <ArrowDownUp />
                  <span className="hidden text-muted-foreground sm:inline">Sort:</span>
                  <span className="hidden sm:inline">
                    {SORTS.find((s) => s.value === sort)?.label}
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup value={sort} onValueChange={(v) => setSort(v as Sort)}>
                  {SORTS.map((s) => (
                    <DropdownMenuRadioItem key={s.value} value={s.value}>
                      {s.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        <NewList />
      </header>
      {lists.error ? (
        <p className="text-sm text-destructive-text">{lists.error.message}</p>
      ) : !lists.data ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-32 rounded-full" />
          <Skeleton className="h-44 rounded-3xl" />
        </div>
      ) : lists.data.length === 0 ? (
        <EmptyLists />
      ) : groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No list matches “{query.trim()}”.</p>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map(({ project, lists }) => (
            <ListGroup key={project?.id ?? 'none'} project={project} lists={lists} />
          ))}
        </div>
      )}
    </div>
  )
}

function ListGroup({ project, lists }: { project: ProjectSummary | null; lists: ListSummary[] }) {
  const active = lists.filter((l) => l.needsYou > 0 || l.inProgress > 0).length
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 px-1 text-[13.5px] font-bold">
        {project ? (
          <ProjectIcon project={project} />
        ) : (
          <span
            aria-hidden
            className="flex size-5 items-center justify-center rounded-sm bg-secondary text-muted-foreground"
          >
            <Library className="size-3" />
          </span>
        )}
        {project?.name ?? 'No project'}
        <span className="text-[12.5px] font-medium text-muted-foreground">
          {lists.length} {lists.length === 1 ? 'list' : 'lists'}
          {active > 0 && ` · ${active} active`}
        </span>
      </h2>
      <div className="overflow-hidden rounded-3xl border bg-card shadow-sm">
        {lists.map((list) => (
          <ListRow key={list.documentId} list={list} />
        ))}
      </div>
    </section>
  )
}

/** A sample of what a list looks like, for a workspace without one yet. */
const SAMPLE = [
  { text: 'Write the launch post', done: true },
  { text: 'Set up the landing page', teammate: 'Riley' },
  { text: 'Post on Product Hunt' },
]

/** No list yet: what one looks like and what it is for, and a way to make the first. */
function EmptyLists() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-3xl border bg-card px-6 py-10 text-center shadow-sm">
      <div
        aria-hidden
        className="mb-2 flex w-64 max-w-full flex-col gap-1 rounded-xl border bg-background px-3 py-2.5 text-left"
      >
        {SAMPLE.map((line) => (
          <div key={line.text} className="flex items-center gap-2 py-0.5 text-xs">
            <span
              className={cn(
                'flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border-[1.5px] border-muted-foreground/60',
                line.done && 'border-success bg-success text-background',
              )}
            >
              {line.done && <Check className="size-2.5" strokeWidth={3.5} />}
            </span>
            <span
              className={cn(
                'min-w-0 flex-1 truncate',
                line.done && 'text-muted-foreground line-through',
              )}
            >
              {line.text}
            </span>
            {line.teammate && (
              <span className="flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 text-[10.5px] font-semibold">
                <span className="size-1.5 rounded-full bg-primary" />
                {line.teammate}
              </span>
            )}
          </div>
        ))}
      </div>
      <h2 className="text-[15px] font-bold">No list yet</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        Write a checklist, hand its lines to teammates and follow them here. Each line is ticked
        once its work is done.
      </p>
      <div className="mt-2">
        <NewList variant="outline" label="Create your first list" />
      </div>
    </div>
  )
}
