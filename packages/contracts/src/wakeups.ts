// Wake-ups: a teammate asks to be prompted again in its thread later ("check
// CI in 10 minutes"), with the conversation so far. The API keeps them and its
// minute tick fires them, on a server and on Workers alike.
import { z } from 'zod'

/** Sooner than this is refused: the tick runs once a minute. */
export const WAKEUP_MIN_MINUTES = 1
/** Later than this is refused: a schedule or a ticket suits waiting longer. */
export const WAKEUP_MAX_DAYS = 7
/** Pending wake-ups one thread may hold. */
export const WAKEUPS_PER_THREAD = 3
/** Wake-ups fired in a thread since a person last wrote in it, before setting another is refused. */
export const WAKEUPS_IN_A_ROW = 5

const Note = z.string().trim().min(1).max(2_000)

/** The wake-up operations of a teammate's schedule tools. */
export const WakeupOperations = [
  z.object({
    name: z.literal('wake'),
    /** In this many minutes, or `at`. */
    minutes: z.number().positive().optional(),
    /** An ISO 8601 instant with its offset, or `minutes`. */
    at: z.string().max(100).optional(),
    note: Note,
  }),
  z.object({ name: z.literal('list_wakeups') }),
  z.object({ name: z.literal('cancel_wakeup'), wakeupId: z.string() }),
] as const

/** When a wake-up asked for fires, or why it cannot be set. */
export function wakeTime(
  input: { minutes?: number | undefined; at?: string | undefined },
  now = new Date(),
): Date | string {
  if ((input.minutes === undefined) === (input.at === undefined))
    return 'Give either minutes or at, not both'
  const when =
    input.minutes !== undefined
      ? new Date(now.getTime() + input.minutes * 60_000)
      : new Date(input.at!)
  if (Number.isNaN(when.getTime())) return `"${input.at}" is not an ISO 8601 time`
  if (when.getTime() < now.getTime() + WAKEUP_MIN_MINUTES * 60_000 - 1_000)
    return `A wake-up is at least ${WAKEUP_MIN_MINUTES} minute from now`
  if (when.getTime() > now.getTime() + WAKEUP_MAX_DAYS * 86_400_000)
    return `A wake-up is at most ${WAKEUP_MAX_DAYS} days from now; for longer, open a ticket or set up a schedule`
  return when
}

const WAKEUP_ASK =
  'Check it now and tell the person what you found. Set another wake-up only if it is still not ready.'

/** The message a wake-up brings back to its thread (src/wakeups.ts in the API). */
export function wakeupMessage(w: {
  /** When it was set, as the person reads it in their timezone. */
  set: string
  timezone: string
  /** Minutes past when it was due, when the computer was offline. */
  lateMinutes?: number
  note: string
}) {
  return (
    `Wake-up you set at ${w.set} (${w.timezone})` +
    (w.lateMinutes ? `, ${w.lateMinutes} minutes late (the computer was offline)` : '') +
    `: ${w.note}\n\n${WAKEUP_ASK}`
  )
}

const WAKEUP_MESSAGE = new RegExp(
  '^Wake-up you set at (.+?) \\(([^()]+)\\)(?:, (\\d+) minutes late \\(the computer was offline\\))?: ' +
    `([\\s\\S]*)\\n\\n${WAKEUP_ASK.replace(/[.]/g, '\\.')}$`,
)

/** A wake-up's message read back (wakeupMessage), for the dashboard's note; null for any other text. */
export function wakeupNote(text: string) {
  const m = WAKEUP_MESSAGE.exec(text)
  if (!m) return null
  return {
    set: m[1]!,
    timezone: m[2]!,
    ...(m[3] ? { lateMinutes: Number(m[3]) } : {}),
    note: m[4]!,
  }
}
