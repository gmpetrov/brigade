// What the workspace's Claude and Codex subscriptions spend tokens on (Settings › Usage).
import { z } from 'zod'

/**
 * A harness run outside a teammate's turn: what Brigade itself asks of the account. memory and
 * tidy: a thread went quiet and its memory is taken, or a memory file laid out again. title: a new
 * thread is named. brief: a project's brief is drafted. image: a picture, through Codex.
 */
export const UsageRunKind = z.enum(['memory', 'tidy', 'title', 'brief', 'image'])
export type UsageRunKind = z.infer<typeof UsageRunKind>

/**
 * Where tokens went, by what asked for them. member: a person's message, and a teammate's turns
 * after it. trigger, schedule, child, review, playbook: work that started without a person.
 * The rest are UsageRunKind.
 */
export const UsageSource = z.enum([
  'member',
  'trigger',
  'schedule',
  'child',
  'review',
  'playbook',
  ...UsageRunKind.options,
])
export type UsageSource = z.infer<typeof UsageSource>

export const USAGE_PERIODS = [1, 7, 30] as const
export type UsagePeriod = (typeof USAGE_PERIODS)[number]

/** Tokens over a stretch: input includes the cache's reads and writes. */
export type UsageTotals = {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  /** Teammate turns, or runs, it counts. */
  runs: number
}

export type UsageGroup = UsageTotals & { id: string; label: string }

export type UsageResponse = {
  days: UsagePeriod
  /** all: the workspace's (owners and admins). mine: the asking member's own accounts only. */
  scope: 'all' | 'mine'
  since: string
  totals: UsageTotals
  /** One per day, oldest first, in UTC. */
  daily: (UsageTotals & { day: string })[]
  byProvider: UsageGroup[]
  bySource: UsageGroup[]
  byTeammate: UsageGroup[]
  byModel: UsageGroup[]
  /** The members whose accounts spent it; with scope all only. */
  byMember: UsageGroup[]
  /** The threads that spent the most, with what started them. */
  topThreads: (UsageGroup & { source: UsageSource; teammateId: string | null })[]
  /** The routines whose runs spent the most. */
  topSchedules: UsageGroup[]
}
