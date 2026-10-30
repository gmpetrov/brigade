// Lists (docs/lists.md): a library Markdown file's checklist lines, as items work is attached
// to. The file stays the list: its lines, their order, sections and notes, and whether each is
// ticked. A line work is attached to carries a marker at its end, `<!-- item:<id> -->`, hidden
// in the editor and in any Markdown viewer; Brigade keeps the rest (the threads on it, the pull
// requests that finish it) by that id. Lines nobody handed to a teammate have no marker.
import { z } from 'zod'

/** An item's id, in its marker. */
export const ListItemId = z.string().regex(/^[a-z0-9]{10,32}$/)

/** A new item's id: 16 characters of [a-z0-9]. */
export function newListItemId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('')
}

export const itemMarker = (id: string) => `<!-- item:${id} -->`
const MARKER = /\s*<!--\s*item:([a-z0-9]+)\s*-->/
const MARKERS = /\s*<!--\s*item:[a-z0-9]+\s*-->/g
/** A checklist line: indent, bullet, box, text. */
const CHECK = /^(\s*)([*+-]|\d+[.)])\s+\[( |x|X)\](?:\s+(.*))?$/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const FENCE = /^\s*(`{3,}|~{3,})/

export type ListLine = {
  /** Its line in the file, from 0. */
  line: number
  /** Spaces before its bullet: a deeper line is nested under the one above. */
  indent: number
  done: boolean
  /** Its text as written (Markdown), without box nor marker. */
  text: string
  /**
   * Its item's id: its marker's, unless a line above has the same marker (a line copied with
   * its marker is a new line, not the same item again).
   */
  id: string | null
  /** The id in its marker as written, a copy's included. */
  marker: string | null
  /** The heading it is under, as written. */
  section: string | null
}

export type ParsedList = {
  /** The file's first level-one heading. */
  title: string | null
  lines: ListLine[]
}

/** The checklist lines of a Markdown file, outside code blocks. */
export function parseList(markdown: string): ParsedList {
  const lines: ListLine[] = []
  let title: string | null = null
  let section: string | null = null
  let fence: string | null = null
  const seen = new Set<string>()
  markdown.split('\n').forEach((raw, line) => {
    const open = raw.match(FENCE)
    if (open) {
      if (!fence) fence = open[1]!
      else if (open[1]!.startsWith(fence[0]!) && open[1]!.length >= fence.length) fence = null
      return
    }
    if (fence) return
    const heading = raw.match(HEADING)
    if (heading) {
      const text = heading[2]!.replace(/\\(.)/g, '$1')
      if (heading[1] === '#' && title === null) title = text
      else section = text
      return
    }
    const check = raw.match(CHECK)
    if (!check) return
    const rest = check[4] ?? ''
    const marker = rest.match(MARKER)?.[1] ?? null
    const copy = !!marker && seen.has(marker)
    if (marker) seen.add(marker)
    lines.push({
      line,
      indent: check[1]!.replace(/\t/g, '    ').length,
      done: check[3] !== ' ',
      text: rest.replace(MARKERS, '').trim(),
      id: copy ? null : marker,
      marker,
      section,
    })
  })
  return { title, lines }
}

/** An item's text without its Markdown: for a chip, a thread's card, a teammate's prompt. */
export function plainItemText(text: string) {
  return text
    .replace(MARKERS, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/@\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .replace(/\\(.)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** For matching a line a teammate names by its text: case, spaces and Markdown aside. */
const normal = (text: string) =>
  plainItemText(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/** Whether two texts are the same line's, case, spaces and Markdown aside. */
export const sameItemText = (a: string, b: string) => normal(a) === normal(b)

/**
 * The line `ref` names: its id, or its text (the whole of it, or its start when only one line
 * starts so). A string when none or several match, saying so.
 */
export function findLine(list: ParsedList, ref: string): ListLine | string {
  const byId = list.lines.find((l) => l.id === ref)
  if (byId) return byId
  const want = normal(ref)
  if (!want) return 'Name a line by its id or its text'
  const whole = list.lines.filter((l) => normal(l.text) === want)
  if (whole.length === 1) return whole[0]!
  const start = whole.length ? whole : list.lines.filter((l) => normal(l.text).startsWith(want))
  if (start.length === 1) return start[0]!
  if (start.length === 0) return `No checklist line matches "${ref}"`
  return `${start.length} checklist lines match "${ref}": give more of its text, or its id`
}

/** The file with `edit` applied to one line. */
function withLine(markdown: string, line: number, edit: (raw: string) => string) {
  const rows = markdown.split('\n')
  rows[line] = edit(rows[line]!)
  return rows.join('\n')
}

/** The line given a marker, unless it has one. */
export function markLine(markdown: string, line: ListLine, id: string) {
  if (line.id) return markdown
  return setMarker(markdown, line, id)
}

/** The line's marker set to `id`: added, or put in place of the one it has (a copy's). */
export function setMarker(markdown: string, line: ListLine, id: string) {
  if (line.marker === id && line.id === id) return markdown
  return withLine(
    markdown,
    line.line,
    (raw) => `${raw.replace(MARKERS, '').replace(/\s+$/, '')} ${itemMarker(id)}`,
  )
}

/** The line ticked or unticked, with a short note after its text when given (e.g. "PR #12, 29 Oct"). */
export function setLineDone(markdown: string, line: ListLine, done: boolean, note?: string) {
  return withLine(markdown, line.line, (raw) => {
    let next = raw.replace(/\[( |x|X)\]/, done ? '[x]' : '[ ]')
    const clean = note
      ?.replace(/[*_`\n]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (clean) {
      const marker = next.match(MARKER)
      const head = marker
        ? next.slice(0, marker.index).replace(/\s+$/, '')
        : next.replace(/\s+$/, '')
      next = `${head} *${clean}*${marker ? ` ${marker[0].trim()}` : ''}`
    }
    return next
  })
}

/**
 * The file with a new line after `after` (nested under it with `nested`, else beside it, after
 * the lines nested under it), or at the end of the section `section`, or at the end of the file.
 */
export function insertLine(
  markdown: string,
  list: ParsedList,
  at: { after?: ListLine; nested?: boolean; section?: string },
  text: string,
  id: string,
) {
  const rows = markdown.split('\n')
  const clean = text.replace(/\s*\n\s*/g, ' ').trim()
  let index = rows.length
  let indent = 0
  if (at.after) {
    const after = at.after
    indent = after.indent + (at.nested ? 2 : 0)
    // After the lines nested under it (and the text continuing it), unless going under it first.
    index = after.line + 1
    if (!at.nested) {
      const nextSibling = list.lines.find((l) => l.line > after.line && l.indent <= after.indent)
      const lastNested = [...list.lines]
        .filter((l) => l.line > after.line && (!nextSibling || l.line < nextSibling.line))
        .pop()
      if (lastNested) index = lastNested.line + 1
    }
  } else if (at.section) {
    const want = normal(at.section)
    const start = rows.findIndex((r) => {
      const h = r.match(HEADING)
      return h && normal(h[2]!) === want
    })
    if (start >= 0) {
      const end = rows.findIndex((r, i) => i > start && HEADING.test(r))
      const inSection = list.lines.filter((l) => l.line > start && (end < 0 || l.line < end))
      const last = inSection.at(-1)
      index = last ? last.line + 1 : start + 1
      if (!last) rows.splice(index++, 0, '')
    }
  }
  // Keep a list's lines together: no blank line between the new one and those above.
  while (!at.after && !at.section && index > 0 && rows[index - 1]!.trim() === '') index--
  const line = `${' '.repeat(indent)}* [ ] ${clean} ${itemMarker(id)}`
  rows.splice(index, 0, line)
  return rows.join('\n')
}

/** Counts of a list's lines, ticked and not. */
export function listCounts(list: ParsedList) {
  const done = list.lines.filter((l) => l.done).length
  return { done, total: list.lines.length }
}

// ---- What the dashboard reads -----------------------------------------------------------------

/** A thread working on an item, as a line's chip shows it. */
export const ListThread = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  stuck: z.boolean(),
  teammate: z.object({ id: z.string(), name: z.string() }),
})
export type ListThread = z.infer<typeof ListThread>

export const ListPull = z.object({
  repository: z.string(),
  number: z.number(),
  state: z.string(),
  closes: z.boolean(),
  url: z.string(),
})
export type ListPull = z.infer<typeof ListPull>

/** Where an item stands, from its threads: one of them waits on a person, or works. */
export const ItemState = z.enum(['done', 'needs_you', 'in_progress', 'open'])
export type ItemState = z.infer<typeof ItemState>

export const ListItemView = z.object({
  id: z.string(),
  text: z.string(),
  done: z.boolean(),
  state: ItemState,
  /** Gone from its file (the line deleted, or its marker): its threads still name it. */
  missing: z.boolean(),
  section: z.string().nullable(),
  doneBy: z.object({ name: z.string(), at: z.string() }).nullable(),
  threads: z.array(ListThread),
  pulls: z.array(ListPull),
})
export type ListItemView = z.infer<typeof ListItemView>

export const ListSummary = z.object({
  documentId: z.string(),
  path: z.string(),
  title: z.string(),
  /** The project whose folder holds the file; null: none does. */
  projectId: z.string().nullable(),
  done: z.number(),
  total: z.number(),
  needsYou: z.number(),
  inProgress: z.number(),
  updatedAt: z.string(),
  /** The items waiting on a person, then those in progress: a few, for the list's card. */
  next: z.array(z.object({ id: z.string(), text: z.string(), state: ItemState })),
})
export type ListSummary = z.infer<typeof ListSummary>

export const ListDetail = ListSummary.omit({ next: true, projectId: true }).extend({
  /** The items work is attached to, in the file's order, then those gone from it. */
  items: z.array(ListItemView),
})
export type ListDetail = z.infer<typeof ListDetail>

/** A thread's items, for the card at its top. */
export const ThreadListItems = z.array(
  ListItemView.extend({ documentId: z.string(), path: z.string(), listTitle: z.string() }),
)
export type ThreadListItems = z.infer<typeof ThreadListItems>

/** Lines picked in the editor: the id each was given there, and its text. */
const PickedLines = z
  .array(z.object({ id: ListItemId, text: z.string().trim().min(1).max(2_000) }))
  .min(1)
  .max(50)

/** Hand lines to a teammate: in one thread together, or a thread each. */
export const HandOffItems = z.object({
  teammateId: z.string(),
  items: PickedLines,
  mode: z.enum(['together', 'each']).default('together'),
  /** What the person adds to the first message. */
  note: z.string().trim().max(4_000).optional(),
})
export type HandOffItems = z.infer<typeof HandOffItems>

/** Attach lines to a thread that runs already. */
export const LinkItems = z.object({ sessionId: z.string(), items: PickedLines })
export type LinkItems = z.infer<typeof LinkItems>

export const SetItemDone = z.object({ done: z.boolean() })

// ---- What a teammate does with them (schedule.call operations) --------------------------------

const Path = z.string().trim().min(1).max(1_000)
const Ref = z.string().trim().min(1).max(2_000)

export const ListOperations = [
  z.object({ name: z.literal('list_items'), path: Path.optional() }),
  z.object({ name: z.literal('link_items'), path: Path, items: z.array(Ref).min(1).max(50) }),
  z.object({
    name: z.literal('complete_item'),
    item: Ref,
    path: Path.optional(),
    note: z.string().trim().max(200).optional(),
  }),
  z.object({
    name: z.literal('add_item'),
    path: Path,
    text: z.string().trim().min(1).max(2_000),
    after: Ref.optional(),
    nested: z.boolean().optional(),
    section: z.string().trim().max(500).optional(),
  }),
] as const

export const LIST_OPERATIONS = ['list_items', 'link_items', 'complete_item', 'add_item'] as const
