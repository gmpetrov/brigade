// Chief answers for the person (docs/chief-answers.md): when a teammate ends its reply on buttons
// or a choices card, Chief reads the question before the person does and, in their name, picks the
// answer their mandate settles, says "not now" to work outside their priorities, or leaves the
// question to them with what it would pick. It first only suggests; a kind of question it may
// answer on its own is the person's to allow, once it agreed with them enough. A member who turns
// it off gets Brigade as it was: nothing here runs, and nothing in the instructions changes.
import { z } from 'zod'

/** The kinds of question Chief may answer in a person's name. */
export const CHIEF_KINDS = ['next_step', 'approach', 'priority'] as const
export const ChiefKind = z.enum(CHIEF_KINDS)
export type ChiefKind = z.infer<typeof ChiefKind>

/** What Chief makes of a question: the kinds it may answer, and those that are always the person's. */
export const ChiefQuestionKind = z.enum([...CHIEF_KINDS, 'taste', 'outside'])
export type ChiefQuestionKind = z.infer<typeof ChiefQuestionKind>

/** Each kind as people read it, with what it covers. */
export const CHIEF_KIND_LABELS: Record<ChiefKind, { label: string; hint: string }> = {
  next_step: { label: 'Next steps', hint: 'Go on, build it, do the next part of the work' },
  approach: { label: 'Approaches', hint: 'Which way to do the work asked' },
  priority: { label: 'Priorities', hint: 'Now or later' },
}

/** A kind of question, in a sentence: "next steps". */
export const chiefKindWords = (kind: ChiefQuestionKind) =>
  kind === 'taste'
    ? 'a matter of taste'
    : kind === 'outside'
      ? 'something that leaves Brigade'
      : CHIEF_KIND_LABELS[kind].label.toLowerCase()

/**
 * Chief's answers in a row in a thread with no word from the person: the question after them
 * goes to the person, whatever its kind.
 */
export const CHIEF_ANSWERS_IN_A_ROW = 3

/**
 * When Brigade offers to let Chief answer a kind on its own: of the latest `decisions` suggestions
 * of that kind the person answered (since they last refused, or set it back), `agreed` at least
 * were the person's own pick.
 */
export const CHIEF_PROMOTION = { decisions: 10, agreed: 9 } as const

/** Where Chief keeps the person's mandate, and the work it put off, in the library. */
export const CHIEF_FOLDER = 'chief'
export const MANDATE_PATH = `${CHIEF_FOLDER}/mandate.md`
export const PARKED_PATH = `${CHIEF_FOLDER}/parked.md`

/** One answer a question offers: its button's words, and the message a click on it sends. */
export const ChiefOption = z.object({
  label: z.string(),
  message: z.string(),
  /** What a choices card's option says of itself, beside its label. */
  description: z.string().optional(),
})
export type ChiefOption = z.infer<typeof ChiefOption>

/**
 * Where a decision stands. pending: Chief is reading the question. suggested: its pick shows on
 * the question, the person decides. answered: it answered on its own. escalated: it left the
 * question to the person, with why. superseded: someone answered first. failed: it could not
 * decide (no account, an error, no decision made).
 */
export const ChiefDecisionStatus = z.enum([
  'pending',
  'suggested',
  'answered',
  'escalated',
  'superseded',
  'failed',
])
export type ChiefDecisionStatus = z.infer<typeof ChiefDecisionStatus>

/** What the person made of it: their own pick was Chief's, another, or Chief's answer was wrong. */
export const ChiefOutcome = z.enum(['agreed', 'disagreed', 'overruled'])
export type ChiefOutcome = z.infer<typeof ChiefOutcome>

/** Chief's decision on one question, as a thread shows it. */
export const ChiefDecisionView = z.object({
  id: z.string(),
  /** The question's card in the thread (its tool.started seq). */
  askSeq: z.number().int(),
  status: ChiefDecisionStatus,
  verdict: z.enum(['answer', 'park', 'escalate']).nullable(),
  kind: ChiefQuestionKind.nullable(),
  /** The answer it picked (or would pick, escalating): what a click on it sends. */
  option: ChiefOption.nullable(),
  reason: z.string().nullable(),
  basis: z.string().nullable(),
  outcome: ChiefOutcome.nullable(),
  /** Chief's thread that decided it, a sub-thread of this one. */
  childSessionId: z.string().nullable(),
  createdAt: z.string(),
})
export type ChiefDecisionView = z.infer<typeof ChiefDecisionView>

/** A member turns Chief's answers on or off, or lets it answer a kind alone or not (PUT /me/chief). */
export const SetChief = z
  .object({
    on: z.boolean().optional(),
    alone: z.object({ kind: ChiefKind, on: z.boolean() }).optional(),
  })
  .refine((v) => (v.on === undefined) !== (v.alone === undefined), {
    message: 'Send on, or alone',
  })
export type SetChief = z.infer<typeof SetChief>

/** What Chief does in a member's name, as their settings show it (GET /me/chief). */
export type ChiefSettings = {
  on: boolean
  kinds: { kind: ChiefKind; alone: boolean; decided: number; agreed: number }[]
  mandate: { id: string; path: string } | null
  stats: {
    days: number
    questions: number
    answered: number
    overruled: number
    suggested: number
    agreed: number
    disagreed: number
    escalated: number
  }
}

/** Chief's decision, as its decision thread sends it (its chief_decide tool). */
const Line = (max: number) => z.string().trim().min(1).max(max)
export const ChiefOperations = [
  z.object({
    name: z.literal('chief_decide'),
    /** answer: pick `option`. park: pick `option`, the one that puts it off, and keep `parked`. escalate: leave it to the person. */
    verdict: z.enum(['answer', 'park', 'escalate']),
    /** The answer, by its number in the brief (1 for the first). Escalating: the one it would pick, if any. */
    option: z.number().int().positive().max(10).optional(),
    kind: ChiefQuestionKind,
    reason: Line(600),
    /** The line of the mandate, or the person's earlier decision, it goes by. */
    basis: Line(300).optional(),
    /** Parking: the work put off, in a line for the person's list. */
    parked: Line(300).optional(),
  }),
  /** Chief's recent decisions for the person of its thread, for the weekly look back. */
  z.object({
    name: z.literal('chief_decisions'),
    days: z.number().int().positive().max(31).optional(),
  }),
] as const

export type ChiefOperation = z.infer<(typeof ChiefOperations)[number]>
export const isChiefOperation = (op: { name: string }): op is ChiefOperation =>
  op.name === 'chief_decide' || op.name === 'chief_decisions'

/** One line: an answer note keeps each part on its own line. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** What the teammate is told with every answer of Chief's: it is not the person. */
export const CHIEF_ANSWER_RULE =
  'Go on as if the person had sent it. It is not them: anything that leaves Brigade (merging, sending, ' +
  'publishing, deploying, paying, deleting) still waits for the person, and your App writes ask them ' +
  'until they write again.'

const ANSWER_HEAD = 'Chief answered for you: '
const decisionTail = (id: string) => `(Chief's decision ${id})`

/**
 * The message Chief's answer reaches the teammate as, in the person's name: the very words a click
 * on the answer sends, with why. The dashboard shows it as a note (chiefAnswerNote).
 */
export function chiefAnswerMessage(a: {
  decisionId: string
  answer: string
  reason: string
  basis?: string | null
}) {
  return [
    `${ANSWER_HEAD}${oneLine(a.answer)}`,
    `Why: ${oneLine(a.reason)}`,
    ...(a.basis ? [`From the mandate: ${oneLine(a.basis)}`] : []),
    '',
    `${CHIEF_ANSWER_RULE} ${decisionTail(a.decisionId)}`,
  ].join('\n')
}

const ANSWER = new RegExp(
  `^${ANSWER_HEAD}(.+)\\nWhy: (.+)\\n(?:From the mandate: (.+)\\n)?\\n` +
    `${CHIEF_ANSWER_RULE.replace(/[.()]/g, '\\$&')} \\(Chief's decision ([A-Za-z0-9_-]+)\\)$`,
)

/** An answer of Chief's read back (chiefAnswerMessage); null for any other text. */
export function chiefAnswerNote(text: string) {
  const m = ANSWER.exec(text)
  if (!m) return null
  return { answer: m[1]!, reason: m[2]!, basis: m[3] ?? null, decisionId: m[4]! }
}

const OVERRULED_HEAD = 'The person marked Chief’s answer as wrong: '

/** What the teammate is told when the person marks one of Chief's answers as wrong. */
export function chiefOverruledMessage(a: { decisionId: string; answer: string }) {
  return (
    `${OVERRULED_HEAD}${oneLine(a.answer)}\n\n` +
    'Stop what you started on it and undo what you can, then wait for what they say next. ' +
    decisionTail(a.decisionId)
  )
}

const OVERRULED = new RegExp(
  `^${OVERRULED_HEAD}(.+)\\n\\nStop what you started on it and undo what you can, then wait for what they say next\\. ` +
    `\\(Chief's decision ([A-Za-z0-9_-]+)\\)$`,
)

/** A wrong answer's message read back (chiefOverruledMessage); null for any other text. */
export function chiefOverruledNote(text: string) {
  const m = OVERRULED.exec(text)
  return m ? { answer: m[1]!, decisionId: m[2]! } : null
}

const BRIEF_HEAD = 'Decide for the person: '

/**
 * The first message of Chief's decision thread: the question, what it offers, and what Chief goes
 * by. Everything it needs is here: it reads no other thread.
 */
export function chiefDecisionBrief(b: {
  person: string
  teammate: string
  threadTitle: string
  request: string
  /** What a choices card asks, as it asks it; buttons ask in the reply itself. */
  cardQuestion?: string | null
  question: string
  options: ChiefOption[]
  mandate: string | null
  earlier: string[]
}) {
  return [
    `${BRIEF_HEAD}${b.threadTitle}`,
    '',
    `${b.teammate} ended its reply in a thread of ${b.person}'s on a question with these answers. ` +
      `Read it as ${b.person}'s chief of staff, then call chief_decide once and end your turn.`,
    '',
    ...(b.cardQuestion?.trim() ? ['## The question', b.cardQuestion.trim(), ''] : []),
    '## The answers it offers',
    ...b.options.map(
      (o, i) => `${i + 1}. ${o.label}${o.description?.trim() ? `: ${oneLine(o.description)}` : ''}`,
    ),
    '',
    `## ${b.teammate}'s reply, ending on the question`,
    b.question,
    '',
    `## What ${b.person} asked in the thread`,
    b.request || '(The thread started without a request of theirs.)',
    '',
    `## ${b.person}'s mandate`,
    b.mandate?.trim() ||
      `(None yet: ${b.person} has not written one with you. Answer only what their own words in the thread, or ` +
        'their decisions in your memory, settle; leave the rest to them.)',
    ...(b.earlier.length
      ? ['', '## Your earlier decisions in this thread', ...b.earlier.map((e) => `- ${e}`)]
      : []),
  ].join('\n')
}

/** A decision thread's first message, by its head: the thread view folds it like Brigade's notes. */
export const isChiefDecisionBrief = (text: string) => text.startsWith(BRIEF_HEAD)
