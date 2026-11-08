// ComputerProvider implementations. No code outside this package names a provider.
import { createBoatLedger, createBoatMachines, createBoatProvider } from './boat/index.js'
export { MACHINE_COMPUTER_SIZE } from './boat/index.js'
import type { ComputerProvider, MachineProvider, ProviderLedger } from './types.js'

export { DesktopNotReady } from './types.js'
export { VM_PRICES, vmCost } from './boat/prices.js'
export { failureStatus, transientFailure } from './failures.js'

export type {
  ComputerProvider,
  ComputerRef,
  ComputerSize,
  ComputerSpec,
  ComputerStatus,
  ExecResult,
  HostedPort,
  MachineProvider,
  ProviderLedger,
  RecoverAnswer,
  RestoreState,
  SavedState,
  SshAccess,
  StartResult,
  VmState,
  VmUsage,
} from './types.js'

/** The configured cloud computer provider, or null when none is configured. */
export function providerFromEnv(env: Record<string, string | undefined>): ComputerProvider | null {
  if (env.BOAT_API_KEY) {
    const autoStop = env.BOAT_AUTO_STOP_SECONDS
    return createBoatProvider({
      apiKey: env.BOAT_API_KEY,
      ...(env.BOAT_BASE_URL ? { basePath: env.BOAT_BASE_URL } : {}),
      autoStopSeconds: autoStop ? Number(autoStop) : null,
      // How long one request waits for boat to set the desktop up (tests: 0, no wait).
      ...(env.BOAT_DESKTOP_WAIT_MS && {
        desktopWait: { forMs: Number(env.BOAT_DESKTOP_WAIT_MS), everyMs: 2_000 },
      }),
    })
  }
  return null
}

/**
 * How long a preview machine runs once nothing keeps it alive any more (the API keeps alive
 * those in use): a backstop should Brigade be gone, not how idle ones stop.
 */
export const MACHINE_AUTO_STOP_SECONDS = 2 * 3600

/** The configured provider of preview machines (docs/previews.md), or null when none is. */
export function machinesFromEnv(env: Record<string, string | undefined>): MachineProvider | null {
  if (!env.BOAT_API_KEY) return null
  return createBoatMachines({
    apiKey: env.BOAT_API_KEY,
    ...(env.BOAT_BASE_URL ? { basePath: env.BOAT_BASE_URL } : {}),
    autoStopSeconds: MACHINE_AUTO_STOP_SECONDS,
  })
}

/** The provider's own figures of what its VMs ran (docs/vm-costs.md), or null without one. */
export function ledgerFromEnv(env: Record<string, string | undefined>): ProviderLedger | null {
  if (!env.BOAT_API_KEY) return null
  return createBoatLedger({
    apiKey: env.BOAT_API_KEY,
    ...(env.BOAT_BASE_URL ? { basePath: env.BOAT_BASE_URL } : {}),
  })
}
