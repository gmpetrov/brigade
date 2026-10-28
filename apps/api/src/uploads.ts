// Uploads straight to the bucket, for files the API keeps elsewhere once used: a library
// file, a skill pack to read, a skill's file, a logo. The client (a member's browser, or a
// runner for a teammate) starts one and PUTs the bytes to a signed URL, never through the
// API; completing it reads them back as they stream and checks them (size, SHA-256, type,
// text for search). The file is then used by its id, its bytes copied inside the bucket to
// where they belong (copyObject), never held whole by the API. Unused ones are swept.
import {
  safeFileName,
  UPLOAD_MAX,
  type FileUploadInfo,
  type FileUploadTicket,
  type UploadPurpose,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { randomUUID } from 'node:crypto'
import {
  checkedUploadKey,
  checkedUploadsPrefix,
  copyObject,
  deleteObject,
  listObjects,
  objectSize,
  uploadsPrefixes,
  UPLOAD_URL_SECONDS,
  uploadKey,
  uploadTarget,
} from './bucket.js'
import { prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { contentTypeFor } from './library.js'
import { inspectObject } from './object-check.js'

/** Who started an upload: only they complete or use it. */
export type UploadOwner =
  { memberId: string } | { computerId: string; sessionId: string; teammateId?: string }

type Row = Awaited<ReturnType<ScopedDb['upload']['findFirstOrThrow']>>

/** An upload whose client went away (its URL works 10 minutes). */
const PENDING_MS = 60 * 60_000
/**
 * A used or refused upload's row stays until its signed URL no longer works, so the sweep
 * also removes what a PUT made late (or replayed) after its bytes were deleted.
 */
const URL_LIFE_MS = UPLOAD_URL_SECONDS * 1000 + 5 * 60_000
/** A checked upload never used. */
const UNUSED_MS = 24 * 3600_000

const ownerWhere = (owner: UploadOwner) =>
  'memberId' in owner
    ? { memberId: owner.memberId }
    : { computerId: owner.computerId, sessionId: owner.sessionId }

export const toUploadInfo = (row: Row): FileUploadInfo => ({
  id: row.id,
  purpose: row.purpose as UploadPurpose,
  name: row.name,
  contentType: row.contentType,
  size: row.size,
  sha256: row.sha256,
})

/** Start an upload: a pending row, and where the client PUTs exactly its size and type. */
export async function startFileUpload(
  db: ScopedDb,
  scope: Scope,
  owner: UploadOwner,
  input: {
    purpose: UploadPurpose
    name: string
    size: number
    contentType?: string
    sha256?: string
  },
): Promise<FileUploadTicket> {
  if (input.size > UPLOAD_MAX[input.purpose])
    throw new HTTPException(413, { message: 'The file is too large' })
  // A library path keeps its folders; any other name is a file's.
  const name = input.purpose === 'library' ? input.name : safeFileName(input.name)
  const contentType = contentTypeFor(name, input.contentType)
  const row = await db.upload.create({
    data: {
      purpose: input.purpose,
      name,
      contentType,
      size: input.size,
      sha256: input.sha256 ?? '',
      status: 'pending',
      ...('memberId' in owner
        ? { memberId: owner.memberId }
        : {
            computerId: owner.computerId,
            sessionId: owner.sessionId,
            teammateId: owner.teammateId ?? null,
          }),
    } as never,
  })
  const target = await uploadTarget(uploadKey(scope, row.id), input.size, contentType)
  return { id: row.id, url: target.url, method: 'PUT', headers: target.headers }
}

/**
 * The client's PUT is done: its bytes are read back as they stream and checked. The size
 * it started with, the SHA-256 it gave (a runner's), and for a library file its text. A
 * mismatch removes it (400: upload it again); bytes not there yet are a 409.
 */
export async function completeFileUpload(
  db: ScopedDb,
  scope: Scope,
  owner: UploadOwner,
  id: string,
) {
  const row = await db.upload.findFirst({ where: { id, ...ownerWhere(owner) } })
  if (!row) throw new HTTPException(404, { message: 'Upload not found' })
  if (row.status === 'ready') return row
  if (row.status !== 'pending')
    throw new HTTPException(409, { message: 'This upload was used or refused; upload it again' })
  const key = uploadKey(scope, id)
  const size = await objectSize(key)
  if (size === null)
    throw new HTTPException(409, { message: 'The file has not reached storage; upload it again' })
  const inspected =
    size === row.size
      ? await inspectObject(key, {
          name: row.name,
          contentType: row.contentType,
          text: row.purpose === 'library',
          max: row.size,
        })
      : null
  if (
    !inspected ||
    inspected.size !== row.size ||
    (row.sha256 && inspected.sha256 !== row.sha256)
  ) {
    await discardUpload(scope, id)
    throw new HTTPException(400, { message: 'The upload does not match the file; upload it again' })
  }
  // The very version checked, where no signed URL reaches: a PUT since (a replay of the URL)
  // changed it, and it is refused. Each completion copies to a key of its own.
  const attempt = randomUUID().replaceAll('-', '')
  const checked = checkedUploadKey(scope, id, attempt)
  if (!(await copyObject(key, checked, inspected.contentType, { ifMatch: inspected.etag }))) {
    await discardUpload(scope, id)
    throw new HTTPException(400, {
      message: 'The upload changed while it was checked; upload it again',
    })
  }
  // Only one completion marks it ready, with the hash of the very bytes it copied; another
  // that ran alongside, or a discard meanwhile, leaves this copy unused.
  const claimed = await db.upload.updateMany({
    where: { id, status: 'pending' },
    data: {
      sha256: inspected.sha256,
      contentType: inspected.contentType,
      text: inspected.text,
      checked: attempt,
      status: 'ready',
    },
  })
  if (claimed.count === 0) {
    await deleteObject(checked).catch(() => undefined)
    const now = await db.upload.findFirst({ where: { id } })
    if (now?.status === 'ready') return now
    throw new HTTPException(409, { message: 'This upload was used or refused; upload it again' })
  }
  await deleteObject(key).catch(() => undefined)
  return db.upload.findFirstOrThrow({ where: { id } })
}

/** A checked upload of the owner's, for this purpose: what is used to save it where it belongs. */
export async function readyUpload(
  db: ScopedDb,
  owner: UploadOwner,
  id: string,
  purpose: UploadPurpose,
) {
  const row = await db.upload.findFirst({ where: { id, purpose, ...ownerWhere(owner) } })
  if (!row) throw new HTTPException(404, { message: 'Upload not found' })
  if (row.status !== 'ready') throw new HTTPException(409, { message: 'Complete the upload first' })
  return row
}

/** Where a checked upload's bytes are, to copy or read them: never changed once checked. */
export const uploadBytesKey = (scope: Scope, row: { id: string; checked: string }) =>
  checkedUploadKey(scope, row.id, row.checked)

/**
 * Copy an upload's bytes to where they belong, inside the bucket. With a type, stored with it.
 * A 409 when they are gone (swept): upload it again.
 */
export async function copyUpload(
  scope: Scope,
  row: { id: string; checked: string },
  to: string,
  contentType?: string,
) {
  if (!(await copyObject(uploadBytesKey(scope, row), to, contentType)))
    throw new HTTPException(409, { message: 'The upload is gone; upload it again' })
}

/**
 * Done with an upload (used, refused or abandoned): its bytes go, and it can no longer be
 * used. Its row stays until its URL no longer works, for the sweep to remove what a late PUT
 * leaves. False when the bytes could not go: the sweep tries again.
 */
export async function discardUpload(scope: Scope, id: string) {
  await scoped(scope).upload.updateMany({ where: { id }, data: { status: 'blocked' } })
  return deleteBytes(scope, id)
}

async function deleteBytes(scope: Scope, id: string) {
  try {
    await deleteObject(uploadKey(scope, id))
    for (const key of await listObjects(checkedUploadsPrefix(scope, id))) await deleteObject(key)
    return true
  } catch (error) {
    console.warn(`upload ${id}: bytes not deleted: ${String(error)}`)
    return false
  }
}

/**
 * Remove uploads never completed, never used, or done with, across workspaces: once their
 * signed URL no longer works, bytes first, then the row (kept while its bytes could not go).
 */
export async function sweepFileUploads() {
  const now = Date.now()
  const rows = await prisma.upload.findMany({
    where: {
      OR: [
        { status: 'pending', createdAt: { lt: new Date(now - PENDING_MS) } },
        { status: 'blocked', createdAt: { lt: new Date(now - URL_LIFE_MS) } },
        { createdAt: { lt: new Date(now - UNUSED_MS) } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: 500,
  })
  for (const row of rows) {
    const scope = { organizationId: row.organizationId, workspaceId: row.workspaceId }
    if (await deleteBytes(scope, row.id)) await prisma.upload.deleteMany({ where: { id: row.id } })
  }
  if (rows.length > 0) console.log(`uploads: removed ${rows.length} upload(s) done with`)
  await sweepOrphanUploads()
}

/** An upload's id in its bucket key: `…/uploads/<id>` or `…/uploads-checked/<id>/<attempt>`. */
const UPLOAD_ID = /\/uploads(?:-checked)?\/([A-Za-z0-9_-]{1,64})(?:\/|$)/

/**
 * Bytes no upload's row names any more: a PUT still under way when its row was swept (a slow
 * one, accepted before its URL expired), or a delete that failed after its row went. Found by
 * listing each workspace's upload folders, so no time window bounds what is removed: an object
 * there exists only for a row made before its URL was signed.
 */
export async function sweepOrphanUploads() {
  const workspaces = await prisma.workspace.findMany({
    select: { id: true, organizationId: true },
  })
  let removed = 0
  for (const workspace of workspaces) {
    const scope = { organizationId: workspace.organizationId, workspaceId: workspace.id }
    const keys = (
      await Promise.all(uploadsPrefixes(scope).map((prefix) => listObjects(prefix)))
    ).flat()
    if (keys.length === 0) continue
    const ids = [...new Set(keys.map((k) => k.match(UPLOAD_ID)?.[1]).filter(Boolean))] as string[]
    const known = new Set(
      (await prisma.upload.findMany({ where: { id: { in: ids } }, select: { id: true } })).map(
        (r) => r.id,
      ),
    )
    for (const key of keys) {
      const id = key.match(UPLOAD_ID)?.[1]
      if (!id || known.has(id)) continue
      await deleteObject(key).then(
        () => removed++,
        (error: unknown) => console.warn(`${key}: not deleted: ${String(error)}`),
      )
    }
  }
  if (removed > 0) console.log(`uploads: removed ${removed} object(s) no upload names`)
}

/** Whether a bucket object is there at this size: a skill file a runner uploaded, say. */
export async function hasObject(key: string, size: number) {
  return (await objectSize(key)) === size
}
