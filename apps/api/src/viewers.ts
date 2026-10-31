// A viewer reads the workspace and changes nothing in it: every request that writes is refused
// to them (requireWorkspace, src/scope.ts), but those that only keep their own place in it,
// such as what they read, pinned or put away for later.
import { HTTPException } from 'hono/http-exception'

/** Writes of a viewer's own, by method and path under /api. */
const OWN_WRITES: [string, RegExp][] = [
  ['POST', /^\/api\/threads\/[^/]+\/read$/],
  ['POST', /^\/api\/threads\/[^/]+\/(pin|later)$/],
  ['DELETE', /^\/api\/threads\/[^/]+\/(pin|later)$/],
  ['PUT', /^\/api\/threads\/pins\/order$/],
  // Reading a thread's preview or code changes nothing.
  ['POST', /^\/api\/threads\/[^/]+\/preview$/],
  ['POST', /^\/api\/threads\/[^/]+\/code\/hashes$/],
  ['POST', /^\/api\/library\/[^/]+\/pin$/],
  ['DELETE', /^\/api\/library\/[^/]+\/pin$/],
  ['POST', /^\/api\/lists\/[^/]+\/pin$/],
  ['DELETE', /^\/api\/lists\/[^/]+\/pin$/],
  ['PUT', /^\/api\/me\/(sidebar-order|suggestions)$/],
  ['POST', /^\/api\/home\/dismiss$/],
  ['PUT', /^\/api\/notifications\/preset$/],
  ['POST', /^\/api\/notifications\/(devices|devices\/remove|test)$/],
]

const reads = new Set(['GET', 'HEAD', 'OPTIONS'])

export function viewerMay(method: string, path: string) {
  return reads.has(method) || OWN_WRITES.some(([m, p]) => m === method && p.test(path))
}

export function requireNotViewer(role: string, method: string, path: string) {
  if (role === 'viewer' && !viewerMay(method, path))
    throw new HTTPException(403, {
      message: 'You can view this workspace but not change it. Ask an owner or admin.',
    })
}
