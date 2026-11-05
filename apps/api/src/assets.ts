// Files put in documents from the editor: images, video, audio, PDFs. Bytes in
// the bucket under <organization>/<workspace>/assets/<id>; the document's text
// refers to each as `asset:<id>`. With R2 the browser uploads straight to the
// bucket and reads through short-lived signed URLs, and the API reads each upload
// back as it streams to check it; without it (development) both go through the
// API. The hourly sweep keeps the bucket to what some
// document still refers to.
import {
  ASSET_MAX,
  ASSET_MAX_THROUGH_API,
  LIBRARY_READ_MAX,
  safeFileName,
  type DocumentAsset,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit } from './audit.js'
import { createHash } from 'node:crypto'
import {
  assetKey,
  deleteObject,
  getObject,
  objectSize,
  presignGet,
  presignPut,
  putObject,
} from './bucket.js'
import { prisma, type Scope, type ScopedDb } from './db.js'
import { hubs } from './hub.js'
import { contentTypeFor, isMarkdown, readLibraryFile } from './library.js'
import { detectType, HEAD_BYTES, inspectObject } from './object-check.js'

/** Shown in the page where it is: what cannot run script, even from the API's origin. */
const INLINE =
  /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|wav|ogg|webm)|application\/pdf)$/
/** An upload whose browser went away. */
const PENDING_MS = 60 * 60_000
/** How long a file no document refers to is kept: undo, or a block moved between documents. */
const UNREFERENCED_MS = 24 * 3600_000
/** How often each kept file is checked again. */
const RECHECK_MS = 24 * 3600_000
/** Library text kept for search stops here (library.ts); past it, read the file itself. */
const INDEXED_CHARS = 400_000

type Row = { id: string; name: string; contentType: string; size: number }

export const toAsset = (row: Row): DocumentAsset => ({
  id: row.id,
  url: `asset:${row.id}`,
  name: row.name,
  contentType: row.contentType,
  size: row.size,
})

/** A Markdown document of this workspace that files can be put in. */
async function editableDocument(db: ScopedDb, documentId: string) {
  const row = await db.document.findFirst({ where: { id: documentId } })
  if (!row || !isMarkdown(row)) throw new HTTPException(404, { message: 'Document not found' })
  return row
}

/** Start a direct upload: the row, pending, and where the browser PUTs the bytes. */
export async function startAssetUpload(
  db: ScopedDb,
  scope: Scope,
  input: { documentId: string; name: string; size: number; contentType: string; memberId: string },
) {
  const document = await editableDocument(db, input.documentId)
  const name = safeFileName(input.name)
  const contentType = contentTypeFor(name, input.contentType)
  const row = await db.documentAsset.create({
    data: {
      documentId: document.id,
      name,
      contentType,
      size: input.size,
      status: 'pending',
      uploadedByMemberId: input.memberId,
    } as never,
  })
  const upload = await presignPut(assetKey(scope, row.id), input.size, contentType)
  return { row, ...upload }
}

/**
 * The browser's upload reached the bucket: read back as it streams (never held whole), it
 * must be the size it announced. Its SHA-256 is kept, and the type its bytes bear out: a file
 * that claims a type shown inline (an image, a PDF) but is not one is served as a download.
 */
export async function finishAssetUpload(db: ScopedDb, scope: Scope, id: string, memberId: string) {
  const row = await db.documentAsset.findFirst({ where: { id, uploadedByMemberId: memberId } })
  if (!row) throw new HTTPException(404, { message: 'Upload not found' })
  if (row.status === 'ready') return row
  const key = assetKey(scope, id)
  const size = await objectSize(key)
  if (size === null)
    throw new HTTPException(409, { message: 'The file has not reached storage; upload it again' })
  const mismatch = async () => {
    await removeAsset(row.id, scope)
    return new HTTPException(400, {
      message: 'The upload does not match the file; upload it again',
    })
  }
  if (size !== row.size || size > ASSET_MAX) throw await mismatch()
  const inspected = await inspectObject(key, {
    name: row.name,
    contentType: row.contentType,
    max: row.size,
  })
  if (!inspected || inspected.size !== row.size) throw await mismatch()
  const ready = await db.documentAsset.update({
    where: { id },
    data: { status: 'ready', sha256: inspected.sha256, contentType: inspected.contentType },
  })
  await auditAdded(scope, memberId, ready)
  // Teammates' mirrors take it beside its document (docs/lists.md), before a hand-off names it.
  void hubs.get(scope.workspaceId).notifyLibraryChanged()
  return ready
}

/** Store a file sent through the API, when the bucket takes no direct uploads. */
export async function storeAsset(
  db: ScopedDb,
  scope: Scope,
  input: { documentId: string; file: File; memberId: string },
) {
  if (input.file.size > ASSET_MAX_THROUGH_API)
    throw new HTTPException(413, { message: 'Files can be up to 25 MB here' })
  const document = await editableDocument(db, input.documentId)
  const name = safeFileName(input.file.name)
  const bytes = new Uint8Array(await input.file.arrayBuffer())
  const contentType = detectType(name, bytes.subarray(0, HEAD_BYTES), input.file.type)
  const row = await db.documentAsset.create({
    data: {
      documentId: document.id,
      name,
      contentType,
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      uploadedByMemberId: input.memberId,
    } as never,
  })
  try {
    await putObject(assetKey(scope, row.id), bytes, contentType)
  } catch (error) {
    await db.documentAsset.delete({ where: { id: row.id } })
    throw error
  }
  await auditAdded(scope, input.memberId, row)
  void hubs.get(scope.workspaceId).notifyLibraryChanged()
  return row
}

const auditAdded = (scope: Scope, memberId: string, row: Row & { documentId: string | null }) =>
  audit({
    ...scope,
    actor: { type: 'member', id: memberId },
    action: 'library.asset_added',
    target: { type: 'document', id: row.documentId ?? row.id },
    data: { assetId: row.id, name: row.name, size: row.size, contentType: row.contentType },
  })

/**
 * How the browser gets the file: a signed bucket URL to redirect to, or the
 * bytes. Any member of the workspace may read any document's files.
 */
export async function serveAsset(
  db: ScopedDb,
  scope: Scope,
  id: string,
  download: boolean,
): Promise<
  | { redirect: { url: string; seconds: number } }
  | { row: Row; bytes: Uint8Array; disposition: string }
> {
  const row = await db.documentAsset.findFirst({ where: { id, status: 'ready' } })
  if (!row) throw new HTTPException(404, { message: 'File not found' })
  const inline = !download && INLINE.test(row.contentType)
  const disposition = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`
  const key = assetKey(scope, row.id)
  try {
    return { redirect: await presignGet(key, { contentType: row.contentType, disposition }) }
  } catch {
    // No R2 (development): through the API.
    const bytes = await getObject(key)
    if (!bytes) throw new HTTPException(404, { message: 'The file is missing from storage' })
    return { row, bytes, disposition }
  }
}

async function removeAsset(id: string, scope: Scope) {
  await prisma.documentAsset.delete({ where: { id } }).catch(() => undefined)
  await deleteObject(assetKey(scope, id)).catch((error) =>
    console.warn(`asset ${id}: bytes not deleted: ${String(error)}`),
  )
}

/**
 * The document of this workspace that still refers to the file: its own first, unless that one
 * is in the trash and a live one refers to it too (a block copied over), which takes it on so the
 * file stays where the library is read (teammates' mirrors, lists). One in the trash keeps it
 * for a restore when no live one refers to it.
 */
async function holder(row: {
  id: string
  organizationId: string
  workspaceId: string
  documentId: string | null
}) {
  const reference = `asset:${row.id}`
  const scope = { organizationId: row.organizationId, workspaceId: row.workspaceId }
  const own = row.documentId
    ? await prisma.document.findUnique({ where: { id: row.documentId } })
    : null
  const ownRefers = own ? await refersTo(scope, own, reference) : false
  if (own && ownRefers && !own.deletedAt) return own.id
  const other = await prisma.document.findFirst({
    where: { ...scope, ...(own ? { id: { not: own.id } } : {}), text: { contains: reference } },
    select: { id: true, deletedAt: true },
    orderBy: { deletedAt: { sort: 'asc', nulls: 'first' } },
  })
  if (other && !other.deletedAt) return other.id
  if (own && ownRefers) return own.id
  return other?.id ?? null
}

/** Whether a document refers to the file, as far as can be told. */
async function refersTo(
  scope: Scope,
  doc: { id: string; kind: string; text: string; size: number; objectKey: string | null },
  reference: string,
) {
  if (doc.text.includes(reference)) return true
  // A long library file: its stored text stops short; read the file itself.
  // One too large to read whole may refer to it: kept.
  if (doc.kind === 'library' && doc.size > LIBRARY_READ_MAX) return true
  if (doc.kind === 'library' && doc.text.length >= INDEXED_CHARS) {
    const bytes = await readLibraryFile(scope, doc).catch(() => null)
    return !bytes || new TextDecoder().decode(bytes).includes(reference)
  }
  return false
}

/**
 * The files of a document going to the trash that a live document refers to too (a block copied
 * over) move to that one, so that they stay where the library is read (teammates' mirrors, a
 * list's lines: docs/lists.md). The others stay with it, for a restore.
 */
export async function moveFilesOfTrashed(scope: Scope, documentId: string) {
  const rows = await prisma.documentAsset.findMany({
    where: { ...scope, documentId, status: 'ready' },
    select: { id: true },
  })
  for (const row of rows) {
    const live = await prisma.document.findFirst({
      where: {
        ...scope,
        id: { not: documentId },
        deletedAt: null,
        text: { contains: `asset:${row.id}` },
      },
      select: { id: true },
    })
    if (live)
      await prisma.documentAsset.update({ where: { id: row.id }, data: { documentId: live.id } })
  }
}

/**
 * Remove files nothing refers to any more, across workspaces: uploads never
 * finished, files whose document was deleted, files taken out of their
 * document a day ago or more. A file another document refers to (a block
 * copied over) moves to that document instead. `ids` checks just those, now:
 * a document's files right after it is deleted.
 */
export async function sweepAssets(ids?: string[]) {
  const now = Date.now()
  const rows = await prisma.documentAsset.findMany({
    where: ids
      ? { id: { in: ids } }
      : {
          OR: [
            { status: 'pending', createdAt: { lt: new Date(now - PENDING_MS) } },
            {
              status: 'ready',
              createdAt: { lt: new Date(now - UNREFERENCED_MS) },
              OR: [{ checkedAt: null }, { checkedAt: { lt: new Date(now - RECHECK_MS) } }],
            },
          ],
        },
    orderBy: { checkedAt: { sort: 'asc', nulls: 'first' } },
    take: 500,
  })
  let removed = 0
  for (const row of rows) {
    const scope = { organizationId: row.organizationId, workspaceId: row.workspaceId }
    const documentId = row.status === 'ready' ? await holder(row) : null
    if (!documentId) {
      await removeAsset(row.id, scope)
      removed++
      continue
    }
    await prisma.documentAsset.update({
      where: { id: row.id },
      data: { documentId, checkedAt: new Date() },
    })
  }
  if (removed > 0) console.log(`assets: removed ${removed} file(s) no document refers to`)
}
