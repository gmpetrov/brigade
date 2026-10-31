// Lists (docs/lists.md): a library Markdown file's checklist lines, as items work is attached
// to. The file stays the list: its lines, their order, sections and notes, and whether each is
// ticked. A line work is attached to carries a marker at its end, `<!-- item:<id> -->`, hidden
// in the editor and in any Markdown viewer; Brigade keeps the rest (the threads on it, the pull
// requests that finish it) by that id. Lines nobody handed to a teammate have no marker.
import { z } from 'zod'
import { formatMention } from './mentions.js'

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
/** Any list line, a checkbox or not: it starts a block of its own, never continues a line above. */
const BULLET = /^\s*([*+-]|\d+[.)])(\s|$)/
/**
 * Rows that start a block of their own and so end a line's text above them (CommonMark): a quote,
 * a thematic break, HTML. A row holding only a marker is not one: the editor writes a marker there
 * when a line break was typed before it, and reads it back as the line's.
 */
const BLOCK = /^ {0,3}(>|([-*_])( *\2){2,} *$|<(\/?[a-zA-Z]|!--))/
const MARKER_ROW = /^\s*<!--\s*item:[a-z0-9]+\s*-->\s*\\?\s*$/
/** A hard line break at the end of a line (a backslash, or two spaces): its text goes on below. */
const BREAK = /(\\| {2,})$/

export type ListLine = {
  /** Its line in the file, from 0: the one with its box. */
  line: number
  /**
   * Its last line in the file: past `line` when its text goes on below it (a line break typed in
   * it), where its marker may then be.
   */
  end: number
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
  const rows = markdown.split('\n')
  // The checklist line whose text the next row may go on with: until a blank row or a new block.
  let open: { item: ListLine; parts: string[] } | null = null
  const close = () => {
    if (!open) return
    const { item, parts } = open
    const all = parts.join(' ')
    // Its marker, wherever in its text: a line break typed before it moves it to a row below.
    const marker = all.match(MARKER)?.[1] ?? null
    const copy = !!marker && seen.has(marker)
    if (marker) seen.add(marker)
    item.marker = marker
    item.id = copy ? null : marker
    item.text = parts
      .map((p) => p.replace(MARKERS, '').replace(BREAK, '').trim())
      .filter(Boolean)
      .join(' ')
    open = null
  }
  rows.forEach((raw, line) => {
    const fenced = raw.match(FENCE)
    if (fenced) {
      close()
      if (!fence) fence = fenced[1]!
      else if (fenced[1]!.startsWith(fence[0]!) && fenced[1]!.length >= fence.length) fence = null
      return
    }
    if (fence) return
    const heading = raw.match(HEADING)
    if (heading) {
      close()
      const text = heading[2]!.replace(/\\(.)/g, '$1')
      if (heading[1] === '#' && title === null) title = text
      else section = text
      return
    }
    const check = raw.match(CHECK)
    if (!check) {
      // Its text going on (a paragraph's next row), unless a blank row or another block ends it.
      if (open && raw.trim() && !BULLET.test(raw) && (MARKER_ROW.test(raw) || !BLOCK.test(raw))) {
        open.parts.push(raw.trim())
        open.item.end = line
      } else close()
      return
    }
    close()
    const item: ListLine = {
      line,
      end: line,
      indent: check[1]!.replace(/\t/g, '    ').length,
      done: check[3] !== ' ',
      text: '',
      id: null,
      marker: null,
      section,
    }
    lines.push(item)
    open = { item, parts: [check[4] ?? ''] }
  })
  close()
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

/**
 * The line's marker set to `id`: put in place of the one it has (a copy's), on whichever of its
 * rows that is, else added at the end of its first row.
 */
export function setMarker(markdown: string, line: ListLine, id: string) {
  if (line.marker === id && line.id === id) return markdown
  const rows = markdown.split('\n')
  for (let row = line.line; row <= line.end; row++)
    if (MARKER.test(rows[row]!)) {
      rows[row] = rows[row]!.replace(MARKER, ` ${itemMarker(id)}`)
      return rows.join('\n')
    }
  return withLine(markdown, line.line, (raw) => {
    const { head, brk } = splitBreak(raw, line.end > line.line)
    return `${head} ${itemMarker(id)}${brk}`
  })
}

/** A line's first row without the line break that ends it when its text goes on below, and that break. */
function splitBreak(raw: string, goesOn: boolean) {
  const brk = goesOn ? raw.match(/(\s*\\| {2,})$/) : null
  const head = (brk ? raw.slice(0, brk.index) : raw).replace(/\s+$/, '')
  return { head, brk: brk ? (brk[1]!.includes('\\') ? ' \\' : '  ') : '' }
}

/** A link in a note: italics around it come back from the editor broken, a little more each save. */
const LINKISH = /(https?:\/\/|www\.|\]\()/i

/**
 * The line ticked or unticked, with a short note after its text when given (e.g. "PR #12, 29
 * Oct"), in italics unless it holds a link. On its first row, before its marker and any line
 * break there.
 */
export function setLineDone(markdown: string, line: ListLine, done: boolean, note?: string) {
  return withLine(markdown, line.line, (raw) => {
    let next = raw.replace(/\[( |x|X)\]/, done ? '[x]' : '[ ]')
    const clean = note
      ?.replace(/[*_`\n]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (clean) {
      const marker = next.match(MARKER)
      const { head, brk } = splitBreak(
        marker ? next.replace(MARKER, '') : next,
        line.end > line.line,
      )
      const text = LINKISH.test(clean) ? `— ${clean}` : `*${clean}*`
      next = `${head} ${text}${marker ? ` ${marker[0].trim()}` : ''}${brk}`
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
    index = after.end + 1
    if (!at.nested) {
      const nextSibling = list.lines.find((l) => l.line > after.line && l.indent <= after.indent)
      const lastNested = [...list.lines]
        .filter((l) => l.line > after.line && (!nextSibling || l.line < nextSibling.line))
        .pop()
      if (lastNested) index = lastNested.end + 1
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
      index = last ? last.end + 1 : start + 1
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
  /** Only part of the item: what remains of it once this one is merged. */
  remains: z.string().nullable(),
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
  /**
   * Still open though nothing works on it: its threads stopped (none works or waits on a person),
   * no pull request on it is open, and no line of what remains of it is open. Someone should
   * tick it, or say what remains.
   */
  stalled: z.boolean(),
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

/**
 * Attach lines to a thread that runs already. `quiet`: its teammate is not told by a note, as the
 * person sends the hand-off as a message of theirs right after (handOffMessage); else the note
 * carries what the person adds (`note`).
 */
export const LinkItems = z.object({
  sessionId: z.string(),
  items: PickedLines,
  quiet: z.boolean().optional(),
  note: z.string().trim().max(4_000).optional(),
})
export type LinkItems = z.infer<typeof LinkItems>

/**
 * The message that hands lines to a teammate, in a new thread or one that runs already: the
 * person's note, or a request naming the list, then the lines.
 */
export function handOffMessage(
  file: { id: string; path: string },
  texts: string[],
  note?: string | null,
) {
  const mention = formatMention({ kind: 'document', id: file.id, label: file.path })
  return [
    note?.trim() ||
      (texts.length > 1
        ? `Please take these items of ${mention}:`
        : `Please take this item of ${mention}:`),
    texts.map((t) => `- ${plainItemText(t)}`).join('\n'),
  ].join('\n\n')
}

const HAND_OFF =
  /^Please take (?:this item|these items) of @\[([^\]]*)\]\(document:([^)\s]+)\):\n\n((?:- .*(?:\n|$))+)$/

/**
 * A hand-off message as handOffMessage writes it with no note of the person's: the list's file
 * and the lines, so people see what was handed over rather than the request it is worded as.
 * Null for any other message, one with a note included: the person wrote that.
 */
export function handOffParts(
  text: string,
): { file: { id: string; path: string }; items: string[] } | null {
  const m = HAND_OFF.exec(text.trim())
  if (!m) return null
  return {
    file: { id: m[2]!, path: m[1]! },
    items: m[3]!
      .trim()
      .split('\n')
      .map((line) => line.slice(2)),
  }
}

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
    /** What shows it is done: a teammate never ticks a line without saying so. */
    note: z
      .string({
        error: 'Say in the note what shows it is done, e.g. "Sitemap read by Google, 31 Oct"',
      })
      .trim()
      .min(1, 'Say in the note what shows it is done, e.g. "Sitemap read by Google, 31 Oct"')
      .max(200),
  }),
  z.object({
    name: z.literal('add_item'),
    path: Path,
    text: z.string().trim().min(1).max(2_000),
    after: Ref.optional(),
    nested: z.boolean().optional(),
    section: z.string().trim().max(500).optional(),
    /** The item this line is what remains of: nested under it, which is ticked once all are. */
    remainsOf: Ref.optional(),
  }),
] as const

export const LIST_OPERATIONS = ['list_items', 'link_items', 'complete_item', 'add_item'] as const
