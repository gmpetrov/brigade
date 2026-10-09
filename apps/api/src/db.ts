import { PrismaPg } from '@prisma/adapter-pg'
import { Prisma, PrismaClient } from './generated/prisma/client.js'
import { env } from './config.js'

export { Prisma }

/** Unscoped client. Use only for auth, runner lookup by token hash, and scoped(). */
export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
})

export type Scope = {
  organizationId: string
  workspaceId: string
}

const ORG_ONLY = new Set(['Member', 'Invitation'])
const UNSCOPED = new Set(['User', 'AuthSession', 'AuthAccount', 'Verification', 'Organization'])
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
          return query(a)
        },
      },
    },
  })
}
export type ScopedDb = ReturnType<typeof scoped>
