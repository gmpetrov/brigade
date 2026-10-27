// What differs between the API's two platforms. src/platform/node.ts implements it
// on Node.js; src/platform/workers.ts on Cloudflare Workers, swapped in by an
// alias in wrangler.jsonc. Code elsewhere imports node.ts.

/** An outbound WebSocket, binary frames only (the desktop relay). */
export type Upstream = {
  send(data: ArrayBuffer): void
  close(): void
}

export type UpstreamEvents = {
  onOpen(): void
  onMessage(data: ArrayBuffer): void
  onClose(): void
  onError(): void
}

/** The runner bundle this API serves (built by `pnpm --filter @brigade/runner bundle`). */
export type RunnerBundleFile = {
  sha256: string
  /** Its length, when known. */
  size: number | null
  body: ReadableStream
}

/**
 * An operation of a workspace's hub that runs in another Durable Object (src/hub.ts): its
 * outcome, an error included, as it crossed.
 */
export type HubCall = (
  name: import('../hub/operations.js').OperationName,
  args: unknown[],
) => Promise<import('../hub.js').Outcome>

/** A workspace's hub object, as other objects call it (src/hub-object.ts). */
export type HubStub = {
  call(
    workspaceId: string,
    name: import('../hub/operations.js').OperationName,
    args: unknown[],
    forwarded: boolean,
  ): Promise<import('../hub.js').Outcome>
  moved(workspaceId: string, mode: 'api' | 'object'): Promise<void>
}
