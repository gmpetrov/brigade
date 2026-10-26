// What an upload holds, read back from the bucket as it streams: its size, SHA-256,
// real type (by its leading bytes) and text for search. The API never holds the file
// whole, but a PDF or Office file small enough for its text to be read.
import { createHash } from 'node:crypto'
import { streamObject } from './bucket.js'
import { contentTypeFor, extractText, isText } from './library.js'
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
/** A PDF or Office file up to this size is held whole a moment, for its text. Larger: no text. */
export const EXTRACT_MAX = 10 * 1024 * 1024
/** Text kept for search, as library.ts keeps (PostgreSQL's tsvector has a 1 MB limit). */
const INDEX_CHARS = 400_000

const extractable = (contentType: string) =>
  contentType === 'application/pdf' || [DOCX, XLSX, PPTX].includes(contentType)

export type Inspected = {
  size: number
  sha256: string
  /** Its type, as its bytes bear it out. */
  contentType: string
  /** Its first bytes (up to HEAD_BYTES). */
  head: Uint8Array
  /** For search; '' unless asked for, or when it has none. */
  text: string
}

/**
 * Read an object back as it streams. `text` also reads its text for search: a text file's
 * as it streams by, a PDF's or an Office file's whole when it is at most EXTRACT_MAX. Stops
 * once more than `max` bytes came. Null when it is not in the bucket.
 */
export async function inspectObject(
  key: string,
  file: { name: string; contentType?: string | null; text?: boolean; max?: number },
): Promise<Inspected | null> {
  const stream = await streamObject(key)
  if (!stream) return null
  const given = contentTypeFor(file.name, file.contentType)
  const hash = createHash('sha256')
  const head = new Uint8Array(HEAD_BYTES)
  let size = 0
  // A text file is decoded as it comes; a PDF's or an Office file's bytes are kept for its reader.
  const decoder = file.text && isText(given) ? new TextDecoder('utf-8', { fatal: true }) : null
  let text = ''
  let readable = true
  let whole: Uint8Array[] | null = file.text && extractable(given) ? [] : null
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
    if (whole) {
      if (size > EXTRACT_MAX) whole = null
      else whole.push(chunk)
    }
  }
  const leading = head.subarray(0, Math.min(size, HEAD_BYTES))
  const contentType = detectType(file.name, leading, file.contentType)
  if (decoder && readable && text.length < INDEX_CHARS)
    try {
      text += decoder.decode()
    } catch {
      text = ''
    }
  if (whole && contentType === given) text = await extractText(concat(whole, size), contentType)
  return {
    size,
    sha256: hash.digest('hex'),
    contentType,
    head: leading,
    text: decoder ? text.replace(/\u0000/g, '').slice(0, INDEX_CHARS) : text,
  }
}

const concat = (chunks: Uint8Array[], size: number) => {
  const all = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    all.set(chunk, at)
    at += chunk.byteLength
  }
  return all
}
