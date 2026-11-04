// The card a person shares from Settings › Usage: a GitHub-like grid of when their tokens went,
// in their own hours, with the period's total and how it changed. What it shows, laid out here;
// components/usage-share.tsx draws it.
import type { UsagePeriod, UsageResponse, UsageTotals } from '@brigade/contracts'

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

/**
 * The grid of a period: 24 hours is the last 24 hours (columns) by quarter hour (rows); 7 days,
 * the last 7 days (rows) by hour (columns); 30 days, the last 30 days (columns) by 3 hours (rows).
 */
export type CardGrid = { columns: number; rows: number; cells: number[] }

const LAYOUTS: Record<UsagePeriod, { columns: number; rows: number }> = {
  1: { columns: 24, rows: 4 },
  7: { columns: 24, rows: 7 },
  30: { columns: 30, rows: 8 },
}

/** Local midnight of the day `at` falls on. */
function midnight(at: Date) {
  const day = new Date(at)
  day.setHours(0, 0, 0, 0)
  return day
}

/** Days between two local midnights, whatever daylight saving time did between them. */
const daysBetween = (from: Date, to: Date) =>
  Math.round((midnight(to).getTime() - midnight(from).getTime()) / DAY_MS)

/** Lay the quarter hours out in the person's own hours (the computer's time zone). */
export function cardGrid(
  days: UsagePeriod,
  quarters: UsageResponse['quarters'],
  now = new Date(),
): CardGrid {
  const { columns, rows } = LAYOUTS[days]
  const cells = new Array<number>(columns * rows).fill(0)
  // The first hour (24 hours) or day (7 and 30 days) the grid shows.
  const firstHour = new Date(now)
  firstHour.setMinutes(0, 0, 0)
  firstHour.setTime(firstHour.getTime() - 23 * HOUR_MS)
  const firstDay = midnight(now)
  firstDay.setDate(firstDay.getDate() - (days === 7 ? 6 : 29))
  for (const q of quarters) {
    const at = new Date(q.at)
    let column: number
    let row: number
    if (days === 1) {
      const quarter = Math.floor((at.getTime() - firstHour.getTime()) / (15 * 60_000))
      column = Math.floor(quarter / 4)
      row = quarter - column * 4
    } else if (days === 7) {
      row = daysBetween(firstDay, at)
      column = at.getHours()
    } else {
      column = daysBetween(firstDay, at)
      row = Math.floor(at.getHours() / 3)
    }
    if (column < 0 || column >= columns || row < 0 || row >= rows) continue
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
