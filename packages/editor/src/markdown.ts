// Documents are stored as Markdown, which teammates read and write. BlockNote's
// own conversion loses what Markdown has no syntax for: a video comes back as
// an image, a file as plain text, a mention as nothing. This wraps it with
// forms that survive the round trip and still read well as Markdown:
//
//   ![cat.png](asset:ck123 "A caption")      an image (caption optional)
//   [demo.mp4](asset:ck456 "video")          a video, audio or file block
//   [report.pdf](asset:ck789 "file: Q3")     ... with a caption
//   @[faq/support.md](document:ck012)        a mention, as messages write them
//   * [ ] Ship it <!-- item:k3f9q2… -->       a list item's marker (docs/lists.md)
//
//   * [ ] Fix the dialog                      a file under a list item (docs/lists.md): on a
//                                             row of its own after a blank one, indented as
//     ![shot.png](asset:ck321)                the item's text, so it stays the item's
//
// `asset:<id>` is a file uploaded to the document (GET /api/library/assets/:id).
import { formatMention, itemMarker, MENTION_KINDS, type Mention } from '@brigade/contracts'

/** What both editors offer: the dashboard's (sync) and the API's ServerBlockNoteEditor (async). */
export type MarkdownEditor = {
  blocksToMarkdownLossy(blocks: any[]): string | Promise<string>
  tryParseMarkdownToBlocks(markdown: string): any[] | Promise<any[]>
}

type Block = {
  id?: string
  type: string
  props?: Record<string, any>
  content?: any
  children?: Block[]
}

const MEDIA = new Set(['image', 'video', 'audio', 'file'])
const OPEN = ''
const CLOSE = ''
/** Between top-level blocks, to convert many at once and split them after. */
const SPLIT = ''
const TOKEN = /([mikn])(\d+)/g
/** A list item's file, at the end of its text until it goes on a row of its own under it. */
const FILE_TOKEN = /n(\d+)/g
/** Blocks whose media children are their files, written under their text. */
const LIST_ITEMS = new Set(['checkListItem', 'bulletListItem', 'numberedListItem'])
/** A list item's first row: its indent, its bullet, and the spaces before its text. */
const LIST_ROW = /^(\s*)([*+-]|\d+[.)])( +|$)/
const HEADING_ROW = /^ {0,3}#{1,6}(\s|$)/
const MEDIA_LINE = /^\s*(!?)\[([^\]\n]*)\]\(([^\s)]+)(?:\s+"([^"\n]*)")?\)\s*$/
const MENTION = new RegExp(`@\\[([^\\]\\n]+)\\]\\((${MENTION_KINDS.join('|')}):([^)\\s]+)\\)`, 'g')
/** A list item's marker, as `itemMarker` writes it. */
const ITEM = /<!--\s*item:([a-z0-9]+)\s*-->/g
const FENCE = /^\s*(`{3,}|~{3,})/

const width = (spaces: string) => spaces.replace(/\t/g, '    ').length
const indentOf = (row: string) => width(row.match(/^\s*/)![0])

/** Where a list item's text starts (CommonMark: past its bullet and the spaces after it), by its row. */
function textColumn(row: string) {
  const m = row.match(LIST_ROW)
  if (!m) return indentOf(row)
  const gap = m[3]!.length
  return width(m[1]!) + m[2]!.length + (gap === 0 || gap > 4 ? 1 : gap)
}

const text = (value: string) => ({ type: 'text', text: value, styles: {} })

function mediaMarkdown(block: Block) {
  const props = block.props ?? {}
  const url = String(props.url).replace(/\s/g, '%20').replace(/\)/g, '%29')
  const name =
    String(props.name || url.split(/[/:]/).pop() || block.type)
      .replace(/[[\]\n]/g, ' ')
      .trim() || block.type
  const caption = String(props.caption ?? '')
    .replace(/["\n]/g, ' ')
    .trim()
  if (block.type === 'image') return `![${name}](${url}${caption ? ` "${caption}"` : ''})`
  return `[${name}](${url} "${block.type}${caption ? `: ${caption}` : ''}")`
}

/** Inline content with mentions and list items' markers as tokens, for BlockNote's conversion. */
function tokenizeInline(content: any, mentions: string[], items: string[]): any {
  if (!Array.isArray(content)) return content
  return content.map((item) =>
    item.type === 'mention'
      ? text(`${OPEN}i${mentions.push(formatMention(item.props as Mention)) - 1}${CLOSE}`)
      : item.type === 'item'
        ? text(`${OPEN}k${items.push(itemMarker(String(item.props.id))) - 1}${CLOSE}`)
        : item.type === 'link'
          ? { ...item, content: tokenizeInline(item.content, mentions, items) }
          : item,
  )
}

function mapContent(content: any, inline: (c: any) => any) {
  if (content?.type !== 'tableContent') return inline(content)
  return {
    ...content,
    rows: content.rows.map((row: any) => ({
      ...row,
      cells: row.cells.map((cell: any) =>
        typeof cell === 'string'
          ? cell
          : Array.isArray(cell)
            ? inline(cell)
            : { ...cell, content: inline(cell.content) },
      ),
    })),
  }
}

/** A file block: media with its file, and nothing under it. */
const isFile = (block: Block) =>
  MEDIA.has(block.type) && !!block.props?.url && !block.children?.length

function tokenize(
  blocks: Block[],
  media: string[],
  mentions: string[],
  items: string[],
  files: string[],
): Block[] {
  return blocks.map((block) => {
    // A list item's files: tokens at the end of its text, put under it once converted (withFiles).
    const own =
      LIST_ITEMS.has(block.type) && Array.isArray(block.content)
        ? (block.children ?? []).filter(isFile)
        : []
    const children = tokenize(
      own.length ? block.children!.filter((c) => !own.includes(c)) : (block.children ?? []),
      media,
      mentions,
      items,
      files,
    )
    if (MEDIA.has(block.type) && block.props?.url)
      return {
        type: 'paragraph',
        content: [text(`${OPEN}m${media.push(mediaMarkdown(block)) - 1}${CLOSE}`)],
        children,
      }
    const { id: _id, ...rest } = block
    const content = mapContent(block.content, (c) => tokenizeInline(c, mentions, items))
    return {
      ...rest,
      content: own.length
        ? [
            ...content,
            text(own.map((f) => `${OPEN}n${files.push(mediaMarkdown(f)) - 1}${CLOSE}`).join('')),
          ]
        : content,
      children,
    }
  })
}

/**
 * Each list item's files on rows of their own under its text, after a blank row and indented as
 * its text, so that they stay the item's (docs/lists.md): BlockNote's own conversion would put
 * them after the list, as blocks of their own.
 */
function withFiles(markdown: string, files: string[]) {
  if (files.length === 0) return markdown
  const rows = markdown.split('\n')
  const out: string[] = []
  rows.forEach((row, i) => {
    const own = [...row.matchAll(FILE_TOKEN)].map((m) => files[+m[1]!]!)
    if (own.length === 0) return void out.push(row)
    // Indented as its text: its first row's, when its text goes on below it (a line break).
    let first = i
    while (first > 0 && !LIST_ROW.test(rows[first]!) && rows[first - 1]!.trim()) first--
    const indent = ' '.repeat(textColumn(LIST_ROW.test(rows[first]!) ? rows[first]! : row))
    out.push(row.replace(FILE_TOKEN, '').replace(/[ \t]+$/, ''))
    for (const file of own) out.push('', `${indent}${file}`)
    if (rows[i + 1]?.trim()) out.push('')
  })
  return out.join('\n')
}

/** The blocks as Markdown, media, mentions and list items' markers included. */
export async function blocksToMarkdown(editor: MarkdownEditor, blocks: Block[]) {
  const media: string[] = []
  const mentions: string[] = []
  const items: string[] = []
  const files: string[] = []
  const markdown = await editor.blocksToMarkdownLossy(
    tokenize(blocks, media, mentions, items, files),
  )
  return withFiles(markdown, files).replace(TOKEN, (_, kind: string, n: string) =>
    kind === 'm' ? media[+n]! : kind === 'k' ? items[+n]! : mentions[+n]!,
  )
}

/**
 * Each top-level block's Markdown, in two conversions rather than one per
 * block: to tell which blocks a new text really changes.
 */
export async function blockMarkdowns(editor: MarkdownEditor, blocks: Block[]) {
  if (blocks.length === 0) return []
  const separated = blocks.flatMap((block, i) =>
    i === 0 ? [block] : [{ type: 'paragraph', content: [text(SPLIT)] }, block],
  )
  const markdown = await blocksToMarkdown(editor, separated)
  const parts = markdown.split(new RegExp(`^${SPLIT}$`, 'm')).map((part) => part.trim())
  // A separator Markdown swallowed (inside a list, say): compare the blocks themselves.
  if (parts.length !== blocks.length)
    return blocks.map((block) =>
      JSON.stringify(block, (key, value) => (key === 'id' ? undefined : value)),
    )
  return parts
}

function mediaBlock(match: RegExpMatchArray): Block | undefined {
  const [, bang, name = '', url = '', title] = match
  if (bang) return { type: 'image', props: { url, name, caption: title ?? '' } }
  const kind = title?.match(/^(image|video|audio|file)(?::\s?([\s\S]*))?$/)
  if (!kind) return undefined
  return { type: kind[1]!, props: { url, name, caption: kind[2] ?? '' } }
}

type Found = { media: Block[]; mentions: any[]; items: any[]; files: Block[] }

/**
 * Inline content with its tokens back as mentions and list items (a stray media token, a link).
 * A list item's files go to `own`, to be put under it.
 */
function restoreInline(content: any, found: Found, own: Block[]): any {
  if (!Array.isArray(content)) return content
  const { media, mentions, items, files } = found
  return content.flatMap((item) => {
    if (item.type === 'link') return [{ ...item, content: restoreInline(item.content, found, own) }]
    if (item.type !== 'text' || !item.text.includes(OPEN)) return [item]
    const out: any[] = []
    let last = 0
    for (const m of item.text.matchAll(TOKEN) as IterableIterator<RegExpMatchArray>) {
      // The text before a file's token is the end of the item's: the space before it is not its.
      const before = item.text.slice(last, m.index)
      const kept = m[1] === 'n' ? before.replace(/\s+$/, '') : before
      if (kept) out.push({ ...item, text: kept })
      if (m[1] === 'i') out.push(mentions[+m[2]!])
      else if (m[1] === 'k') out.push(items[+m[2]!])
      else if (m[1] === 'n') own.push({ ...files[+m[2]!]! })
      else {
        const block = media[+m[2]!]!
        out.push({
          type: 'link',
          href: block.props!.url,
          content: [{ ...item, text: block.props!.name || block.props!.url }],
        })
      }
      last = m.index! + m[0].length
    }
    if (last < item.text.length) out.push({ ...item, text: item.text.slice(last) })
    return out
  })
}

function restore(blocks: Block[], found: Found): Block[] {
  return blocks.map((block) => {
    const children = restore(block.children ?? [], found)
    const only =
      Array.isArray(block.content) && block.content.length === 1 ? block.content[0] : null
    const token = only?.type === 'text' ? only.text.trim().match(/^m(\d+)$/) : null
    if (block.type === 'paragraph' && token)
      return { ...found.media[+token[1]!]!, id: block.id, children }
    // A list item's files come back under it, before the lines nested under it.
    const own: Block[] = []
    const content = mapContent(block.content, (c) => restoreInline(c, found, own))
    return { ...block, content, children: own.length ? [...own, ...children] : children }
  })
}

/** Markdown as blocks, media, mentions and list items included. Code blocks are left as written. */
export async function markdownToBlocks(editor: MarkdownEditor, markdown: string) {
  const found: Found = { media: [], mentions: [], items: [], files: [] }
  let fence: string | null = null
  // The list items the rows below may be under, deepest last: where each one's text starts, past
  // which a row is still its own, and the row its text ends on, where a file under it is noted.
  const under: { column: number; row: number }[] = []
  const leave = (indent: number) => {
    while (under.length && under.at(-1)!.column > indent) under.pop()
  }
  let blank = true
  const lines: string[] = []
  for (const line of markdown.split('\n')) {
    const f = line.match(FENCE)?.[1]
    if (f) {
      if (!fence) {
        leave(indentOf(line))
        fence = f
      } else if (f[0] === fence[0] && f.length >= fence.length) fence = null
      lines.push(line)
      blank = false
      continue
    }
    if (fence) {
      lines.push(line)
      continue
    }
    if (!line.trim()) {
      lines.push(line)
      blank = true
      continue
    }
    const indent = indentOf(line)
    const match = line.match(MEDIA_LINE)
    const block = match && mediaBlock(match)
    if (block) {
      leave(indent)
      const item = under.at(-1)
      // Indented under a list item: its file, kept under it (docs/lists.md).
      if (item) lines[item.row] += `${OPEN}n${found.files.push(block) - 1}${CLOSE}`
      // Else its own paragraph, so it becomes its own block.
      lines.push(item ? '' : `\n${OPEN}m${found.media.push(block) - 1}${CLOSE}\n`)
      blank = true
      continue
    }
    const list = LIST_ROW.test(line)
    if (HEADING_ROW.test(line)) under.length = 0
    else if (list || blank) leave(indent)
    // The text of the item above going on: its files go after it.
    else if (under.length) under.at(-1)!.row = lines.length
    if (list) under.push({ column: textColumn(line), row: lines.length })
    blank = false
    lines.push(
      line
        .replace(MENTION, (_, label: string, kind: string, id: string) => {
          const n = found.mentions.push({ type: 'mention', props: { kind, id, label } }) - 1
          return `${OPEN}i${n}${CLOSE}`
        })
        .replace(ITEM, (_, id: string) => {
          const n = found.items.push({ type: 'item', props: { id } }) - 1
          return `${OPEN}k${n}${CLOSE}`
        }),
    )
  }
  const blocks = await editor.tryParseMarkdownToBlocks(lines.join('\n'))
  return restore(blocks, found)
}

/** Ids of the uploaded files (`asset:<id>`) a Markdown text refers to. */
export const assetIds = (markdown: string) =>
  [...markdown.matchAll(/\basset:([A-Za-z0-9_-]{1,64})/g)].map((m) => m[1]!)
