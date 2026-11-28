// A teammate's search, library saves, moves and deletes, and design systems, and
// the memory a quiet thread leaves behind. Both come from a runner over its socket;
// the API checks the thread is on that runner's computer and the teammate's grant.
import {
  formatMention,
  LIBRARY_FILE_MAX,
  LIBRARY_READ_MAX,
  TRASH_DAYS,
  type ApiToRunner,
  type RunnerToApi,
  retiredAppFolderRefusal,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit } from './audit.js'
import { scoped, type Scope, type ScopedDb } from './db.js'
import { personEdits, saveTeammateDesignSystem } from './designs.js'
import { hubs } from './hub.js'
import { libraryChangeRefusal } from './library-changes.js'
import { moveFolder, saveRefusal, teammateLibraryAccess, trashFolder } from './library-folders.js'
import { actorNames, trashLibraryFile } from './library-history.js'
import {
  editMemory,
  moveLibraryFile,
  readLibraryFile,
  saveLibraryFile,
  saveSummary,
  search,
  StaleMemory,
  tidyMemory,
} from './library.js'
import { proposeSkill } from './skills.js'
import { actingTeammate, shownAccounts } from './thread-spec.js'
import { toolStateFor } from './tools.js'
import { claimUpload, discardUpload, readyUpload, uploadBytesKey } from './uploads.js'

type Runner = { computerId: string; organizationId: string; workspaceId: string }

export async function handleLibraryCall(
  runner: Runner,
  call: Extract<RunnerToApi, { type: 'library.call' }>,
  reply: (message: ApiToRunner) => void,
) {
  const scope: Scope = { organizationId: runner.organizationId, workspaceId: runner.workspaceId }
  const db = scoped(scope)
  const done = (output: unknown) =>
    reply({ type: 'connector.result', callId: call.callId, ok: true, output })
  const fail = (error: string) =>
    reply({ type: 'connector.result', callId: call.callId, ok: false, error })

  const session = await db.session.findFirst({
    where: { id: call.sessionId, computerId: runner.computerId },
  })
  if (!session) return fail('Unknown thread')
  const teammate = await actingTeammate(db, session, call.teammateId)
  if (!teammate) return fail('That teammate is not in this thread')
  const op = call.operation

  if (op.name === 'search') {
    const hits = await search(scope, { query: op.query, limit: op.limit, teammate })
    return done(hits)
  }

  if (op.name === 'design_system') {
    const library = await teammateLibraryAccess(db, teammate)
    try {
      const { row, created } = await saveTeammateDesignSystem(
        db,
        scope,
        teammate.id,
        op.designSystem,
        (path) => library.of(path) === 'read_write',
      )
      return done({
        name: row.name,
        path: row.path,
        created,
        isDefault: row.isDefault,
        folders: row.folders,
        repositories: row.repositories,
      })
    } catch (error) {
      if (error instanceof HTTPException) return fail(error.message)
      throw error
    }
  }

  if (op.name === 'skill_proposal')
    try {
      return done(await proposeSkill(db, scope, teammate, session.id, op.proposal))
    } catch (error) {
      if (error instanceof HTTPException) return fail(error.message)
      throw error
    }

  if (op.name === 'move' || op.name === 'delete') {
    const to = op.name === 'move' ? op.to : undefined
    if (to === op.path) return done({ path: to, moved: 0 })
    const file = await db.document.findFirst({
      where: { kind: 'library', path: op.path, deletedAt: null },
      select: { id: true },
    })
    const below = { OR: [{ path: op.path }, { path: { startsWith: `${op.path}/` } }] }
    const [files, folders, projects] = file
      ? [[], [], []]
      : await Promise.all([
          db.document.findMany({
            where: { kind: 'library', deletedAt: null, path: { startsWith: `${op.path}/` } },
            select: { path: true },
          }),
          db.libraryFolder.findMany({
            where: below,
            select: { path: true, restricted: true, _count: { select: { grants: true } } },
          }),
          db.project.findMany({
            where: { OR: [{ folder: op.path }, { folder: { startsWith: `${op.path}/` } }] },
            select: { name: true, folder: true },
          }),
        ])
    if (!file && files.length === 0 && folders.length === 0)
      return fail(`Nothing in the library at ${op.path}.`)
    const library = await teammateLibraryAccess(db, teammate)
    const refusal = libraryChangeRefusal(teammate.name, library.of, {
      path: op.path,
      to,
      files: files.map((f) => f.path),
      ruled: folders.filter((f) => f.restricted || f._count.grants > 0).map((f) => f.path),
      projects: projects.map((p) => ({ name: p.name, folder: p.folder! })),
    })
    if (refusal) return fail(refusal)
    const actor = { type: 'teammate' as const, id: teammate.id }
    try {
      if (to !== undefined) {
        if (file) await moveLibraryFile(db, scope, actor, file.id, to)
        else await moveFolder(db, scope, actor, op.path, to)
        return done({ path: to, moved: file ? 1 : files.length })
      }
      if (file) await trashLibraryFile(db, scope, actor, file.id)
      else await trashFolder(db, scope, actor, op.path)
      return done({
        trashed: file ? 1 : files.length,
        status: `In the library's trash: a person can restore it there for ${TRASH_DAYS} days.`,
      })
    } catch (error) {
      if (error instanceof HTTPException) return fail(error.message)
      throw error
    }
  }

  const access = (await teammateLibraryAccess(db, teammate)).of(op.path)
  if (op.name === 'design_edits')
    return access === 'none'
      ? fail(`${teammate.name} has no access to that folder of the library.`)
      : done(await personEdits(db, session, op.path))
  if (op.name === 'tool_state') {
    if (access === 'none')
      return fail(`${teammate.name} has no access to that folder of the library.`)
    // The shared keys, and the own keys of the person the thread works for, if one.
    const { person } = await shownAccounts(db, session)
    try {
      return done(await toolStateFor(db, scope, op.path, person))
    } catch (error) {
      if (error instanceof HTTPException) return fail(error.message)
      throw error
    }
  }
  const refusal = saveRefusal(teammate.name, access, op.path) ?? retiredAppFolderRefusal(op.path)
  if (refusal) return fail(refusal)
  const actor = { type: 'teammate' as const, id: teammate.id }
  // save_to_library's guard: never over a change it has not seen. What it may replace is checked
  // again as it commits (expect): a save meanwhile refuses this one too.
  const guarded = !!(op.guard || op.base)
  let expect: { sha256: string } | { absent: true } | undefined
  if (guarded) {
    const check = await guardedBase(db, session, op.path, op.base)
    if (!check.ok) return fail(await overwriteRefusal(db, scope, op.path, check.row))
    expect = check.expect
  }
  const context = { sessionId: session.id, ...(guarded ? { guardedBy: session.id } : {}) }
  const stale = async (error: unknown) => {
    if (!(error instanceof StaleMemory)) return false
    const row = await db.document.findFirst({
      where: { kind: 'library', path: op.path, deletedAt: null },
    })
    fail(await overwriteRefusal(db, scope, op.path, row))
    return true
  }
  let row
  if (op.upload) {
    // Uploaded straight to the bucket by the runner, and checked (routes/runner-uploads.ts).
    const owner = { computerId: runner.computerId, sessionId: session.id }
    try {
      const upload = await readyUpload(db, owner, op.upload.id, 'library')
      if (upload.size > LIBRARY_FILE_MAX)
        return fail('Files saved from a thread can be up to 500 MB')
      // Taken for this save alone: the same save sent again (a runner that restarted before it
      // heard this one's answer) writes nothing, rather than over what was saved there since.
      if (!(await claimUpload(db, upload.id)))
        return fail('This upload was used or refused; upload it again')
      row = await saveLibraryFile(
        db,
        scope,
        actor,
        {
          path: op.path,
          contentType: op.contentType ?? upload.contentType,
          upload: { key: uploadBytesKey(scope, upload), ...upload },
        },
        context,
        { expect },
      )
      await discardUpload(scope, upload.id)
    } catch (error) {
      if (error instanceof HTTPException) return fail(error.message)
      if (await stale(error)) return discardUpload(scope, op.upload.id)
      throw error
    }
  } else {
    // A runner before DIRECT_UPLOAD_PROTOCOL: the bytes in the message. Remove with it.
    const bytes = Buffer.from(op.content ?? '', 'base64')
    if (bytes.byteLength > LIBRARY_READ_MAX)
      return fail(
        "Files saved from a thread can be up to 25 MB until this computer's runner is updated",
      )
    try {
      row = await saveLibraryFile(
        db,
        scope,
        actor,
        { path: op.path, bytes, contentType: op.contentType ?? null },
        context,
        { expect },
      )
    } catch (error) {
      if (await stale(error)) return
      throw error
    }
  }
  // The mention opens this file from the teammate's reply, where a bare name may not.
  return done({
    path: row.path,
    size: row.size,
    contentType: row.contentType,
    mention: formatMention({ kind: 'document', id: row.id, label: row.path }),
  })
}

/** The library's text of a file save_to_library refuses to save over, at most this long. */
const REFUSAL_TEXT_MAX = 200_000

type LibraryRow = {
  id: string
  objectKey: string | null
  size: number
  sha256: string
  contentType: string
  updatedAt: Date
  updatedByType: string | null
  updatedById: string | null
}

/**
 * What a save_to_library save may replace: with `base`, the file with that SHA-256 (the one a
 * refusal gave); else the file exactly as this thread last saved it whole with save_to_library,
 * or, never having, a file nobody changed since the thread started, or no file. Anything else is
 * a change it has not seen: a person's, another thread's, a list's (its own add_item included,
 * which its file on this computer lacks too).
 */
async function guardedBase(
  db: ScopedDb,
  session: { id: string; createdAt: Date; workspaceId: string },
  path: string,
  base: string | undefined,
): Promise<
  | { ok: true; expect: { sha256: string } | { absent: true } }
  | { ok: false; row: LibraryRow | null }
> {
  const row = await db.document.findFirst({ where: { kind: 'library', path, deletedAt: null } })
  if (base)
    return row?.sha256 === base ? { ok: true, expect: { sha256: base } } : { ok: false, row }
  if (!row) return { ok: true, expect: { absent: true } }
  // Its last guarded save of this file: the audit entry is written with the save, before it
  // answers, and names the SHA-256 it wrote.
  const last = await db.auditEntry.findFirst({
    where: {
      workspaceId: session.workspaceId,
      targetType: 'document',
      targetId: row.id,
      action: { in: ['library.file_added', 'library.file_replaced'] },
      at: { gte: session.createdAt },
      data: { path: ['guardedBy'], equals: session.id },
    },
    orderBy: { at: 'desc' },
    select: { data: true },
  })
  const saved = (last?.data as { sha256?: unknown } | null)?.sha256
  const unchanged =
    typeof saved === 'string'
      ? row.sha256 === saved
      : row.updatedAt.getTime() <= session.createdAt.getTime()
  return unchanged ? { ok: true, expect: { sha256: row.sha256 } } : { ok: false, row }
}

/**
 * Why save_to_library saved nothing: who changed the file last, and the file as it is now, to
 * make the change on (the teammate's mirror may not have it yet).
 */
async function overwriteRefusal(db: ScopedDb, scope: Scope, path: string, row: LibraryRow | null) {
  if (!row)
    return `Nothing is at \`${path}\` in the library now: it was moved or deleted since. Nothing was saved. Save again without base to add it anew.`
  const name = await actorNames(db, [{ type: row.updatedByType ?? '', id: row.updatedById ?? '' }])
  const who = name(row.updatedByType, row.updatedById)?.name ?? 'Someone'
  const head =
    `\`${path}\` changed in the library since you last saved it (last by ${who}), and your file would undo that. Nothing was saved. ` +
    `Make your change on the library's file as it is now (SHA-256 ${row.sha256}), then save it with base: "${row.sha256}".`
  const text =
    row.size <= REFUSAL_TEXT_MAX &&
    (/^text\//.test(row.contentType) || /json|markdown|xml|yaml/.test(row.contentType))
      ? await readLibraryFile(scope, row)
          .then((bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes))
          .catch(() => null)
      : null
  if (text === null)
    return `${head} Its copy in your library mirror is that one once its SHA-256 matches; it updates shortly after a save.`
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)))
  return `${head} It is:\n\n${fence}\n${text}\n${fence}`
}

/**
 * What a short harness run took from a quiet thread: its summary, and lines
 * for the memory files. A private thread leaves workspace memory alone.
 */
export async function handleMemoryUpdate(
  runner: Runner,
  update: Extract<RunnerToApi, { type: 'memory.update' }>,
) {
  const scope: Scope = { organizationId: runner.organizationId, workspaceId: runner.workspaceId }
  const db = scoped(scope)
  const session = await db.session.findFirst({
    where: { id: update.sessionId, computerId: runner.computerId },
    include: { teammates: { include: { teammate: true } } },
  })
  if (!session) return
  const actor = { type: 'teammate' as const, id: session.teammateId }

  const summary = await saveSummary(db, scope, session, update.summary)
  await audit({
    ...scope,
    actor,
    action: 'memory.summary_saved',
    target: { type: 'document', id: summary.id },
    data: { sessionId: session.id },
  })
  if (!session.private)
    await editMemory(db, scope, actor, { kind: 'workspace_memory' }, update.workspace, session.id)
  // Into the project the thread is in now, if it still is in one. A private thread leaves it alone.
  const project = session.projectId
    ? await db.project.findFirst({
        where: { id: session.projectId },
        select: { id: true, name: true },
      })
    : null
  if (project && update.project && !session.private)
    await editMemory(
      db,
      scope,
      actor,
      { kind: 'project_memory', projectId: project.id, name: project.name },
      update.project,
      session.id,
    )
  for (const { teammateId, edit } of update.teammates) {
    // Only teammates of this thread learn from it.
    const seat = session.teammates.find((t) => t.teammateId === teammateId)
    if (!seat) continue
    await editMemory(
      db,
      scope,
      { type: 'teammate', id: teammateId },
      { kind: 'teammate_memory', teammateId, name: seat.teammate.name },
      edit,
      session.id,
    )
  }
  void hubs.get(scope.workspaceId).notifyLibraryChanged()
}

/**
 * A tidy run's new layout for one memory file, run on the account of a thread
 * that went quiet. Only for a file that thread may edit: the workspace's (not
 * from a private thread), its project's, or one of its teammates'.
 */
export async function handleMemoryTidy(
  runner: Runner,
  tidy: Extract<RunnerToApi, { type: 'memory.tidy' }>,
) {
  const scope: Scope = { organizationId: runner.organizationId, workspaceId: runner.workspaceId }
  const db = scoped(scope)
  const session = await db.session.findFirst({
    where: { id: tidy.sessionId, computerId: runner.computerId },
    include: { teammates: { include: { teammate: true } } },
  })
  if (!session) return
  const { file } = tidy
  const input = { sessionId: session.id, lastTidied: tidy.lastTidied }
  if (file.kind === 'workspace') {
    if (session.private) return
    await tidyMemory(
      scope,
      { type: 'teammate', id: session.teammateId },
      { kind: 'workspace_memory' },
      tidy.layout,
      input,
    )
  } else if (file.kind === 'project') {
    if (session.private || session.projectId !== file.projectId) return
    const project = await db.project.findFirst({
      where: { id: file.projectId },
      select: { id: true, name: true },
    })
    if (!project) return
    await tidyMemory(
      scope,
      { type: 'teammate', id: session.teammateId },
      { kind: 'project_memory', projectId: project.id, name: project.name },
      tidy.layout,
      input,
    )
  } else {
    const seat = session.teammates.find((t) => t.teammateId === file.teammateId)
    if (!seat) return
    await tidyMemory(
      scope,
      { type: 'teammate', id: file.teammateId },
      { kind: 'teammate_memory', teammateId: file.teammateId, name: seat.teammate.name },
      tidy.layout,
      input,
    )
  }
}
