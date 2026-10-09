// The workspace cloud computer: created with the workspace, stopped when idle,
// resumed on demand. Provider details stay inside @brigade/providers.
import { providerFromEnv, type ComputerRef } from '@brigade/providers'
import { audit } from './audit.js'
import { defaults, env } from './config.js'
import { prisma } from './db.js'
import { broadcastComputer, isOnline } from './hub.js'
import { bootstrapScript } from './cloud-bootstrap.js'
import { issueLinkCode } from './link-codes.js'

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
  if (status === 'destroyed' || status === 'error') return setStatus(computer, 'error')
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

/** Stop cloud computers that have had no running thread for the idle period. */
async function stopIdle() {
  const idleMs = env.IDLE_STOP_MINUTES * 60_000
  const running = await prisma.computer.findMany({ where: { kind: 'cloud', status: 'running' } })
  for (const computer of running) {
    const busy = await prisma.session.count({
      where: { computerId: computer.id, status: 'running' },
    })
    if (busy > 0) {
      touch(computer.id)
      continue
    }
    const since = lastActive.get(computer.id) ?? computer.updatedAt.getTime()
    if (Date.now() - since < idleMs) continue
    console.log(`stopping idle computer ${computer.id}`)
    await stopComputer(computer, { type: 'system', id: 'brigade' }).catch((error) =>
      console.error('idle stop failed', error),
    )
  }
}

if (provider) setInterval(() => void stopIdle().catch(console.error), 60_000).unref()
