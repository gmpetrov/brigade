// Office files read on the API, for previews in the dashboard and text for
// search: a Word document as HTML (shown in a frame that runs no script), a
// spreadsheet's first rows, a deck's slides as text. Read from the zip with
// fflate; sizes are checked before anything is inflated.
import type { LibraryPreview } from '@brigade/contracts'
import { unzipSync, type Unzipped } from 'fflate'

export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
export const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

/** Inflated size the reader takes per part of the zip, and in all. */
const PART_MAX = 20 * 1024 * 1024
const TOTAL_MAX = 60 * 1024 * 1024
const ROWS = 200
const COLUMNS = 30
const SHEETS = 20
const SLIDES = 200
/** HTML of a Word document the preview sends; embedded images make it large. */
const HTML_MAX = 8 * 1024 * 1024

/** The parts of a zip whose names pass `want`, refusing ones that inflate too large. */
function unzip(bytes: Uint8Array, want: (name: string) => boolean): Unzipped {
  let total = 0
  return unzipSync(bytes, {
    filter: (file) => {
      if (!want(file.name)) return false
      if (file.originalSize > PART_MAX || (total += file.originalSize) > TOTAL_MAX)
        throw new Error('The file is too large to preview')
      return true
    },
  })
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) =>
    name[0] === '#'
      ? String.fromCodePoint(
          name[1] === 'x' || name[1] === 'X'
            ? parseInt(name.slice(2), 16)
            : parseInt(name.slice(1), 10),
        )
      : (ENTITIES[name] ?? whole),
  )
const xml = (part: Uint8Array | undefined) => (part ? new TextDecoder().decode(part) : '')
/** The text of every `<tag>` (e.g. "t" or "a:t") in a piece of XML, joined. */
const texts = (source: string, tag: string) =>
  [...source.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g'))]
    .map((m) => decode(m[1]!))
    .join('')
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]

/** Relationship id to target, from a .rels part. */
function relations(source: string) {
  const out = new Map<string, string>()
  for (const [tag] of source.matchAll(/<Relationship\s[^>]*>/g)) {
    const id = attr(tag, 'Id')
    const target = attr(tag, 'Target')
    if (id && target) out.set(id, target)
  }
  return out
}

/** "ppt/slides/slide1.xml" from a target relative to the folder of the part that names it. */
const resolve = (folder: string, target: string) =>
  target.startsWith('/') ? target.slice(1) : `${folder}/${target}`.replace(/[^/]+\/\.\.\//g, '')

// ---------------------------------------------------------------------------
// Spreadsheets
// ---------------------------------------------------------------------------

const columnIndex = (ref: string) => {
  let n = 0
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

type Sheet = Extract<LibraryPreview, { kind: 'sheets' }>['sheets'][number]

function readSheets(bytes: Uint8Array, rowsMax = ROWS): Sheet[] {
  const zip = unzip(
    bytes,
    (n) => (n.startsWith('xl/') && n.endsWith('.xml')) || n.endsWith('.rels'),
  )
  const strings = [...xml(zip['xl/sharedStrings.xml']).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    texts(m[1]!, 't'),
  )
  const rels = relations(xml(zip['xl/_rels/workbook.xml.rels']))
  const sheets: Sheet[] = []
  for (const [tag] of xml(zip['xl/workbook.xml']).matchAll(/<sheet\s[^>]*>/g)) {
    if (sheets.length >= SHEETS) break
    const target = rels.get(attr(tag, 'r:id') ?? '')
    const part = target ? xml(zip[resolve('xl', target)]) : ''
    const rows: string[][] = []
    let truncated = false
    for (const row of part.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      // Rows keep their place: empty ones in between are not in the file.
      const at = Number(attr(row[1]!, 'r') ?? rows.length + 1) - 1
      while (rows.length < Math.min(at, rowsMax)) rows.push([])
      if (rows.length >= rowsMax) {
        truncated = true
        break
      }
      const cells: string[] = []
      for (const cell of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const head = cell[1]!
        const at = columnIndex(attr(head, 'r') ?? '')
        const column = at >= 0 ? at : cells.length
        if (column >= COLUMNS) {
          truncated = true
          continue
        }
        const body = cell[2] ?? ''
        const type = attr(head, 't')
        const value = decode(body.match(/<v>([^<]*)<\/v>/)?.[1] ?? '')
        const text =
          type === 's'
            ? (strings[Number(value)] ?? '')
            : type === 'inlineStr'
              ? texts(body, 't')
              : type === 'b'
                ? value === '1'
                  ? 'TRUE'
                  : 'FALSE'
                : value
        while (cells.length < column) cells.push('')
        cells[column] = text
      }
      rows.push(cells)
    }
    sheets.push({
      name: decode(attr(tag, 'name') ?? `Sheet ${sheets.length + 1}`),
      rows,
      truncated,
    })
  }
  return sheets
}

// ---------------------------------------------------------------------------
// Decks
// ---------------------------------------------------------------------------

type Slide = Extract<LibraryPreview, { kind: 'slides' }>['slides'][number]

function readSlides(bytes: Uint8Array): Slide[] {
  const zip = unzip(
    bytes,
    (n) => n.startsWith('ppt/') && (n.endsWith('.xml') || n.endsWith('.rels')),
  )
  const rels = relations(xml(zip['ppt/_rels/presentation.xml.rels']))
  // In the deck's order; by number if the deck does not say.
  let parts = [...xml(zip['ppt/presentation.xml']).matchAll(/<p:sldId\s[^>]*>/g)]
    .map(([tag]) => rels.get(attr(tag, 'r:id') ?? ''))
    .filter((t): t is string => Boolean(t))
    .map((t) => resolve('ppt', t))
  if (parts.length === 0)
    parts = Object.keys(zip)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
  return parts.slice(0, SLIDES).map((name) => {
    const source = xml(zip[name])
    let title = ''
    const lines: string[] = []
    for (const shape of source.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)) {
      const isTitle = /<p:ph[^>]*type="(?:title|ctrTitle)"/.test(shape[1]!)
      const paragraphs = [...shape[1]!.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
        .map((p) => texts(p[1]!, 'a:t').trim())
        .filter(Boolean)
      if (isTitle && !title) title = paragraphs.join(' ')
      else lines.push(...paragraphs)
    }
    if (!title && lines.length > 0) title = lines.shift()!
    return { title, lines }
  })
}

// ---------------------------------------------------------------------------

/** A preview of an office file, or why there is none. */
export async function libraryPreview(
  bytes: Uint8Array,
  contentType: string,
): Promise<LibraryPreview> {
  try {
    if (contentType === DOCX) {
      const mammoth = await import('mammoth')
      const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) })
      if (value.length > HTML_MAX)
        return { kind: 'none', reason: 'The document is too large to preview' }
      return { kind: 'html', html: value }
    }
    if (contentType === XLSX) return { kind: 'sheets', sheets: readSheets(bytes) }
    if (contentType === PPTX) return { kind: 'slides', slides: readSlides(bytes) }
  } catch (error) {
    return { kind: 'none', reason: error instanceof Error ? error.message : 'It could not be read' }
  }
  return { kind: 'none', reason: 'No preview for this kind of file' }
}

/** The text of an office file, for search; '' for anything else. */
export async function officeText(bytes: Uint8Array, contentType: string) {
  if (contentType === DOCX) {
    const mammoth = await import('mammoth')
    return (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value
  }
  if (contentType === XLSX)
    return readSheets(bytes, 5_000)
      .map((s) => `${s.name}\n${s.rows.map((r) => r.join('\t')).join('\n')}`)
      .join('\n\n')
  if (contentType === PPTX)
    return readSlides(bytes)
      .map((s) => [s.title, ...s.lines].join('\n'))
      .join('\n\n')
  return ''
}
