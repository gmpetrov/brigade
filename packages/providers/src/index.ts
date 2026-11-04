// ComputerProvider implementations. No code outside this package names a provider.
import { createBoatProvider } from './boat/index.js'
import type { ComputerProvider } from './types.js'

export { DesktopNotReady } from './types.js'

export type {
  ComputerProvider,
  ComputerRef,
  ComputerSize,
  ComputerSpec,
  ComputerStatus,
  ExecResult,
  HostedPort,
  RestoreState,
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
