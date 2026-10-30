import { z } from 'zod'

/**
 * An error the dashboard met, sent to the API (`POST /api/errors`), which scrubs it and passes it
 * on to PostHog's error tracking (docs/analytics.md › Errors). Its message and stack as the
 * browser gave them, cut short; never the page's content.
 */
export const ErrorReport = z.object({
  /** The error's name: TypeError, ApiError… */
  type: z.string().max(100),
  /** Its message. */
  value: z.string().max(2_000),
  /** Its stack as the browser wrote it. */
  stack: z.string().max(20_000).optional(),
  /** How it was met: thrown and caught by nothing, a rejected promise nobody handled, or caught by a page's error boundary. */
  how: z.enum(['uncaught', 'unhandled_rejection', 'boundary']),
  /** The dashboard's build (NEXT_PUBLIC_BUILD_ID). */
  build: z.string().max(64).optional(),
  /** The page's path, the browser's `location.pathname`. */
  path: z.string().max(500).optional(),
})
export type ErrorReport = z.infer<typeof ErrorReport>
