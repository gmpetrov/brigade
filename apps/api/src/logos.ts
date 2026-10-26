// Logos the dashboard uploads straight to the bucket (or, without R2 only, sends as
// data URLs): a project's, a workspace's. One per owner in the bucket, replaced by a new one; the row keeps "<version>.<type>",
// so the URL it is read at changes with it and a browser keeps each for good.
import { randomUUID } from 'node:crypto'
import { LOGO_UPLOAD, PROJECT_LOGO_MAX, PROJECT_LOGO_TYPES } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { deleteObject, directUploads, getObject, putObject, readHead } from './bucket.js'
import { scoped } from './db.js'
import { imageType } from './project-sites.js'
import type { WorkspaceScope } from './scope.js'
import { copyUpload, discardUpload, readyUpload, uploadBytesKey } from './uploads.js'

const LOGO_EXTENSIONS: Record<(typeof PROJECT_LOGO_TYPES)[number], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/x-icon': 'ico',
  'image/svg+xml': 'svg',
}

const TOO_LARGE = 'A logo can be up to 256 KB'

/** A logo's type, by its first bytes: they decide it, whatever the name or URL says. */
function logoType(head: Uint8Array) {
  const type = imageType(head) as keyof typeof LOGO_EXTENSIONS | null
  if (!type || !(type in LOGO_EXTENSIONS))
    throw new HTTPException(400, { message: 'A logo is a PNG, JPEG, GIF, WebP, ICO or SVG image' })
  return { type, extension: LOGO_EXTENSIONS[type] }
}

/** A logo's bytes and type, from a data URL. */
export function decodeLogo(dataUrl: string) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  if (bytes.byteLength > PROJECT_LOGO_MAX) throw new HTTPException(413, { message: TOO_LARGE })
  return { bytes, ...logoType(bytes) }
}

/**
 * Keep a logo at the key its version names (or at one key for all): the member's upload
 * (`upload:<id>`), copied inside the bucket, or without R2 only a data URL. Returns its
 * version: what its row's `logo` holds.
 */
export async function storeLogo(
  scope: WorkspaceScope,
  logo: string,
  keyFor: (version: string) => string,
) {
  const version = (extension: string) => `${randomUUID().slice(0, 8)}.${extension}`
  if (logo.startsWith(LOGO_UPLOAD)) {
    const upload = await readyUpload(
      scoped(scope),
      { memberId: scope.memberId },
      logo.slice(LOGO_UPLOAD.length),
      'logo',
    )
    try {
      if (upload.size > PROJECT_LOGO_MAX) throw new HTTPException(413, { message: TOO_LARGE })
      const head = await readHead(uploadBytesKey(scope, upload), 1024)
      if (!head) throw new HTTPException(409, { message: 'The upload is gone; upload it again' })
      const { type, extension } = logoType(head)
      const kept = version(extension)
      await copyUpload(scope, upload, keyFor(kept), type)
      return kept
    } finally {
      await discardUpload(scope, upload.id)
    }
  }
  if (directUploads) throw new HTTPException(400, { message: 'Upload the logo first' })
  const { bytes, type, extension } = decodeLogo(logo)
  const kept = version(extension)
  await putObject(keyFor(kept), bytes, type)
  return kept
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
