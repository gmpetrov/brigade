// A turn that failed on an error that passes is tried again by the runner on its own
// (apps/runner/src/threads.ts, failed), a few times: until those tries are over, its failed
// thread waits on nobody, and the API counts it as waiting on a person only after them
// (apps/api/src/failed.ts).

/**
 * Errors that pass (a full disk, the network, Claude's API down or overloaded, the harness's
 * process gone, as the kernel kills it when the computer runs out of memory): a turn that
 * failed on one is tried again on its own, after RETRY_AFTER_MS. Out of usage is not one
 * of them: that turn moves to another account, or pauses.
 */
export const PASSING_ERROR =
  /ENOSPC|no space left|EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|fetch failed|network error|overloaded|internal server error|api_error|service unavailable|bad gateway|gateway time-?out|\b(500|502|503|504|529)\b|bridge closed before the turn finished/i

/** What a turn's error starts with once the runner's memory guard stopped it: tried again too. */
export const MEMORY_STOPPED = /^Stopped to give the computer memory back/

/** How long before each try of a turn that failed on a passing error; then a person tries again. */
export const RETRY_AFTER_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000]

/**
 * How long after a passing error its thread may still be tried again on its own: the longest
 * wait before a try, and a minute for the try to start. Past it, a person tries again.
 */
export const RETRY_GRACE_MS = Math.max(...RETRY_AFTER_MS) + 60_000

/** Whether the runner tries a turn that failed on this error again on its own. */
export const retriedOnItsOwn = (error: string) =>
  MEMORY_STOPPED.test(error) || PASSING_ERROR.test(error)
