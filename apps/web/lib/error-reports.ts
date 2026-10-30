// The dashboard's errors, sent to Brigade's API, which passes them on to PostHog's error tracking
// (docs/analytics.md › Errors): errors nothing caught, promises nobody handled, and what a page's
// error boundary caught. Through the API rather than PostHog's script: nothing of a third party
// loads in the dashboard, and blockers do not drop them. Never in the demo.
import type { ErrorReport } from '@brigade/contracts'
import { ApiError, api } from './api'
import { DEMO } from './demo/flag'

/** At most this many reports from one page load. */
const MAX_PER_PAGE = 20

let sent = 0
const seen = new Set<string>()

/**
 * Not worth a report: a request the API refused or failed (the API reports its own), the
 * network gone, a request cancelled, a script of a new build gone after a deploy (the update
 * pill offers the reload), or a cross-origin script's error, which says nothing.
 */
function ignored(error: unknown, type: string, value: string) {
  if (error instanceof ApiError) return true
  if (type === 'AbortError' || type === 'ChunkLoadError') return true
  return /^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?|Script error\.?)$/.test(
    value,
  )
}

/** What a thrown value says: its name, message and stack. */
function describe(error: unknown) {
  if (error instanceof Error)
    return { type: error.name || 'Error', value: error.message, stack: error.stack }
  return {
    type: 'Error',
    value: typeof error === 'string' ? error : String(error),
    stack: undefined,
  }
}

/** Send an error the dashboard met. Never throws, and never waits. */
export function reportError(error: unknown, how: ErrorReport['how']) {
  if (DEMO || sent >= MAX_PER_PAGE) return
  try {
    const { type, value, stack } = describe(error)
    if (ignored(error, type, value)) return
    const key = `${type}: ${value}`
    if (seen.has(key)) return
    seen.add(key)
    sent++
    const report: ErrorReport = {
      type: type.slice(0, 100),
      value: value.slice(0, 2_000),
      ...(stack && { stack: stack.slice(0, 20_000) }),
      how,
      ...(process.env.NEXT_PUBLIC_BUILD_ID && { build: process.env.NEXT_PUBLIC_BUILD_ID }),
      path: location.pathname.slice(0, 500),
    }
    void api('/errors', { body: report }).catch(() => {})
  } catch {
    // A report that cannot be made is dropped.
  }
}

/** Report the page's uncaught errors and unhandled rejections, until the returned stop. */
export function listenForErrors() {
  const uncaught = (event: ErrorEvent) => reportError(event.error ?? event.message, 'uncaught')
  const unhandled = (event: PromiseRejectionEvent) =>
    reportError(event.reason, 'unhandled_rejection')
  window.addEventListener('error', uncaught)
  window.addEventListener('unhandledrejection', unhandled)
  return () => {
    window.removeEventListener('error', uncaught)
    window.removeEventListener('unhandledrejection', unhandled)
  }
}
