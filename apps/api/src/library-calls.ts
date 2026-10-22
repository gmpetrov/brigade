// A teammate's search, library saves, moves and deletes, and design systems, and
// the memory a quiet thread leaves behind. Both come from a runner over its socket;
// the API checks the thread is on that runner's computer and the teammate's grant.
import {
  formatMention,
  LIBRARY_SAVE_MAX,
  TRASH_DAYS,
  type ApiToRunner,
  type RunnerToApi,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit } from './audit.js'
import { scoped, type Scope } from './db.js'
import { personEdits, saveTeammateDesignSystem } from './designs.js'
import { notifyLibraryChanged } from './hub.js'
import { libraryChangeRefusal } from './library-changes.js'
import { moveFolder, teammateLibraryAccess, trashFolder } from './library-folders.js'
import { trashLibraryFile } from './library-history.js'
import {
  editMemory,
  moveLibraryFile,
  saveLibraryFile,
  saveSummary,
  search,
  tidyMemory,
} from './library.js'
import { proposeSkill } from './skills.js'
import { actingTeammate } from './thread-spec.js'

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
    return done(await proposeSkill(db, scope, teammate, session.id, op.proposal))

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
  if (access !== 'read_write')
    return fail(
      access === 'none'
        ? `${teammate.name} has no access to that folder of the library.`
        : `${teammate.name} may read ${op.path.includes('/') ? 'that folder of ' : ''}the library but not save to it. An admin can allow it in the library or on the teammate's page.`,
    )
  const bytes = Buffer.from(op.content, 'base64')
  if (bytes.byteLength > LIBRARY_SAVE_MAX)
    return fail('Files saved from a thread can be up to 10 MB')
  const row = await saveLibraryFile(
    db,
    scope,
    { type: 'teammate', id: teammate.id },
    { path: op.path, bytes, contentType: op.contentType ?? null },
    { sessionId: session.id },
  )
  // The mention opens this file from the teammate's reply, where a bare name may not.
  return done({
    path: row.path,
    size: row.size,
    contentType: row.contentType,
    mention: formatMention({ kind: 'document', id: row.id, label: row.path }),
  })
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
  notifyLibraryChanged(scope.workspaceId)
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
