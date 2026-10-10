// Schedules: a teammate is prompted with the same instructions on a cron
// schedule, each firing in a fresh thread. The API and the dashboard check
// and compute runs with these same helpers.
import { Cron } from 'croner'
import { z } from 'zod'

/** Runs closer together than this are refused. */
export const SCHEDULE_MIN_GAP_MINUTES = 5

const cronOf = (cron: string, timezone: string) =>
  new Cron(cron, { timezone, mode: '5-part', paused: true })

/** Whether the runtime knows this IANA timezone. */
export function isTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

/** The next `count` runs after `after`, in UTC instants. Throws on an invalid expression. */
export function nextRuns(cron: string, timezone: string, count: number, after = new Date()) {
  return cronOf(cron, timezone).nextRuns(count, after)
}

/** The first run after `after`, or null when the expression never fires again. */
export function nextRun(cron: string, timezone: string, after = new Date()) {
  return cronOf(cron, timezone).nextRun(after)
}

/** Why a cron expression cannot be used, or null when it can. */
export function cronProblem(cron: string, timezone: string): string | null {
  if (cron.trim().split(/\s+/).length !== 5)
    return 'A schedule has five fields: minute, hour, day of month, month, day of week'
  if (!isTimezone(timezone)) return `Unknown timezone "${timezone}"`
  let runs: Date[]
  try {
    runs = nextRuns(cron, timezone, 10)
  } catch (error) {
    return `Invalid schedule: ${error instanceof Error ? error.message : String(error)}`
  }
  if (runs.length === 0) return 'This schedule never runs'
  for (let i = 1; i < runs.length; i++)
    if (runs[i]!.getTime() - runs[i - 1]!.getTime() < SCHEDULE_MIN_GAP_MINUTES * 60_000)
      return `Runs must be at least ${SCHEDULE_MIN_GAP_MINUTES} minutes apart`
  return null
}

const Title = z.string().trim().min(1).max(200)
const Instructions = z.string().trim().min(1).max(20_000)
const CronExpression = z.string().trim().min(1).max(100)
const Timezone = z.string().trim().min(1).max(100)

/** A cron expression and timezone that can run: five fields, a known zone, not too often. */
const valid = <T extends { cron?: string; timezone?: string }>(value: T, ctx: z.RefinementCtx) => {
  if (value.cron === undefined || value.timezone === undefined) return
  const problem = cronProblem(value.cron, value.timezone)
  if (problem) ctx.addIssue({ code: 'custom', message: problem, path: ['cron'] })
}

export const CreateSchedule = z
  .object({
    teammateId: z.string(),
    title: Title,
    instructions: Instructions,
    cron: CronExpression,
    timezone: Timezone,
  })
  .superRefine(valid)

/** cron and timezone go together, so the pair is checked as one. */
export const UpdateSchedule = z
  .object({
    teammateId: z.string().optional(),
    title: Title.optional(),
    instructions: Instructions.optional(),
    cron: CronExpression.optional(),
    timezone: Timezone.optional(),
  })
  .refine((v) => (v.cron === undefined) === (v.timezone === undefined), {
    message: 'Send cron and timezone together',
  })
  .superRefine(valid)

/** A teammate's schedule tools, sent by the runner and checked by the API. */
export const ScheduleOperation = z.discriminatedUnion('name', [
  z.object({
    name: z.literal('create'),
    title: Title,
    instructions: Instructions,
    cron: CronExpression,
    timezone: Timezone.optional(),
  }),
  z.object({ name: z.literal('list') }),
  z.object({
    name: z.literal('update'),
    scheduleId: z.string(),
    title: Title.optional(),
    instructions: Instructions.optional(),
    cron: CronExpression.optional(),
    timezone: Timezone.optional(),
    paused: z.boolean().optional(),
  }),
])
export type ScheduleOperation = z.infer<typeof ScheduleOperation>
