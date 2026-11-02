// A thread's pending wake-up, as a small alarm at the end of its sidebar row: a teammate will
// check on something there, on its own. Its time shows on hover; the thread's panel lists them.
import { AlarmClock } from 'lucide-react'

/** "14:30" today, else with its day: "Fri 16 Oct, 09:00". */
export const wakeTime = (at: string) => {
  const date = new Date(at)
  const today = date.toDateString() === new Date().toDateString()
  return date.toLocaleString(undefined, {
    ...(today ? {} : { weekday: 'short', day: 'numeric', month: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function WakeupIcon({ at }: { at: string }) {
  const label = `Wake-up at ${wakeTime(at)}`
  return (
    <span title={label} className="flex shrink-0">
      <AlarmClock aria-hidden className="size-3 opacity-50" />
      <span className="sr-only">{label}</span>
    </span>
  )
}
