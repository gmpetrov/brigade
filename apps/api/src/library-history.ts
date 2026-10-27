// What happened to library files: the versions each save leaves, and the
// trash. A version's bytes are kept in the bucket beside the file's own; a
// trashed file keeps its row and bytes, under a path no live file can have,
// until a restore or the sweep 30 days on.
import { TRASH_DAYS, VERSIONS_KEPT, type LibraryActor } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { sweepAssets } from './assets.js'
import { audit, type Actor } from './audit.js'
import {
  copyObject,
  deleteObject,
  documentKey,
  getObject,
  putObject,
  versionKey,
} from './bucket.js'
import { notifyCollab } from './collab.js'
import { prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { hubs } from './hub.js'

/** Saves by one author from one thread this close together make one version. */
const FOLD_MS = 10 * 60_000

const TRASH = /^\.trash\/[^/]+\//

/** Where a trashed file goes: a path no live file can have (they never start with "."). */
export const trashPath = (id: string, path: string) => `.trash/${id}/${path}`
/** Where a trashed file was. */
export const originalPath = (path: string) => path.replace(TRASH, '')

type Saved = { id: string; path: string; contentType: string; size: number; sha256: string }

/**
 * Record a save of a library file: a new version, or the latest one updated
 * when the same author saved it moments ago from the same place.
 */
export async function recordVersion(
  db: ScopedDb,
  scope: Scope,
  row: Saved,
  /** Its bytes, or the bucket key they are at (copied there, never read by the API). */
  bytes: Uint8Array | { key: string },
  actor: Actor,
  options: { sessionId?: string | null; restoredFromId?: string } = {},
) {
  const sessionId = options.sessionId ?? null
  const latest = await db.documentVersion.findFirst({
    where: { documentId: row.id },
    orderBy: { createdAt: 'desc' },
  })
  if (latest?.sha256 === row.sha256 && !options.restoredFromId) return latest
  const fold =
    latest &&
    !options.restoredFromId &&
    !latest.restoredFromId &&
    latest.actorType === actor.type &&
    latest.actorId === actor.id &&
    latest.sessionId === sessionId &&
    Date.now() - latest.updatedAt.getTime() < FOLD_MS
  const fields = {
    path: row.path,
    contentType: row.contentType,
    size: row.size,
    sha256: row.sha256,
  }
  const keep = async (key: string) => {
    if (bytes instanceof Uint8Array) return putObject(key, bytes, row.contentType)
    if (!(await copyObject(bytes.key, key, row.contentType)))
      throw new Error(`${bytes.key} is not in the bucket`)
  }
  if (fold) {
    await keep(versionKey(scope, latest.id))
    return db.documentVersion.update({ where: { id: latest.id }, data: fields })
  }
  const version = await db.documentVersion.create({
    data: {
      documentId: row.id,
      ...fields,
      actorType: actor.type,
      actorId: actor.id,
      sessionId,
      restoredFromId: options.restoredFromId ?? null,
    } as never,
  })
  await keep(versionKey(scope, version.id)).catch(async (error) => {
    await db.documentVersion.delete({ where: { id: version.id } })
    throw error
  })
  await pruneVersions(db, scope, row.id)
  return version
}

/** Keep the newest versions only. */
async function pruneVersions(db: ScopedDb, scope: Scope, documentId: string) {
  const old = await db.documentVersion.findMany({
    where: { documentId },
    orderBy: { createdAt: 'desc' },
    skip: VERSIONS_KEPT,
    select: { id: true },
  })
  if (old.length === 0) return
  await db.documentVersion.deleteMany({ where: { id: { in: old.map((v) => v.id) } } })
  for (const v of old)
    await deleteObject(versionKey(scope, v.id)).catch((error) =>
      console.warn(`library: version ${v.id} not deleted from the bucket: ${String(error)}`),
    )
}

/**
 * A file from before versions were kept has none: its current bytes become
 * the first, credited to whoever last changed it.
 */
export async function ensureFirstVersion(
  db: ScopedDb,
  scope: Scope,
  row: Saved & {
    updatedAt: Date
    createdAt: Date
    updatedByType: Actor['type'] | null
    updatedById: string | null
    updatedInSessionId: string | null
  },
) {
  if (await db.documentVersion.findFirst({ where: { documentId: row.id }, select: { id: true } }))
    return
  const version = await db.documentVersion.create({
    data: {
      documentId: row.id,
      path: row.path,
      contentType: row.contentType,
      size: row.size,
      sha256: row.sha256,
      actorType: row.updatedByType ?? 'system',
      actorId: row.updatedById ?? 'brigade',
      sessionId: row.updatedInSessionId,
      createdAt: row.updatedAt,
    } as never,
  })
  // Copied inside the bucket: the API never holds the file.
  const copied = await copyObject(
    documentKey(scope, row.id),
    versionKey(scope, version.id),
    row.contentType,
  ).catch(async (error) => {
    await db.documentVersion.delete({ where: { id: version.id } })
    throw error
  })
  if (!copied) await db.documentVersion.delete({ where: { id: version.id } })
}

/** A version's bytes. */
export async function readVersion(scope: Scope, versionId: string) {
  const bytes = await getObject(versionKey(scope, versionId))
  if (!bytes) throw new HTTPException(404, { message: 'That version is missing from storage' })
  return bytes
}

/** Names for the people and teammates who did things, by actor. */
export async function actorNames(db: ScopedDb, actors: { type: string; id: string }[]) {
  const ids = (type: string) => [...new Set(actors.filter((a) => a.type === type).map((a) => a.id))]
  const [members, teammates] = await Promise.all([
    ids('member').length
      ? db.member.findMany({
          where: { id: { in: ids('member') } },
          select: { id: true, user: { select: { name: true, email: true } } },
        })
      : [],
    ids('teammate').length
      ? db.teammate.findMany({
          where: { id: { in: ids('teammate') } },
          select: { id: true, name: true },
        })
      : [],
  ])
  const names = new Map<string, string>()
  for (const m of members) names.set(`member:${m.id}`, m.user.name || m.user.email)
  for (const t of teammates) names.set(`teammate:${t.id}`, t.name)
  return (
    type: string | null,
    id: string | null,
    sessionId: string | null = null,
  ): LibraryActor | null => {
    if (!type || !id) return null
    const name =
      type === 'system' || type === 'runner'
        ? 'Brigade'
        : (names.get(`${type}:${id}`) ??
          (type === 'member' ? 'A former member' : 'A removed teammate'))
    return { type: type as LibraryActor['type'], id, name, sessionId }
  }
}

// ---------------------------------------------------------------------------
// Trash
// ---------------------------------------------------------------------------

/** A file in the trash. */
export async function trashedFile(db: ScopedDb, id: string) {
  const row = await db.document.findFirst({
    where: { id, kind: 'library', deletedAt: { not: null } },
  })
  if (!row) throw new HTTPException(404, { message: 'Not in the trash' })
  return row
}

/**
 * Move a file to the trash. Its row, bytes and versions stay; teammates and
 * search no longer see it. `quiet` leaves the audit and notices to the caller
 * (a folder going to the trash whole).
 */
export async function trashLibraryFile(
  db: ScopedDb,
  scope: Scope,
  actor: Actor,
  id: string,
  options: { quiet?: boolean } = {},
) {
  const row = await db.document.findFirst({ where: { id, kind: 'library', deletedAt: null } })
  if (!row) throw new HTTPException(404, { message: 'File not found' })
  await db.document.update({
    where: { id },
    data: {
      path: trashPath(id, row.path),
      deletedAt: new Date(),
      deletedByType: actor.type,
      deletedById: actor.id,
    },
  })
  if (options.quiet) return
  await audit({
    ...scope,
    actor,
    action: 'library.file_trashed',
    target: { type: 'document', id },
    data: { path: row.path },
  })
  void hubs.get(scope.workspaceId).notifyLibraryChanged()
  notifyCollab(id, 'delete')
}

/** "notes (restored).md", then "(restored 2)": a free path near the old one. */
async function freePath(db: ScopedDb, path: string) {
  const taken = async (p: string) =>
    Boolean(
      await db.document.findFirst({ where: { kind: 'library', path: p }, select: { id: true } }),
    )
  if (!(await taken(path))) return path
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  const cut = dot > slash + 1 ? dot : path.length
  for (let n = 1; n < 100; n++) {
    const candidate = `${path.slice(0, cut)} (restored${n > 1 ? ` ${n}` : ''})${path.slice(cut)}`
    if (!(await taken(candidate))) return candidate
  }
  throw new HTTPException(409, { message: 'Rename the file at that path first' })
}

/** Put a trashed file back where it was, or beside a file that took its place. */
export async function restoreLibraryFile(db: ScopedDb, scope: Scope, actor: Actor, id: string) {
  const row = await trashedFile(db, id)
  const path = await freePath(db, originalPath(row.path))
  const restored = await db.document.update({
    where: { id },
    data: { path, deletedAt: null, deletedByType: null, deletedById: null },
  })
  await audit({
    ...scope,
    actor,
    action: 'library.file_restored',
    target: { type: 'document', id },
    data: { path },
  })
  void hubs.get(scope.workspaceId).notifyLibraryChanged()
  return restored
}

/** Delete a trashed file for good: its row, bytes, versions and the files in it. */
export async function purgeLibraryFile(db: ScopedDb, scope: Scope, actor: Actor, id: string) {
  const row = await trashedFile(db, id)
  const [assets, versions] = await Promise.all([
    db.documentAsset.findMany({ where: { documentId: id }, select: { id: true } }),
    db.documentVersion.findMany({ where: { documentId: id }, select: { id: true } }),
  ])
  await db.document.delete({ where: { id } })
  // Its files go too, now, unless another document refers to them.
  if (assets.length > 0)
    void sweepAssets(assets.map((a) => a.id)).catch((error) =>
      console.warn(`library: files of ${id} not swept: ${String(error)}`),
    )
  for (const key of [documentKey(scope, id), ...versions.map((v) => versionKey(scope, v.id))])
    await deleteObject(key).catch((error) =>
      console.warn(`library: could not delete ${key} from the bucket: ${String(error)}`),
    )
  await audit({
    ...scope,
    actor,
    action: 'library.file_deleted',
    target: { type: 'document', id },
    data: { path: originalPath(row.path) },
  })
}

/** Delete what has been in the trash longer than TRASH_DAYS, across workspaces. */
export async function sweepTrash() {
  const rows = await prisma.document.findMany({
    where: {
      kind: 'library',
      deletedAt: { lt: new Date(Date.now() - TRASH_DAYS * 24 * 60 * 60_000) },
    },
    select: { id: true, organizationId: true, workspaceId: true },
    take: 500,
  })
  for (const row of rows) {
    const scope = { organizationId: row.organizationId, workspaceId: row.workspaceId }
    await purgeLibraryFile(scoped(scope), scope, { type: 'system', id: 'trash' }, row.id).catch(
      (error) => console.warn(`library: ${row.id} not purged: ${String(error)}`),
    )
  }
  if (rows.length > 0) console.log(`library: deleted ${rows.length} file(s) from the trash`)
}
