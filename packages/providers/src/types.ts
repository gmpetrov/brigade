export type ComputerSize = '2x4' | '4x8' | '8x16'

export type ComputerSpec = {
  /** Used to name the machine; never sent to it as configuration. */
  workspaceId: string
  size: ComputerSize
}

/** Opaque to everything outside this package. Stored as JSON on Computer.providerRef. */
export type ComputerRef = { provider: string; id: string }

export type ComputerStatus = 'creating' | 'running' | 'stopped' | 'error' | 'destroyed'

/**
 * Whether a computer's disk is all there after a resume. `at` tells restores apart: the
 * same for the same restore.
 */
export type RestoreState = { done: false; running: boolean } | { done: true; at: string }

export type ExecResult = { exitCode: number; stdout: string; stderr: string }

/** A port of the computer on a public HTTPS address. */
export type HostedPort = {
  /** Where the port answers, with no secret in it: what the app is told it is served at. */
  origin: string
  /** What a person opens: the origin with whatever lets them in (a token). Never logged. */
  url: string
}

export interface ComputerProvider {
  create(spec: ComputerSpec): Promise<ComputerRef>
  start(ref: ComputerRef): Promise<void> // resume with its disk
  stop(ref: ComputerRef): Promise<void> // keep the disk, stop billing
  keepAlive(ref: ComputerRef): Promise<void> // push back the provider's own auto-stop while in use
  destroy(ref: ComputerRef): Promise<void>
  exec(ref: ComputerRef, command: string): Promise<ExecResult> // install and start the runner
  desktopUrl(ref: ComputerRef): Promise<string | null> // live desktop for takeover
  hostPort(ref: ComputerRef, port: number): Promise<HostedPort> // a stable public address for a port (previews)
  status(ref: ComputerRef): Promise<ComputerStatus>
  /**
   * For a provider that starts a computer before its disk is restored (boat copies the home
   * in from its snapshot in the background): whether that is done. `running` false: the
   * computer stopped, so it will not be.
   */
  restore?(ref: ComputerRef): Promise<RestoreState>
}
