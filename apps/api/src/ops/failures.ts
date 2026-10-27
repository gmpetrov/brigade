// Failures as they happen, counted in memory for the checks (src/ops/checks.ts): requests that
// failed, webhooks Brigade could not take, jobs that threw, teammates' turns that failed. Three
// hours of them at most; a restart of the API forgets them, which only delays an alert. Those of
// a workspace's hub object go to the Api object, where the checks run (withFailureSink).
import { AsyncLocalStorage } from 'node:async_hooks'

const KEEP_MS = 3 * 60 * 60_000
const MAX = 2000

export type Failure = {
  /** What failed: api, stripe-webhook, stripe-signature, resend-webhook, job:<name>, turn… */
  kind: string
  at: number
  /** One line, for the alert. */
  message: string
  /** The workspace, when it is one's: a turn's. */
  workspaceId?: string
}

const failures: Failure[] = []

/** Where failures go from code that does not run the checks itself: a hub object's. */
const sinks = new AsyncLocalStorage<(failure: Failure) => void>()

/** Run `fn` with its failures sent to `sink` rather than counted here. */
export const withFailureSink = <T>(sink: (failure: Failure) => void, fn: () => T): T =>
  sinks.run(sink, fn)

export function noteFailure(
  kind: string,
  error: unknown,
  extra: { workspaceId?: string; at?: number } = {},
) {
  const at = extra.at ?? Date.now()
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
  keepFailure({
    kind,
    at,
    message,
    ...(extra.workspaceId ? { workspaceId: extra.workspaceId } : {}),
  })
}

/** Count a failure here, or send it where the checks run. */
export function keepFailure(failure: Failure) {
  const sink = sinks.getStore()
  if (sink) return sink(failure)
  failures.push(failure)
  while (failures.length > MAX || (failures.length && failure.at - failures[0]!.at > KEEP_MS))
    failures.shift()
}

/** The failures of a kind (or of every kind under `prefix:`) in the last `ms`. */
export function failuresOf(kind: string, ms: number, now = Date.now()) {
  return failures.filter(
    (f) => now - f.at < ms && (f.kind === kind || (kind.endsWith(':') && f.kind.startsWith(kind))),
  )
}

/** Their messages, most common first, for an alert's detail. */
export function summary(list: Failure[], lines = 5) {
  const counts = new Map<string, number>()
  for (const f of list) {
    const line = f.kind.includes(':') ? `${f.kind}: ${f.message}` : f.message
    counts.set(line, (counts.get(line) ?? 0) + 1)
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, lines)
    .map(([line, n]) => `${n}× ${line}`)
    .join('\n')
}

/** Only for tests. */
export function clearFailures() {
  failures.length = 0
}
