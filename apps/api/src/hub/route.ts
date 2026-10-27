// How a socket names its workspace, for the API's front to route it to that workspace's hub
// (src/front.ts, src/hub-object.ts). Imports nothing: the front Worker stays small.

/** A runner token's workspace: tokens from a link start with it (`<workspaceId>.<secret>`). */
export function workspaceOfToken(authorization: string | null | undefined) {
  return authorization?.match(/^Bearer ([^.\s]+)\.\S+$/)?.[1] ?? null
}

/** The workspace a socket's request names: its query, else its runner token. */
export function workspaceOfSocket(request: Request) {
  return (
    new URL(request.url).searchParams.get('workspace') ??
    workspaceOfToken(request.headers.get('authorization'))
  )
}

/**
 * The answer of the object that does not hold a workspace's sockets: 421, saying where they go
 * (x-brigade-hub: 'api' or 'object') and, when the asker could not know it, whose they are.
 */
export const MISDIRECTED = 421
export const HUB_HEADER = 'x-brigade-hub'
export const WORKSPACE_HEADER = 'x-brigade-workspace'

/** The header the front sets on a request it sends to the API's own isolates (statelessRoute). */
export const STATELESS_HEADER = 'x-brigade-stateless'

/**
 * Whether a request runs in the API Worker's own isolates rather than the Api object
 * (docs/workspace-hubs-plan.md, Phase 4): a read (GET, HEAD) under one of `prefixes`, a
 * comma-separated list of paths (the front's STATELESS_ROUTES). Sockets never do.
 */
export function statelessRoute(request: Request, prefixes: string | undefined) {
  if (!prefixes || (request.method !== 'GET' && request.method !== 'HEAD')) return false
  if (request.headers.get('upgrade')) return false
  const { pathname } = new URL(request.url)
  return prefixes
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}
