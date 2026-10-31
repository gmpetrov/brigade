// Tidying a memory file, so it stays useful as it grows: a short harness run,
// on the account of a thread that went quiet, lays the file out again: the core
// within its budget, the rest in topics, lines that say the same thing merged,
// and lines a newer one replaced or that are outdated sent to the archive
// (search still finds them, and people can put them back). Runs beside the
// thread, never in its queue.
import {
  coreLength,
  layOutMemoryFile,
  MEMORY_CORE_BUDGET,
  MEMORY_TIDY_AT,
  MemoryLayout,
  memoryLineCount,
  memoryLineKey,
  parseMemoryFile,
  tidyTakesTooMuch,
  type MemoryFileRef,
  type MemoryLineMeta,
  type MemoryScope,
} from '@brigade/contracts'
import { z } from 'zod'
import { memoryDay, numberedMemory } from './memory-layers.js'

/** A memory file a tidy run may lay out, as the runner sees it. */
export type TidyFile = {
  ref: MemoryFileRef
  scope: MemoryScope
  /** What the file is, said to the run. */
  about: string
  text: string
  /** Its lines' dates, by key. */
  meta: Record<string, MemoryLineMeta>
  /** Lines newer than `meta`: dated today. */
  fresh: Set<string>
  /** When it was last tidied, as the manifest says. */
  lastTidied: string | null
}

/** A file never tidied is laid out into topics once it has this many lines. */
const FIRST_TIDY_LINES = 30
/** A tidied file is looked at again after this, when lines changed since. */
const RETIDY_MS = 7 * 24 * 3600_000
/** Not twice in this long, whatever the file looks like: a run that could not fix it waits. */
const TIDY_GAP_MS = 6 * 3600_000

/** What the file is brought under when it is too long, so the next memory run does not tidy it again. */
const TIDY_TARGET = Math.round(MEMORY_TIDY_AT * 0.9)

/**
 * A reason as people read it in the archive, where line numbers mean nothing:
 * "replaced by line 158" names the line's text instead.
 */
export function inWords(reason: string | undefined, lines: string[]) {
  const quote = (n: string) => {
    const text = lines[Number(n) - 1]
    return text ? `“${text.length > 80 ? `${text.slice(0, 79).trimEnd()}…` : text}”` : n
  }
  return (reason ?? '')
    .trim()
    .replace(/\blines?\s+(\d+(?:\s*(?:,|and|&)\s*\d+)*)/gi, (_, numbers: string) =>
      numbers
        .split(/\s*(?:,|and|&)\s*/i)
        .map(quote)
        .join(' and '),
    )
    .slice(0, 200)
}

/** Lines named by number, or by their text when a run writes that instead. */
export const LineRef = z.union([z.number().int(), z.string()])
/** A memory file as a run read it: each line's text and the day shown after it, by number less one. */
export type ReadLines = { lines: string[]; notes: string[] }

/**
 * The line a run names, by its number or its text: its text as the file has it, which is
 * how the API finds it. A text is the line's own, or the line as the run read it, with
 * its day after it; a line's own text wins, so a day in a line's text is never a guess.
 */
export function lineAt(file: ReadLines, ref: number | string): string | null {
  if (typeof ref === 'number') return file.lines[ref - 1] ?? null
  const key = memoryLineKey(ref)
  const own = file.lines.find((l) => memoryLineKey(l) === key)
  if (own !== undefined) return own
  const read = file.lines.findIndex((l, i) => memoryLineKey(`${l}${file.notes[i] ?? ''}`) === key)
  return read >= 0 ? file.lines[read]! : ref.trim() || null
}

/**
 * A line a run wrote in place of `from` (a line's text), without the day the run
 * read after `from` when it copied it onto the end: that day is memory's, not the line's,
 * and would show twice. A day `from` had in its own text is the line's, and stays.
 */
export function withoutCopiedDay(text: string, file: ReadLines, from: string) {
  const i = file.lines.indexOf(from)
  const day = i >= 0 ? file.notes[i]!.trim() : ''
  if (!day || from.endsWith(day) || !text.endsWith(day)) return text
  return text.slice(0, -day.length).trimEnd()
}
/** A list that keeps the items it can read and drops the others. */
export const lenientList = <T extends z.ZodTypeAny>(item: T) =>
  z
    .array(z.unknown())
    .catch([])
    .default([])
    .transform((items) =>
      items.flatMap((i) => {
        const parsed = item.safeParse(i)
        return parsed.success ? [parsed.data as z.infer<T>] : []
      }),
    )

/**
 * Whether a file needs tidying: its core past its budget, the file past
 * MEMORY_TIDY_AT, never tidied with enough lines to sort, or not tidied for a
 * week while lines changed. Never twice within TIDY_GAP_MS.
 */
export function needsTidy(file: TidyFile, now: Date) {
  const last = file.lastTidied ? Date.parse(file.lastTidied) : NaN
  if (!Number.isNaN(last) && now.getTime() - last < TIDY_GAP_MS) return false
  const layers = parseMemoryFile(file.text)
  const count = memoryLineCount(file.text)
  if (count === 0) return false
  if (coreLength(layers) > MEMORY_CORE_BUDGET[file.scope]) return true
  if (file.text.length > MEMORY_TIDY_AT) return true
  if (Number.isNaN(last)) return count >= FIRST_TIDY_LINES
  return (
    now.getTime() - last > RETIDY_MS &&
    (file.fresh.size > 0 || Object.values(file.meta).some((m) => Date.parse(m.at) > last))
  )
}

const Answer = z.object({
  core: lenientList(LineRef),
  topics: lenientList(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      lines: lenientList(LineRef),
    }),
  ),
  merge: lenientList(
    z.object({
      lines: lenientList(LineRef),
      text: z.string(),
      topic: z.string().nullable().optional(),
    }),
  ),
  archive: lenientList(
    z.union([LineRef, z.object({ line: LineRef, reason: z.string().optional() })]),
  ),
})

/** The tidy run for one file: its prompt, and how to read its answer as a layout. */
export function tidyRun(file: TidyFile, now = new Date()) {
  const numbered = numberedMemory(file.text, file.meta, now, file.fresh)
  const budget = MEMORY_CORE_BUDGET[file.scope]
  const over = file.text.length > MEMORY_TIDY_AT
  const prompt = [
    `You tidy one memory file of a team that works with AI teammates: ${file.about}. It has a core, which every thread loads, and topics, which a thread reads when its work touches them. Below is the file: each line is numbered and, when memory knows it, ends with the day it was learned or last confirmed ("before" a day: older than dates in memory; "by" a name: a person wrote it). A line with no day is older than the dated ones; among those, a line further down is newer. Today is ${memoryDay(now.toISOString(), now)} ${now.getUTCFullYear()}.`,
    'Reply with only one JSON object and nothing else, in this shape:',
    '{"core": [1, 4], "topics": [{"name": "Sidebar", "description": "What the sidebar shows and how it behaves", "lines": [12, 13]}], "merge": [{"lines": [40, 41], "text": "…", "topic": "Sidebar"}], "archive": [{"line": 33, "reason": "…"}]}',
    [
      `- core: the lines nearly every thread needs before it starts: how the team wants work done, decisions that hold everywhere, pitfalls that can do harm (a live account, production data). At most ${budget.toLocaleString('en')} characters in all, merged lines put in the core included (the core has ${numbered.coreChars.toLocaleString('en')} now); everything else goes in topics.${file.scope === 'workspace' ? ' Every thread of every project loads this core: a line about one product, app or client rather than the workspace as a whole goes in a topic named after it.' : ''}`,
      '- topics: the other lines, grouped by what a thread would be working on when it needs them: a part of the product, a tool, a provider, a kind of task. Short names, each with a one-line description of when to read it; about 3 to 15 topics, none of a single line unless nothing else fits. Keep an existing topic and its name when it still fits.',
      '- merge: lines that each say part of the same thing, said once in a line that holds today, under a topic (null: the core); or a single line said again in the words of today (a feature renamed since). List those lines only in the merge, not in a topic too.',
      '- archive: lines that leave the file, each with a reason of a few words: a newer line replaced or contradicted it (say which in words), it is outdated (a plan since shipped, a "for now" or "until" whose time has passed, a feature since removed, a bug of a version long replaced), or another line already says all of it. A line about something still there stays, even if it is being phased out. When two lines disagree about the same case, the newer one wins; lines about different cases both stay. A line a person wrote outranks one a teammate learned, and goes only when a newer line replaces it. Never archive a line only because it is old, long or rarely useful: archived lines leave every thread.',
      over &&
        `- The whole file is past ${MEMORY_TIDY_AT.toLocaleString('en')} characters: beyond the rules above, also archive the lines least likely to matter again until it is under ${TIDY_TARGET.toLocaleString('en')} (search still finds them).`,
      '- Every line goes in exactly one place: the core, one topic, one merge, or the archive.',
    ]
      .filter(Boolean)
      .join('\n'),
    `The file:\n<<<\n${numbered.text}\n>>>`,
  ].join('\n\n')

  /** The run's answer as a layout, or null when it is not the JSON asked for or would take too much away. */
  const parse = (text: string): MemoryLayout | null => {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    let json: unknown
    try {
      json = JSON.parse(text.slice(start, end + 1))
    } catch {
      return null
    }
    const parsed = Answer.safeParse(json)
    if (!parsed.success) return null
    const answer = parsed.data
    const line = (ref: number | string) => lineAt(numbered, ref)
    const lines = (refs: (number | string)[]) =>
      refs.flatMap((r) => {
        const text = line(r)
        return text ? [text] : []
      })
    const layout = MemoryLayout.safeParse({
      core: lines(answer.core).slice(0, 400),
      topics: answer.topics
        .filter((t) => t.name.trim())
        .slice(0, 30)
        .map((t) => ({
          name: t.name.trim().slice(0, 60),
          description: (t.description ?? '').trim().slice(0, 200),
          lines: lines(t.lines).slice(0, 400),
        })),
      merge: answer.merge
        .map((m) => {
          const from = lines(m.lines).slice(0, 20)
          const text = from.reduce(
            (t, f) => withoutCopiedDay(t, numbered, f),
            m.text.trim().replace(/\s*\n\s*/g, ' '),
          )
          return { from, text: text.slice(0, 1000), topic: m.topic?.trim().slice(0, 60) || null }
        })
        .filter((m) => m.from.length >= 1 && m.text)
        .slice(0, 100),
      archive: answer.archive
        .flatMap((a) => {
          const text = line(typeof a === 'object' ? a.line : a)
          const reason = typeof a === 'object' ? a.reason : undefined
          return text ? [{ text, reason: inWords(reason, numbered.lines) || 'Tidied away' }] : []
        })
        .slice(0, 400),
    })
    if (!layout.success) return null
    // A run that would take most of the file away is not trusted with it.
    if (tidyTakesTooMuch(file.text, layOutMemoryFile(file.text, layout.data).text)) return null
    return layout.data
  }

  return { prompt, parse }
}
