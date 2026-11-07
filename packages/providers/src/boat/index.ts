// boat (https://boat.dev): persistent Ubuntu VMs with snapshots on stop.
import { BoatApi, Configuration, execCommand, waitUntilReady, type Middleware } from '@boatdev/sdk'
import {
  DesktopNotReady,
  type ComputerProvider,
  type ComputerRef,
  type ComputerSize,
  type ComputerStatus,
  type MachineProvider,
  type ProviderLedger,
  type RecoverAnswer,
  type RestoreState,
  type SavedState,
  type StartResult,
  type VmState,
} from '../types.js'

const PROVIDER = 'boat'
const SIZES: Record<ComputerSize, 'small' | 'default' | 'large'> = {
  '2x4': 'small',
  '4x8': 'default',
  '8x16': 'large',
}

/** On Cloudflare Workers, whose node:http2 is a stub, the SDK must use the global fetch. */
const onWorkers = globalThis.navigator?.userAgent === 'Cloudflare-Workers'

/** How long one request to boat may take before it is given up: it answers in about a second. */
export const BOAT_REQUEST_MS = 60_000
/** A command's own time limit (its timeoutSeconds) plus this, for boat to answer once it ends. */
export const BOAT_COMMAND_GRACE_MS = 60_000

/**
 * How long desktopUrl waits for boat to set a desktop up, asking every `everyMs`. The SDK's own
 * waitForDesktop waits 5 minutes: on Nov 4, boat kept a running computer's desktop "provisioning"
 * for longer, and each request for it held its caller 5 minutes before failing. Past this wait,
 * DesktopNotReady: the dashboard asks again (each ask is cheap) and opens it once it is up.
 */
export const BOAT_DESKTOP_WAIT = { forMs: 25_000, everyMs: 2_000 }

/**
 * How long a start waits for a stop's snapshot (`archiving`) to finish before it resumes the VM,
 * asking every `everyMs`. It waited 4 minutes: on Nov 7, boat took about 15 to archive the
 * workspace computer, a VM whose agent no longer answered, and each start in between failed
 * ("Sandbox entered terminal state archiving"), marking the computer down four times in a row.
 */
export const BOAT_ARCHIVING_WAIT = { forMs: 30 * 60_000, everyMs: 5_000 }

/**
 * How long a request to boat may take, or null for none. Without a limit, a request boat never
 * answers held its caller for 10 minutes, and with it the jobs' queue (src/jobs.ts in apps/api):
 * a cloud computer's keep-alive, on Oct 30 and 31. A command waits for as long as it may run; a
 * stream (a command's or the events') is read for as long as its caller wants.
 */
export function boatDeadlineMs(url: string, init?: RequestInit): number | null {
  const path = new URL(url).pathname
  if (path.endsWith('/stream')) return null
  if (init?.method === 'POST' && /\/sandboxes\/[^/]+\/commands$/.test(path)) {
    let seconds = 30
    try {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
      if (typeof body?.timeoutSeconds === 'number') seconds = body.timeoutSeconds
    } catch {}
    return seconds * 1000 + BOAT_COMMAND_GRACE_MS
  }
  return BOAT_REQUEST_MS
}

/** Gives each request to boat its deadline (boatDeadlineMs), besides its own signal. */
export const deadlines: Middleware = {
  async pre({ url, init }) {
    const ms = boatDeadlineMs(url, init)
    if (ms === null) return { url, init }
    const deadline = AbortSignal.timeout(ms)
    return {
      url,
      init: { ...init, signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline },
    }
  },
}

/** `send`: the fetch to use (tests); else the global one on Workers, the SDK's own on Node. */
export function boatClient(
  apiKey: string,
  basePath = 'https://boat.dev/api/v1',
  send?: typeof fetch,
) {
  const fetchApi =
    send ?? (onWorkers ? (...args: Parameters<typeof fetch>) => fetch(...args) : null)
  return new BoatApi(
    new Configuration({
      basePath,
      accessToken: apiKey,
      middleware: [deadlines],
      ...(fetchApi ? { fetchApi } : {}),
    }),
  )
}

/**
 * boat's refusals of a recover (409), as Brigade takes them. Its baremetal machines cannot be
 * power-cycled at all: a running sandbox on one answers `recover_unsupported` whether it answers or
 * not (tried on a throwaway sandbox on Nov 7), and its own advice is then a forced stop and a
 * resume.
 */
const RECOVER_ANSWERS: Record<string, RecoverAnswer> = {
  sandbox_is_reachable: 'reachable',
  // A power-cycle started less than 10 minutes ago: still under way, as far as Brigade knows.
  too_soon: 'recovering',
  recover_unsupported: 'impossible',
  no_machine: 'impossible',
  reset_failed: 'impossible',
}

/** The code of boat's 409 answer (`{ ok: false, status: 409, code, message }`), or null. */
async function conflictCode(error: unknown): Promise<string | null> {
  const response = (error as { response?: unknown } | null)?.response
  if (!(response instanceof Response) || response.status !== 409) return null
  try {
    const body = (await response.clone().json()) as { code?: unknown; error?: { code?: unknown } }
    const code = body.code ?? body.error?.code
    return typeof code === 'string' ? code : null
  } catch {
    return null
  }
}

function idOf(ref: ComputerRef) {
  if (ref.provider !== PROVIDER) throw new Error(`Not a ${PROVIDER} computer: ${ref.provider}`)
  return ref.id
}

export function createBoatProvider(options: {
  apiKey: string
  basePath?: string
  /**
   * boat's own auto-stop: a deadline from start, not from last use, so the API
   * pushes it back with keepAlive while the computer is in use. It only fires
   * when the API is gone. null: none. Trial accounts require <= 7200.
   */
  autoStopSeconds?: number | null
  /** Tests: the fetch to use, and a shorter desktop wait. */
  send?: typeof fetch
  desktopWait?: { forMs: number; everyMs: number }
  archivingWait?: { forMs: number; everyMs: number }
}): ComputerProvider {
  const boat = boatClient(options.apiKey, options.basePath, options.send)
  const desktopWait = options.desktopWait ?? BOAT_DESKTOP_WAIT
  const archivingWait = options.archivingWait ?? BOAT_ARCHIVING_WAIT

  return {
    async create(spec) {
      // noEnv: the VM receives none of Brigade's own boat account secrets.
      const created = await boat.create({
        type: SIZES[spec.size],
        noEnv: true,
        ttlSeconds: options.autoStopSeconds ?? null,
      })
      const sandboxId = created.sandbox.id
      await spec.onCreated?.({ provider: PROVIDER, id: sandboxId })
      await boat.update({ sandboxId, name: `brigade-${spec.workspaceId}` })
      await waitUntilReady(boat, sandboxId)
      return { provider: PROVIDER, id: sandboxId }
    },

    async start(ref): Promise<StartResult> {
      const sandboxId = idOf(ref)
      // A stop snapshots the disk first; resume once that has finished. A
      // failed resume leaves the sandbox in 'error': resuming again is boat's remedy.
      let resumedAt: Date | null = null
      const deadline = Date.now() + archivingWait.forMs
      for (;;) {
        const { sandbox } = await boat.get({ sandboxId })
        if (sandbox.state === 'archived' || sandbox.state === 'error') {
          resumedAt = new Date()
          await boat.resume({ sandboxId, noEnv: true })
          break
        }
        if (sandbox.state !== 'archiving') break
        if (Date.now() + archivingWait.everyMs > deadline)
          throw new Error(
            `boat still archiving ${sandboxId} after ${Math.round(archivingWait.forMs / 60_000)} min`,
          )
        await new Promise((resolve) => setTimeout(resolve, archivingWait.everyMs))
      }
      await waitUntilReady(boat, sandboxId)
      return { resumedAt }
    },

    async stop(ref, options) {
      // Forced, boat still saves the disk first when it can; when it cannot, it stops anyway with
      // the last completed snapshot. Not forced, it refuses to stop a sandbox it has not saved for
      // 30 minutes and keeps it running (Nov 7: "could not stop … snapshot keeps failing").
      await boat.stop({
        sandboxId: idOf(ref),
        ...(options?.force ? { stopRequest: { force: true } } : {}),
      })
    },

    async saved(ref): Promise<SavedState> {
      const { sandbox } = await boat.get({ sandboxId: idOf(ref) })
      const snapshotAt = sandbox.snapshotCompletedAt ?? null
      return {
        // A check that found nothing new to save confirms the disk too.
        savedAt: sandbox.snapshotVerifiedAt ?? snapshotAt,
        snapshotAt,
        health: sandbox.health ?? null,
        healthReason: sandbox.healthReason ?? null,
      }
    },

    async recover(ref): Promise<RecoverAnswer> {
      try {
        await boat.recover({ sandboxId: idOf(ref) })
        return 'recovering'
      } catch (error) {
        const code = await conflictCode(error)
        const answer = code === null ? undefined : RECOVER_ANSWERS[code]
        if (!answer) throw error
        return answer
      }
    },

    async keepAlive(ref) {
      if (options.autoStopSeconds == null) return
      // The deadline becomes now + ttlSeconds.
      await boat.update({ sandboxId: idOf(ref), ttlSeconds: options.autoStopSeconds })
    },

    async destroy(ref) {
      const sandboxId = idOf(ref)
      await boat.deleteSandbox({ sandboxId, xAsciiConfirmDelete: sandboxId })
    },

    async exec(ref, command) {
      const result = await execCommand(boat, idOf(ref), command, undefined, 600)
      if (!('exitCode' in result)) throw new Error('boat started the command in the background')
      return {
        exitCode: result.exitCode ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      }
    },

    async desktopUrl(ref) {
      const sandboxId = idOf(ref)
      // boat sets VNC up on the first request after a boot (`provisioning` until it is ready).
      const deadline = Date.now() + desktopWait.forMs
      for (;;) {
        const desktop = await boat.desktop({ sandboxId, vnc: 1, desktopRequest: {} })
        if (desktop.desktopUrl && !desktop.provisioning) return desktop.desktopUrl
        if (Date.now() + desktopWait.everyMs > deadline)
          throw new DesktopNotReady(desktop.message || undefined)
        await new Promise((resolve) => setTimeout(resolve, desktopWait.everyMs))
      }
    },

    async hostPort(ref, port) {
      // Stable per sandbox and port, and idempotent: the same address and token each time.
      const hosted = await boat.hostPort({
        sandboxId: idOf(ref),
        hostPortRequest: { port, title: `Brigade preview :${port}` },
      })
      if (!hosted.url) throw new Error(`boat did not host port ${port}`)
      const url = new URL(hosted.url)
      return { origin: url.origin, url: hosted.url }
    },

    async status(ref): Promise<ComputerStatus> {
      const { sandbox } = await boat.get({ sandboxId: idOf(ref) })
      switch (sandbox.state) {
        case 'ready':
        case 'idle':
        case 'running':
          return 'running'
        case 'archiving':
        case 'archived':
          return 'stopped'
        case 'error':
          return 'error'
        case 'cancelled':
          return 'destroyed'
        default:
          return 'creating'
      }
    },

    async restore(ref): Promise<RestoreState> {
      const { sandbox } = await boat.get({ sandboxId: idOf(ref) })
      // Stopping, stopped or gone: its restore will not finish. Still starting: it will.
      if (['archiving', 'archived', 'error', 'cancelled'].includes(sandbox.state))
        return { done: false, running: false }
      if (!['ready', 'idle', 'running'].includes(sandbox.state))
        return { done: false, running: true }
      // A resumed sandbox answers before every file of its snapshot is back: they keep copying
      // in, and `hydrated` turns true once they are. A sandbox that restored nothing is
      // hydrated from the start (no `hydratedAt`); one that does not say, as restored.
      if (sandbox.hydrated === false) return { done: false, running: true }
      return { done: true, at: sandbox.hydratedAt?.toISOString() ?? '' }
    },
  }
}

/** A preview machine's size (docs.boat.dev/machines), and what it has, for people. */
export const MACHINE_COMPUTER_SIZE: ComputerSize = '8x16'
const MACHINE_TYPE = SIZES[MACHINE_COMPUTER_SIZE]
export const MACHINE_SIZE = '8 vCPU, 16 GB'

/**
 * Preview machines at boat (docs/previews.md): a sandbox of their own for one thread's preview,
 * with none of Brigade's boat account secrets (noEnv), and boat's own stop as a backstop:
 * `autoStopSeconds` after it was last kept alive, should Brigade stop keeping it.
 */
export function createBoatMachines(options: {
  apiKey: string
  basePath?: string
  autoStopSeconds: number
  /** Tests: the fetch to use. */
  send?: typeof fetch
}): MachineProvider {
  const boat = boatClient(options.apiKey, options.basePath, options.send)
  // Starting, stopping, destroying and keeping alive are a cloud computer's.
  const computers = createBoatProvider(options)

  return {
    size: MACHINE_SIZE,

    async create({ name, key, onCreated }) {
      // Sent again with the same key (a retry after an answer that never came), boat gives the
      // same sandbox rather than a second one.
      const created = await boat.create(
        { type: MACHINE_TYPE, noEnv: true, ttlSeconds: options.autoStopSeconds },
        async ({ init }) => ({
          headers: { ...(init.headers as Record<string, string>), 'Idempotency-Key': key },
        }),
      )
      const sandboxId = created.sandbox.id
      await onCreated?.({ provider: PROVIDER, id: sandboxId })
      await boat.update({ sandboxId, name })
      await waitUntilReady(boat, sandboxId)
      return { provider: PROVIDER, id: sandboxId }
    },

    start: (ref) => computers.start(ref),
    stop: (ref) => computers.stop(ref),
    destroy: (ref) => computers.destroy(ref),
    status: (ref) => computers.status(ref),
    keepAlive: (ref) => computers.keepAlive(ref),

    async authorize(ref, publicKey) {
      // The host key comes over this API, not over SSH: it can be pinned before connecting.
      const answer = await boat.sshKey({ sandboxId: idOf(ref), key: publicKey })
      const hostKey = answer.hostKey?.trim()
      if (!hostKey) throw new Error('boat gave no host key')
      // A sandbox without a public IPv4 of its own is reached at an endpoint, "host:port".
      const endpoint = answer.sshEndpoint ? /^(.+):(\d+)$/.exec(answer.sshEndpoint) : null
      const host = endpoint ? endpoint[1]! : answer.machineIp
      if (!host) throw new Error('boat gave no address to connect to')
      return {
        host,
        port: endpoint ? Number(endpoint[2]) : 22,
        user: answer.sshUser || 'user',
        hostKey,
      }
    },
  }
}

/** Where a sandbox is, in Brigade's terms: boat bills `running` only (docs.boat.dev/pricing). */
export function vmState(state: string): VmState {
  switch (state) {
    case 'ready':
    case 'idle':
    case 'running':
      return 'running'
    case 'archiving':
    case 'archived':
    case 'cancelled':
      return 'stopped'
    case 'error':
      return 'error'
    default:
      return 'starting'
  }
}

/** Pages of the account's sandboxes read at most, of LIST_PAGE each. */
const LIST_PAGES = 50
const LIST_PAGE = 100

/**
 * boat's own figures (docs/vm-costs.md): the account's sandboxes and their states, a page at a
 * time, and what one ran over a window (GET /sandboxes/{id}/usage, at list price).
 */
export function createBoatLedger(options: {
  apiKey: string
  basePath?: string
  send?: typeof fetch
}): ProviderLedger {
  const boat = boatClient(options.apiKey, options.basePath, options.send)
  return {
    async states() {
      const states = new Map<string, VmState>()
      let cursor: string | null = null
      for (let page = 0; page < LIST_PAGES; page++) {
        const list = await boat.sandboxes({ limit: LIST_PAGE, ...(cursor ? { cursor } : {}) })
        for (const sandbox of list.sandboxes) states.set(sandbox.id, vmState(sandbox.state))
        cursor = list.pageInfo?.hasMore ? list.pageInfo.nextCursor : null
        if (!cursor) return states
      }
      throw new Error(`boat listed more than ${LIST_PAGES * LIST_PAGE} sandboxes`)
    },

    async usage(id, since, until) {
      const usage = await boat.usage({
        sandboxId: id,
        since: since.toISOString(),
        until: until.toISOString(),
      })
      // `seconds` is scaled by the size's multiplier (2 for large): the time it ran is unscaled.
      const multiplier = usage.billingMultiplier > 0 ? usage.billingMultiplier : 1
      return {
        runSeconds: usage.seconds / multiplier,
        dollars: usage.dollars,
        running: usage.running,
      }
    },

    async limits() {
      return boat.limits({})
    },
  }
}
