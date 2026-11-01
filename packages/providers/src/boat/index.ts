// boat (https://boat.dev): persistent Ubuntu VMs with snapshots on stop.
import {
  BoatApi,
  Configuration,
  execCommand,
  waitForDesktop,
  waitUntilReady,
  type Middleware,
} from '@boatdev/sdk'
import type {
  ComputerProvider,
  ComputerRef,
  ComputerSize,
  ComputerStatus,
  RestoreState,
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
}): ComputerProvider {
  const boat = boatClient(options.apiKey, options.basePath)

  return {
    async create(spec) {
      // noEnv: the VM receives none of Brigade's own boat account secrets.
      const created = await boat.create({
        type: SIZES[spec.size],
        noEnv: true,
        ttlSeconds: options.autoStopSeconds ?? null,
      })
      const sandboxId = created.sandbox.id
      await boat.update({ sandboxId, name: `brigade-${spec.workspaceId}` })
      await waitUntilReady(boat, sandboxId)
      return { provider: PROVIDER, id: sandboxId }
    },

    async start(ref) {
      const sandboxId = idOf(ref)
      // A stop snapshots the disk first; resume once that has finished. A
      // failed resume leaves the sandbox in 'error': resuming again is boat's remedy.
      for (let i = 0; i < 120; i++) {
        const { sandbox } = await boat.get({ sandboxId })
        if (sandbox.state === 'archived' || sandbox.state === 'error') {
          await boat.resume({ sandboxId, noEnv: true })
          break
        }
        if (sandbox.state !== 'archiving') break
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
      await waitUntilReady(boat, sandboxId)
    },

    async stop(ref) {
      await boat.stop({ sandboxId: idOf(ref) })
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
      const desktop = await waitForDesktop(boat, idOf(ref))
      return desktop.desktopUrl ?? null
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
