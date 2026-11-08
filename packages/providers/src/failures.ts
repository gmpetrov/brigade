// What a provider's failed request says, as Brigade takes it. The boat SDK throws a ResponseError
// ("Response returned an error code") with the answer in `response`, and a FetchError, its cause
// the fetch's own error, when no answer came: a timeout (boatDeadlineMs) or a cut connection.

/** The HTTP status the provider answered with, or null when none came (or not a provider's). */
export function failureStatus(error: unknown): number | null {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status
  return typeof status === 'number' ? status : null
}

/**
 * A failure that only waiting out mends, said in a few words ("answered 503", "timed out", "did
 * not answer"), or null for any other: a 5xx or a 429, a request given up on its deadline, or
 * one that got no answer at all. A 4xx (a key refused, a request boat no longer takes) is not.
 */
export function transientFailure(error: unknown): string | null {
  const status = failureStatus(error)
  if (status !== null) return status === 429 || status >= 500 ? `answered ${status}` : null
  if (!(error instanceof Error)) return null
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timed out'
  if (error.name !== 'FetchError') return null
  const cause = (error as { cause?: unknown }).cause
  const name = cause instanceof Error ? cause.name : ''
  return name === 'TimeoutError' || name === 'AbortError' ? 'timed out' : 'did not answer'
}
