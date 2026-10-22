// The images a teammate's reply shows (`![…](/tmp/shot.png)`, a link to one), read
// when the reply is done and sent with it (message.images): the API keeps them in the
// thread's bucket folder, so the thread shows them after the file has gone (/tmp, a
// folder cleaned up) or while the computer is off. Read as the teammate's user on a
// cloud computer: what it can read itself, nothing more.
import { isAbsolute, join } from 'node:path'
import { IMAGE_VIEW_MAX } from '@brigade/contracts'
import { readStart, real } from './files.js'

/** A link target in Markdown, `](path)` or `](<path with spaces>)`, with an optional title. */
const TARGET = /\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g
const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i
/** More than a reply needs; each is read whole, up to IMAGE_VIEW_MAX. */
const MAX_IMAGES = 10

/** The type of an image by its leading bytes; SVG is not one (it can run script). */
const TYPES: { type: string; is: (b: Buffer) => boolean }[] = [
  { type: 'image/png', is: (b) => b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG' },
  { type: 'image/jpeg', is: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', is: (b) => b.toString('latin1', 0, 4) === 'GIF8' },
  {
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

/**
 * Each image the reply names that is on the computer, as a data: URL, by its path as
 * the reply writes it. A relative one is in the thread's working folder. One that is
 * missing, too large or no image is left out: the thread tries the computer for it.
 */
export async function readReplyImages(
  text: string,
  folder: { workDir: string; runAs?: string },
): Promise<Record<string, string>> {
  const images: Record<string, string> = {}
  for (const path of imagesIn(text)) {
    const target = await real(isAbsolute(path) ? path : join(folder.workDir, path), folder.runAs)
    if (!target) continue
    try {
      const { bytes } = await readStart(target, folder.runAs, IMAGE_VIEW_MAX)
      if (bytes.length > IMAGE_VIEW_MAX) continue
      const type = TYPES.find((t) => t.is(bytes))?.type
      if (type) images[path] = `data:${type};base64,${bytes.toString('base64')}`
    } catch {
      // Unreadable (gone since, not its own): the thread tries the computer.
    }
  }
  return images
}
