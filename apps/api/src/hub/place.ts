// Where the running code is, on Cloudflare (docs/workspace-hubs-plan.md): the Api object, a
// workspace's hub object, or neither (a Worker's own isolate: the cron, a queue's consumer). Each
// object's entry points set it; objects may share an isolate, so it is never a module's variable.
// On Node nothing sets it: the one process is all of them.
import { AsyncLocalStorage } from 'node:async_hooks'

export type Place = { kind: 'api' } | { kind: 'hub'; workspaceId: string }

const places = new AsyncLocalStorage<Place>()

/** Run `fn` as code of this place. */
export const runIn = <T>(place: Place, fn: () => T): T => places.run(place, fn)

/** Where the running code is, if an object said. */
export const currentPlace = (): Place | undefined => places.getStore()
