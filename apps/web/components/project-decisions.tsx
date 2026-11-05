'use client'
// A project's decisions on its page (docs/projects.md, Decisions): its specs, notes and designs
// with the status each one says, read from its library folder. Nobody keeps this list: a status
// changes in the file, and a merged pull request that ships a spec marks it shipped.
import type { DecisionFlag, DecisionStatus, DecisionView } from '@brigade/contracts'
import { FileText, Palette } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { timeAgo } from '@/components/dashboard'
import { StatusBadge, type StatusTone } from '@/components/status-badge'
import { Card } from '@/components/ui/card'
import { useApi } from '@/lib/api'

/** Rows shown before "+N more". */
const SHOWN = 6

const TONE: Record<DecisionStatus, StatusTone> = {
  draft: 'neutral',
  accepted: 'progress',
  shipped: 'success',
  paused: 'warning',
  dropped: 'neutral',
  superseded: 'neutral',
}

const FLAG_TEXT: Record<DecisionFlag, string> = {
  no_status: 'No status line Brigade can read',
  merged_not_shipped: 'A pull request for it is merged: is it shipped?',
  no_reference: 'Shipped, but names no reference',
}

const FILTERS = {
  open: {
    label: 'Open',
    keep: (d: DecisionView) => d.status === 'draft' || d.status === 'accepted',
  },
  shipped: { label: 'Shipped', keep: (d: DecisionView) => d.status === 'shipped' },
  all: { label: 'All', keep: () => true },
} as const
type Filter = keyof typeof FILTERS

/** Those that need a look first: a flag, then open ones, then by when they last changed. */
const rank = (d: DecisionView) =>
  d.flags.length ? 0 : d.status === 'draft' || d.status === 'accepted' ? 1 : 2

const href = (d: DecisionView) =>
  d.type === 'design'
    ? `/app/library?design=${encodeURIComponent(d.path)}`
    : `/app/library?file=${d.documentId}`

export function ProjectDecisions({
  projectId,
  section,
}: {
  projectId: string
  /** The page's section frame, with its title and a control at its right. */
  section: (props: { action: React.ReactNode; children: React.ReactNode }) => React.ReactNode
}) {
  const decisions = useApi<DecisionView[]>(`/projects/${projectId}/decisions`, ['library.updated'])
  const [chosen, setFilter] = useState<Filter>()
  const [more, setMore] = useState(false)
  const all = decisions.data
  // A project with none says nothing: its page stays about what moves.
  if (!all?.length) return null
  const open = all.filter(FILTERS.open.keep)
  // Open ones first, when there are some; else all of them.
  const filter = chosen ?? (open.length || all.some((d) => d.flags.length) ? 'open' : 'all')
  const flagged = all.filter((d) => d.flags.length && !FILTERS[filter].keep(d))
  const rows = [...all.filter(FILTERS[filter].keep), ...(filter === 'open' ? flagged : [])].sort(
    (a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt),
  )
  const shown = more ? rows : rows.slice(0, SHOWN)

  const action = (
    <div role="tablist" aria-label="Show" className="flex items-center gap-0.5">
      {(Object.keys(FILTERS) as Filter[]).map((key) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={filter === key}
          onClick={() => {
            setFilter(key)
            setMore(false)
          }}
          className={`rounded-md px-2 py-0.5 text-xs font-medium transition-colors ${
            filter === key
              ? 'bg-secondary text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {FILTERS[key].label}
          <span className="ml-1 text-muted-foreground">
            {key === 'all' ? all.length : all.filter(FILTERS[key].keep).length}
          </span>
        </button>
      ))}
    </div>
  )

  return section({
    action,
    children:
      rows.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">
          Nothing {filter === 'open' ? 'open' : 'shipped'} here.
        </p>
      ) : (
        <Card className="gap-0 py-1.5">
          <ul className="flex flex-col">
            {shown.map((d) => (
              <li key={d.documentId}>
                <Link
                  href={href(d)}
                  className="flex items-center gap-3 px-4 py-2 text-sm transition-colors hover:bg-accent/60"
                >
                  {d.type === 'design' ? (
                    <Palette className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  ) : (
                    <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{d.title}</span>
                    <span
                      className={`truncate text-xs ${d.flags.length ? 'text-warning' : 'text-muted-foreground'}`}
                    >
                      {d.flags.length
                        ? d.flags.map((f) => FLAG_TEXT[f]).join(' · ')
                        : [
                            d.kind,
                            d.pullRequests.length
                              ? d.pullRequests.map((n) => `#${n}`).join(', ')
                              : null,
                            `changed ${timeAgo(d.updatedAt)}`,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                    </span>
                  </span>
                  {d.status ? (
                    <StatusBadge status={d.status} tone={TONE[d.status]} className="shrink-0" />
                  ) : (
                    <StatusBadge status="no status" tone="warning" className="shrink-0" />
                  )}
                </Link>
              </li>
            ))}
          </ul>
          {rows.length > SHOWN && (
            <button
              type="button"
              onClick={() => setMore(!more)}
              className="self-start px-4 pt-1 pb-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              {more ? 'Show less' : `+${rows.length - SHOWN} more`}
            </button>
          )}
        </Card>
      ),
  })
}
