// Library folders: the ones people make (folders also exist as the paths of
// their files), moved and deleted whole, and the access rules that keep a
// folder from teammates. A rule follows the folder's path; the runner mirrors
// for each teammate only what it may read.
import {
  inFolder,
  libraryAccessFor,
  type FolderAccess,
  type FolderRule,
  type LibraryAccess,
  type LibraryFolder,
  type SetFolderAccess,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit, type Actor } from './audit.js'
import { notifyCollab } from './collab.js'
import { prisma, type Scope, type ScopedDb } from './db.js'
import { notifyLibraryChanged } from './hub.js'
import { trashLibraryFile } from './library-history.js'

/** Every folder with a row: made by someone, or holding access rules. */
export async function explicitFolders(db: ScopedDb): Promise<LibraryFolder[]> {
  const rows = await db.libraryFolder.findMany({
    include: { grants: { select: { teammateId: true, access: true } } },
    orderBy: { path: 'asc' },
  })
  return rows.map((r) => ({
    path: r.path,
    explicit: true,
    restricted: r.restricted,
    grants: r.grants,
  }))
}

/** The folders' access rules, for working out what a teammate reaches. */
export async function folderRules(db: ScopedDb): Promise<FolderRule[]> {
  const rows = await db.libraryFolder.findMany({
    where: { OR: [{ restricted: true }, { grants: { some: {} } }] },
    include: { grants: { select: { teammateId: true, access: true } } },
  })
  return rows.map((r) => ({
    path: r.path,
    restricted: r.restricted,
    grants: Object.fromEntries(r.grants.map((g) => [g.teammateId, g.access])),
  }))
}

/** What a teammate may do with each library path. */
export async function teammateLibraryAccess(
  db: ScopedDb,
  teammate: { id: string; libraryAccess: LibraryAccess },
) {
  const rules = await folderRules(db)
  const who = { id: teammate.id, library: teammate.libraryAccess }
  return {
    rules,
    of: (path: string): FolderAccess => libraryAccessFor(path, who, rules),
  }
}

/** Make a folder (and nothing else): an empty one shows in the library until removed. */
export async function createFolder(db: ScopedDb, scope: Scope, actor: Actor, path: string) {
  if (await db.document.findFirst({ where: { kind: 'library', path } }))
    throw new HTTPException(409, { message: 'A file already has that path' })
  const existing = await db.libraryFolder.findFirst({ where: { path } })
  if (existing) return existing
  const row = await db.libraryFolder.create({
    data: { path, createdByType: actor.type, createdById: actor.id } as never,
  })
  await audit({
    ...scope,
    actor,
    action: 'library.folder_created',
    target: { type: 'library_folder', id: row.id },
    data: { path },
  })
  return row
}

const moved = (path: string, from: string, to: string) => to + path.slice(from.length)

/**
 * Rename or move a folder: every file in it and every folder below, at once.
 * Refused when something already has one of the new paths.
 */
export async function moveFolder(
  db: ScopedDb,
  scope: Scope,
  actor: Actor,
  from: string,
  to: string,
) {
  if (from === to) return
  if (inFolder(to, from))
    throw new HTTPException(400, { message: 'A folder cannot go inside itself' })
  const where = { kind: 'library' as const, deletedAt: null }
  const [files, folders] = await Promise.all([
    db.document.findMany({
      where: { ...where, path: { startsWith: `${from}/` } },
      select: { id: true, path: true },
    }),
    db.libraryFolder.findMany({
      where: { OR: [{ path: from }, { path: { startsWith: `${from}/` } }] },
      select: { id: true, path: true },
    }),
  ])
  if (files.length === 0 && folders.length === 0)
    throw new HTTPException(404, { message: 'Folder not found' })
  const targets = files.map((f) => moved(f.path, from, to))
  const clash = await db.document.findFirst({
    where: { kind: 'library', OR: [{ path: { in: targets } }, { path: to }] },
    select: { path: true },
  })
  if (clash) throw new HTTPException(409, { message: `Something is already at ${clash.path}` })
  const folderTargets = folders.map((f) => moved(f.path, from, to))
  const folderClash = await db.libraryFolder.findFirst({
    where: { path: { in: folderTargets }, id: { notIn: folders.map((f) => f.id) } },
    select: { path: true },
  })
  if (folderClash)
    throw new HTTPException(409, { message: `A folder is already at ${folderClash.path}` })

  await prisma.$transaction([
    ...files.map((f) =>
      prisma.document.update({
        where: { id: f.id, workspaceId: scope.workspaceId },
        data: { path: moved(f.path, from, to) },
      }),
    ),
    ...folders.map((f) =>
      prisma.libraryFolder.update({
        where: { id: f.id, workspaceId: scope.workspaceId },
        data: { path: moved(f.path, from, to) },
      }),
    ),
  ])
  await audit({
    ...scope,
    actor,
    action: 'library.folder_moved',
    target: { type: 'library_folder', id: folders.find((f) => f.path === from)?.id ?? from },
    data: { from, to, files: files.length },
  })
  notifyLibraryChanged(scope.workspaceId)
}

/** Put every file in a folder in the trash, and remove the folder and its rules. */
export async function trashFolder(db: ScopedDb, scope: Scope, actor: Actor, path: string) {
  const files = await db.document.findMany({
    where: { kind: 'library', deletedAt: null, path: { startsWith: `${path}/` } },
    select: { id: true },
  })
  for (const file of files) await trashLibraryFile(db, scope, actor, file.id, { quiet: true })
  const removed = await db.libraryFolder.deleteMany({
    where: { OR: [{ path }, { path: { startsWith: `${path}/` } }] },
  })
  if (files.length === 0 && removed.count === 0)
    throw new HTTPException(404, { message: 'Folder not found' })
  await audit({
    ...scope,
    actor,
    action: 'library.folder_trashed',
    target: { type: 'library_folder', id: path },
    data: { path, files: files.length },
  })
  notifyLibraryChanged(scope.workspaceId)
  for (const file of files) notifyCollab(file.id, 'delete')
}

/** Set who among the teammates reaches a folder. */
export async function setFolderAccess(
  db: ScopedDb,
  scope: Scope,
  actor: Actor,
  input: SetFolderAccess,
) {
  const teammates = await db.teammate.findMany({
    where: { id: { in: input.grants.map((g) => g.teammateId) }, archivedAt: null },
    select: { id: true },
  })
  const known = new Set(teammates.map((t) => t.id))
  const grants = input.grants.filter((g) => known.has(g.teammateId))
  if (await db.document.findFirst({ where: { kind: 'library', path: input.path } }))
    throw new HTTPException(409, { message: 'That is a file, not a folder' })

  const existing = await db.libraryFolder.findFirst({ where: { path: input.path } })
  const folder = existing
    ? await db.libraryFolder.update({
        where: { id: existing.id },
        data: { restricted: input.restricted },
      })
    : await db.libraryFolder.create({
        data: {
          path: input.path,
          restricted: input.restricted,
          createdByType: actor.type,
          createdById: actor.id,
        } as never,
      })
  await db.libraryFolderGrant.deleteMany({ where: { folderId: folder.id } })
  if (grants.length > 0)
    await db.libraryFolderGrant.createMany({
      data: grants.map((g) => ({
        folderId: folder.id,
        teammateId: g.teammateId,
        access: g.access,
      })) as never,
    })
  await audit({
    ...scope,
    actor,
    action: 'library.folder_access_changed',
    target: { type: 'library_folder', id: folder.id },
    data: { path: input.path, restricted: input.restricted, grants },
  })
  // The computers' mirrors follow.
  notifyLibraryChanged(scope.workspaceId)
}
