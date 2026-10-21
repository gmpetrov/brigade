// Logos the dashboard sends as data URLs: a project's, a workspace's. One per
// owner in the bucket, replaced by a new one; the row keeps "<version>.<type>",
// so the URL it is read at changes with it and a browser keeps each for good.
import { randomUUID } from 'node:crypto'
import { PROJECT_LOGO_MAX, PROJECT_LOGO_TYPES } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { deleteObject, getObject, putObject } from './bucket.js'
import { imageType } from './project-sites.js'

const LOGO_EXTENSIONS: Record<(typeof PROJECT_LOGO_TYPES)[number], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/x-icon': 'ico',
  'image/svg+xml': 'svg',
}

/** A logo's bytes and type: its bytes decide the type, whatever the URL says. */
export function decodeLogo(dataUrl: string) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  if (bytes.byteLength > PROJECT_LOGO_MAX)
    throw new HTTPException(413, { message: 'A logo can be up to 256 KB' })
  const type = imageType(bytes) as keyof typeof LOGO_EXTENSIONS | null
  if (!type || !(type in LOGO_EXTENSIONS))
    throw new HTTPException(400, { message: 'A logo is a PNG, JPEG, GIF, WebP, ICO or SVG image' })
  return { bytes, type, extension: LOGO_EXTENSIONS[type] }
}

/** Keep a logo at the key its version names (or at one key for all). Returns its version: what its row's `logo` holds. */
export async function storeLogo(dataUrl: string, keyFor: (version: string) => string) {
  const { bytes, type, extension } = decodeLogo(dataUrl)
  const version = `${randomUUID().slice(0, 8)}.${extension}`
  await putObject(keyFor(version), bytes, type)
  return version
}

export const removeLogo = (key: string) =>
  deleteObject(key).catch((error: unknown) =>
    console.warn(`${key}: logo not deleted: ${String(error)}`),
  )

/** The logo at `key`, its type from the row's `logo`; null when it is gone. */
export async function readLogo(key: string, logo: string) {
  const extension = logo.split('.').pop()
  const type = Object.entries(LOGO_EXTENSIONS).find(([, e]) => e === extension)?.[0]
  const bytes = type ? await getObject(key) : null
  return bytes && type ? { bytes, type } : null
}

/** How a logo is sent: kept for good (its URL names the version), and inert on its own. */
export const LOGO_HEADERS = {
  'cache-control': 'private, max-age=31536000, immutable',
  'x-content-type-options': 'nosniff',
  // An SVG opened on its own runs nothing from the API's origin.
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
}
