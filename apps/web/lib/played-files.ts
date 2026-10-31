// The library's videos and sounds a teammate's reply mentions, which play in the thread under
// the text that names them (components/markdown.tsx). Read from the block's syntax tree, as
// react-markdown hands it to a renderer.

/** A library file's mention, as a link once the markdown renderer made it one: `document:<id>`. */
const DOCUMENT_HREF = /^document:([^\s]+)$/

/** Library files that play in the thread, by their name: as the file panel plays them. */
export const VIDEO_FILE = /\.(mp4|m4v|webm|mov)$/i
export const AUDIO_FILE = /\.(mp3|m4a|wav|ogg)$/i

/** What react-markdown hands a renderer as its `node`, as far as players need it. */
export type HastNode = {
  type: string
  tagName?: string
  value?: string
  properties?: { href?: unknown }
  children?: HastNode[]
}
export type PlayedFile = { id: string; name: string; kind: 'video' | 'audio' }

const hastText = (node: HastNode): string =>
  node.type === 'text' ? (node.value ?? '') : (node.children ?? []).map(hastText).join('')

/**
 * The library's videos and sounds a block's own text mentions (not those of a paragraph or list
 * inside it, which play under their own), once each.
 */
export function playedFiles(node: HastNode | undefined): PlayedFile[] {
  const found = new Map<string, PlayedFile>()
  const visit = (n: HastNode) => {
    for (const child of n.children ?? []) {
      if (child.type !== 'element' || ['p', 'ul', 'ol', 'li'].includes(child.tagName!)) continue
      const href = child.tagName === 'a' ? child.properties?.href : undefined
      const id = typeof href === 'string' ? href.match(DOCUMENT_HREF)?.[1] : undefined
      if (!id) {
        visit(child)
        continue
      }
      const name = hastText(child)
      const kind = VIDEO_FILE.test(name) ? 'video' : AUDIO_FILE.test(name) ? 'audio' : undefined
      if (kind && !found.has(id)) found.set(id, { id, name, kind })
    }
  }
  if (node) visit(node)
  return [...found.values()]
}
