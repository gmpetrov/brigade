// Images and PDFs a teammate's tools return (a screenshot it read, a page it captured,
// a PDF it read) arrive in its events as base64, hundreds of kB each: most of what the
// database held, sent again to every page that opens the thread. Each goes to the bucket
// once, and the stored event keeps its name in its place (STORED_FILE), which the
// dashboard shows from there.
import { createHash } from 'node:crypto'
import { STORED_FILE } from '@brigade/contracts'
import { putObject, threadFileKey } from './bucket.js'
import type { Scope } from './db.js'

/** Shorter strings stay in the event: a small icon is not worth a trip to the bucket. */
const MIN_LENGTH = 4096

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const DATA_URL = /^data:(?:image\/[\w.+-]+|application\/pdf);base64,/

/** The types kept apart, by their leading bytes. SVG is not one: it is text, and can run script. */
const KINDS = [
  {
    ext: 'png',
    type: 'image/png',
    is: (b: Uint8Array) => b[0] === 0x89 && ascii(b, 1, 4) === 'PNG',
  },
  {
    ext: 'jpg',
    type: 'image/jpeg',
    is: (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  { ext: 'gif', type: 'image/gif', is: (b: Uint8Array) => ascii(b, 0, 4) === 'GIF8' },
  {
    ext: 'webp',
    type: 'image/webp',
    is: (b: Uint8Array) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
  },
  { ext: 'pdf', type: 'application/pdf', is: (b: Uint8Array) => ascii(b, 0, 5) === '%PDF-' },
]
const ascii = (b: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...b.subarray(from, to))

type File = { name: string; type: string; bytes: Uint8Array }

/** The image or PDF a string holds whole, in base64 or as a data: URL; undefined for anything else. */
export function fileIn(text: string): File | undefined {
  if (text.length < MIN_LENGTH) return undefined
  const base64 = DATA_URL.test(text) ? text.slice(text.indexOf(',') + 1) : text
  // Its first bytes first: most long strings are not files, and need not be decoded.
  const head = Buffer.from(base64.slice(0, 16), 'base64')
  const kind = KINDS.find((k) => k.is(head))
  if (!kind || !BASE64.test(base64)) return undefined
  const bytes = Buffer.from(base64, 'base64')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return { name: `${sha256}.${kind.ext}`, type: kind.type, bytes }
}

/**
 * The value with each file in it replaced by STORED_FILE and the file's name, the
 * files put in the thread's folder in the bucket first. The value as it was when none
 * is in it, or when the bucket refuses one: an event is stored whole rather than lose
 * its file.
 */
export async function keepFilesApart<T>(
  scope: Scope,
  sessionId: string,
  value: T,
  put: typeof putObject = putObject,
): Promise<T> {
  const files = new Map<string, File>()
  const replaced = replaceFiles(value, files)
  if (!files.size) return value
  try {
    // The same file twice in a thread (a tool's result and the harness's copy of it) is one object.
    await Promise.all(
      [...files.values()].map((file) =>
        put(threadFileKey(scope, sessionId, file.name), file.bytes, file.type),
      ),
    )
  } catch (error) {
    console.error(`thread ${sessionId}: could not keep its files apart, storing them inline`, error)
    return value
  }
  return replaced as T
}

function replaceFiles(value: unknown, files: Map<string, File>): unknown {
  if (typeof value === 'string') {
    const file = fileIn(value)
    if (!file) return value
    files.set(file.name, file)
    return `${STORED_FILE}${file.name}`
  }
  if (Array.isArray(value)) return value.map((v) => replaceFiles(v, files))
  if (isPlain(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, replaceFiles(v, files)]),
    )
  return value
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
