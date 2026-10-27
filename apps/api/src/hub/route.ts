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
