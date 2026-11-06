import { designFolderOf } from '@brigade/contracts'

/**
 * The Markdown file a search row opens, if it is one: it opens in the document panel on the
 * page you are on, so it stays open as you go on. Other files (images, PDFs, a design's files)
 * open in the library, in its own panel.
 */
export function markdownFile(row: { kind: string; key: string; title: string; editor?: boolean }) {
  if (row.kind !== 'file' || !row.key.startsWith('file:')) return undefined
  // Only when the API says the editor takes it: a Markdown file too big for it is previewed
  // in the library instead.
  if (row.editor !== true) return undefined
  const path = row.title
  if (!/\.(md|markdown)$/i.test(path) || designFolderOf(path)) return undefined
  return { id: row.key.slice('file:'.length), path }
}
