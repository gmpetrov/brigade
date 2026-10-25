'use client'
// Usage: what the workspace's Claude and Codex subscriptions spent tokens on, and what asked for
// them, to see a process that spends more than it should. Owners and admins see the whole
// workspace; a member sees what their own accounts spent. Counts only, never what was said.
import type {
  UsageGroup,
  UsagePeriod,
  UsageResponse,
  UsageSource,
  UsageTotals,
} from '@brigade/contracts'
import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import { TeammateAvatar, useDashboard } from '@/components/dashboard'
import { HarnessLogo } from '@/components/harness-logo'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useApi } from '@/lib/api'

const PERIODS: { days: UsagePeriod; label: string }[] = [
  { days: 1, label: '24 hours' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
]

/** What asked for the tokens, as a person reads it. */
const SOURCES: Record<UsageSource, string> = {
  member: 'Messages from people',
  trigger: 'Triggers',
  schedule: 'Routines',
  child: 'Child threads',
  review: 'Pull request reviews',
  playbook: 'Playbooks',
  memory: 'Memory from quiet threads',
  tidy: 'Memory tidying',
  title: 'Thread titles',
  brief: 'Project briefs',
  image: 'Images',
}
const sourceLabel = (id: string) => SOURCES[id as UsageSource] ?? id

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const tokens = (n: number) => compact.format(n)
const all = (t: UsageTotals) => t.input + t.output
const percent = (part: number, whole: number) =>
  whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—'

export default function UsagePage() {
  const [days, setDays] = useState<UsagePeriod>(7)
  const usage = useApi<UsageResponse>(`/usage?days=${days}`)
  const data = usage.data?.days === days ? usage.data : undefined

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-extrabold tracking-tight">Usage</h1>
        <p className="max-w-prose text-muted-foreground">
          The tokens your Claude and Codex subscriptions spent, and what for. Brigade keeps only the
          counts, never what was said.
          {usage.data?.scope === 'mine' && ' You see what your own accounts spent.'}
        </p>
        <Tabs value={String(days)} onValueChange={(v) => setDays(Number(v) as UsagePeriod)}>
          <TabsList aria-label="Period">
            {PERIODS.map((p) => (
              <TabsTrigger key={p.days} value={String(p.days)}>
                {p.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {usage.error && <p className="text-sm text-destructive-text">{usage.error.message}</p>}
      </header>

      {!data ? (
        !usage.error && <p className="text-sm text-muted-foreground">Loading…</p>
      ) : data.totals.runs === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing spent in the last {PERIODS.find((p) => p.days === days)!.label}. Usage shows after
          a teammate&apos;s next turn.
        </p>
      ) : (
        <Report data={data} />
      )}
    </div>
  )
}

function Report({ data }: { data: UsageResponse }) {
  const { teammates } = useDashboard()
  const total = all(data.totals)
  return (
    <>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl bg-muted/60 px-4 py-3 sm:grid-cols-4">
        <Figure label="Tokens" value={tokens(total)} />
        <Figure
          label="Read from the cache"
          value={percent(data.totals.cacheRead, total)}
          note={`${tokens(data.totals.cacheRead)} tokens`}
        />
        <Figure label="Written by the models" value={tokens(data.totals.output)} />
        <Figure label="Turns and runs" value={data.totals.runs.toLocaleString()} />
      </dl>
      <p className="-mt-4 max-w-prose px-1 text-xs text-muted-foreground">
        Each step of a turn reads the thread&apos;s context again, mostly from the cache: that is
        most of the tokens. Your plan limits usage over time windows rather than in tokens; the
        Usage row of your menu shows how much of each is gone.
      </p>

      {data.daily.length > 1 && <Daily daily={data.daily} />}

      <Table
        title="What asked for them"
        rows={data.bySource}
        total={total}
        name={(r) => sourceLabel(r.id)}
      />
      <Table
        title="Threads that spent the most"
        rows={data.topThreads}
        total={total}
        name={(r) => {
          const thread = data.topThreads.find((t) => t.id === r.id)!
          return (
            <span className="flex min-w-0 items-center gap-2">
              {thread.teammateId && (
                <TeammateAvatar
                  teammate={{
                    id: thread.teammateId,
                    name: teammates.find((t) => t.id === thread.teammateId)?.name ?? '',
                  }}
                  className="size-4 shrink-0"
                />
              )}
              <Link href={`/app/threads/${r.id}`} className="truncate hover:underline">
                {r.label}
              </Link>
              <span className="shrink-0 text-xs text-muted-foreground">
                {sourceLabel(thread.source)}
              </span>
            </span>
          )
        }}
      />
      {data.topSchedules.length > 0 && (
        <Table
          title="Routines"
          runsLabel="Runs"
          rows={data.topSchedules}
          total={total}
          name={(r) => (
            <Link href="/app/routines" className="truncate hover:underline">
              {r.label}
            </Link>
          )}
        />
      )}
      <Table
        title="Teammates"
        rows={data.byTeammate}
        total={total}
        name={(r) =>
          r.id ? (
            <span className="flex min-w-0 items-center gap-2">
              <TeammateAvatar teammate={{ id: r.id, name: r.label }} className="size-4 shrink-0" />
              <span className="truncate">{r.label}</span>
            </span>
          ) : (
            'Brigade itself'
          )
        }
      />
      {data.byMember.length > 0 && (
        <Table title="Members' accounts" rows={data.byMember} total={total} />
      )}
      <Table
        title="Subscriptions"
        rows={data.byProvider}
        total={total}
        name={(r) => (
          <span className="flex items-center gap-2">
            <HarnessLogo harness={r.id === 'codex' ? 'codex' : 'claude_code'} className="size-4" />
            {r.label}
          </span>
        )}
      />
      <Table title="Models" rows={data.byModel} total={total} />
    </>
  )
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
      {note && <dd className="truncate text-xs text-muted-foreground tabular-nums">{note}</dd>}
    </div>
  )
}

const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })

/** Tokens per day, one bar each: a day out of line is what to look into. */
function Daily({ daily }: { daily: UsageResponse['daily'] }) {
  const top = Math.max(...daily.map(all), 1)
  return (
    <section className="flex flex-col gap-2" aria-labelledby="usage-daily">
      <h2 id="usage-daily" className="px-1 text-sm font-medium text-muted-foreground">
        Tokens per day
      </h2>
      <div className="rounded-xl bg-muted/60 px-4 pt-4 pb-2">
        <div className="flex h-32 items-end gap-0.5" role="list">
          {daily.map((d) => {
            const value = all(d)
            return (
              <Tooltip key={d.day}>
                <TooltipTrigger asChild>
                  <div
                    role="listitem"
                    aria-label={`${dayLabel(d.day)}: ${tokens(value)} tokens`}
                    tabIndex={0}
                    className="group flex h-full min-w-0 flex-1 items-end outline-none"
                  >
                    <div
                      className="w-full rounded-t-[4px] bg-primary/85 transition-colors group-hover:bg-primary group-focus-visible:bg-primary"
                      style={{ height: value ? `max(2px, ${(value / top) * 100}%)` : 0 }}
                    />
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <span className="font-medium">{dayLabel(d.day)}</span> · {tokens(value)} tokens ·{' '}
                  {d.runs} {d.runs === 1 ? 'run' : 'runs'}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
        <div className="mt-1.5 flex justify-between border-t border-border/60 pt-1 text-xs text-muted-foreground tabular-nums">
          <span>{dayLabel(daily[0]!.day)}</span>
          <span>{dayLabel(daily.at(-1)!.day)}</span>
        </div>
      </div>
    </section>
  )
}

/**
 * A breakdown, biggest first: its tokens, its share of the period's and per run, the figure
 * that shows a process spending more each time than the others.
 */
function Table({
  title,
  rows,
  total,
  name = (r) => r.label,
  runsLabel = 'Turns',
}: {
  title: string
  rows: UsageGroup[]
  total: number
  name?: (row: UsageGroup) => ReactNode
  runsLabel?: string
}) {
  if (rows.length === 0) return null
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-sm font-medium text-muted-foreground">{title}</h2>
      <div className="overflow-x-auto rounded-xl bg-muted/60 pb-1.5">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="px-4 pt-3 pb-1 text-left font-normal">Name</th>
              <th className="px-2 pt-3 pb-1 text-right font-normal">Tokens</th>
              <th className="hidden px-2 pt-3 pb-1 text-left font-normal sm:table-cell">Share</th>
              <th className="px-2 pt-3 pb-1 text-right font-normal">{runsLabel}</th>
              <th className="px-4 pt-3 pb-1 text-right font-normal whitespace-nowrap">Per run</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((r) => {
              const value = all(r)
              const share = total > 0 ? value / total : 0
              return (
                <tr key={r.id || r.label}>
                  <td className="w-full max-w-0 truncate px-4 py-1.5">{name(r)}</td>
                  <td className="px-2 py-1.5 text-right whitespace-nowrap">{tokens(value)}</td>
                  <td className="hidden w-28 px-2 py-1.5 sm:table-cell">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 rounded-full bg-border/70">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${Math.max(share * 100, value ? 2 : 0)}%` }}
                        />
                      </div>
                      <span className="w-8 text-right text-xs text-muted-foreground">
                        {percent(value, total)}
                      </span>
                    </div>
                  </td>
                  <td className="px-2 py-1.5 text-right">{r.runs.toLocaleString()}</td>
                  <td className="px-4 py-1.5 text-right whitespace-nowrap">
                    {r.runs ? tokens(value / r.runs) : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
