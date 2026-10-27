// Live previews: apps teammates run in their threads, for people to try. The
// runner keeps the process and reports it as preview.changed events; the API
// hosts a cloud computer's ports with the provider and hands out the address,
// with its token, only to people who may see the thread.
import { randomUUID } from 'node:crypto'
import {
  PREVIEW_PROTOCOL,
  PREVIEW_START_PROTOCOL,
  PreviewInfo,
  PreviewRecipe,
  previewReady,
  type ApiToRunner,
  type PreviewStartOutcome,
  type RunnerToApi,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit } from './audit.js'
import { cloudAvailable, forgetPreviewAddress, hostedPort } from './cloud.js'
import { prisma, scoped, type Prisma } from './db.js'
import type { ScopedDb } from './db.js'
import { hubs, type ComputerPresence } from './hub.js'
import { latestEvents } from './latest-events.js'
import { previewEnded } from './preview-gateway.js'
import { variableNames, variableValues } from './preview-variables.js'
import { actingTeammate, currentTeammate, type LoadedThread } from './thread-spec.js'

type Runner = { computerId: string; organizationId: string; workspaceId: string }

/** Said when a preview's events say it runs, but it was lost with its runner's previous process. */
const LOST = 'Stopped when the computer restarted'

/** A computer of a workspace, as its hub tells how it is connected. */
type Hosted = { id: string; workspaceId: string }

/**
 * Whether a preview reported at `at` was lost: its computer's runner has restarted since,
 * and previews do not outlive their runner. Its stop may never have been reported (the
 * computer was stopped or crashed before it could say so).
 */
function lost(presence: ComputerPresence | undefined, at: Date) {
  const startedAt = presence?.startedAt
  return !!startedAt && at.getTime() < Date.parse(startedAt)
}

/**
 * A thread's preview as its latest event says (with the teammate running it), or null when it
 * never had one. With its computer: stopped when it was lost with a runner that restarted since.
 */
export async function latestPreview(db: ScopedDb, sessionId: string, computer?: Hosted) {
  const row = await db.sessionEvent.findFirst({
    where: { sessionId, type: 'preview.changed' },
    orderBy: { seq: 'desc' },
    select: { data: true, at: true },
  })
  const preview = row ? previewOf(row.data) : null
  if (
    preview &&
    computer &&
    (preview.status === 'starting' || preview.status === 'running') &&
    lost((await hubs.get(computer.workspaceId).presence([computer.id]))[computer.id], row!.at)
  )
    return { ...preview, status: 'stopped' as const, reason: LOST }
  return preview
}

function previewOf(data: unknown): (PreviewInfo & { teammateId?: string }) | null {
  const parsed = PreviewInfo.safeParse(data)
  if (!parsed.success) return null
  const teammateId = (data as { teammateId?: unknown }).teammateId
  return typeof teammateId === 'string' ? { ...parsed.data, teammateId } : parsed.data
}

/** Where each of these threads' previews stands, for lists: starting, running or ready; null when none runs. */
export async function previewStates(db: ScopedDb, sessionIds: string[]) {
  const states = new Map<string, 'starting' | 'running' | 'ready' | null>()
  if (!sessionIds.length) return states
  const [rows, sessions] = await Promise.all([
    latestEvents(db, sessionIds, 'preview.changed'),
    db.session.findMany({
      where: { id: { in: sessionIds } },
      select: { id: true, computerId: true, workspaceId: true },
    }),
  ])
  const computers = new Map(sessions.map((s) => [s.id, s.computerId]))
  const presence = sessions.length
    ? await hubs.get(sessions[0]!.workspaceId).presence([...new Set(computers.values())])
    : {}
  for (const row of rows) {
    const preview = previewOf(row.data)
    const computerId = computers.get(row.sessionId)
    states.set(
      row.sessionId,
      !preview ||
        (preview.status !== 'starting' && preview.status !== 'running') ||
        (computerId && lost(presence[computerId], row.at))
        ? null
        : previewReady(preview)
          ? 'ready'
          : preview.status,
    )
  }
  return states
}

/** A thread's preview ended: its address on the preview gateway stops working. */
export function notePreviewEvents(sessionId: string, events: { event: { type: string } }[]) {
  if (previewEnded(events)) forgetPreviewAddress(sessionId)
}

/** Stop a thread's preview if one runs, saying why (its pull request merged). */
export async function stopThreadPreview(db: ScopedDb, sessionId: string, reason: string) {
  const session = await db.session.findFirst({
    where: { id: sessionId },
    select: { computerId: true, workspaceId: true },
  })
  if (!session) return
  const computer = { id: session.computerId, workspaceId: session.workspaceId }
  const preview = await latestPreview(db, sessionId, computer)
  if (!preview || (preview.status !== 'starting' && preview.status !== 'running')) return
  await hubs.get(session.workspaceId).sendToRunner(session.computerId, {
    type: 'preview.control',
    sessionId,
    action: 'stop',
    reason,
  })
}

/**
 * A person starts a thread's preview without a turn. The runner starts it
 * again as it last ran, or from a saved setup of a repository the thread has
 * checked out; or says the teammate has to set it up. A runner from before
 * that always needs the teammate.
 */
export async function startPreview(
  db: ScopedDb,
  thread: LoadedThread,
  repository?: string,
): Promise<PreviewStartOutcome> {
  const hub = hubs.get(thread.workspaceId)
  const protocol = await hub.runnerProtocol(thread.computer.id)
  // A stopped workspace computer starts first; the dashboard asks again once it is up.
  if (protocol === undefined && thread.computer.kind === 'cloud' && cloudAvailable()) {
    await hub.ensureRunning(thread.computer.id)
    return { outcome: 'waking' }
  }
  if (protocol === undefined)
    throw new HTTPException(409, {
      message:
        thread.computer.kind === 'cloud'
          ? 'The cloud computer is not running. It starts with the next message.'
          : `${thread.computer.name} is offline. Start its runner and try again.`,
    })
  if (protocol < PREVIEW_START_PROTOCOL) return { outcome: 'setup', repositories: [] }
  // Whoever ran it last first, then whom the thread asked last, then the rest.
  const last = await latestPreview(db, thread.id)
  const teammateIds = [
    ...new Set([
      ...(last?.teammateId ? [last.teammateId] : []),
      currentTeammate(thread).id,
      thread.teammateId,
      ...thread.teammates.map((t) => t.teammateId),
    ]),
  ].slice(0, 10)
  const answer = await hub.askRunner(
    thread.computer.id,
    {
      type: 'preview.start',
      requestId: randomUUID(),
      sessionId: thread.id,
      teammateIds,
      ...(repository ? { repository: repository.toLowerCase() } : {}),
    },
    60_000,
  )
  const result = 'type' in answer && answer.type === 'preview.start.result' ? answer : null
  if (!result?.ok || !result.result)
    throw new HTTPException(409, {
      message:
        result?.error ??
        ('error' in answer ? answer.error : undefined) ??
        'The preview could not start',
    })
  return result.result
}

type PreviewComputer = { id: string; kind: string; name: string; workspaceId: string }

/**
 * Why a thread's preview cannot be running, whatever its events say: its computer is offline (a
 * stopped workspace computer lost its processes), or its runner runs no previews. Undefined when
 * it may be running. With the computers' presence, for a list (previewOfflineIn).
 */
export async function previewOffline(computer: PreviewComputer) {
  const presence = await hubs.get(computer.workspaceId).presence([computer.id])
  return previewOfflineIn(presence, computer)
}

export function previewOfflineIn(
  presence: Record<string, ComputerPresence>,
  computer: Omit<PreviewComputer, 'workspaceId'>,
) {
  if ((presence[computer.id]?.protocolVersion ?? 0) >= PREVIEW_PROTOCOL) return undefined
  return computer.kind === 'cloud'
    ? 'Stopped with the cloud computer'
    : `Stopped: ${computer.name} is offline`
}

/** The preview a person acts on: one that is starting or running, on a runner that runs previews. */
export async function livePreview(db: ScopedDb, thread: { id: string; computer: PreviewComputer }) {
  const preview = await latestPreview(db, thread.id, thread.computer)
  if (!preview || (preview.status !== 'starting' && preview.status !== 'running'))
    throw new HTTPException(409, { message: 'This thread has no preview running' })
  if (await previewOffline(thread.computer))
    throw new HTTPException(409, {
      message:
        thread.computer.kind === 'cloud'
          ? 'The cloud computer stopped, so the preview did too. Start it again from the preview panel.'
          : `${thread.computer.name} is offline, so the preview is too. Start its runner, then the preview.`,
    })
  return preview
}

/** Tell the runner someone has the preview open, so it does not expire. */
export function touchPreview(computer: Hosted, sessionId: string) {
  return hubs
    .get(computer.workspaceId)
    .sendToRunner(computer.id, { type: 'preview.control', sessionId, action: 'touch' })
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
  if (session.computer.kind !== 'cloud') return fail('Only the cloud computer hosts previews')
  const origins: Record<number, string> = {}
  const urls: Record<number, string> = {}
  for (const port of call.ports) {
    const hosted = await hostedPort(session.computer, port, session.id)
    origins[port] = hosted.origin
    if (call.token && !hosted.url) return fail('The preview gateway did not answer')
    if (call.token) urls[port] = hosted.url!
  }
  reply({
    type: 'connector.result',
    callId: call.callId,
    ok: true,
    output: call.token ? { origins, urls } : { origins },
  })
}

type LogsResult = Extract<RunnerToApi, { type: 'preview.logs.result' }>

/** A thread's preview output, from its computer. */
export async function previewLogs(computer: Hosted, sessionId: string): Promise<LogsResult> {
  const requestId = randomUUID()
  const answer = await hubs
    .get(computer.workspaceId)
    .askRunner(computer.id, { type: 'preview.logs', requestId, sessionId }, 10_000, {
      touch: false,
    })
  if ('type' in answer && answer.type === 'preview.logs.result') return answer
  return {
    type: 'preview.logs.result',
    requestId,
    ok: false,
    error: 'error' in answer ? answer.error : 'The computer did not answer',
  }
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
    return done({
      recipe: parsed?.success ? parsed.data : null,
      updatedAt: row?.updatedAt,
      // Names only: their values go to the app, never to the teammate.
      variables: await variableNames(db, repository),
    })
  }

  if (op.name === 'variables') {
    // The runner starts the preview with them; it never hands them to the teammate.
    const { env, secrets } = await variableValues(db, scope, repository)
    if (secrets.length)
      await audit({
        ...scope,
        actor: { type: 'teammate', id: teammate.id },
        action: 'preview.secrets_used',
        target: { type: 'repository', id: repository },
        data: { sessionId: session.id, names: secrets },
      })
    return done({ env, secrets })
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
