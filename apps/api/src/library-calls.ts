// A teammate's search and library saves, and the memory a quiet thread
// leaves behind. Both come from a runner over its socket; the API checks the
// thread is on that runner's computer and the teammate's grant.
import { LIBRARY_SAVE_MAX, type ApiToRunner, type RunnerToApi } from '@brigade/contracts'
import { audit } from './audit.js'
import { scoped, type Scope } from './db.js'
import { notifyLibraryChanged } from './hub.js'
import { editMemory, saveLibraryFile, saveSummary, search } from './library.js'
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
    const hits = await search(scope, { query: op.query, limit: op.limit, teammateId: teammate.id })
    return done(hits)
  }

  if (teammate.libraryAccess !== 'read_write')
    return fail(
      `${teammate.name} may read the library but not save to it. An admin can allow it on the teammate's page.`,
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
  return done({ path: row.path, size: row.size, contentType: row.contentType })
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
  for (const { teammateId, edit } of update.teammates) {
    // Only teammates of this thread learn from it.
    const seat = session.teammates.find((t) => t.teammateId === teammateId)
    if (!seat) continue
    await editMemory(
      db,
      scope,
      { type: 'teammate', id: teammateId },
      { kind: 'teammate_memory', teammateId, teammateName: seat.teammate.name },
      edit,
      session.id,
    )
  }
  notifyLibraryChanged(scope.workspaceId)
}
