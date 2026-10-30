'use client'
import type { ListSummary, ProjectSummary } from '@brigade/contracts'
import { ArrowDownUp, ChevronRight, Library, Search } from 'lucide-react'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { useDashboard } from '@/components/dashboard'
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
import { Hint } from '@/components/ui/tooltip'

type Sort = 'recent' | 'name'
const SORTS: { value: Sort; label: string }[] = [
  { value: 'recent', label: 'Recent activity' },
  { value: 'name', label: 'Name' },
]

/** Where a list stands, from its lines: what waits on a person first, then what runs. */
const stateOf = (list: ListSummary) =>
  list.needsYou > 0
    ? 'needs_you'
    : list.inProgress > 0
      ? 'in_progress'
      : list.total > 0 && list.done === list.total
        ? 'done'
        : 'open'

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
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-1">
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
          <div className="flex items-center gap-2">
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
      </header>
      {lists.error ? (
        <p className="text-sm text-destructive-text">{lists.error.message}</p>
      ) : !lists.data ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-32 rounded-full" />
          <Skeleton className="h-44 rounded-3xl" />
        </div>
      ) : lists.data.length === 0 ? (
        <p className="max-w-2xl text-sm text-muted-foreground">
          No list yet. A Markdown file of the library with checkboxes (<code>- [ ] Ship it</code>)
          shows here, and its lines can be handed to a teammate.
        </p>
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

const DOT = { needs_you: 'bg-warning', in_progress: 'bg-primary', done: '', open: '' }
const LINE = {
  needs_you: 'bg-warning',
  in_progress: 'bg-primary',
  done: 'bg-success',
  open: 'bg-muted-foreground/50',
}
const SAID = { needs_you: 'Needs you', in_progress: 'In progress', done: 'Done', open: '' }

/** One list: the dot alone says where it stands; the line under its title, how far and what is on. */
function ListRow({ list }: { list: ListSummary }) {
  const state = stateOf(list)
  const share = list.total ? Math.round((list.done / list.total) * 100) : 0
  const next = list.next[0]
  return (
    <Hint label={list.path}>
      <Link
        href={`/app/lists/${list.documentId}`}
        className="relative flex items-center gap-3 border-t py-2.5 pr-3 pl-4 transition-colors first:border-t-0 hover:bg-accent/60 md:pr-5"
      >
        <Hint label={SAID[state] || undefined}>
          <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', DOT[state])} />
        </Hint>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              'truncate text-[13.5px] font-semibold',
              state === 'done' && 'font-medium text-muted-foreground',
            )}
          >
            {list.title}
            {SAID[state] && <span className="sr-only">, {SAID[state].toLowerCase()}</span>}
          </span>
          <span className="truncate text-[12.5px] text-muted-foreground">
            <span className="font-mono text-xs text-foreground">
              {list.done}/{list.total}
            </span>
            {next ? ` · ${next.text}` : state === 'done' ? ' · done' : ''}
          </span>
        </span>
        {/* Wide, a bar beside it; on a phone, a line under the row once anything is ticked. */}
        <span
          role="progressbar"
          aria-label="Done"
          aria-valuenow={share}
          aria-valuemin={0}
          aria-valuemax={100}
          className="hidden h-1 w-28 shrink-0 overflow-hidden rounded-full bg-secondary md:block"
        >
          <span
            className={cn(
              'block h-full rounded-full',
              state === 'done' ? 'bg-success' : 'bg-primary',
            )}
            style={{ width: `${share}%` }}
          />
        </span>
        <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground md:hidden" />
        {list.done > 0 && state !== 'done' && (
          <span
            aria-hidden
            className={cn('absolute bottom-0 left-4 h-0.5 rounded-full md:hidden', LINE[state])}
            style={{ width: `calc((100% - 2rem) * ${share / 100})` }}
          />
        )}
      </Link>
    </Hint>
  )
}
