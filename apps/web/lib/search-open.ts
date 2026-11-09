import { designFolderOf } from '@brigade/contracts'

/**
 * The library file a search row opens, if it is one: it opens in the file panel
 * (components/document-panel.tsx) on the page you are on, so it stays open as you go on,
 * whatever it is. A design's files open in the library, as the design. A Markdown file the
 * editor does not take (too big, as the API says) shows as a preview: `editable` false.
 */
export function libraryFile(row: { kind: string; key: string; title: string; editor?: boolean }) {
  if (row.kind !== 'file' || !row.key.startsWith('file:')) return undefined
  const path = row.title
  if (designFolderOf(path)) return undefined
  const markdown = /\.(md|markdown)$/i.test(path)
  return {
    id: row.key.slice('file:'.length),
    path,
    ...(markdown && row.editor !== undefined ? { editable: row.editor } : {}),
  }
}
