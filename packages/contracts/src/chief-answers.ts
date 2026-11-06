// Chief for the person (docs/chief-answers.md), with no turn of its own on each question:
// - Their rules: a text the person keeps (Preferences → Chief), given to every teammate working
//   for them, which decides what the rules settle and asks them only the rest.
// - A daily pass: once a day, when something waits on them, Chief goes through it in a thread of
//   its own that no list shows. It answers in their name the questions their rules settle, tries
//   failed threads again, and leaves on Today what is still theirs to decide, with what it would
//   pick, what it noticed across their threads, and rules worth adding from their recent answers.
// Off (the default), none of it runs, and teammates' instructions are as they were.
import { z } from 'zod'

/** The most of a person's rules their teammates read. */
export const CHIEF_RULES_MAX = 4_000
/** Rules a person refused, the latest ones: Chief does not propose them again. */
export const CHIEF_RULES_REFUSED_MAX = 50
/** The hour of the person's day, in their timezone, from which their pass may run. */
export const CHIEF_PASS_HOUR = 7

/**
 * Chief's answers in a row in a thread with no word from the person: the question after them
 * waits for the person, whatever their rules say.
 */
export const CHIEF_ANSWERS_IN_A_ROW = 3

/** One answer a question offers: its button's words, and the message a click on it sends. */
export const ChiefOption = z.object({
  label: z.string(),
  message: z.string(),
  /** What a choices card's option says of itself, beside its label. */
  description: z.string().optional(),
  /** A design to pick on its card: a matter of taste, never answered by Chief. */
  design: z.boolean().optional(),
})
export type ChiefOption = z.infer<typeof ChiefOption>

/**
 * Where an answer of Chief's stands. answered: it goes, or went, to the teammate in the person's
 * name. superseded: the person, or the thread, moved on first, and it never goes. escalated: it was
 * left to the person (CHIEF_ANSWERS_IN_A_ROW). pending and failed: on its way, or not made.
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

/** overruled: the person marked Chief's answer as wrong. */
export const ChiefOutcome = z.enum(['agreed', 'disagreed', 'overruled'])
export type ChiefOutcome = z.infer<typeof ChiefOutcome>

/** One line: an answer note keeps each part on its own line. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** What the teammate is told with every answer of Chief's: it is not the person. */
export const CHIEF_ANSWER_RULE =
  'Go on as if the person had sent it. It is not them: anything that leaves Brigade (merging, sending, ' +
  'publishing, deploying, paying, deleting) still waits for the person, and your App writes ask them ' +
  'until they write again.'

const ANSWER_HEAD = 'Chief answered for you: '
const RULE_HEAD = 'By their rule: '
const decisionTail = (id: string) => `(Chief's decision ${id})`

/**
 * The message Chief's answer reaches the teammate as, in the person's name: the very words a click
 * on the answer sends, with why and the rule it goes by. The dashboard shows it as a note
 * (chiefAnswerNote).
 */
export function chiefAnswerMessage(a: {
  decisionId: string
  answer: string
  reason: string
  /** The person's rule it goes by, in their words. */
  basis?: string | null
}) {
  return [
    `${ANSWER_HEAD}${oneLine(a.answer)}`,
    `Why: ${oneLine(a.reason)}`,
    ...(a.basis ? [`${RULE_HEAD}${oneLine(a.basis)}`] : []),
    '',
    `${CHIEF_ANSWER_RULE} ${decisionTail(a.decisionId)}`,
  ].join('\n')
}

// Answers made before the rules (#724) said "From the mandate:": still read back as answers.
const ANSWER = new RegExp(
  `^${ANSWER_HEAD}(.+)\\nWhy: (.+)\\n(?:(?:${RULE_HEAD}|From the mandate: )(.+)\\n)?\\n` +
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

// ---------------------------------------------------------------------------
// The person's settings and rules
// ---------------------------------------------------------------------------

/** A member turns their daily pass on or off, sets their rules, or says their timezone (PUT /me/chief). */
export const SetChief = z
  .object({
    pass: z.boolean().optional(),
    rules: z.string().max(CHIEF_RULES_MAX).optional(),
    /** IANA, as their browser says it: their pass runs in their morning. */
    timezone: z.string().trim().min(1).max(64).optional(),
  })
  .refine((v) => v.pass !== undefined || v.rules !== undefined || v.timezone !== undefined, {
    message: 'Send pass, rules or timezone',
  })
export type SetChief = z.infer<typeof SetChief>

/** What a member set for Chief (GET /me/chief). */
export type ChiefSettings = {
  pass: boolean
  rules: string
  timezone: string | null
  /** Their pass runs from this hour of their day. */
  hour: number
  /**
   * Chief acts on their rules (the chief_acts feature): the pass answers in their name and their
   * teammates decide by them. Else, while rules are calibrated, the pass only recommends.
   */
  acts: boolean
}

/** The person takes a rule Chief proposed into their rules, or refuses it (POST /me/chief/rules). */
export const ChiefRuleDecision = z.object({
  line: z.string().trim().min(1).max(300),
  add: z.boolean(),
})
export type ChiefRuleDecision = z.infer<typeof ChiefRuleDecision>

// ---------------------------------------------------------------------------
// The daily pass
// ---------------------------------------------------------------------------

const Thread = { n: z.number().int().positive(), title: z.string() }

/** One thing that waits on the person, as their pass lists it: by its number in Chief's brief. */
export const ChiefPassItem = z.discriminatedUnion('kind', [
  /** A teammate's reply ended on buttons or a choices card nobody answered: Chief may answer it. */
  z.object({
    kind: z.literal('question'),
    ...Thread,
    sessionId: z.string(),
    teammate: z.string(),
    teammateId: z.string(),
    /** The card's event in the thread (its tool.started seq). */
    askSeq: z.number().int(),
    options: z.array(ChiefOption),
    /** The reply ending on it (its end), and what a choices card asks. */
    question: z.string(),
    cardQuestion: z.string().nullable(),
  }),
  /** A thread that stopped on an error: Chief may try it again. */
  z.object({
    kind: z.literal('failed'),
    ...Thread,
    sessionId: z.string(),
    teammate: z.string(),
    error: z.string(),
  }),
  /** A ticket (an approval, an access, a question in a turn): always the person's to answer. */
  z.object({
    kind: z.literal('ticket'),
    ...Thread,
    sessionId: z.string().nullable(),
    ticket: z.string(),
    type: z.string(),
  }),
  /** A pull request waiting on a person: always theirs to merge. */
  z.object({
    kind: z.literal('pull'),
    ...Thread,
    sessionId: z.string().nullable(),
    pull: z.string(),
    state: z.string(),
  }),
])
export type ChiefPassItem = z.infer<typeof ChiefPassItem>

/** A question of the person's answered by a click, lately: what Chief learns their rules from. */
export type ChiefRecentAnswer = { thread: string; question: string; picked: string }

const BRIEF_HEAD = "Chief's pass for "
const clip = (text: string, max: number) =>
  text.length <= max ? text : `…${text.slice(text.length - max)}`

/** A pass that only recommends (no chief_acts), as its brief tells Chief whatever its runner. */
export const CHIEF_RECOMMENDS_ONLY =
  'For now they want recommendations only: answer nothing and try nothing again in their name ' +
  '(chief_answer and chief_retry are refused). In chief_report, give every item what you would do; ' +
  'for a question, the answer you would pick and the rule of theirs it goes by. They decide on ' +
  'Today, which shows how often your pick matched theirs.'

/**
 * The first message of the person's pass: their rules, what waits on them, numbered, and their
 * recent answers. Everything Chief goes by is here: it reads no thread. acts: Chief may answer and
 * retry in their name (chief_acts); else it only recommends, which the brief says.
 */
export function chiefPassBrief(b: {
  person: string
  day: string
  rules: string | null
  refused: string[]
  items: ChiefPassItem[]
  answers: ChiefRecentAnswer[]
  acts: boolean
}) {
  const item = (i: ChiefPassItem) => {
    const head = `${i.n}. "${oneLine(i.title)}"`
    switch (i.kind) {
      case 'question':
        return [
          `${head}: ${i.teammate} ended its reply on a question.`,
          ...(i.cardQuestion?.trim() ? [`   Question: ${oneLine(i.cardQuestion)}`] : []),
          `   Its reply, ending on it: ${oneLine(clip(i.question, 1_500)) || '(no text)'}`,
          `   Answers: ${i.options
            .map(
              (o, k) =>
                `${k + 1}) ${o.label}${o.description?.trim() ? ` (${oneLine(o.description)})` : ''}` +
                (o.design ? ' [a design: theirs to pick]' : ''),
            )
            .join('  ')}`,
        ].join('\n')
      case 'failed':
        return `${head}: ${i.teammate}'s turn stopped on an error: ${oneLine(clip(i.error, 600))}`
      case 'ticket':
        return `${head}: a ticket waits on them (${i.type}): ${oneLine(i.ticket)}. Theirs to answer.`
      case 'pull':
        return `${head}: pull request ${oneLine(i.pull)} (${i.state}). Theirs to merge.`
    }
  }
  return [
    `${BRIEF_HEAD}${b.person}, ${b.day}`,
    '',
    `Go through what waits on ${b.person} this morning, as their chief of staff (see your instructions), then ` +
      'call chief_report once and end your turn.',
    ...(b.acts ? [] : ['', CHIEF_RECOMMENDS_ONLY]),
    '',
    `## ${b.person}'s rules`,
    b.rules?.trim() ||
      (b.acts
        ? `(None yet. Answer nothing in their name; from their recent answers below, propose rules they may want.)`
        : `(None yet. Recommend from their recent answers below, and propose rules they may want.)`),
    '',
    '## What waits on them',
    ...b.items.map(item),
    ...(b.answers.length
      ? [
          '',
          '## Their answers to questions lately',
          ...b.answers.map(
            (a) =>
              `- "${oneLine(a.thread)}": ${oneLine(clip(a.question, 300))} → ${oneLine(a.picked)}`,
          ),
        ]
      : []),
    ...(b.refused.length
      ? ['', '## Rules they refused (never propose these again)', ...b.refused.map((r) => `- ${r}`)]
      : []),
  ].join('\n')
}

/** A pass's first message, by its head: its thread view folds it like Brigade's notes. */
export const isChiefPassBrief = (text: string) => text.startsWith(BRIEF_HEAD)

const Line = (max: number) => z.string().trim().min(1).max(max)

/** What Chief leaves the person at the end of its pass (chief_report). */
export const ChiefPassReport = z.object({
  /** What is still theirs to decide, each with what Chief would do: an answer, by its number, for a question. */
  decisions: z
    .array(
      z.object({
        item: z.number().int().positive(),
        recommendation: Line(400),
        option: z.number().int().positive().max(10).optional(),
        /** For a question: the person's rule the pick goes by, in their words; none: no rule settles it. */
        rule: Line(300).optional(),
      }),
    )
    .max(30)
    .default([]),
  /** What it noticed across their threads: a question settled elsewhere, two threads on the same work. */
  notes: z
    .array(z.object({ item: z.number().int().positive().optional(), text: Line(400) }))
    .max(10)
    .default([]),
  /** Rules worth adding, from their recent answers: one line each, in their language, with why. */
  rules: z
    .array(z.object({ line: Line(300), why: Line(300) }))
    .max(5)
    .default([]),
})
export type ChiefPassReport = z.infer<typeof ChiefPassReport>

/** Chief's operations, as its threads send them (its tools, through schedule calls). */
export const ChiefOperations = [
  /** In a pass: answer a question item in the person's name, by its answer's number. */
  z.object({
    name: z.literal('chief_answer'),
    item: z.number().int().positive(),
    option: z.number().int().positive().max(10),
    reason: Line(600),
    /** The person's rule that settles it, in their words. */
    rule: Line(300),
  }),
  /** In a pass: try a failed item's turn again. */
  z.object({
    name: z.literal('chief_retry'),
    item: z.number().int().positive(),
    reason: Line(300),
  }),
  /** In a pass, once, last: what is left to the person. */
  z.object({ name: z.literal('chief_report') }).merge(ChiefPassReport),
  /** In a thread with the person: their rules, whole, as they agreed to them. */
  z.object({ name: z.literal('chief_rules'), rules: z.string().max(CHIEF_RULES_MAX) }),
] as const

export type ChiefOperation = z.infer<(typeof ChiefOperations)[number]>
const CHIEF_OPERATIONS = new Set(['chief_answer', 'chief_retry', 'chief_report', 'chief_rules'])
export const isChiefOperation = (op: { name: string }): op is ChiefOperation =>
  CHIEF_OPERATIONS.has(op.name)

/** One of Chief's answers in a thread, as its view shows it beside the answer's note. */
export const ChiefDecisionView = z.object({
  id: z.string(),
  /** The question's card in the thread (its tool.started seq). */
  askSeq: z.number().int(),
  status: ChiefDecisionStatus,
  /** The answer it picked: what a click on it sends. */
  option: ChiefOption.nullable(),
  reason: z.string().nullable(),
  /** The person's rule it went by. */
  basis: z.string().nullable(),
  outcome: ChiefOutcome.nullable(),
  createdAt: z.string(),
})
export type ChiefDecisionView = z.infer<typeof ChiefDecisionView>

/** A thread a pass item is in, as Today links it. */
type PassThread = { id: string; title: string } | null

/** A member's pass, as Today shows it (GET /me/chief/pass). */
export type ChiefPassView = {
  id: string
  /** The member's day it ran for (YYYY-MM-DD, their timezone). */
  day: string
  /** running: Chief is at it. done: it reported. failed: it stopped before reporting. */
  status: 'running' | 'done' | 'failed'
  /** Chief's thread for it, to see how it worked. */
  threadId: string | null
  at: string
  /** What it settled in their name. */
  settled: {
    kind: 'answered' | 'retried'
    thread: PassThread
    /** The answer it gave, or what it tried again. */
    what: string
    reason: string
    rule: string | null
    /** An answer's: to mark it wrong, and where it stands (superseded: the person was first). */
    decisionId: string | null
    status: ChiefDecisionStatus | null
    outcome: ChiefOutcome | null
  }[]
  /** What is still theirs, with what Chief would do. */
  decisions: {
    kind: ChiefPassItem['kind']
    thread: PassThread
    what: string
    recommendation: string
    /** The answer it would pick, for a question still open: a click sends it as theirs. */
    option: ChiefOption | null
    /** The person's rule its pick goes by. */
    rule: string | null
    /** A question still open, or a thread still failed: Today may answer it, or try it again. */
    open: boolean
    /** Once the person answered a question Chief picked for: the same answer, or another. */
    answered: ChiefPickOutcome | null
  }[]
  notes: { thread: PassThread; text: string }[]
  rules: { line: string; why: string; state: 'proposed' | 'added' | 'refused' }[]
  /** Whether Chief acts on their rules (chief_acts), or only recommends. */
  acts: boolean
  /** How Chief's picks compare with the person's answers, over CHIEF_CALIBRATION_DAYS, by rule. */
  calibration: ChiefCalibration[]
}

/** The person's answer to a question Chief picked for: its pick, or another. */
export type ChiefPickOutcome = 'same' | 'otherwise'

/** Chief's picks the person answered lately: CHIEF_CALIBRATION_DAYS of passes. */
export const CHIEF_CALIBRATION_DAYS = 7

/** Chief's picks by one rule (none: by no rule), and how many the person answered the same way. */
export type ChiefCalibration = { rule: string | null; same: number; answered: number }
