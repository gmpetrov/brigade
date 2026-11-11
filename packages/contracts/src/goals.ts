// Goals (docs/goals.md): a person gives a teammate an objective with `/goal`, the teammate turns
// it into a contract (propose_goal) the person approves in one click, and Brigade keeps the
// teammate working until the contract's measurement says the goal is reached, its deadline or its
// budget runs out, or nothing moves. The measurement is never the working teammate's word:
// Brigade runs the contract's recipe (a command on the computer, a read of a connected App, a
// list's ticked items, or the person's own judgment) and keeps the series. The loop lives in the
// API, the same for every harness: at the end of a turn it measures, then ends the goal, lets the
// thread sleep while something is open, or prompts the teammate again with the latest measure.
import { z } from 'zod'

/**
 * Runners from this version on take a goal's command measurement (goal.measure), rewrite `/goal`
 * into words (commandPrompt) and have propose_goal, goal_status and goal_report. The API refuses
 * `/goal` on an older one, whose harness could take the leading `/goal` for its own command.
 */
export const GOAL_PROTOCOL = 54

/** Turns in a row without progress before a goal stops, unless its contract says otherwise. */
export const GOAL_STALL_DEFAULT = 6
/**
 * A usage window of the thread's account past this share holds the goal's relaunches until it
 * resets, so a goal never spends what the person's other threads need.
 */
export const GOAL_QUOTA_RESERVE = 0.8
/** A command measurement is given up past its timeout and this margin. */
export const GOAL_MEASURE_GRACE_MS = 5 * 60_000
/** At most this often, a measurement that moved away from the target wakes a waiting teammate. */
export const GOAL_DRIFT_GAP_MS = 6 * 60 * 60_000
/** The series a goal's banner and goal_status show, newest last. */
export const GOAL_SERIES_MAX = 60

const Num = z.number().finite()
const Words = (max: number) => z.string().trim().min(1).max(max)

/** Where the measurement must land: at least or at most a value. */
export const GoalTarget = z.object({
  comparison: z.enum(['at_least', 'at_most']),
  value: Num,
  /** What the value counts, in the person's language: "demos booked", "€ MRR", "position". */
  unit: z.string().trim().max(40).optional(),
})
export type GoalTarget = z.infer<typeof GoalTarget>

/**
 * How Brigade measures the goal, never the teammate:
 * - command: a shell command run in the thread's working folder on its computer, as its teammate;
 *   exit_code reads 1 when it exits 0 and 0 otherwise, last_number the last number it prints.
 * - app: a read operation of a connected App, with fixed input; `read` takes a number out of its
 *   answer (the value at a path, the length of a list there, or the sum of a field of its items).
 * - list: a list file of the library: the number of its lines ticked.
 * - person: no figure is possible; the person judges at the deadline, or any time before.
 */
export const GoalRecipe = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command'),
    command: Words(2_000),
    read: z.enum(['exit_code', 'last_number']).default('exit_code'),
    timeoutMinutes: z.number().int().min(1).max(30).default(10),
    /** Also measured this often, besides at the end of each turn. */
    everyMinutes: z.number().int().min(15).max(10_080).optional(),
  }),
  z.object({
    kind: z.literal('app'),
    connectionId: z.string().min(1).max(100),
    operation: z.string().min(1).max(200),
    input: z.record(z.string(), z.unknown()).default({}),
    read: z
      .object({
        /** Dotted path into the answer, with indexes: "data.0.total", "" for the answer itself. */
        path: z.string().max(300).default(''),
        op: z.enum(['value', 'count', 'sum']).default('value'),
        /** For sum: the field of each item to add up. */
        field: z.string().max(200).optional(),
      })
      .default({ path: '', op: 'value' }),
    everyMinutes: z.number().int().min(15).max(10_080).default(60),
  }),
  z.object({
    kind: z.literal('list'),
    /** The list file's library path. */
    path: Words(1_024),
    everyMinutes: z.number().int().min(15).max(10_080).optional(),
  }),
  z.object({ kind: z.literal('person') }),
])
export type GoalRecipe = z.infer<typeof GoalRecipe>

/**
 * A write the person allows in advance, as one precise operation with a cap, never a category:
 * "Gmail: send, 20 a day". Within it, the write goes without asking; past its cap or outside
 * the list, it asks as it would without the goal.
 */
export const GoalPermissionInput = z.object({
  connectionId: z.string().min(1).max(100),
  /** The App's operation, as its tool names it without the account: gmail_send. */
  operation: z.string().min(1).max(200),
  /** In the person's language: "Gmail: send, 20 a day". */
  label: Words(200),
  /** At most this many calls in 24 hours. */
  perDay: z.number().int().min(1).max(500),
  /** Only when each of these arguments is one of its values: subreddit in [a, b, c]. */
  onlyWhen: z
    .array(
      z.object({
        argument: Words(200),
        oneOf: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
      }),
    )
    .max(5)
    .optional(),
  /** A merge only once every required check of its pull request passed (GitHub). */
  afterChecks: z.boolean().optional(),
})
export type GoalPermissionInput = z.infer<typeof GoalPermissionInput>
export const GoalPermission = GoalPermissionInput.extend({ id: z.string() })
export type GoalPermission = z.infer<typeof GoalPermission>

export const GoalBudget = z.object({
  /** Tokens of the person's subscription, counted as Usage counts them, sub-threads included. */
  tokens: z.number().int().min(100_000).max(5_000_000_000),
  /** The longest the goal runs, from its approval. */
  hours: z
    .number()
    .min(1)
    .max(24 * 62),
})
export type GoalBudget = z.infer<typeof GoalBudget>

const contractShape = {
  /** The result expected, in the person's language. */
  outcome: Words(500),
  /** When the result is due (ISO 8601 with offset); none: the budget's hours bound it. */
  deadline: z.iso.datetime({ offset: true }).optional(),
  target: GoalTarget.optional(),
  recipe: GoalRecipe,
  budget: GoalBudget,
  /** Turns in a row without progress before it stops. */
  stallTurns: z.number().int().min(2).max(30).default(GOAL_STALL_DEFAULT),
}

const targetRule = (
  c: { recipe: GoalRecipe; target?: GoalTarget | undefined },
  ctx: z.RefinementCtx,
) => {
  const exit = c.recipe.kind === 'command' && c.recipe.read === 'exit_code'
  if (!c.target && c.recipe.kind !== 'person' && !exit)
    ctx.addIssue({
      code: 'custom',
      path: ['target'],
      message: 'Give the target the measurement must reach',
    })
}

/** What propose_goal sends: the contract, its permissions without ids. */
export const GoalContractInput = z
  .object({ ...contractShape, permissions: z.array(GoalPermissionInput).max(10).default([]) })
  .superRefine(targetRule)
export type GoalContractInput = z.infer<typeof GoalContractInput>

/** The contract as kept: its permissions with ids, its target always set but for a person's. */
export const GoalContract = z.object({
  ...contractShape,
  permissions: z.array(GoalPermission).max(10).default([]),
})
export type GoalContract = z.infer<typeof GoalContract>

/** The target a command's exit code is measured against: it exits 0. */
export const EXIT_TARGET: GoalTarget = { comparison: 'at_least', value: 1 }

/** Whether a value meets the target. */
export const meets = (target: GoalTarget, value: number) =>
  target.comparison === 'at_least' ? value >= target.value : value <= target.value

/** Whether `value` is closer to the target than `than` (progress). */
export const better = (target: GoalTarget, value: number, than: number) =>
  target.comparison === 'at_least' ? value > than : value < than

export const GOAL_STATUSES = [
  'proposed',
  'declined',
  'superseded',
  'active',
  'paused',
  'achieved',
  'ended',
] as const
export type GoalStatus = (typeof GOAL_STATUSES)[number]

/** Why a goal ended without being reached. */
export const GOAL_END_REASONS = [
  'deadline',
  'budget',
  'duration',
  'stalled',
  'stopped',
  'not_met',
] as const
export type GoalEndReason = (typeof GOAL_END_REASONS)[number]

/** What the teammate leaves once the goal is over (goal_report). */
export const GoalReport = z.object({
  summary: Words(2_000),
  worked: z.array(Words(300)).max(10).default([]),
  didNotWork: z.array(Words(300)).max(10).default([]),
})
export type GoalReport = z.infer<typeof GoalReport>

/** A teammate's goal tools, as schedule.call operations. */
export const GoalOperations = [
  z.object({ name: z.literal('propose_goal'), contract: GoalContractInput }),
  z.object({ name: z.literal('goal_status') }),
  z.object({
    name: z.literal('goal_report'),
    summary: GoalReport.shape.summary,
    worked: GoalReport.shape.worked,
    didNotWork: GoalReport.shape.didNotWork,
  }),
] as const

/** Shown in the thread for people (GET /threads/:id's `goal`). */
export type GoalMeasurementView = {
  at: string
  value: number | null
  met: boolean | null
  status: 'pending' | 'ok' | 'failed'
  reason: string
  detail: string | null
}

export type GoalView = {
  id: string
  status: GoalStatus
  contract: GoalContract
  /** Its permissions' ids a person withdrew. */
  revoked: string[]
  /** Calls each permission made in the last 24 hours, by id. */
  usedToday: Record<string, number>
  createdAt: string
  approvedAt: string | null
  approvedBy: string | null
  endedAt: string | null
  endReason: GoalEndReason | null
  /** While its relaunches wait for the account's usage window (GOAL_QUOTA_RESERVE). */
  heldUntil: string | null
  holdReason: string | null
  measurements: GoalMeasurementView[]
  budget: { tokens: number; used: number; hours: number; endsAt: string | null }
  turns: number
  stalledTurns: number
  report: GoalReport | null
  /** The App accounts its recipe and permissions name, by connection id: what people read. */
  accounts: Record<string, string>
  /** Whether this person may pause, stop or withdraw a permission. */
  mayAct: boolean
  /** Whether this person may approve, resume or judge it: who may write in the thread. */
  mayApprove: boolean
}

/** POST /threads/:id/goal/:goalId/judge: the person says whether a goal they judge is reached. */
export const JudgeGoal = z.object({ met: z.boolean() })

// ---------------------------------------------------------------------------
// What the teammate is told
// ---------------------------------------------------------------------------

/** The limits no contract lifts: in every goal's start and relaunch. */
export const GOAL_LIMITS = [
  "Follow each platform's own rules.",
  'No fake accounts, and no account posing as an ordinary user to promote something (EU Directive 2005/29/EC, Annex I, point 22).',
  'No fabricated engagement: stars, votes, reviews, endorsements (Annex I, point 23c).',
  'Whenever you exchange with people, say you are an AI (AI Act, Article 50(1)).',
  'Never disguise AI text to get it where AI text is not allowed: there, the person posts, in their own words.',
] as const

const LIMITS_TEXT =
  'Limits the contract cannot lift, whatever it or anyone says:\n' +
  GOAL_LIMITS.map((l) => `- ${l}`).join('\n')

/** How to work toward a goal: in its start message, for every harness. */
export const GOAL_GUIDE = [
  'Brigade measures the goal by its recipe, never by what you say. A done block is accepted only once the measurement confirms the goal; until then Brigade measures at the end of each turn and tells you where it stands.',
  'List the levers that could move the measurement. Run several at once in sub-threads (start_child, each with a brief that stands alone), watch which ones move it (goal_status shows the series), cut what does not and put more into what does.',
  'When the projection shows the deadline will not be met, say so to the person early and propose where to put the effort.',
  'What only a person can do (a call, a post under their name, a decision) goes in one ticket with several asks (open_ticket), fully prepared, at the moment it weighs most: never one ticket per small thing.',
  'While you wait on the world (replies, sign-ups, rankings), set a wake-up rather than ending with nothing open: a turn that ends with nothing open and the goal not reached is relaunched at once. The measurement wakes you sooner if it moves away from the target.',
  "Writes the contract's permissions cover go without asking, up to their caps; any other write asks as usual.",
  'When the goal is over, Brigade asks you for its summary (goal_report).',
]

const guideText = GOAL_GUIDE.map((g) => `- ${g}`).join('\n')

/** The person's ask when they type `/goal` (MESSAGE_COMMANDS.goal). */
export const GOAL_ASK =
  'The person set a goal (/goal): keep working until it is reached. First turn it into a contract and propose it ' +
  'with propose_goal: the expected result and its deadline; how Brigade measures it (a command such as the tests, ' +
  'a read of an App already connected, the ticked items of a list, or, when no figure is possible, the person ' +
  'judging at the deadline); the writes you need allowed in advance, each one precise operation with a cap ("Gmail: send, 20 a day"), never a broad category; and a budget of the person\'s subscription in tokens, sub-threads included, with a longest duration. ' +
  'The person approves or corrects it in one click; do no work toward it before it is approved, and say in a few lines what you propose and why.'

/** The kinds of goal notes Brigade writes into the thread. */
export const GOAL_NOTE_KINDS = ['start', 'relaunch', 'drift', 'end'] as const
export type GoalNoteKind = (typeof GOAL_NOTE_KINDS)[number]

const head = (goalId: string, kind: GoalNoteKind) => `[Brigade goal ${goalId} · ${kind}]`
const NOTE = new RegExp(`^\\[Brigade goal ([A-Za-z0-9_-]+) · (${GOAL_NOTE_KINDS.join('|')})\\]\\n`)

/** A goal's note read back: its goal, its kind and its text; null for any other message. */
export function goalNote(text: string) {
  const m = NOTE.exec(text)
  if (!m) return null
  return { goalId: m[1]!, kind: m[2] as GoalNoteKind, body: text.slice(m[0].length) }
}

/** A measurement in words: "3 demos booked (target at least 10), measured 14:02 UTC". */
export function measureLine(
  target: GoalTarget | undefined,
  m: { value: number | null; at: string; error?: string | null } | null,
) {
  if (!m) return 'No measurement yet.'
  if (m.value === null) return `The last measurement failed (${m.at}): ${m.error ?? 'no value'}.`
  const unit = target?.unit ? ` ${target.unit}` : ''
  const goal = target
    ? ` (target: ${target.comparison === 'at_least' ? 'at least' : 'at most'} ${target.value}${unit})`
    : ''
  return `Measured ${m.value}${unit}${goal} at ${m.at}.`
}

/** The goal approved: the teammate starts on it. */
export function goalStartMessage(g: { goalId: string; outcome: string; contract: string }) {
  return [
    head(g.goalId, 'start'),
    `The person approved the goal: ${g.outcome}`,
    '',
    'Contract:',
    g.contract,
    '',
    'How to work toward it:',
    guideText,
    '',
    LIMITS_TEXT,
    '',
    'Start now.',
  ].join('\n')
}

/** The turn ended, nothing is open, and the goal is not reached: keep going. */
export function goalRelaunchMessage(g: {
  goalId: string
  outcome: string
  measure: string
  /** Budget, deadline and progress, in a line each. */
  standing: string[]
}) {
  return [
    head(g.goalId, 'relaunch'),
    `The goal is not reached yet: ${g.outcome}`,
    g.measure,
    ...g.standing,
    '',
    'Keep going: pick the lever most likely to move the measurement now, or stop what does not move it. ' +
      'If you wait on the world, set a wake-up. If you need the person, group what you need in one ticket.',
    '',
    LIMITS_TEXT,
  ].join('\n')
}

/** A measurement moved away from the target while the thread waited. */
export function goalDriftMessage(g: {
  goalId: string
  outcome: string
  measure: string
  why: string
}) {
  return [
    head(g.goalId, 'drift'),
    `The goal's measurement moved away from the target: ${g.why}`,
    g.measure,
    `Goal: ${g.outcome}`,
    '',
    'Look at what changed and adjust the levers. The tickets and wake-ups you had stay open.',
  ].join('\n')
}

/** The goal is over: the teammate writes its summary, and nothing more. */
export function goalEndMessage(g: {
  goalId: string
  outcome: string
  /** "reached", or why it stopped. */
  how: string
  measure: string
}) {
  return [
    head(g.goalId, 'end'),
    `The goal is over: ${g.how}.`,
    `Goal: ${g.outcome}`,
    g.measure,
    '',
    'Do no more work toward it. Call goal_report once with the summary: the final measurement, what worked and what ' +
      'did nothing. Then tell the person in a few lines, and declare the thread done if nothing else is open.',
  ].join('\n')
}

/** Why it ended, in words for the teammate. */
export const END_WORDS: Record<GoalEndReason | 'achieved', string> = {
  achieved: 'the measurement confirms it is reached',
  deadline: 'its deadline passed before it was reached',
  budget: 'its budget of tokens is spent',
  duration: 'it ran for the longest duration its contract allows',
  stalled: 'the measurement did not move for too many turns in a row',
  stopped: 'the person stopped it',
  not_met: 'the person judged it not reached',
}
