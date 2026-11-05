// A project's decisions (docs/projects.md, Decisions): its specs, notes and designs, each with a
// status. A spec says it on its third line, after its title and a blank line:
//
//   # Later threads
//
//   Spec, 2026-10-19. Status: shipped (#241). Decided with the member.
//
// A design says it in its design.json (`status`, `pullRequests`). Brigade reads both to show the
// project's Decisions, and a merged pull request that ships one marks it shipped (src/decisions.ts
// in the API). The words are always English, whatever language the document is in.
import { z } from 'zod'

/** The six words a decision's status may be, and nothing else. */
export const DECISION_STATUSES = [
  'draft',
  'accepted',
  'shipped',
  'paused',
  'dropped',
  'superseded',
] as const
export const DecisionStatus = z.enum(DECISION_STATUSES)
export type DecisionStatus = z.infer<typeof DecisionStatus>

/** Where a project keeps its decisions and designs, under its folder, once it has folders. */
export const DECISIONS_FOLDER = 'decisions'
export const DESIGNS_FOLDER = 'designs'

/** A status line read: `<Kind>, <YYYY-MM-DD>. Status: <word><rest>`. */
export type StatusLine = {
  /** What it is: Spec, Note, Proposal… as written. */
  kind: string
  date: string
  status: DecisionStatus
  /** What follows the word, as written: the pull requests, the reference, why. */
  rest: string
  /** Its line in the text, from 0. */
  line: number
}

const STATUS_LINE = new RegExp(
  `^([A-Za-z][\\w -]{0,39}), (\\d{4}-\\d{2}-\\d{2})\\. Status: (${DECISION_STATUSES.join('|')})\\b(.*)$`,
)
/** Lines read for the title and the status line: blank lines around them are allowed. */
const STATUS_LINE_WITHIN = 12

/**
 * A document's status line, or null when it has none Brigade can read. It is the first line
 * with text after the title (the first line with text, a heading): a line further down, such as
 * an example in a code block, is not one.
 */
export function parseStatusLine(text: string): StatusLine | null {
  const lines = text.split('\n', STATUS_LINE_WITHIN).map((l) => l.replace(/\r$/, '').trim())
  const next = (from: number) => {
    let i = from
    while (i < lines.length && !lines[i]) i++
    return i
  }
  const title = next(0)
  if (!/^#{1,6}\s+\S/.test(lines[title] ?? '')) return null
  const line = next(title + 1)
  const m = STATUS_LINE.exec(lines[line] ?? '')
  if (!m) return null
  return {
    kind: m[1]!.trim(),
    date: m[2]!,
    status: m[3] as DecisionStatus,
    rest: m[4]!,
    line,
  }
}

/** A Markdown document's title: its first heading, else null. */
export function markdownTitle(text: string) {
  const first = text.split('\n', STATUS_LINE_WITHIN).find((l) => /^#\s+\S/.test(l))
  return first ? first.replace(/^#\s+/, '').trim() : null
}

/** The pull request numbers a status line names (`#241`), in order, once each. */
export function pullNumbersIn(rest: string) {
  return [...new Set([...rest.matchAll(/(?<![\w/])#(\d{1,7})\b/g)].map((m) => Number(m[1])))]
}

/**
 * Whether a shipped spec's line says where the truth now lives: a path in backticks or a link
 * (`docs/lists.md`, `apps/api/playbooks/README.md`, `../reference/offer.md`).
 */
export function namesReference(rest: string) {
  return /`[^`\s]*[/.][^`\s]*`/.test(rest) || /\]\([^)\s]+\)/.test(rest)
}

/**
 * The status line with a pull request added after the word, and the word set to `shipped` when
 * it ships the document: `Status: accepted. Decided…` → `Status: shipped (#300). Decided…`; a
 * parenthesis already there gets the number first: `shipped (#241)` → `shipped (#300, #241)`.
 * Unchanged when the line names that pull request already, and shipping a shipped one only adds
 * the number. Null when the text has no status line.
 */
export function withPullOnStatusLine(text: string, number: number, ships: boolean) {
  const found = parseStatusLine(text)
  if (!found) return null
  const lines = text.split('\n')
  if (pullNumbersIn(found.rest).includes(number) && (!ships || found.status === 'shipped'))
    return text
  const status = ships ? 'shipped' : found.status
  const named = pullNumbersIn(found.rest).includes(number)
  const rest = named
    ? found.rest
    : /^ \(/.test(found.rest)
      ? found.rest.replace(/^ \(/, ` (#${number}, `)
      : ` (#${number})${found.rest}`
  const original = lines[found.line]!
  const indent = /^\s*/.exec(original)![0]
  const cr = original.endsWith('\r') ? '\r' : ''
  lines[found.line] = `${indent}${found.kind}, ${found.date}. Status: ${status}${rest}${cr}`
  return lines.join('\n')
}

/** What a design's design.json says of its status, read leniently: a bad value is none. */
export const DesignStatus = z.object({
  status: DecisionStatus.optional().catch(undefined),
  pullRequests: z.array(z.number().int().positive()).max(100).optional().catch(undefined),
})

/** A design.json's title and status, from its text; what cannot be read is left out. */
export function readDesignStatus(json: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    // Not JSON (written by hand and broken): no status Brigade can trust. A field found by
    // searching the text could be a board's, not the design's.
    return { title: null, status: null, pullRequests: [] as number[] }
  }
  const object = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  const read = DesignStatus.safeParse(object)
  return {
    title: typeof object.title === 'string' ? object.title : null,
    status: (read.success ? read.data.status : undefined) ?? null,
    pullRequests: (read.success ? read.data.pullRequests : undefined) ?? [],
  }
}

/**
 * A design.json with a pull request added to its `pullRequests`, and `status` set to `shipped`
 * when it ships the design. Its other keys are kept as they were. Null when it is not a JSON
 * object; unchanged when nothing changes.
 */
export function withPullInDesign(json: string, number: number, ships: boolean) {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const object = parsed as Record<string, unknown>
  const pulls = Array.isArray(object.pullRequests)
    ? object.pullRequests.filter((n): n is number => typeof n === 'number')
    : []
  const has = pulls.includes(number)
  if (has && (!ships || object.status === 'shipped')) return json
  const next = {
    ...object,
    ...(ships ? { status: 'shipped' } : {}),
    pullRequests: has ? pulls : [...pulls, number],
  }
  return `${JSON.stringify(next, null, 2)}\n`
}

/** What a pull request says of the library's specs and designs (github_create_pull_request's `specs`). */
export const PullSpecs = z.object({
  /** Library paths of the specs and designs it ships: each is marked shipped once it is merged. */
  ships: z.array(z.string().max(1024)).max(20).optional(),
  /** Those it is only part of: it is named on them once merged, their status unchanged. */
  partOf: z.array(z.string().max(1024)).max(20).optional(),
})
export type PullSpecs = z.infer<typeof PullSpecs>

/** What may be off with a decision, shown beside it. */
export const DecisionFlag = z.enum([
  /** A file under decisions/ (or a design under designs/) with no status Brigade can read. */
  'no_status',
  /** Still draft or accepted, though a pull request it was linked to is merged. */
  'merged_not_shipped',
  /** Shipped, and its line names no reference. */
  'no_reference',
])
export type DecisionFlag = z.infer<typeof DecisionFlag>

/** One of a project's decisions, as the dashboard shows it. */
export const DecisionView = z.object({
  /** The library file it is read from: the Markdown file, or the design's design.json. */
  documentId: z.string(),
  /** The library path: the Markdown file, or the design's folder. */
  path: z.string(),
  type: z.enum(['spec', 'design']),
  title: z.string(),
  /** Spec, Note, Proposal… as its line says; null for a design or no status line. */
  kind: z.string().nullable(),
  date: z.string().nullable(),
  status: DecisionStatus.nullable(),
  /** What its line says after the word; empty for a design. */
  detail: z.string(),
  pullRequests: z.array(z.number()),
  flags: z.array(DecisionFlag),
  updatedAt: z.string(),
})
export type DecisionView = z.infer<typeof DecisionView>
