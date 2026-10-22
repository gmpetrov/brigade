// The images a teammate's reply shows (`![…](/tmp/shot.png)`, a link to one), read
// when the reply is done and put in the thread's bucket folder, straight to R2 through
// a signed URL (the API's /runner/files): the thread shows them after the file has gone
// (/tmp, a folder cleaned up) or while the computer is off. The reply's event names
// each by its stored file (message.images). Read as the teammate's user on a cloud
// computer: what it can read itself, nothing more.
import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { IMAGE_VIEW_MAX, STORED_FILE } from '@brigade/contracts'
import { readStart, real } from './files.js'

/** A link target in Markdown, `](path)` or `](<path with spaces>)`, with an optional title. */
const TARGET = /\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g
const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i
/** More than a reply needs; each is read whole, up to IMAGE_VIEW_MAX. */
const MAX_IMAGES = 10

/** The type of an image by its leading bytes; SVG is not one (it can run script). */
const TYPES: { ext: string; type: string; is: (b: Buffer) => boolean }[] = [
  {
    ext: 'png',
    type: 'image/png',
    is: (b) => b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG',
  },
  { ext: 'jpg', type: 'image/jpeg', is: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', type: 'image/gif', is: (b) => b.toString('latin1', 0, 4) === 'GIF8' },
  {
    ext: 'webp',
    type: 'image/webp',
    is: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  },
]

/**
 * A link target as the dashboard reads it (`relativeFile` in file-links.tsx, with no
 * base): undefined for an address, an anchor or anything but an image.
 */
export function imagePath(href: string) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('//'))
    return undefined
  let path: string
  try {
    path = decodeURI(href.split('#')[0]!.split('?')[0]!)
  } catch {
    return undefined
  }
  path = path.replace(/^\.\//, '')
  return path && IMAGE_FILE.test(path) ? path : undefined
}

/** A reference definition, `[name]: path` on a line of its own, for `![alt][name]`. */
const DEFINITION = /^ {0,3}\[[^\]\n]+\]:[ \t]*(?:<([^>\n]+)>|(\S+))/gm

/** The image files a reply names, each once, in order, at most MAX_IMAGES. */
export function imagesIn(text: string) {
  const paths = new Set<string>()
  const targets = [...text.matchAll(TARGET), ...text.matchAll(DEFINITION)]
    .sort((a, b) => a.index - b.index)
    .map((m) => m[1] ?? m[2]!)
  for (const target of targets) {
    const path = imagePath(target)
    if (path) paths.add(path)
    if (paths.size >= MAX_IMAGES) break
  }
  return [...paths]
}

/** Put an image in the thread's bucket folder under `name` (`<sha256>.<ext>`). */
export type StoreImage = (
  sessionId: string,
  name: string,
  bytes: Buffer,
  type: string,
) => Promise<void>

/**
 * StoreImage through the API's /runner/files: a signed URL to PUT the image to R2,
 * or the API itself without R2 (development).
 */
export function imageStore(api: { apiUrl: string; token: string }): StoreImage {
  return async (sessionId, name, bytes, type) => {
    const file = new URL(
      `/runner/files/${encodeURIComponent(sessionId)}/${encodeURIComponent(name)}`,
      api.apiUrl,
    )
    const auth = { authorization: `Bearer ${api.token}` }
    const ticket = await fetch(`${file}/upload`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ size: bytes.length }),
    })
    if (!ticket.ok) throw new Error(`the API refused the image (${ticket.status})`)
    const { url, headers } = (await ticket.json()) as {
      url: string | null
      headers?: Record<string, string>
    }
    const body = new Uint8Array(bytes)
    const upload = url
      ? await fetch(url, { method: 'PUT', headers: headers ?? { 'content-type': type }, body })
      : await fetch(file, { method: 'PUT', headers: { ...auth, 'content-type': type }, body })
    if (!upload.ok)
      throw new Error(`the ${url ? 'bucket' : 'API'} refused the image (${upload.status})`)
  }
}

/**
 * Each image the reply names that is on the computer, stored in the thread's bucket
 * folder, by its path as the reply writes it: STORED_FILE and the stored file's name.
 * A relative one is in the thread's working folder. One that is missing, too large,
 * no image or could not be stored is left out: the thread tries the computer for it.
 */
export async function keepReplyImages(
  text: string,
  folder: { workDir: string; runAs?: string },
  sessionId: string,
  store: StoreImage,
): Promise<Record<string, string>> {
  const images: Record<string, string> = {}
  for (const path of imagesIn(text)) {
    const target = await real(isAbsolute(path) ? path : join(folder.workDir, path), folder.runAs)
    if (!target) continue
    try {
      const { bytes } = await readStart(target, folder.runAs, IMAGE_VIEW_MAX)
      if (bytes.length > IMAGE_VIEW_MAX) continue
      const kind = TYPES.find((t) => t.is(bytes))
      if (!kind) continue
      const name = `${createHash('sha256').update(bytes).digest('hex')}.${kind.ext}`
      await store(sessionId, name, bytes, kind.type)
      images[path] = `${STORED_FILE}${name}`
    } catch (error) {
      // Unreadable (gone since, not its own) or not stored: the thread tries the computer.
      console.warn(`thread ${sessionId}: could not keep the image ${path}: ${String(error)}`)
    }
  }
  return images
}
