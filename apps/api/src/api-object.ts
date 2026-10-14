// The one Api object (src/worker.ts), as the Workers in front of it reach it: src/front.ts
// forwards requests to it, src/worker.ts's cron wakes it. Nothing of the app is imported
// here: the front Worker must stay small.
import type { Api } from './worker.js'

/**
 * An object stays in the data center it was created in, near the first Worker to ask
 * for it, and each query crosses from there to the database. This one was created in
 * Frankfurt, next to the database, by a Worker placed there (`"placement": { "region":
 * "aws:eu-central-1" }` in its Wrangler file), since removed. A new name makes a new
 * object, near whichever Worker asks first: to have it next to the database again, place
 * the front Worker there until the object is created. The cron is never placed: should it
 * ask first, its hint keeps the object in western Europe.
 */
export const NAME = 'eu-central-1'

export const apiObject = (
  namespace: DurableObjectNamespace<Api>,
  locationHint?: DurableObjectLocationHint,
) => namespace.get(namespace.idFromName(NAME), locationHint && { locationHint })
