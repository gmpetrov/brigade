// Routines as an agenda: each schedule once, under the day of its next run, in the member's
// own day. Paused ones, and those that never run again, go to the end.

type Scheduled = { title: string; pausedAt: string | null; nextRunAt: string | null }

export type AgendaGroup<T> = { key: string; label: string; items: T[] }

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Calendar days from `now` to `date`, in the browser's timezone: 0 today, 1 tomorrow. */
function daysFrom(now: Date, date: Date) {
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return Math.round((start(date) - start(now)) / 86_400_000)
}

/** The group of a next run: Today, Tomorrow, a weekday within the week, or Later. */
function groupOf(now: Date, next: Date): { key: string; label: string } {
  const days = daysFrom(now, next)
  if (days <= 0) return { key: 'today', label: 'Today' }
  if (days === 1) return { key: 'tomorrow', label: 'Tomorrow' }
  if (days < 7) return { key: `day-${days}`, label: WEEKDAYS[next.getDay()]! }
  return { key: 'later', label: 'Later' }
}

/**
 * The agenda: groups in time order, each schedule once at its next run (a routine that runs
 * every three hours shows once, at the next of them); `rest` holds the paused ones and those
 * that never run again.
 */
export function agendaOf<T extends Scheduled>(schedules: T[], now = new Date()) {
  const upcoming = schedules
    .filter((s) => !s.pausedAt && s.nextRunAt)
    .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!) || a.title.localeCompare(b.title))
  const groups: AgendaGroup<T>[] = []
  for (const s of upcoming) {
    const { key, label } = groupOf(now, new Date(s.nextRunAt!))
    const last = groups.at(-1)
    if (last?.key === key) last.items.push(s)
    else groups.push({ key, label, items: [s] })
  }
  const rest = schedules
    .filter((s) => s.pausedAt || !s.nextRunAt)
    .sort((a, b) => a.title.localeCompare(b.title))
  return { groups, rest }
}

/** The time a row shows: the hour within the week, the date after it ("16 Nov"). */
export function agendaTime(iso: string, now = new Date()) {
  const date = new Date(iso)
  if (daysFrom(now, date) < 7)
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(date)
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(date)
}
