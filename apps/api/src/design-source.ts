// A design page's HTML as the canvas edits it. The elements a person wrote in
// <body> are numbered in document order; the sandbox host marks each with its
// number (`data-bid`) when it serves the page, and an edit names elements by
// that number. Both read the same bytes through `elementsOf`, so the numbers
// match; an edit is made by splicing the original text, so everything else in
// the file stays as the teammate wrote it.
import { parse, type DefaultTreeAdapterTypes } from 'parse5'
import type { DesignEditOp } from '@brigade/contracts'

type Node = DefaultTreeAdapterTypes.Node
type Element = DefaultTreeAdapterTypes.Element
type Span = { startOffset: number; endOffset: number }

export type SourceElement = {
  id: number
  tag: string
  line: number
  node: Element
  startTag: Span
  /** Absent when the parser closed it (an implied `</p>`, `</li>`) or it is void. */
  endTag?: Span
  attrs: Record<string, Span>
}

/** Elements selected whole: their children are not numbered. */
const WHOLE = new Set(['svg', 'math'])
/** Elements that show nothing a person edits: neither they nor their children are numbered. */
const SKIPPED = new Set(['template', 'script', 'style', 'noscript'])

const isElement = (node: Node): node is Element => 'tagName' in node

/** FNV-1a over UTF-16 code units, base 36: the bridge computes the same in the page. */
export function fingerprint(text: string) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

/** An element's own text nodes, whitespace collapsed: what its fingerprint is of. */
export const ownText = (node: Element) =>
  node.childNodes
    .map((c) => (c.nodeName === '#text' ? (c as DefaultTreeAdapterTypes.TextNode).value : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()

function bodyOf(html: string) {
  const document = parse(html, { sourceCodeLocationInfo: true })
  const root = document.childNodes.find((n) => isElement(n) && n.tagName === 'html') as
    Element | undefined
  return root?.childNodes.find((n) => isElement(n) && n.tagName === 'body') as Element | undefined
}

/** The elements written in a page's `<body>`, numbered in document order. */
export function elementsOf(html: string): SourceElement[] {
  const body = bodyOf(html)
  const found: SourceElement[] = []
  const seen = new Set<number>()
  const walk = (parent: Element) => {
    for (const node of parent.childNodes) {
      if (!isElement(node) || SKIPPED.has(node.tagName)) continue
      const at = node.sourceCodeLocation
      // Implied by the parser (a <tbody>), or rebuilt across misnested tags (a second <b>).
      const written = at?.startTag && !seen.has(at.startTag.startOffset)
      if (written) {
        seen.add(at.startTag!.startOffset)
        found.push({
          id: found.length,
          tag: node.tagName,
          line: at.startLine,
          node,
          startTag: at.startTag!,
          ...(at.endTag ? { endTag: at.endTag } : {}),
          attrs: at.attrs ?? {},
        })
      }
      if (!WHOLE.has(node.tagName)) walk(node)
    }
  }
  if (body) walk(body)
  return found
}

/** Where a new attribute goes: right after the tag's name as written. */
const afterName = (html: string, element: SourceElement) =>
  element.startTag.startOffset +
  (/^<[^\s/>]+/.exec(html.slice(element.startTag.startOffset))?.[0].length ?? 0)

type Splice = { start: number; end: number; text: string }

function applySplices(html: string, splices: Splice[]) {
  let out = html
  // From the end, so earlier offsets still hold; at one offset, the longer splice first.
  for (const s of [...splices].sort((a, b) => b.start - a.start || b.end - a.end))
    out = out.slice(0, s.start) + s.text + out.slice(s.end)
  return out
}

/** The page with each element of `<body>` marked with its number, line and text fingerprint. */
export function annotate(html: string) {
  return applySplices(
    html,
    elementsOf(html).map((e) => {
      const at = afterName(html, e)
      return {
        start: at,
        end: at,
        text: ` data-bid="${e.id}:${e.line}:${fingerprint(ownText(e.node))}"`,
      }
    }),
  )
}

/** A change the page cannot take, said to the person. */
export class EditError extends Error {}

const escapeAttr = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const escapeText = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A `style` attribute's declarations, in order. Splits on `;` outside quotes and brackets. */
export function readStyle(style: string) {
  const declarations = new Map<string, string>()
  let depth = 0
  let quote = ''
  let current = ''
  const flush = () => {
    const colon = current.indexOf(':')
    if (colon > 0) {
      const name = current.slice(0, colon).trim()
      const value = current.slice(colon + 1).trim()
      if (name && value) declarations.set(name.startsWith('--') ? name : name.toLowerCase(), value)
    }
    current = ''
  }
  for (const char of style) {
    if (quote) {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if (char === '(') depth++
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if (char === ';' && depth === 0) {
      flush()
      continue
    }
    current += char
  }
  flush()
  return declarations
}

const writeStyle = (declarations: Map<string, string>) =>
  [...declarations].map(([name, value]) => `${name}: ${value}`).join('; ')

/** Whether an element's text can be retyped: one piece of text between its own tags. */
export function retypable(html: string, element: SourceElement) {
  if (!element.endTag) return false
  if (element.node.childNodes.some(isElement)) return false
  const inner = html.slice(element.startTag.endOffset, element.endTag.startOffset)
  return !/<[a-zA-Z/!?]/.test(inner)
}

/** The page with the changes made, each a splice of the original text. */
export function applyEdits(html: string, ops: DesignEditOp[]) {
  const elements = elementsOf(html)
  // Per element: its declarations and attributes as they end up, and its text.
  type Change = { style?: Map<string, string>; attrs: Map<string, string | null>; text?: string }
  const changes = new Map<number, Change>()
  for (const op of ops) {
    const element = elements[op.id]
    if (!element) throw new EditError(`The page has no element ${op.id}: reload it and try again`)
    const change: Change = changes.get(op.id) ?? { attrs: new Map() }
    changes.set(op.id, change)
    if ('style' in op) {
      change.style ??= readStyle(element.node.attrs.find((a) => a.name === 'style')?.value ?? '')
      for (const [name, value] of Object.entries(op.style))
        if (value === null || value.trim() === '') change.style.delete(name)
        else change.style.set(name, value.trim())
    } else if ('text' in op) {
      if (!retypable(html, element))
        throw new EditError('Retype one piece of text at a time: this element holds other elements')
      change.text = op.text
    } else {
      for (const [name, value] of Object.entries(op.attrs)) change.attrs.set(name, value ?? null)
    }
  }

  const splices: Splice[] = []
  for (const [id, change] of changes) {
    const element = elements[id]!
    const attrs = new Map(change.attrs)
    if (change.style) {
      const style = writeStyle(change.style)
      attrs.set('style', style || null)
    }
    let added = ''
    for (const [name, value] of attrs) {
      const at = element.attrs[name]
      if (at) {
        // Replace it where it is, or take it out with the space before it.
        let start = at.startOffset
        if (value === null) while (start > 0 && /\s/.test(html[start - 1]!)) start--
        splices.push({
          start,
          end: at.endOffset,
          text: value === null ? '' : `${name}="${escapeAttr(value)}"`,
        })
      } else if (value !== null) added += ` ${name}="${escapeAttr(value)}"`
    }
    if (added) {
      const at = afterName(html, element)
      splices.push({ start: at, end: at, text: added })
    }
    if (change.text !== undefined)
      splices.push({
        start: element.startTag.endOffset,
        end: element.endTag!.startOffset,
        text: escapeText(change.text),
      })
  }
  return applySplices(html, splices)
}
