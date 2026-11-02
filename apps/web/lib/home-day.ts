// Home's day at a glance, from the Board (src/board.ts in the API): what the team finished
// today and the routines of the day, in the member's own day.
import type { Board, BoardRoutine } from '@brigade/contracts'

export const isToday = (iso: string | null | undefined, now = new Date()) =>
  !!iso && new Date(iso).toDateString() === now.toDateString()

/** "Riley", "Riley and Max", "Riley, Max and Ada", "Riley, Max and 2 others". */
export function namesInWords(names: string[]) {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} others`
}

/** Cards in the Board's Done column that were done today: the count its link opens on. */
export function doneToday(board: Pick<Board, 'cards'>, now = new Date()) {
  return board.cards.filter((c) => c.column === 'done' && isToday(c.done?.at ?? c.at, now)).length
}

export type RoutineOfToday = {
  routine: BoardRoutine
  /** Its row's time: its run under way, its last run today, or its next one. */
  at: string
  /** It ran or runs today; otherwise it is still to come. */
  ran: boolean
  /** Its next run, when that is later today. */
  next: string | null
}

/** The routines that ran today, run now, or will run later today, in the day's order. */
export function routinesOfToday(routines: BoardRoutine[], now = new Date()): RoutineOfToday[] {
  const rows: RoutineOfToday[] = []
  for (const r of routines) {
    const running = r.running && isToday(r.running.since, now) ? r.running.since : null
    const ran = r.today.runs > 0 || !!running
    const next = r.health !== 'paused' && isToday(r.nextRunAt, now) ? r.nextRunAt : null
    const at = ran ? (running ?? r.last?.at ?? next) : next
    if (!at) continue
    rows.push({ routine: r, at, ran, next: next === at ? null : next })
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at))
}
