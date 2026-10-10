// The workspace cloud computer: created with the workspace, stopped when idle,
// resumed on demand. Provider details stay inside @brigade/providers.
import { providerFromEnv, type ComputerRef } from '@brigade/providers'
import { audit } from './audit.js'
import { defaults, env } from './config.js'
import { prisma } from './db.js'
import { broadcastComputer, isOnline, notifyLibraryChanged, runnerProtocol } from './hub.js'
import { bootstrapScript, reinstallScript, SETUP_SHA, setupScript } from './cloud-bootstrap.js'
import { issueLinkCode } from './link-codes.js'
import { runnerBundle } from './routes/runner-install.js'

const provider = providerFromEnv(process.env)

export const cloudAvailable = () => provider !== null

const lastActive = new Map<string, number>()

/** Mark a cloud computer as in use, which postpones its idle stop. */
export function touch(computerId: string) {
  lastActive.set(computerId, Date.now())
}

async function setStatus(
  computer: { id: string; workspaceId: string },
  status: 'creating' | 'starting' | 'running' | 'stopped' | 'error',
) {
  await prisma.computer.update({ where: { id: computer.id }, data: { status } })
  broadcastComputer(computer.workspaceId, computer.id)
}

/** Create the workspace's cloud computer and install its runner, in the background. */
export async function createWorkspaceComputer(workspace: { id: string; organizationId: string }) {
  if (!provider) return null
  const existing = await prisma.computer.findFirst({
    where: { workspaceId: workspace.id, kind: 'cloud', status: { not: 'destroyed' } },
  })
  if (existing) return existing
  const computer = await prisma.computer.create({
    data: {
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      kind: 'cloud',
      name: 'Workspace computer',
      size: defaults.cloudComputerSize,
      status: 'creating',
    },
  })
  void provision(computer).catch(async (error) => {
    console.error(`provisioning ${computer.id} failed:`, error)
    await setStatus(computer, 'error')
  })
  return computer
}

async function provision(computer: { id: string; organizationId: string; workspaceId: string }) {
  const ref = await provider!.create({
    workspaceId: computer.workspaceId,
    size: defaults.cloudComputerSize,
  })
  await prisma.computer.update({ where: { id: computer.id }, data: { providerRef: ref } })
  const { code } = await issueLinkCode({
    kind: 'cloud',
    organizationId: computer.organizationId,
    workspaceId: computer.workspaceId,
    computerId: computer.id,
  })
  const result = await provider!.exec(ref, bootstrapScript({ apiUrl: env.API_URL, code }))
  if (result.exitCode !== 0)
    throw new Error(`runner install failed (${result.exitCode}): ${result.stderr.slice(-2000)}`)
  await audit({
    organizationId: computer.organizationId,
    workspaceId: computer.workspaceId,
    actor: { type: 'system', id: 'brigade' },
    action: 'computer.created',
    target: { type: 'computer', id: computer.id },
  })
  // The runner connects on its own; its hello marks the computer running.
}

const refOf = (computer: { providerRef: unknown }) => computer.providerRef as ComputerRef | null

/**
 * Make sure a cloud computer is on its way up. Returns at once; commands for
 * it wait in the hub until its runner connects.
 */
export async function ensureRunning(computerId: string) {
  touch(computerId)
  if (!provider) return
  const computer = await prisma.computer.findUnique({ where: { id: computerId } })
  const ref = computer && refOf(computer)
  if (
    !computer ||
    computer.kind !== 'cloud' ||
    !ref ||
    computer.status === 'starting' ||
    computer.status === 'creating'
  )
    return
  // A stopping computer can still be connected for a few seconds; trust our own status.
  if (computer.status !== 'stopped' && isOnline(computerId)) return
  const status = await provider.status(ref)
  if (status === 'running' && computer.status !== 'stopped') return // booting or reconnecting
  if (status === 'destroyed') return setStatus(computer, 'error')
  // An 'error' computer (a failed resume, say) gets another start: it resumes from its last snapshot.
  await setStatus(computer, 'starting')
  void provider
    .start(ref)
    .then(() =>
      audit({
        organizationId: computer.organizationId,
        workspaceId: computer.workspaceId,
        actor: { type: 'system', id: 'brigade' },
        action: 'computer.started',
        target: { type: 'computer', id: computer.id },
      }),
    )
    .catch(async (error) => {
      console.error(`starting ${computer.id} failed:`, error)
      await setStatus(computer, 'error')
    })
}

export async function stopComputer(
  computer: { id: string; organizationId: string; workspaceId: string; providerRef: unknown },
  actor: { type: 'member' | 'system'; id: string },
) {
  const ref = refOf(computer)
  if (!provider || !ref) return
  await provider.stop(ref)
  await setStatus(computer, 'stopped')
  await audit({
    organizationId: computer.organizationId,
    workspaceId: computer.workspaceId,
    actor,
    action: 'computer.stopped',
    target: { type: 'computer', id: computer.id },
  })
}

/** A live desktop for takeover. The URL carries a token: only for members of the workspace. */
export async function desktopUrl(computer: { providerRef: unknown }) {
  const ref = refOf(computer)
  return provider && ref ? provider.desktopUrl(ref) : null
}

/** The setup last tried per computer, so a failing one is not retried on every connect. */
const setupTried = new Map<string, string>()

/**
 * Bring a cloud computer's root setup (teammate helper, library folder) up to
 * date when its runner reports an older one. Nothing restarts.
 */
export async function ensureSetup(
  computer: { id: string; organizationId: string; workspaceId: string; providerRef: unknown },
  reported: string | undefined,
) {
  const ref = refOf(computer)
  if (!provider || !ref || reported === SETUP_SHA) return
  if (setupTried.get(computer.id) === SETUP_SHA) return
  setupTried.set(computer.id, SETUP_SHA)
  console.log(`updating the root setup on ${computer.id}`)
  const result = await provider.exec(ref, setupScript())
  if (result.exitCode !== 0)
    throw new Error(`exit ${result.exitCode}: ${result.stderr.slice(-2000)}`)
  await audit({
    organizationId: computer.organizationId,
    workspaceId: computer.workspaceId,
    actor: { type: 'system', id: 'brigade' },
    action: 'computer.setup_updated',
    target: { type: 'computer', id: computer.id },
  })
  // The library folder may be new: have the runner fill it.
  notifyLibraryChanged(computer.workspaceId)
}

/**
 * Runners from before self-update (protocol 3), by the bundle they were last
 * reinstalled from: tried once per bundle, since an older bundle cannot help.
 */
const reinstalled = new Map<string, string>()

/**
 * A runner too old to update itself is reinstalled through the provider, when
 * no thread is running there. Its restart parks threads like any stop.
 */
async function reinstallOldRunner(computer: {
  id: string
  organizationId: string
  workspaceId: string
  providerRef: unknown
}) {
  const ref = refOf(computer)
  const protocol = runnerProtocol(computer.id)
  const bundle = await runnerBundle()
  if (!provider || !ref || !bundle || protocol === undefined || protocol >= 3) return
  if (reinstalled.get(computer.id) === bundle) return
  reinstalled.set(computer.id, bundle)
  console.log(`reinstalling the runner on ${computer.id} (protocol ${protocol})`)
  const result = await provider.exec(ref, reinstallScript(env.API_URL))
  if (result.exitCode !== 0)
    return console.error(
      `runner reinstall on ${computer.id} failed (${result.exitCode}): ${result.stderr.slice(-2000)}`,
    )
  await audit({
    organizationId: computer.organizationId,
    workspaceId: computer.workspaceId,
    actor: { type: 'system', id: 'brigade' },
    action: 'runner.updated',
    target: { type: 'computer', id: computer.id },
    data: { fromProtocol: protocol },
  })
}

/** How often a computer in use pushes back its provider's own auto-stop. */
const KEEP_ALIVE_EVERY_MS = 10 * 60_000
const keptAlive = new Map<string, number>()

/** The provider's auto-stop counts from start, not from last use: push it back while in use. */
async function keepAlive(computer: { id: string; providerRef: unknown }) {
  const ref = refOf(computer)
  if (!provider || !ref) return
  if (Date.now() - (keptAlive.get(computer.id) ?? 0) < KEEP_ALIVE_EVERY_MS) return
  keptAlive.set(computer.id, Date.now())
  await provider
    .keepAlive(ref)
    .catch((error) => console.error(`keeping ${computer.id} alive failed`, error))
}

/**
 * Stop cloud computers that have had no running thread for the idle period,
 * keep the others alive, and reinstall old runners on them while they are idle.
 * A computer whose runner is gone and that its provider stopped is marked
 * stopped, so the next message resumes it.
 */
async function stopIdle() {
  const idleMs = env.IDLE_STOP_MINUTES * 60_000
  const running = await prisma.computer.findMany({ where: { kind: 'cloud', status: 'running' } })
  for (const computer of running) {
    const ref = refOf(computer)
    if (provider && ref && !isOnline(computer.id)) {
      const status = await provider.status(ref).catch(() => null)
      if (status === 'stopped') {
        console.log(`computer ${computer.id} was stopped outside Brigade`)
        keptAlive.delete(computer.id)
        await setStatus(computer, 'stopped')
        continue
      }
    }
    const busy = await prisma.session.count({
      where: { computerId: computer.id, status: 'running' },
    })
    if (busy > 0) {
      touch(computer.id)
    } else {
      await reinstallOldRunner(computer).catch((error) =>
        console.error('runner reinstall failed', error),
      )
      const since = lastActive.get(computer.id) ?? computer.updatedAt.getTime()
      if (Date.now() - since >= idleMs) {
        console.log(`stopping idle computer ${computer.id}`)
        keptAlive.delete(computer.id)
        await stopComputer(computer, { type: 'system', id: 'brigade' }).catch((error) =>
          console.error('idle stop failed', error),
        )
        continue
      }
    }
    await keepAlive(computer)
  }
}

if (provider) setInterval(() => void stopIdle().catch(console.error), 60_000).unref()
