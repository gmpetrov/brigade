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
import { copyObject, deleteObject, objectSize, uploadKey, uploadTarget } from './bucket.js'
import { prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { contentTypeFor } from './library.js'
import { inspectObject } from './object-check.js'

/** Who started an upload: only they complete or use it. */
export type UploadOwner =
  { memberId: string } | { computerId: string; sessionId: string; teammateId?: string }

type Row = Awaited<ReturnType<ScopedDb['upload']['findFirstOrThrow']>>

/** An upload whose client went away (its URL works 10 minutes). */
const PENDING_MS = 60 * 60_000
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
  return db.upload.update({
    where: { id },
    data: {
      sha256: inspected.sha256,
      contentType: inspected.contentType,
      text: inspected.text,
      status: 'ready',
    },
  })
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

/** Where an upload's bytes are, to copy or read them. */
export const uploadBytesKey = (scope: Scope, row: { id: string }) => uploadKey(scope, row.id)

/**
 * Copy an upload's bytes to where they belong, inside the bucket. With a type, stored with it.
 * A 409 when they are gone (swept): upload it again.
 */
export async function copyUpload(
  scope: Scope,
  row: { id: string },
  to: string,
  contentType?: string,
) {
  if (!(await copyObject(uploadKey(scope, row.id), to, contentType)))
    throw new HTTPException(409, { message: 'The upload is gone; upload it again' })
}

/** Its bytes, then its row: a row stays while its bytes could not go, for the sweep to try again. */
export async function discardUpload(scope: Scope, id: string) {
  try {
    await deleteObject(uploadKey(scope, id))
  } catch (error) {
    console.warn(`upload ${id}: bytes not deleted: ${String(error)}`)
    return false
  }
  await scoped(scope).upload.deleteMany({ where: { id } })
  return true
}

/** Remove uploads never completed or never used, across workspaces, bytes first. */
export async function sweepFileUploads() {
  const now = Date.now()
  const rows = await prisma.upload.findMany({
    where: {
      OR: [
        { status: 'pending', createdAt: { lt: new Date(now - PENDING_MS) } },
        { createdAt: { lt: new Date(now - UNUSED_MS) } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: 500,
  })
  for (const row of rows)
    await discardUpload(
      { organizationId: row.organizationId, workspaceId: row.workspaceId },
      row.id,
    )
  if (rows.length > 0) console.log(`uploads: removed ${rows.length} unused upload(s)`)
}

/** Whether a bucket object is there at this size: a skill file a runner uploaded, say. */
export async function hasObject(key: string, size: number) {
  return (await objectSize(key)) === size
}
