// boat (https://boat.dev): persistent Ubuntu VMs with snapshots on stop.
import { BoatApi, Configuration, execCommand, waitForDesktop, waitUntilReady } from '@boatdev/sdk'
import type { ComputerProvider, ComputerRef, ComputerSize, ComputerStatus } from '../types.js'

const PROVIDER = 'boat'
const SIZES: Record<ComputerSize, 'small' | 'default' | 'large'> = {
  '2x4': 'small',
  '4x8': 'default',
  '8x16': 'large',
}

export function boatClient(apiKey: string, basePath = 'https://boat.dev/api/v1') {
  return new BoatApi(new Configuration({ basePath, accessToken: apiKey }))
}

function idOf(ref: ComputerRef) {
  if (ref.provider !== PROVIDER) throw new Error(`Not a ${PROVIDER} computer: ${ref.provider}`)
  return ref.id
}

export function createBoatProvider(options: {
  apiKey: string
  basePath?: string
  /** boat's own auto-stop. null: none, the API stops idle computers. Trial accounts require <= 7200. */
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
  }
}
