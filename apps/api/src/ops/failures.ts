// Failures as they happen, counted in memory for the checks (src/ops/checks.ts): requests that
// failed, webhooks Brigade could not take, jobs that threw, teammates' turns that failed. Three
// hours of them at most; a restart of the API forgets them, which only delays an alert.
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
  failures.push({
    kind,
    at,
    message,
    ...(extra.workspaceId ? { workspaceId: extra.workspaceId } : {}),
  })
  while (failures.length > MAX || (failures.length && at - failures[0]!.at > KEEP_MS))
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
