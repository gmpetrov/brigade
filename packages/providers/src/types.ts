export type ComputerSize = '2x4' | '4x8' | '8x16'

export type ComputerSpec = {
  /** Used to name the machine; never sent to it as configuration. */
  workspaceId: string
  size: ComputerSize
}

/** Opaque to everything outside this package. Stored as JSON on Computer.providerRef. */
export type ComputerRef = { provider: string; id: string }

export type ComputerStatus = 'creating' | 'running' | 'stopped' | 'error' | 'destroyed'

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
}
