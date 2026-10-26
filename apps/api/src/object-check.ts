// What an upload holds, read back from the bucket as it streams: its size, SHA-256,
// real type (by its leading bytes) and text for search. The API never holds the file
// whole: a text file is decoded as it streams by, an Office file's text read from its
// XML parts as they unzip. A PDF's text needs the whole file, so a PDF uploaded straight
// to the bucket is kept and found by its name, not its text.
import { createHash } from 'node:crypto'
import { Unzip, UnzipInflate } from 'fflate'
import { openObject } from './bucket.js'
import { contentTypeFor, isText } from './library.js'
import { DOCX, PPTX, XLSX } from './previews.js'

/** Leading bytes of the types the dashboard shows inline: a file that claims one must be one. */
export const MAGIC: Record<string, (b: Uint8Array) => boolean> = {
  'application/pdf': (b) => ascii(b, 0, 5) === '%PDF-',
  'image/png': (b) => b[0] === 0x89 && ascii(b, 1, 4) === 'PNG',
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => ascii(b, 0, 4) === 'GIF8',
  'image/webp': (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
}
const ascii = (b: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...b.subarray(from, to))

/** The file's type from its name, checked against its leading bytes for types shown inline. */
export function detectType(name: string, head: Uint8Array, given?: string | null) {
  const type = contentTypeFor(name, given)
  const check = MAGIC[type]
  return check && !check(head) ? 'application/octet-stream' : type
}

/** Leading bytes kept, for the type. */
export const HEAD_BYTES = 1024
/** Text kept for search, as library.ts keeps (PostgreSQL's tsvector has a 1 MB limit). */
const INDEX_CHARS = 400_000

export type Inspected = {
  size: number
  sha256: string
  /** Its type, as its bytes bear it out. */
  contentType: string
  /** Its first bytes (up to HEAD_BYTES). */
  head: Uint8Array
  /** For search; '' unless asked for, or when it has none. */
  text: string
  /** The tag of the version read: copy it with copyObject's ifMatch to keep just these bytes. */
  etag: string
}

/**
 * Read an object back as it streams. `text` also reads its text for search: a text file's,
 * or an Office file's from its XML parts, as they come. Stops once more than `max` bytes
 * came. Null when it is not in the bucket.
 */
export async function inspectObject(
  key: string,
  file: { name: string; contentType?: string | null; text?: boolean; max?: number },
): Promise<Inspected | null> {
  const opened = await openObject(key)
  if (!opened) return null
  const stream = opened.body
  const given = contentTypeFor(file.name, file.contentType)
  const hash = createHash('sha256')
  const head = new Uint8Array(HEAD_BYTES)
  let size = 0
  const decoder = file.text && isText(given) ? new TextDecoder('utf-8', { fatal: true }) : null
  let text = ''
  let readable = true
  const office = file.text && [DOCX, XLSX, PPTX].includes(given) ? officeReader(given) : null
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    if (size < HEAD_BYTES) head.set(chunk.subarray(0, HEAD_BYTES - size), size)
    size += chunk.byteLength
    if (file.max !== undefined && size > file.max) {
      await stream.cancel().catch(() => undefined)
      break
    }
    hash.update(chunk)
    if (decoder && readable && text.length < INDEX_CHARS)
      try {
        text += decoder.decode(chunk, { stream: true })
      } catch {
        // Not UTF-8: kept, just not searchable.
        readable = false
        text = ''
      }
    office?.push(chunk)
  }
  const leading = head.subarray(0, Math.min(size, HEAD_BYTES))
  const contentType = detectType(file.name, leading, file.contentType)
  if (decoder && readable && text.length < INDEX_CHARS)
    try {
      text += decoder.decode()
    } catch {
      text = ''
    }
  if (office) text = contentType === given ? office.text() : ''
  return {
    size,
    sha256: hash.digest('hex'),
    contentType,
    head: leading,
    text: storable(text),
    etag: opened.etag,
  }
}

// PostgreSQL text cannot hold NUL.
const storable = (text: string) => text.replace(/\u0000/g, '').slice(0, INDEX_CHARS)

/** The XML parts of an Office file that hold its text. */
const OFFICE_PARTS: Record<string, RegExp> = {
  [DOCX]: /^word\/(document|footnotes|endnotes|header\d*|footer\d*)\.xml$/,
  [XLSX]: /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/,
  [PPTX]: /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/,
}
/** A run of text (`<w:t>`, `<a:t>`, `<t>`), and what ends a paragraph, a cell's string or a row. */
const RUN = /<(?:[wa]:)?t(?:\s[^>]*)?>([^<]*)<\/(?:[wa]:)?t>|<\/(?:[wa]:p|si|row)>/g
const ENTITY = /&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/**
 * An Office file's text as its zip streams by: only the parts that hold text are inflated,
 * and of each only its runs of text are kept, up to INDEX_CHARS. A damaged file gives ''.
 */
function officeReader(contentType: string) {
  const parts = OFFICE_PARTS[contentType]!
  let text = ''
  let failed = false
  const unzip = new Unzip((entry) => {
    if (!parts.test(entry.name) || failed) return
    const decoder = new TextDecoder()
    let pending = ''
    entry.ondata = (error, data, final) => {
      if (error) {
        failed = true
        return
      }
      if (text.length >= INDEX_CHARS) return
      pending += decoder.decode(data, { stream: !final })
      // What follows the last complete tag waits for the rest of it.
      const cut = final ? pending.length : pending.lastIndexOf('<')
      const ready = pending.slice(0, Math.max(cut, 0))
      pending = pending.slice(Math.max(cut, 0))
      // A run split across chunks: wait for its closing tag.
      const open = ready.search(/<(?:[wa]:)?t(?:\s[^>]*)?>[^<]*$/)
      const done = open >= 0 && !final ? ready.slice(0, open) : ready
      if (open >= 0 && !final) pending = ready.slice(open) + pending
      for (const m of done.matchAll(RUN)) text += m[1] !== undefined ? decode(m[1]) : '\n'
      if (pending.length > 1024 * 1024) pending = '' // One tag this long is not text.
    }
    entry.start()
  })
  unzip.register(UnzipInflate)
  return {
    push(chunk: Uint8Array) {
      if (failed) return
      try {
        unzip.push(chunk)
      } catch {
        failed = true
      }
    },
    text() {
      if (failed) return ''
      try {
        unzip.push(new Uint8Array(0), true)
      } catch {
        return ''
      }
      return failed ? '' : text.replace(/\n{3,}/g, '\n\n').trim()
    },
  }
}

const decode = (text: string) =>
  text.replace(ENTITY, (_, dec, hex, name) =>
    dec
      ? String.fromCodePoint(Number(dec))
      : hex
        ? String.fromCodePoint(parseInt(hex, 16))
        : NAMED[name.toLowerCase()]!,
  )
