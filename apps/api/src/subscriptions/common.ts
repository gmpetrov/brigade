// What every subscription needs: the connection, its triggers, and a way to say
// why the vendor could not be subscribed.
import { env } from '../config.js'
import { triggersOf } from '../connectors/index.js'
import type { ConnectorKind } from '../connectors/types.js'
import type { Scope, ScopedDb } from '../db.js'

/** The vendor refused, or this server cannot be reached: shown to the admin as is. */
export class SubscribeError extends Error {}

/** Vendors push only to a public HTTPS address. */
export const reachable = () => env.API_URL.startsWith('https://')

export type Target = {
  db: ScopedDb
  scope: Scope
  connection: {
    id: string
    kind: ConnectorKind
    vaultSecretId: string | null
    externalAccount: string | null
  }
  /** The connection's triggers. None: unsubscribe. */
  triggers: { event: string; options: unknown }[]
}

/** The vendor event types a connection's triggers listen to, sorted. */
export const vendorEvents = (target: Target) =>
  [
    ...new Set(
      target.triggers.flatMap((t) => triggersOf(target.connection.kind)[t.event]?.events ?? []),
    ),
  ].sort()

/** Calls to the same subscription wait for each other: never two readers of one cursor. */
const running = new Map<string, Promise<unknown>>()
export function serially<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = running.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(work)
  running.set(key, next)
  void next
    .finally(() => {
      if (running.get(key) === next) running.delete(key)
    })
    .catch(() => undefined)
  return next
}
