// The card a person shares from Settings › Usage: a GitHub-like grid of when their tokens went,
// in their own hours, with the period's total and how it changed. What it shows, laid out here;
// components/usage-share.tsx draws it.
import type { UsagePeriod, UsageResponse, UsageTotals } from '@brigade/contracts'

const HOUR_MS = 60 * 60_000

/**
 * The grid of a period, cell by cell up to now, oldest first: 24 hours is 24 hours (columns) by
 * quarter hour (rows); 7 days, 7 stretches of 24 hours (rows) by hour (columns); 30 days,
 * 30 stretches of 24 hours (columns) by 3 hours (rows). Each stretch starts at the same hour of
 * the person's day, so a column (or row) is the same hours all along.
 */
export type CardGrid = { columns: number; rows: number; cells: number[] }

const LAYOUTS: Record<
  UsagePeriod,
  { columns: number; rows: number; cellMs: number; hours: number; byColumn: boolean }
> = {
  // byColumn: cells follow each other down a column, then on to the next one.
  1: { columns: 24, rows: 4, cellMs: 15 * 60_000, hours: 1, byColumn: true },
  7: { columns: 24, rows: 7, cellMs: HOUR_MS, hours: 1, byColumn: false },
  30: { columns: 30, rows: 8, cellMs: 3 * HOUR_MS, hours: 3, byColumn: true },
}

/** Lay the quarter hours out in the person's own hours (the computer's time zone). */
export function cardGrid(
  days: UsagePeriod,
  quarters: UsageResponse['quarters'],
  now = new Date(),
): CardGrid {
  const { columns, rows, cellMs, hours, byColumn } = LAYOUTS[days]
  const count = columns * rows
  const cells = new Array<number>(count).fill(0)
  // The last cell is the one now falls in: its hour, or its 3 hours of the day.
  // Counted back from now rather than set with setHours, which picks the first of an hour the
  // clocks go back through twice, and would leave out the second one's tokens.
  const intoCell =
    ((now.getHours() % hours) * 60 + now.getMinutes()) * 60_000 +
    now.getSeconds() * 1000 +
    now.getMilliseconds()
  const end = now.getTime() - intoCell + hours * HOUR_MS
  const start = end - count * cellMs
  for (const q of quarters) {
    const index = Math.floor((new Date(q.at).getTime() - start) / cellMs)
    if (index < 0 || index >= count) continue
    const column = byColumn ? Math.floor(index / rows) : index % columns
    const row = byColumn ? index % rows : Math.floor(index / columns)
    cells[row * columns + column]! += q.tokens
  }
  return { columns, rows, cells }
}

/**
 * Each cell's shade, 0 (nothing) to 4, as GitHub does: by where it ranks among the cells that
 * spent anything, so a grid has all four shades whether it counts thousands or billions, and
 * the busiest cells always the darkest.
 */
export function shades(cells: number[]): number[] {
  const spent = cells.filter((c) => c > 0)
  return cells.map((c) =>
    c <= 0 ? 0 : Math.max(1, Math.ceil((spent.filter((s) => s <= c).length / spent.length) * 4)),
  )
}

const all = (t: UsageTotals) => t.input + t.output

/**
 * How much more the period spent than the one before, in whole percent; null when it spent
 * less or the same (nobody shares a drop), or there is nothing to compare with.
 */
export function rise(totals: UsageTotals, previous: UsageTotals | null): number | null {
  if (!previous || all(previous) <= 0) return null
  const change = Math.round((all(totals) / all(previous) - 1) * 100)
  return change > 0 ? change : null
}

export const PERIOD_TITLES: Record<UsagePeriod, string> = {
  1: 'Last 24 hours',
  7: 'Last 7 days',
  30: 'Last 30 days',
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })

/** What the card says, in English like the rest of Brigade's interface. */
export function cardText(data: UsageResponse) {
  const total = compact.format(all(data.totals))
  const providers = data.byProvider.filter((p) => all(p) > 0).map((p) => p.id)
  return {
    title: PERIOD_TITLES[data.days],
    total: `${total} tokens`,
    rise: rise(data.totals, data.previous),
    providers: (['claude_code', 'codex'] as const).filter((p) => providers.includes(p)),
    post: `${total} tokens in the ${PERIOD_TITLES[data.days].toLowerCase()} with my AI teammates on Brigade`,
  }
}
