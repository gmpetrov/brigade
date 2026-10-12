// Live previews: apps teammates run in their threads, for people to try. The
// runner keeps the process and reports it as preview.changed events; the API
// hosts a cloud computer's ports with the provider and hands out the address,
// with its token, only to people who may see the thread.
import { randomUUID } from 'node:crypto'
import {
  PREVIEW_PROTOCOL,
  PreviewInfo,
  PreviewRecipe,
  type ApiToRunner,
  type RunnerToApi,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit } from './audit.js'
import { hostedPort } from './cloud.js'
import { prisma, scoped, type Prisma } from './db.js'
import type { ScopedDb } from './db.js'
import { runnerProtocol, sendToRunner } from './hub.js'
import { actingTeammate } from './thread-spec.js'

type Runner = { computerId: string; organizationId: string; workspaceId: string }

/** A thread's preview as its latest event says, or null when it never had one. */
export async function latestPreview(db: ScopedDb, sessionId: string) {
  const row = await db.sessionEvent.findFirst({
    where: { sessionId, type: 'preview.changed' },
    orderBy: { seq: 'desc' },
    select: { data: true },
  })
  const parsed = row ? PreviewInfo.safeParse(row.data) : null
  return parsed?.success ? parsed.data : null
}

/** The preview a person acts on: one that is starting or running, on a runner that runs previews. */
export async function livePreview(db: ScopedDb, thread: { id: string; computer: { id: string } }) {
  const preview = await latestPreview(db, thread.id)
  if (!preview || (preview.status !== 'starting' && preview.status !== 'running'))
    throw new HTTPException(409, { message: 'This thread has no preview running' })
  if ((runnerProtocol(thread.computer.id) ?? 0) < PREVIEW_PROTOCOL)
    throw new HTTPException(409, {
      message: 'The computer is offline, so the preview is too. It starts again with the app.',
    })
  return preview
}

/** Tell the runner someone has the preview open, so it does not expire. */
export function touchPreview(computerId: string, sessionId: string) {
  sendToRunner(computerId, { type: 'preview.control', sessionId, action: 'touch' })
}

/**
 * A runner asks for the public origins of a preview's ports before starting
 * it. Only for a thread on its own computer, and only on a cloud computer.
 */
export async function handlePreviewExpose(
  runner: Runner,
  call: Extract<RunnerToApi, { type: 'preview.expose' }>,
  reply: (message: ApiToRunner) => void,
) {
  const fail = (error: string) =>
    reply({ type: 'connector.result', callId: call.callId, ok: false, error })
  const session = await prisma.session.findFirst({
    where: { id: call.sessionId, computerId: runner.computerId },
    include: { computer: true },
  })
  if (!session) return fail('Unknown thread')
  if (session.computer.kind !== 'cloud') return fail('Only the workspace computer hosts previews')
  const origins: Record<number, string> = {}
  const urls: Record<number, string> = {}
  for (const port of call.ports) {
    const hosted = await hostedPort(session.computer, port)
    origins[port] = hosted.origin
    if (call.token) urls[port] = hosted.url
  }
  reply({
    type: 'connector.result',
    callId: call.callId,
    ok: true,
    output: call.token ? { origins, urls } : { origins },
  })
}

type LogsResult = Extract<RunnerToApi, { type: 'preview.logs.result' }>
const logReads = new Map<string, { computerId: string; settle: (result: LogsResult) => void }>()

/** A thread's preview output, from its computer. */
export function previewLogs(computerId: string, sessionId: string) {
  return new Promise<LogsResult>((resolve) => {
    const requestId = randomUUID()
    const settle = (result: LogsResult) => {
      clearTimeout(timer)
      logReads.delete(requestId)
      resolve(result)
    }
    const fail = (error: string) =>
      settle({ type: 'preview.logs.result', requestId, ok: false, error })
    const timer = setTimeout(() => fail('The computer did not answer'), 10_000)
    logReads.set(requestId, { computerId, settle })
    if (!sendToRunner(computerId, { type: 'preview.logs', requestId, sessionId }, { touch: false }))
      fail('The computer is offline')
  })
}

/** A runner's answer to previewLogs; only the computer asked may answer. */
export function settlePreviewLogs(computerId: string, result: LogsResult) {
  const read = logReads.get(result.requestId)
  if (read?.computerId === computerId) read.settle(result)
}

/**
 * A teammate reads a repository's saved preview recipe, or saves the one its
 * thread's preview runs (the runner saves only one whose check passed). One
 * per repository and workspace; saving again replaces it.
 */
export async function handlePreviewCall(
  runner: Runner,
  call: Extract<RunnerToApi, { type: 'preview.call' }>,
  reply: (message: ApiToRunner) => void,
) {
  const scope = { organizationId: runner.organizationId, workspaceId: runner.workspaceId }
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
  const repository = op.repository.toLowerCase()

  if (op.name === 'get') {
    const row = await db.previewRecipe.findFirst({ where: { repository } })
    const parsed = row ? PreviewRecipe.safeParse(row.recipe) : null
    return done({ recipe: parsed?.success ? parsed.data : null, updatedAt: row?.updatedAt })
  }

  const recipe = op.recipe as Prisma.InputJsonValue
  const saved = await db.previewRecipe.upsert({
    where: { workspaceId_repository: { workspaceId: scope.workspaceId, repository } },
    create: {
      repository,
      recipe,
      savedByTeammateId: teammate.id,
      savedFromSessionId: session.id,
    } as never,
    update: { recipe, savedByTeammateId: teammate.id, savedFromSessionId: session.id },
  })
  await audit({
    ...scope,
    actor: { type: 'teammate', id: teammate.id },
    action: 'preview.recipe_saved',
    target: { type: 'repository', id: repository },
    data: { sessionId: session.id, recipeId: saved.id },
  })
  return done({ saved: true })
}
