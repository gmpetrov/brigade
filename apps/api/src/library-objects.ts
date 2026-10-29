// A library file's bytes, one bucket object per save (LibraryObject). A save writes its bytes to
// an object of its own, then points the file's row to it: that row update is its only commit. A
// write that lands late, past its save's lease or after a crash, lands in its own object, which no
// row points to and nobody reads, and the sweep deletes it. Files not saved since keep their bytes
// at the legacy key (documentKey), until their next save.
import { randomBytes } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import {
  deleteObject,
  documentKey,
  libraryObjectKey,
  libraryObjectsPrefix,
  listObjects,
  type SignedWrite,
  versionKey,
  workspacePrefix,
} from './bucket.js'
import { prisma, type Prisma, type Scope } from './db.js'

/**
 * How long an object no row points to is kept: from its creation before it can be marked, then
 * from its mark before it is deleted. A save claims its object within its lease (seconds); a
 * reader that read a row just before a newer save still finds the bytes it points to. A write
 * lands within SIGNED_WRITE_MS of its object's making or never (newLibraryObject), long before
 * this; one that did anyway would be found by the listing sweep (sweepOrphanLibraryObjects).
 */
const GRACE_MS = 60 * 60_000

/** Lowercase letters and digits: a bucket key part, and an id's. */
const base36 = (length: number) =>
  Array.from(randomBytes(length), (byte) => (byte % 36).toString(36)).join('')

/** An id shaped as Prisma's cuid, for a new file: its bytes go in before its row is made. */
export const newDocumentId = () => `c${base36(24)}`

type Keyed = { objectKey: string | null }

/** Where a library file's bytes are: its last save's object, or the legacy key. */
export function fileKey(scope: Scope, row: Keyed & { id: string }) {
  return row.objectKey ? ownObject(scope, row.id, row.objectKey) : documentKey(scope, row.id)
}

/** Where a version's bytes are: its save's object, or the legacy version key. */
export function versionBytesKey(scope: Scope, version: Keyed & { id: string; documentId: string }) {
  return version.objectKey
    ? ownObject(scope, version.documentId, version.objectKey)
    : versionKey(scope, version.id)
}

/** A key from a row, checked to be one of the file's own objects in this workspace. */
function ownObject(scope: Scope, documentId: string, key: string) {
  if (!key.startsWith(libraryObjectsPrefix(scope, documentId)))
    throw new Error(`${key} is not an object of ${documentId}`)
  return key
}

/**
 * A new object for one save of a file, with its write (signPut, signCopy). Recorded before its
 * bytes are written, so it is never lost track of; and the write is signed before that, while
 * the workspace is still there, so the bucket refuses it SIGNED_WRITE_MS on, however long the
 * process pauses before sending it. Nothing can land after that: not once its object was swept,
 * nor once its deleted workspace's folder was emptied (workspace-delete.ts waits longer).
 */
export async function newLibraryObject(
  scope: Scope,
  documentId: string,
  sign: (key: string) => Promise<SignedWrite>,
) {
  const key = libraryObjectKey(scope, documentId, base36(20))
  const write = await sign(key)
  const made = await prisma.$executeRaw`
    INSERT INTO "LibraryObject" ("key", "organizationId", "workspaceId", "documentId", "createdAt")
    SELECT ${key}, ${scope.organizationId}, ${scope.workspaceId}, ${documentId}, timezone('UTC', now())
    WHERE EXISTS (SELECT 1 FROM "Workspace" WHERE "id" = ${scope.workspaceId})`
  if (!made) throw new HTTPException(404, { message: 'Workspace not found' })
  return { key, write }
}

/** The save came too late: the sweep found its object unclaimed and will delete it. */
export class ObjectExpired extends HTTPException {
  constructor() {
    super(409, { message: 'The file took too long to save; try again' })
  }
}

/**
 * Before a row points to an object, in the same transaction: the object must not be marked for
 * deletion, and the sweep cannot mark it until the transaction ends (its row is locked). Every
 * write that makes a row point to an object claims it first.
 */
export async function claimObject(tx: Prisma.TransactionClient, key: string) {
  const found = await tx.$queryRaw<unknown[]>`
    SELECT 1 FROM "LibraryObject" WHERE "key" = ${key} AND "unreferencedAt" IS NULL FOR UPDATE`
  if (!found.length) throw new ObjectExpired()
}

/**
 * Objects no file or version points to: superseded by a newer save, left by a version pruned or
 * folded, by a file deleted for good or its workspace, or by a save that failed or came too late.
 * Marked once older than the grace period, deleted from the bucket a grace period on, then their
 * row: one that failed stays for the next sweep (jobs.ts).
 */
export async function sweepLibraryObjects(now = new Date()) {
  const before = new Date(now.getTime() - GRACE_MS)
  // Claimed while the sweep marked it (the mark waited for the claim's lock, then went on as it
  // had read): pointed to, so kept.
  await prisma.$executeRaw`
    UPDATE "LibraryObject" o SET "unreferencedAt" = NULL
    WHERE o."unreferencedAt" IS NOT NULL
      AND (EXISTS (SELECT 1 FROM "Document" d WHERE d."objectKey" = o."key")
        OR EXISTS (SELECT 1 FROM "DocumentVersion" v WHERE v."objectKey" = o."key"))`
  // Marked a grace period ago and still pointed to by nothing: nothing can claim them any more.
  const gone = await prisma.$queryRaw<{ key: string }[]>`
    SELECT o."key" FROM "LibraryObject" o
    WHERE o."unreferencedAt" < ${before}
      AND NOT EXISTS (SELECT 1 FROM "Document" d WHERE d."objectKey" = o."key")
      AND NOT EXISTS (SELECT 1 FROM "DocumentVersion" v WHERE v."objectKey" = o."key")
    LIMIT 500`
  let deleted = 0
  for (const { key } of gone) {
    try {
      // The bytes first: the row is the promise that they will go.
      await deleteObject(key)
      await prisma.libraryObject.deleteMany({ where: { key, unreferencedAt: { not: null } } })
      deleted++
    } catch (error) {
      console.warn(`library: object ${key} not deleted yet: ${String(error)}`)
    }
  }
  await prisma.$executeRaw`
    UPDATE "LibraryObject" o SET "unreferencedAt" = ${now}
    WHERE o."unreferencedAt" IS NULL
      AND o."createdAt" < ${before}
      AND NOT EXISTS (SELECT 1 FROM "Document" d WHERE d."objectKey" = o."key")
      AND NOT EXISTS (SELECT 1 FROM "DocumentVersion" v WHERE v."objectKey" = o."key")`
  if (deleted > 0) console.log(`library: deleted ${deleted} object(s) no file points to`)
  return deleted
}

/** A library object's key: `<org>/<ws>/library-objects/<document id>/<id>`. */
const OBJECT_KEY = /\/library-objects\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}$/

/**
 * Bytes in a workspace's library objects folder that no LibraryObject row names: a write that
 * landed after its object was swept (its row goes only once its bytes did), or a delete that
 * failed after. Found by listing each workspace's folder, so no time window bounds what is
 * removed: a row is made before any write to its key, and kept until its bytes are deleted.
 */
export async function sweepOrphanLibraryObjects() {
  const workspaces = await prisma.workspace.findMany({
    select: { id: true, organizationId: true },
  })
  let removed = 0
  for (const workspace of workspaces) {
    const scope = { organizationId: workspace.organizationId, workspaceId: workspace.id }
    const keys = (await listObjects(`${workspacePrefix(scope)}library-objects/`)).filter((key) =>
      OBJECT_KEY.test(key),
    )
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000)
      const known = new Set(
        (
          await prisma.libraryObject.findMany({
            where: { key: { in: batch } },
            select: { key: true },
          })
        ).map((row) => row.key),
      )
      for (const key of batch) {
        if (known.has(key)) continue
        await deleteObject(key).then(
          () => removed++,
          (error: unknown) => console.warn(`library: ${key} not deleted: ${String(error)}`),
        )
      }
    }
  }
  if (removed > 0) console.log(`library: removed ${removed} object(s) no row names`)
  return removed
}
