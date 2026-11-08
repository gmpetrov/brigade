import type { LibraryFile } from '@brigade/contracts'

// How the file panel (components/document-panel.tsx) shows a library file. It opens a file from
// wherever it was named, often knowing only its id and path (a mention, a thread, search, tabs
// kept from before), so what it is comes from the API (GET /library/:id) once that answers;
// until then from what the opener knew, and a Markdown file by its name, so a document opens
// in the editor at once, as it always has.

/**
 * `editor`: the live document editor (Markdown, small enough). `text`: another text file, read
 * and edited as text. `preview`: anything else, as the library previews it (an image, a PDF, an
 * Office file, a Markdown file too big to edit). `loading`: not known yet. `missing`: no longer
 * in the library.
 */
export type FileView = 'editor' | 'text' | 'preview' | 'loading' | 'missing'

/** What the opener knew about the file, if anything. */
export type FileHint = { contentType?: string; editable?: boolean }

export const isMarkdownName = (name: string) => /\.(md|markdown)$/i.test(name)

/**
 * `file`: the file as the API gave it, null once it said there is none, undefined while it has
 * not answered (or could not: then what the opener knew is all there is).
 */
export function fileView(
  name: string,
  hint: FileHint,
  file: Pick<LibraryFile, 'contentType' | 'editable'> | null | undefined,
): FileView {
  if (file === null) return 'missing'
  const contentType = file?.contentType ?? hint.contentType
  const editable = file?.editable ?? hint.editable
  const markdown = contentType ? contentType === 'text/markdown' : isMarkdownName(name)
  if (markdown) return editable === false ? 'preview' : 'editor'
  if (!contentType) return 'loading'
  return editable ? 'text' : 'preview'
}

/** Whether a file shown so has a Download button: those not edited live as a document. */
export const downloadable = (view: FileView) => view === 'text' || view === 'preview'
