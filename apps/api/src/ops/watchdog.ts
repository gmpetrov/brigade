// The watchdog in the Worker's cron (src/worker.ts): the one alert the Api object cannot send
// itself, when it does not answer or its jobs stopped. Small on purpose: the cron's isolate
// loads none of the API.
import { sendNotice, type Destinations, type Notice } from './send.js'

/** What the Api object's ping says (src/worker.ts). */
export type Pulse = {
  upForMs: number
  /** When the ops checks last succeeded; 0 before they first did. */
  checksAt: number
  /** Why they failed since, if they did: the database out of reach, say. */
  error?: string | null
}

/** Checks that have not run for this long have stopped (they run each minute). */
export const STALLED_MS = 10 * 60_000

/** What is wrong, from the pings of one cron run: null when it is fine. */
export function diagnose(pulse: Pulse | Error, now: number): string | null {
  if (pulse instanceof Error) return `The Api object does not answer: ${pulse.message}`
  const why = pulse.error ? ` Last failure: ${pulse.error}` : ''
  if (pulse.checksAt && now - pulse.checksAt > STALLED_MS)
    return `Its checks stopped: they last succeeded ${Math.round((now - pulse.checksAt) / 60_000)} min ago.${why}`
  if (!pulse.checksAt && pulse.upForMs > STALLED_MS)
    return `Its checks never succeeded: up for ${Math.round(pulse.upForMs / 60_000)} min.${why}`
  return null
}

/** Told about at most this often while it lasts, as the keys below make it to receivers. */
const EVERY_MS = 60 * 60_000

/** What the watchdog tells: the object down. Its resets show in worker:<script>:resets. */
export const API_DOWN = { key: 'api-down', title: 'Brigade API down' }

/** In this isolate's memory only: a new isolate may tell once more, within EVERY_MS's keys. */
const downs = new Map<string, { since: number; toldAt: number }>()

/**
 * Tell operators the API is down, at most once an hour, and that it is back. The notice's
 * time is rounded to the hour, so receivers that keep one per id (Resend's idempotency keys,
 * Brigade's custom apps) keep one an hour even when each cron run is a new isolate.
 */
export async function watchdog(
  to: Destinations,
  problem: string | null,
  now = Date.now(),
  what = API_DOWN,
) {
  const base = { ...what, severity: 'critical' as const }
  const down = downs.get(what.key)
  if (!problem) {
    if (!down) return
    const since = down.since
    downs.delete(what.key)
    await sendNotice(to, {
      ...base,
      kind: 'resolved',
      detail: '',
      firstAt: new Date(since),
      at: new Date(now),
    })
    return
  }
  const state = down ?? { since: now, toldAt: 0 }
  downs.set(what.key, state)
  if (now - state.toldAt < EVERY_MS) return
  const notice: Notice = {
    ...base,
    kind: 'firing',
    detail: `${problem}\n\nNothing else alerts while it lasts: the API's own checks run in it.`,
    firstAt: new Date(Math.floor(now / EVERY_MS) * EVERY_MS),
    at: new Date(Math.floor(now / EVERY_MS) * EVERY_MS),
  }
  await sendNotice(to, notice)
  state.toldAt = now
}
