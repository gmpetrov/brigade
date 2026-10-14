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
