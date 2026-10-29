import { AsyncLocalStorage } from 'node:async_hooks'
import { PrismaPg } from '@prisma/adapter-pg'
import { Prisma, PrismaClient } from './generated/prisma/client.js'
import { env } from './config.js'
import { countQuery } from './timing.js'

export { Prisma }

/**
 * A Prisma client on its own pool of connections. pool: what limits it (a workspace's hub object
 * keeps few connections, and lets them go soon, so that it can hibernate).
 */
export function newPrismaClient(
  connectionString: string,
  pool: { max?: number; idleTimeoutMillis?: number } = {},
) {
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString, ...pool }),
    log: [{ emit: 'event', level: 'query' }],
  })
  client.$on('query', (event) => countQuery(event.duration))
  return client
}

/** The process's client: the API's on Node, the Api object's on Cloudflare. */
const processClient = newPrismaClient(env.DATABASE_URL)

/**
 * The client of the Durable Object the code runs for, when it has its own (a workspace's hub
 * object, src/hub-object.ts): objects may share an isolate, and a connection opened for one cannot
 * serve another.
 */
const objectClients = new AsyncLocalStorage<PrismaClient>()

/** Run `fn` with this client as `prisma`. */
export const withPrismaClient = <T>(client: PrismaClient, fn: () => T): T =>
  objectClients.run(client, fn)

/**
 * Unscoped client. Use only for auth, runner lookup by token hash, and scoped(). It is the
 * process's, or the running object's own (withPrismaClient).
 */
export const prisma: PrismaClient = new Proxy(processClient, {
  get(target, key) {
    const client = objectClients.getStore() ?? target
    const value = Reflect.get(client, key, client) as unknown
    return typeof value === 'function'
      ? (value as (...a: unknown[]) => unknown).bind(client)
      : value
  },
})

export type Scope = {
  organizationId: string
  workspaceId: string
}

const ORG_ONLY = new Set(['Member', 'Invitation'])
const UNSCOPED = new Set([
  'User',
  'AuthSession',
  'AuthAccount',
  'Verification',
  'Organization',
  'PushDevice',
  'McpClient',
  // A workspace's plan, an organization's deletion under way: src/billing.ts's only.
  'BillingSubscription',
  'BillingClosing',
  // Webhooks as they came, before anyone knows whose they are: src/inbound.ts's only.
  'InboundEvent',
  // A library file's lock, by workspace and file: src/library.ts's withLibraryLock only.
  'LibraryLock',
])
const READS_AND_BULK = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
])
const CREATES = new Set(['create', 'createMany', 'createManyAndReturn'])
const READS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
])

type WriteListener = (model: string, scope: Scope, operation: string, result: unknown) => void
const writeListeners: WriteListener[] = []

/** Called after every write through a scoped client, e.g. to tell dashboards. */
export function onScopedWrite(listener: WriteListener) {
  writeListeners.push(listener)
}

/**
 * A client whose every query is filtered by the session's organization and
 * workspace, and whose every create is stamped with them. Request input can
 * never widen it (spec hard constraint 5).
 */
export function scoped(scope: Scope) {
  return prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (UNSCOPED.has(model)) return query(args)
          const stamp: Record<string, string> = ORG_ONLY.has(model)
            ? { organizationId: scope.organizationId }
            : model === 'Workspace'
              ? { organizationId: scope.organizationId, id: scope.workspaceId }
              : { organizationId: scope.organizationId, workspaceId: scope.workspaceId }
          const a = (args ?? {}) as Record<string, any>
          if (READS_AND_BULK.has(operation)) {
            a.where = { ...a.where, ...stamp }
          } else if (CREATES.has(operation)) {
            if (model === 'Workspace') throw new Error('Create workspaces with the unscoped client')
            const add = (row: object) => ({ ...row, ...stamp })
            a.data = Array.isArray(a.data) ? a.data.map(add) : add(a.data)
          } else if (operation === 'upsert') {
            a.where = { ...a.where, ...stamp }
            a.create = { ...a.create, ...stamp }
          } else {
            throw new Error(`scoped(): unsupported operation ${model}.${operation}`)
          }
          const result = await query(a)
          // A bulk write that matched nothing changed nothing.
          const none = (result as { count?: number } | null)?.count === 0
          if (!READS.has(operation) && !none)
            for (const listener of writeListeners) listener(model, scope, operation, result)
          return result
        },
      },
    },
  })
}
export type ScopedDb = ReturnType<typeof scoped>
