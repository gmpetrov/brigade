import { trackAudit, type AnalyticsProps } from './analytics.js'
import { prisma, Prisma } from './db.js'

export type Actor = { type: 'member' | 'teammate' | 'runner' | 'system'; id: string }

/**
 * Append one entry to the audit log. Every action that changes something is
 * recorded with actor, target and time (spec hard constraint 6). Its product analytics
 * events (src/analytics-events.ts) go too, not waited on.
 */
export async function audit(entry: {
  organizationId: string
  workspaceId: string | null
  actor: Actor
  action: string
  target: { type: string; id: string }
  data?: Prisma.InputJsonValue
  /**
   * For analytics alone, not kept in the log: enums and counts its events carry
   * (docs/analytics.md), such as how a thread started.
   */
  track?: AnalyticsProps
}) {
  await prisma.auditEntry.create({
    data: {
      organizationId: entry.organizationId,
      workspaceId: entry.workspaceId,
      actorType: entry.actor.type,
      actorId: entry.actor.id,
      action: entry.action,
      targetType: entry.target.type,
      targetId: entry.target.id,
      ...(entry.data === undefined ? {} : { data: entry.data }),
    },
  })
  trackAudit(entry)
}
