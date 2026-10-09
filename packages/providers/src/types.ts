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

export interface ComputerProvider {
  create(spec: ComputerSpec): Promise<ComputerRef>
  start(ref: ComputerRef): Promise<void> // resume with its disk
  stop(ref: ComputerRef): Promise<void> // keep the disk, stop billing
  destroy(ref: ComputerRef): Promise<void>
  exec(ref: ComputerRef, command: string): Promise<ExecResult> // install and start the runner
  desktopUrl(ref: ComputerRef): Promise<string | null> // live desktop for takeover
  status(ref: ComputerRef): Promise<ComputerStatus>
}
