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
const TOKEN = /([mik])(\d+)/g
const MEDIA_LINE = /^\s*(!?)\[([^\]\n]*)\]\(([^\s)]+)(?:\s+"([^"\n]*)")?\)\s*$/
const MENTION = new RegExp(`@\\[([^\\]\\n]+)\\]\\((${MENTION_KINDS.join('|')}):([^)\\s]+)\\)`, 'g')
/** A list item's marker, as `itemMarker` writes it. */
const ITEM = /<!--\s*item:([a-z0-9]+)\s*-->/g
const FENCE = /^\s*(`{3,}|~{3,})/

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

function tokenize(blocks: Block[], media: string[], mentions: string[], items: string[]): Block[] {
  return blocks.map((block) => {
    const children = tokenize(block.children ?? [], media, mentions, items)
    if (MEDIA.has(block.type) && block.props?.url)
      return {
        type: 'paragraph',
        content: [text(`${OPEN}m${media.push(mediaMarkdown(block)) - 1}${CLOSE}`)],
        children,
      }
    const { id: _id, ...rest } = block
    return {
      ...rest,
      content: mapContent(block.content, (c) => tokenizeInline(c, mentions, items)),
      children,
    }
  })
}

/** The blocks as Markdown, media, mentions and list items' markers included. */
export async function blocksToMarkdown(editor: MarkdownEditor, blocks: Block[]) {
  const media: string[] = []
  const mentions: string[] = []
  const items: string[] = []
  const markdown = await editor.blocksToMarkdownLossy(tokenize(blocks, media, mentions, items))
  return markdown.replace(TOKEN, (_, kind: string, n: string) =>
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

/** Inline content with its tokens back as mentions and list items (a stray media token, a link). */
function restoreInline(content: any, media: Block[], mentions: any[], items: any[]): any {
  if (!Array.isArray(content)) return content
  return content.flatMap((item) => {
    if (item.type === 'link')
      return [{ ...item, content: restoreInline(item.content, media, mentions, items) }]
    if (item.type !== 'text' || !item.text.includes(OPEN)) return [item]
    const out: any[] = []
    let last = 0
    for (const m of item.text.matchAll(TOKEN) as IterableIterator<RegExpMatchArray>) {
      if (m.index! > last) out.push({ ...item, text: item.text.slice(last, m.index) })
      if (m[1] === 'i') out.push(mentions[+m[2]!])
      else if (m[1] === 'k') out.push(items[+m[2]!])
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

function restore(blocks: Block[], media: Block[], mentions: any[], items: any[]): Block[] {
  return blocks.map((block) => {
    const children = restore(block.children ?? [], media, mentions, items)
    const only =
      Array.isArray(block.content) && block.content.length === 1 ? block.content[0] : null
    const token = only?.type === 'text' ? only.text.trim().match(/^m(\d+)$/) : null
    if (block.type === 'paragraph' && token)
      return { ...media[+token[1]!]!, id: block.id, children }
    return {
      ...block,
      content: mapContent(block.content, (c) => restoreInline(c, media, mentions, items)),
      children,
    }
  })
}

/** Markdown as blocks, media, mentions and list items included. Code blocks are left as written. */
export async function markdownToBlocks(editor: MarkdownEditor, markdown: string) {
  const media: Block[] = []
  const mentions: any[] = []
  const items: any[] = []
  let fence: string | null = null
  const lines = markdown.split('\n').map((line) => {
    const f = line.match(FENCE)?.[1]
    if (f) {
      if (!fence) fence = f
      else if (f[0] === fence[0] && f.length >= fence.length) fence = null
      return line
    }
    if (fence) return line
    const match = line.match(MEDIA_LINE)
    const block = match && mediaBlock(match)
    // Its own paragraph, so it becomes its own block.
    if (block) return `\n${OPEN}m${media.push(block) - 1}${CLOSE}\n`
    return line
      .replace(MENTION, (_, label: string, kind: string, id: string) => {
        const n = mentions.push({ type: 'mention', props: { kind, id, label } }) - 1
        return `${OPEN}i${n}${CLOSE}`
      })
      .replace(ITEM, (_, id: string) => {
        const n = items.push({ type: 'item', props: { id } }) - 1
        return `${OPEN}k${n}${CLOSE}`
      })
  })
  const blocks = await editor.tryParseMarkdownToBlocks(lines.join('\n'))
  return restore(blocks, media, mentions, items)
}

/** Ids of the uploaded files (`asset:<id>`) a Markdown text refers to. */
export const assetIds = (markdown: string) =>
  [...markdown.matchAll(/\basset:([A-Za-z0-9_-]{1,64})/g)].map((m) => m[1]!)
