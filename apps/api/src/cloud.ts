// The workspace cloud computer: created with the workspace, stopped when idle,
// resumed on demand. Provider details stay inside @brigade/providers.
import { providerFromEnv, type ComputerRef } from '@brigade/providers'
import { HTTPException } from 'hono/http-exception'
import { audit } from './audit.js'
import { billingEnabled, cloudEntitled, requireCloudPlan } from './billing.js'
import { defaults, env } from './config.js'
import { Prisma, prisma } from './db.js'
import {
  broadcastComputer,
  dropRunner,
  isOnline,
  notifyLibraryChanged,
  runnerProtocol,
} from './hub.js'
import {
  bootstrapScript,
  GIVE_HOMES_BACK,
  reinstallScript,
  SETUP_SHA,
  setupScript,
} from './cloud-bootstrap.js'
import { restored } from './cloud-restore.js'
import { throughGateway } from './preview-gateway.js'
import { issueLinkCode } from './link-codes.js'
import { runnerBundle } from './routes/runner-install.js'

const provider = providerFromEnv(process.env)

/** The previews' own site, in front of the provider's addresses (src/preview-gateway.ts). */
const gateway =
  env.PREVIEW_GATEWAY_URL && env.PREVIEW_GATEWAY_SECRET
    ? { url: env.PREVIEW_GATEWAY_URL, secret: env.PREVIEW_GATEWAY_SECRET }
    : null

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
  broadcastComputer(computer.workspaceId, computer.id, status)
}

/**
 * Create the workspace's cloud computer and install its runner, in the background. Not
 * without the Cloud plan, when billing is on (src/billing.ts): null then. Under a lock on the
 * workspace: two at once (a webhook and a click) make one computer.
 */
export async function createWorkspaceComputer(workspace: { id: string; organizationId: string }) {
  if (!provider) return null
  const found = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cloud:${workspace.id}`}))`
    if (!(await cloudEntitled(workspace.id))) return null
    const existing = await tx.computer.findFirst({
      where: { workspaceId: workspace.id, kind: 'cloud', status: { not: 'destroyed' } },
    })
    if (existing) return { existing, created: null }
    const created = await tx.computer.create({
      data: {
        organizationId: workspace.organizationId,
        workspaceId: workspace.id,
        kind: 'cloud',
        name: 'Cloud computer',
        size: defaults.cloudComputerSize,
        status: 'creating',
      },
    })
    return { existing: null, created }
  })
  if (!found) return null
  if (found.created) {
    startProvision(found.created)
    return found.created
  }
  const existing = found.existing!
  if (await unfinished(existing)) await reprovision(existing)
  return existing
}

/** Cloud computers this process is making, by id: one making at a time for each. */
const provisioning = new Set<string>()

/**
 * A cloud computer whose runner was never installed (its making failed or was cut short, the
 * API restarted meanwhile) and that nothing is making now: its VM, if any, holds nothing.
 */
async function unfinished(computer: { id: string; kind?: string }) {
  if (computer.kind && computer.kind !== 'cloud') return false
  if (provisioning.has(computer.id)) return false
  const runner = await prisma.runner.findUnique({
    where: { computerId: computer.id },
    select: { id: true },
  })
  return !runner
}

function startProvision(computer: { id: string; organizationId: string; workspaceId: string }) {
  if (provisioning.has(computer.id)) return
  provisioning.add(computer.id)
  void provision(computer)
    .catch(async (error) => {
      console.error(`provisioning ${computer.id} failed: ${await providerReason(error)}`, error)
      await setStatus(computer, 'error')
    })
    .finally(() => provisioning.delete(computer.id))
}

/** Make an unfinished computer again, from a new VM: the one it had, if any, goes first. */
async function reprovision(computer: { id: string; organizationId: string; workspaceId: string }) {
  if (provisioning.has(computer.id)) return
  await setStatus(computer, 'creating')
  startProvision(computer)
}

/**
 * The VM of an unfinished computer goes, and the computer with it: nothing was installed on
 * it. Its workspace gets a new one with its next plan. Throws when the provider fails; the
 * minute check tries again (enforcePlans).
 */
async function retire(computer: { id: string; workspaceId: string; providerRef: unknown }) {
  const ref = refOf(computer)
  if (provider && ref) await destroyVm(ref)
  await prisma.computer.update({ where: { id: computer.id }, data: { status: 'destroyed' } })
  broadcastComputer(computer.workspaceId, computer.id, 'destroyed')
}

/** Destroy a VM, unless the provider no longer has it. */
async function destroyVm(ref: ComputerRef) {
  const gone = await provider!.status(ref).then(
    (status) => status === 'destroyed',
    (error: unknown) => {
      if ((error as { response?: { status?: number } }).response?.status === 404) return true
      throw error
    },
  )
  if (!gone) await provider!.destroy(ref)
}

async function provision(computer: { id: string; organizationId: string; workspaceId: string }) {
  // Made before and cut short: that VM holds nothing, a new one is made.
  const before = await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } })
  const old = refOf(before)
  if (old) {
    await destroyVm(old)
    await prisma.computer.update({
      where: { id: computer.id },
      data: { providerRef: Prisma.DbNull },
    })
  }
  const ref = await provider!.create({
    workspaceId: computer.workspaceId,
    size: defaults.cloudComputerSize,
  })
  await prisma.computer.update({ where: { id: computer.id }, data: { providerRef: ref } })
  // The plan ended while it was being made, before its stop could reach it (src/billing.ts):
  // nothing is installed yet, so the VM goes rather than wait, stopped, for a runner.
  if (!(await cloudEntitled(computer.workspaceId))) {
    await retire({ ...computer, providerRef: ref })
    return
  }
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

/** Computers whose state is being checked to bring them up, by id: see ensureRunning. */
const bringing = new Map<string, Promise<void>>()

/**
 * Make sure a cloud computer is on its way up: once its start is asked for, commands
 * for it wait in the hub until its runner connects. That asks the provider how the
 * computer is first, a request to boat.dev that can take seconds. Asked again
 * meanwhile, the same check is waited for: two would start it twice.
 */
export function ensureRunning(computerId: string): Promise<void> {
  touch(computerId)
  const pending = bringing.get(computerId)
  if (pending) return pending
  const check = bringUp(computerId)
    .then(() => undefined)
    .finally(() => bringing.delete(computerId))
  bringing.set(computerId, check)
  return check
}

/**
 * ensureRunning, not waited for: for a command queued for the computer, whose sender is
 * told so either way. A failed check marks the computer errored, so the dashboard says
 * it and the next command starts it again.
 */
export function wake(computerId: string) {
  void ensureRunning(computerId).catch(async (error: unknown) => {
    // Its workspace has no Cloud plan: it stays stopped, nothing is broken.
    if (error instanceof HTTPException && error.status === 402) return
    console.error(`waking ${computerId} failed: ${await providerReason(error)}`, error)
    const computer = await prisma.computer
      .update({ where: { id: computerId }, data: { status: 'error' } })
      .catch(() => null)
    if (computer) broadcastComputer(computer.workspaceId, computer.id, 'error')
  })
}

async function bringUp(computerId: string) {
  if (!provider) return
  const computer = await prisma.computer.findUnique({ where: { id: computerId } })
  // A workspace whose plan ended keeps its computer, stopped, until the plan comes back;
  // whatever its row says (a stop whose answer was lost leaves it "running").
  if (computer?.kind === 'cloud') await requireCloudPlan(computer.workspaceId)
  const ref = computer && refOf(computer)
  if (computer?.kind === 'cloud' && (await unfinished(computer))) return reprovision(computer)
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
      console.error(`starting ${computer.id} failed: ${await providerReason(error)}`, error)
      await setStatus(computer, 'error')
    })
}

/**
 * A cloud computer that runs without its workspace's plan (src/billing.ts) is stopped: on its
 * runner's hello, and each minute by the idle check, until a stop goes through. True if so.
 */
export async function stopWithoutPlan(computer: {
  id: string
  organizationId: string
  workspaceId: string
  kind: string
  providerRef: unknown
}) {
  if (computer.kind !== 'cloud' || (await cloudEntitled(computer.workspaceId))) return false
  console.log(`stopping ${computer.id}: its workspace has no Cloud plan`)
  keptAlive.delete(computer.id)
  await stopComputer(computer, { type: 'system', id: 'billing' })
  return true
}

/**
 * A cloud computer whose workspace has no plan any more, stopped: an unfinished one goes
 * (retire); one being made stops itself once made (provision). Throws when the provider fails.
 */
export async function shutDown(computer: {
  id: string
  organizationId: string
  workspaceId: string
  kind: string
  providerRef: unknown
}) {
  if (computer.kind !== 'cloud' || provisioning.has(computer.id) || !refOf(computer)) return
  if (await unfinished(computer)) return retire(computer)
  keptAlive.delete(computer.id)
  await stopComputer(computer, { type: 'system', id: 'billing' })
}

/**
 * Each minute, with billing on: every cloud computer that is up, being made or broken while
 * its workspace has no plan is shut down, until the provider does it. Whatever failed before
 * (a stop, a VM left by a cut-short making) is tried again here.
 */
export async function enforcePlans() {
  if (!provider || !billingEnabled()) return
  const computers = await prisma.computer.findMany({
    where: { kind: 'cloud', status: { notIn: ['stopped', 'destroyed'] } },
  })
  for (const computer of computers) {
    if (provisioning.has(computer.id) || !refOf(computer)) continue
    if (await cloudEntitled(computer.workspaceId)) continue
    console.log(`shutting ${computer.id} down: its workspace has no Cloud plan`)
    await shutDown(computer).catch(async (error) =>
      console.error(`shutting ${computer.id} down failed: ${await providerReason(error)}`, error),
    )
  }
}

export async function stopComputer(
  computer: { id: string; organizationId: string; workspaceId: string; providerRef: unknown },
  actor: { type: 'member' | 'system'; id: string },
) {
  const ref = refOf(computer)
  if (!provider || !ref) return
  await provider.stop(ref)
  // Its runner went with it, without closing its connection.
  dropRunner(computer.id)
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
/** What a provider's failed request said: the text of its answer, when it has one. */
export async function providerReason(error: unknown) {
  const response = (error as { response?: unknown } | null)?.response
  const text = response instanceof Response ? await response.text().catch(() => '') : ''
  return (text.trim() || (error instanceof Error ? error.message : String(error))).slice(0, 300)
}

/**
 * Desktop requests in flight, per computer. A provider sets the desktop up on
 * the first request after a boot, and two at once can each write a VNC
 * password, leaving the server with one and the URL with the other.
 */
const desktopRequests = new Map<string, Promise<string | null>>()

/** The desktop's URL. A provider that does not answer is a 503, which the dashboard retries. */
export async function desktopUrl(computer: { providerRef: unknown }) {
  const ref = refOf(computer)
  if (!provider || !ref) return null
  const key = `${ref.provider}:${ref.id}`
  let request = desktopRequests.get(key)
  if (!request) {
    request = provider.desktopUrl(ref).finally(() => desktopRequests.delete(key))
    desktopRequests.set(key, request)
  }
  try {
    return await request
  } catch (error) {
    throw new HTTPException(503, {
      message: `The cloud computer's provider did not answer: ${await providerReason(error)}`,
    })
  }
}

/** A port of a cloud computer on a public address (a thread's preview). */
export async function hostedPort(computer: { providerRef: unknown }, port: number) {
  const ref = refOf(computer)
  if (!provider || !ref)
    throw new HTTPException(409, { message: 'No cloud provider for this computer' })
  let hosted: { origin: string; url: string }
  try {
    hosted = await provider.hostPort(ref, port)
  } catch (error) {
    throw new HTTPException(503, {
      message: `The cloud computer's provider did not host the preview: ${await providerReason(error)}`,
    })
  }
  return throughGateway(hosted, gateway)
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

/** A resumed computer's restore: checked this often, for at most this long (cloud-restore.ts). */
const RESTORE_WAIT = { everyMs: 15_000, forMs: 3 * 60 * 60_000, checkMs: 60_000, failures: 5 }
/** Per computer: the restore whose homes were given back. */
const homesGivenBack = new Map<string, string>()
/** Per computer whose restore is awaited: whether a hello came meanwhile (a new resume, say). */
const awaitingRestore = new Map<string, { again: boolean }>()

/**
 * A resumed computer runs before its disk is all there: boat copies the home in from its
 * snapshot in the background, and can bring a folder of a teammate's home back owned by root
 * (its ~/.cache) after the runner's ensure-user gave the home back (TEAMMATE_HELPER). Once the
 * restore is done, the homes are given back again. From each runner's hello: once per restore,
 * and once more after the API restarted.
 */
export async function giveHomesBackOnceRestored(computer: { id: string; providerRef: unknown }) {
  const ref = refOf(computer)
  const cloud = provider
  if (!cloud?.restore || !ref) return
  const awaiting = awaitingRestore.get(computer.id)
  if (awaiting) {
    awaiting.again = true
    return
  }
  const watch = { again: false }
  awaitingRestore.set(computer.id, watch)
  try {
    const restore = await restored(() => cloud.restore!(ref), RESTORE_WAIT)
    if (!restore.done) {
      if (restore.why === 'too long')
        console.warn(`${computer.id}: still restoring, homes not checked`)
      return
    }
    if (homesGivenBack.get(computer.id) === restore.at) return
    const result = await cloud.exec(ref, GIVE_HOMES_BACK)
    if (result.exitCode !== 0)
      throw new Error(`exit ${result.exitCode}: ${result.stderr.slice(-2000)}`)
    homesGivenBack.set(computer.id, restore.at)
    console.log(`${computer.id} restored${restore.at ? ` at ${restore.at}` : ''}: homes given back`)
  } finally {
    awaitingRestore.delete(computer.id)
    // What this one checked may predate that hello's boot: its restore is waited for too.
    if (watch.again)
      void giveHomesBackOnceRestored(computer).catch((error) =>
        console.error(`giving homes back on ${computer.id} failed`, error),
      )
  }
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
 * stopped, so the next message resumes it; with a thread running, it starts
 * again now, and its runner continues the turn.
 */
async function stopIdle() {
  const idleMs = env.IDLE_STOP_MINUTES * 60_000
  const running = await prisma.computer.findMany({ where: { kind: 'cloud', status: 'running' } })
  for (const computer of running) {
    // Without a plan: enforcePlans, just before, shut it down or will try again.
    if (!(await cloudEntitled(computer.workspaceId))) continue
    const ref = refOf(computer)
    if (provider && ref && !isOnline(computer.id)) {
      const status = await provider.status(ref).catch(() => null)
      if (status === 'stopped') {
        console.log(`computer ${computer.id} was stopped outside Brigade`)
        keptAlive.delete(computer.id)
        await setStatus(computer, 'stopped')
        const cutOff = await prisma.session.count({
          where: { computerId: computer.id, status: 'running' },
        })
        // Not once its plan ended (a 402): the next computers are still checked.
        if (cutOff > 0)
          await ensureRunning(computer.id).catch((error) =>
            console.error(`restarting ${computer.id} failed`, error),
          )
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

/** Stop idle cloud computers every minute. Started by the entry (src/jobs.ts). */
export const watchIdle = () => {
  if (provider)
    setInterval(
      () =>
        void enforcePlans()
          .catch(console.error)
          .then(() => stopIdle())
          .catch(console.error),
      60_000,
    )
}
