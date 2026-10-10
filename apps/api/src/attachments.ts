// Attachments (spec, "Attachments"): files given to a thread, uploaded by a
// member or taken from a connection. Bytes in the bucket, metadata in
// `Attachment`; `ThreadAttachment` puts a file in a thread at a path that is
// the same in every teammate's working folder. The runner copies them there.
import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import {
  ATTACHMENT_MAX,
  ATTACHMENTS_DIR,
  ATTACHMENTS_PER_MESSAGE,
  ATTACHMENTS_TOTAL_MAX,
  safeFileName,
  type AttachmentInfo,
  type AttachmentSource,
  type ThreadAttachmentRef,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit, type Actor } from './audit.js'
import { attachmentKey, deleteObject, getObject, presignPut, putObject } from './bucket.js'
import type { ConnectorContext, ExternalFile } from './connectors/types.js'
import { prisma, Prisma, type Scope, type ScopedDb } from './db.js'
import { contentTypeFor, extractText } from './library.js'

/** Programs and installers: never taken from outside (an email, a chat), where they are a common lure. */
const PROGRAM =
  /\.(exe|scr|com|pif|bat|cmd|msi|msp|ps1|psm1|vbs|vbe|jse|wsf|wsh|hta|cpl|jar|app|dmg|pkg|deb|rpm|apk|lnk|reg|iso|img|vhd|vhdx)$/i

/** Small inline images in an email are signatures and logos, not something it is about. */
const INLINE_IMAGE_MIN = 20 * 1024

/** Leading bytes of the types the dashboard shows inline: a file that claims one must be one. */
const MAGIC: Record<string, (b: Uint8Array) => boolean> = {
  'application/pdf': (b) => ascii(b, 0, 5) === '%PDF-',
  'image/png': (b) => b[0] === 0x89 && ascii(b, 1, 4) === 'PNG',
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => ascii(b, 0, 4) === 'GIF8',
  'image/webp': (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
}
const ascii = (b: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...b.subarray(from, to))

/** The file's type from its name, checked against its bytes for types shown inline. */
function detectType(name: string, bytes: Uint8Array, given?: string | null) {
  const type = contentTypeFor(name, given)
  const check = MAGIC[type]
  return check && !check(bytes) ? 'application/octet-stream' : type
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

type Row = {
  id: string
  name: string
  contentType: string
  size: number
  sha256: string
  status: 'pending' | 'ready' | 'blocked'
  note: string | null
  source: AttachmentSource
}

export const toInfo = (row: Row, path?: string): AttachmentInfo => ({
  id: row.id,
  name: row.name,
  contentType: row.contentType,
  size: row.size,
  status: row.status,
  ...(row.note ? { note: row.note } : {}),
  source: row.source,
  ...(path ? { path } : {}),
})

const toRef = (row: Row, path: string): ThreadAttachmentRef => ({
  id: row.id,
  path,
  name: row.name,
  contentType: row.contentType,
  size: row.size,
  sha256: row.sha256,
  // A pending upload is never in a thread (attachToThread takes only ready ones).
  status: row.status === 'ready' ? 'ready' : 'blocked',
  ...(row.note ? { note: row.note } : {}),
  source: row.source,
})

type Origin = {
  source: AttachmentSource
  uploadedByMemberId?: string
  connectionId?: string
  externalRef?: string
  /** A file a teammate sent: its thread. */
  sessionId?: string
}

/** What Brigade records of a file's bytes: its real type, size, hash and text for search. */
async function inspect(name: string, bytes: Uint8Array, given?: string | null) {
  const contentType = detectType(name, bytes, given)
  return {
    contentType,
    size: bytes.byteLength,
    sha256: sha256(bytes),
    text: await extractText(bytes, contentType),
  }
}

/** Keep a file's bytes. Not yet in any thread. */
export async function storeAttachment(
  db: ScopedDb,
  scope: Scope,
  input: Origin & { name: string; bytes: Uint8Array; contentType?: string | null },
) {
  if (input.bytes.byteLength > ATTACHMENT_MAX)
    throw new HTTPException(413, { message: 'Files can be up to 25 MB' })
  const name = safeFileName(input.name)
  const fields = await inspect(name, input.bytes, input.contentType)
  const contentType = fields.contentType
  const row = await db.attachment.create({
    data: {
      name,
      ...fields,
      source: input.source,
      uploadedByMemberId: input.uploadedByMemberId ?? null,
      connectionId: input.connectionId ?? null,
      externalRef: input.externalRef ?? null,
      sessionId: input.sessionId ?? null,
    } as never,
  })
  await putObject(attachmentKey(scope, row.id), input.bytes, contentType).catch(async (error) => {
    await db.attachment.delete({ where: { id: row.id } })
    throw error
  })
  return row
}

/** A file Brigade does not keep, so the teammate is told it exists and why it is missing. */
function blockedAttachment(
  db: ScopedDb,
  input: Origin & { name: string; contentType: string; size: number; note: string },
) {
  return db.attachment.create({
    data: {
      name: safeFileName(input.name),
      contentType: input.contentType,
      size: input.size,
      status: 'blocked',
      note: input.note,
      source: input.source,
      connectionId: input.connectionId ?? null,
      externalRef: input.externalRef ?? null,
    } as never,
  })
}

/** A pending upload untouched this long was abandoned (its URL works 10 minutes). */
const PENDING_MS = 60 * 60_000
/** An upload never sent with a message is removed after this long. */
const UNSENT_MS = 24 * 3600_000

/**
 * A member starts an upload straight to the bucket: a pending file, and a URL
 * that takes exactly its declared size and type. Checked by finishUpload.
 */
export async function startUpload(
  db: ScopedDb,
  scope: Scope,
  input: { name: string; size: number; contentType: string; memberId: string },
) {
  const name = safeFileName(input.name)
  // The type the bucket stores and the browser sends; checked against the bytes on completion.
  const contentType = contentTypeFor(name, input.contentType)
  const row = await db.attachment.create({
    data: {
      name,
      contentType,
      size: input.size,
      status: 'pending',
      source: 'upload',
      uploadedByMemberId: input.memberId,
    } as never,
  })
  const upload = await presignPut(attachmentKey(scope, row.id), input.size, contentType)
  return { row, ...upload }
}

/**
 * The browser finished its upload: the bytes are read back from the bucket
 * and checked like any other file, then it is ready to send.
 */
export async function finishUpload(db: ScopedDb, scope: Scope, id: string, memberId: string) {
  const row = await db.attachment.findFirst({
    where: { id, source: 'upload', uploadedByMemberId: memberId },
  })
  if (!row) throw new HTTPException(404, { message: 'Upload not found' })
  if (row.status === 'ready') return row
  if (row.status !== 'pending')
    throw new HTTPException(409, { message: 'This upload cannot be completed' })
  const bytes = await getObject(attachmentKey(scope, id))
  if (!bytes)
    throw new HTTPException(409, { message: 'The file has not reached storage; upload it again' })
  if (bytes.byteLength !== row.size || bytes.byteLength > ATTACHMENT_MAX) {
    await deleteAttachment(db, scope, { type: 'member', id: memberId }, id)
    throw new HTTPException(400, { message: 'The upload does not match the file; upload it again' })
  }
  // The type the bytes bear out is the one recorded; the API serves files with it, not the bucket's.
  const fields = await inspect(row.name, bytes, row.contentType)
  return db.attachment.update({ where: { id }, data: { ...fields, status: 'ready' } })
}

/**
 * Remove abandoned uploads, across workspaces: pending ones whose browser went
 * away, and uploads never sent with a message.
 */
export async function sweepUploads() {
  const now = Date.now()
  const rows = await prisma.attachment.findMany({
    where: {
      source: 'upload',
      threads: { none: {} },
      OR: [
        { status: 'pending', createdAt: { lt: new Date(now - PENDING_MS) } },
        { createdAt: { lt: new Date(now - UNSENT_MS) } },
      ],
    },
    take: 500,
  })
  for (const row of rows) {
    const scope = { organizationId: row.organizationId, workspaceId: row.workspaceId }
    await prisma.attachment.delete({ where: { id: row.id } })
    await deleteObject(attachmentKey(scope, row.id)).catch((error) =>
      console.warn(`attachment ${row.id}: bytes not deleted: ${String(error)}`),
    )
  }
  if (rows.length > 0) console.log(`attachments: removed ${rows.length} unsent upload(s)`)
}

export async function readAttachment(scope: Scope, id: string) {
  const bytes = await getObject(attachmentKey(scope, id))
  if (!bytes) throw new HTTPException(404, { message: 'The file is missing from storage' })
  return bytes
}

/** Delete a file and its bytes. Its threads lose it too. */
export async function deleteAttachment(db: ScopedDb, scope: Scope, actor: Actor, id: string) {
  const row = await db.attachment.findFirst({ where: { id } })
  if (!row) return
  await db.attachment.delete({ where: { id } })
  if (row.status !== 'blocked')
    await deleteObject(attachmentKey(scope, id)).catch((error) =>
      console.warn(`attachment ${id}: bytes not deleted: ${String(error)}`),
    )
  await audit({
    ...scope,
    actor,
    action: 'attachment.deleted',
    target: { type: 'attachment', id },
    data: { name: row.name },
  })
}

/** `attachments/name.pdf`, or `attachments/name-2.pdf` when the thread has one by that name. */
function freePath(name: string, taken: Set<string>) {
  const ext = extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  for (let n = 1; ; n++) {
    const path = `${ATTACHMENTS_DIR}/${n === 1 ? name : `${stem}-${n}${ext}`}`
    if (!taken.has(path)) return path
  }
}

/**
 * Give files to a thread, in order. A member may give only their own unsent
 * uploads (`memberId`); a trigger or a connector call passes files it just
 * took from the connection. Returns where each is, and the links it made.
 */
export async function attachToThread(
  db: ScopedDb,
  scope: Scope,
  sessionId: string,
  attachmentIds: string[],
  check: { memberId: string } | null,
): Promise<{ refs: ThreadAttachmentRef[]; created: string[] }> {
  const ids = [...new Set(attachmentIds)]
  if (ids.length === 0) return { refs: [], created: [] }
  const rows = await db.attachment.findMany({
    where: {
      id: { in: ids },
      ...(check
        ? {
            source: 'upload',
            status: 'ready',
            uploadedByMemberId: check.memberId,
            threads: { none: {} },
          }
        : { status: { not: 'pending' } }),
    },
    include: { threads: { where: { sessionId } } },
  })
  if (rows.length !== ids.length)
    throw new HTTPException(400, { message: 'An attached file was not found or was already sent' })
  const total = rows.reduce((sum, r) => sum + (r.status === 'ready' ? r.size : 0), 0)
  if (check && total > ATTACHMENTS_TOTAL_MAX)
    throw new HTTPException(413, { message: 'One message can carry up to 50 MB of files' })

  const refs: ThreadAttachmentRef[] = []
  const created: string[] = []
  for (const id of ids) {
    const row = rows.find((r) => r.id === id)!
    const existing = row.threads[0]
    if (existing) {
      refs.push(toRef(row, existing.path))
      continue
    }
    // Paths are unique in a thread; another message may take one meanwhile.
    for (let attempt = 0; ; attempt++) {
      const taken = new Set(
        (await db.threadAttachment.findMany({ where: { sessionId }, select: { path: true } })).map(
          (t) => t.path,
        ),
      )
      const path = freePath(row.name, taken)
      try {
        const link = await db.threadAttachment.create({
          data: { sessionId, attachmentId: row.id, path } as never,
        })
        created.push(link.id)
        refs.push(toRef(row, path))
        break
      } catch (error) {
        const clash =
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
        if (!clash || attempt >= 5) throw error
      }
    }
  }
  if (created.length > 0)
    await audit({
      ...scope,
      actor: check ? { type: 'member', id: check.memberId } : { type: 'system', id: 'brigade' },
      action: 'thread.files_attached',
      target: { type: 'thread', id: sessionId },
      data: { attachmentIds: ids },
    })
  return { refs, created }
}

/** Take back links made for a message that never reached the computer: its files can be sent again. */
export const detach = (db: ScopedDb, linkIds: string[]) =>
  linkIds.length
    ? db.threadAttachment.deleteMany({ where: { id: { in: linkIds } } })
    : Promise.resolve()

/** Every file in the thread, oldest first: each teammate gets them all in its working folder. */
export async function threadAttachments(db: ScopedDb, sessionId: string) {
  const links = await db.threadAttachment.findMany({
    where: { sessionId },
    include: { attachment: true },
    orderBy: { createdAt: 'asc' },
  })
  return links.map((l) => toRef(l.attachment, l.path))
}

/**
 * Take a connection's files into Brigade, once per file: the same email
 * matched by two triggers is fetched once. Too large, a program, too many or
 * unreachable: kept as blocked, so the teammate is told what it lacks.
 * Small inline images (signatures, logos) are left out.
 */
export async function ingestExternal(
  db: ScopedDb,
  scope: Scope,
  connectionId: string,
  files: ExternalFile[],
  ctx: Pick<ConnectorContext, 'fetch'>,
): Promise<string[]> {
  const ids: string[] = []
  let total = 0
  const wanted = files.filter(
    (f) => !(f.inline && f.contentType.startsWith('image/') && f.size < INLINE_IMAGE_MIN),
  )
  for (const [i, file] of wanted.entries()) {
    const origin = { source: 'connector' as const, connectionId, externalRef: file.key }
    const existing = await db.attachment.findFirst({
      where: { connectionId, externalRef: file.key },
    })
    if (existing) {
      ids.push(existing.id)
      continue
    }
    const blocked = (note: string, keep = true) =>
      blockedAttachment(db, {
        ...origin,
        // A file that could not be fetched may be tried again later: not kept under its key.
        ...(keep ? {} : { externalRef: undefined }),
        name: file.name,
        contentType: file.contentType,
        size: file.size,
        note,
      })
    let row
    if (i >= ATTACHMENTS_PER_MESSAGE) row = await blocked('more files than Brigade takes at once')
    else if (file.size > ATTACHMENT_MAX) row = await blocked('larger than 25 MB')
    else if (PROGRAM.test(file.name))
      row = await blocked('a program or installer, which Brigade does not take from outside')
    else if (total + file.size > ATTACHMENTS_TOTAL_MAX)
      row = await blocked('more than 50 MB of files at once')
    else {
      let fetched = false
      try {
        const bytes = await file.download(ctx)
        fetched = true
        row = await storeAttachment(db, scope, {
          ...origin,
          name: file.name,
          bytes,
          contentType: file.contentType,
        })
        total += row.size
      } catch (error) {
        // Fetched meanwhile by another delivery of the same event.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const again = await db.attachment.findFirst({
            where: { connectionId, externalRef: file.key },
          })
          if (again) {
            ids.push(again.id)
            continue
          }
        }
        const reason =
          error instanceof HTTPException
            ? error.message
            : fetched
              ? 'Brigade could not keep it'
              : 'it could not be fetched'
        console.warn(`attachment ${file.key}: ${String(error)}`)
        row = await blocked(reason, false)
      }
    }
    ids.push(row.id)
  }
  return ids
}

/**
 * A connector call's file, taken into the call's thread (e.g. an email
 * attachment the teammate asked for). Fetched only if Brigade lacks it.
 */
export async function keepConnectorFile(
  db: ScopedDb,
  scope: Scope,
  session: { id: string },
  connectionId: string,
  file: Omit<ExternalFile, 'download' | 'size'> & { bytes: () => Promise<Uint8Array> },
  ctx: Pick<ConnectorContext, 'fetch'>,
) {
  const [id] = await ingestExternal(
    db,
    scope,
    connectionId,
    [
      {
        ...file,
        inline: false,
        // Unknown until fetched; the limit is checked on the bytes.
        size: 0,
        download: async () => {
          const bytes = await file.bytes()
          if (bytes.byteLength > ATTACHMENT_MAX)
            throw new HTTPException(413, { message: 'larger than 25 MB' })
          return bytes
        },
      },
    ],
    ctx,
  )
  const { refs } = await attachToThread(db, scope, session.id, [id!], null)
  return refs[0]!
}
