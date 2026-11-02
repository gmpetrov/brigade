'use client'
import type { ListSummary } from '@brigade/contracts'
import { ChevronRight } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'

/** Where a list stands, from its lines: what waits on a person first, then what runs. */
export const stateOf = (list: ListSummary) =>
  list.needsYou > 0
    ? 'needs_you'
    : list.inProgress > 0
      ? 'in_progress'
      : list.total > 0 && list.done === list.total
        ? 'done'
        : 'open'

const DOT = { needs_you: 'bg-warning', in_progress: 'bg-primary', done: '', open: '' }
const LINE = {
  needs_you: 'bg-warning',
  in_progress: 'bg-primary',
  done: 'bg-success',
  open: 'bg-muted-foreground/50',
}
const SAID = { needs_you: 'Needs you', in_progress: 'In progress', done: 'Done', open: '' }

/** One list: the dot alone says where it stands; the line under its title, how far and what is on. */
export function ListRow({ list }: { list: ListSummary }) {
  const state = stateOf(list)
  const share = list.total ? Math.round((list.done / list.total) * 100) : 0
  const next = list.next[0]
  return (
    <Link
      href={`/app/lists/${list.documentId}`}
      title={list.path}
      className="relative flex items-center gap-3 border-t py-2.5 pr-3 pl-4 transition-colors first:border-t-0 hover:bg-accent/60 md:pr-5"
    >
      <span
        aria-hidden
        className={cn('size-1.5 shrink-0 rounded-full', DOT[state])}
        title={SAID[state] || undefined}
      />
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
  )
}
