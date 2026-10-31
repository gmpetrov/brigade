// The Apps a teammate can suggest from what a person needs (list_apps): the accounts it uses in
// its thread, the workspace's it may ask for, and the Apps a person may connect for it. Only
// names: an account's tools stay in the thread's spec, as before.
import { z } from 'zod'

/** A teammate's App tools, sent as schedule.call operations and answered by the API. */
export const AppOperations = [
  /** Its accounts here, the workspace's it may ask for, and the Apps it may ask a person to connect. */
  z.object({ name: z.literal('list_apps') }),
] as const
