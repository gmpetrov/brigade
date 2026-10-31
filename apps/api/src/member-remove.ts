// A person leaves an organization others stay in: removed by an owner or admin
// (src/routes/members.ts), or when they delete their account (src/account-delete.ts). The threads
// they started go with their files, the accounts they connected for themselves alone are
// disconnected, then their membership goes, and what hangs off it (schedules, tasks, their own
// machines and AI accounts) with it.
import { HTTPException } from 'hono/http-exception'
import { audit } from './audit.js'
import { prisma, scoped } from './db.js'
import type { SessionStatus } from './generated/prisma/enums.js'
import type { WorkspaceScope } from './scope.js'
import { deleteThread } from './thread-delete.js'

const BUSY: SessionStatus[] = ['starting', 'running']

export type Membership = {
  id: string
  role: string
  organizationId: string
  organization: { name: string }
}

/** Refused while a teammate works in a thread they started: its run would stop halfway. */
export async function checkMemberIdle(membership: Membership, whose: string = 'you') {
  const busy = await prisma.session.count({
    where: {
      organizationId: membership.organizationId,
      status: { in: BUSY },
      OR: [{ startedByMemberId: membership.id }, { parent: { startedByMemberId: membership.id } }],
    },
  })
  if (busy)
    throw new HTTPException(409, {
      message: `A teammate is working in a thread ${whose} started in ${membership.organization.name}. Stop it first, or wait for it to finish.`,
    })
}

/**
 * The threads they started go first, each with its files (their rows would go with the
 * membership, but not what they left in the bucket), and the accounts they connected for
 * themselves alone are disconnected. Then the membership, and the organization stops being the
 * active one of their sessions.
 */
export async function removeMember(
  userId: string,
  membership: Membership,
  by: { actor: { type: 'member'; id: string }; reason: string },
) {
  const { disconnect } = await import('./routes/connections.js')
  const workspaces = await prisma.workspace.findMany({
    where: { organizationId: membership.organizationId },
    select: { id: true },
  })
  for (const { id: workspaceId } of workspaces) {
    const scope: WorkspaceScope = {
      organizationId: membership.organizationId,
      workspaceId,
      userId,
      memberId: membership.id,
      role: membership.role as WorkspaceScope['role'],
    }
    const db = scoped(scope)
    const actor = { type: 'member' as const, id: membership.id }
    const started = await db.session.findMany({
      where: { startedByMemberId: membership.id },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    })
    for (const { id } of started) {
      // A child thread went with its parent already.
      if (!(await db.session.findFirst({ where: { id }, select: { id: true } }))) continue
      await deleteThread(db, scope, actor, id)
    }
    const own = await db.connection.findMany({
      where: { createdByMemberId: membership.id, reach: 'mine', status: { not: 'removed' } },
      select: { id: true, kind: true, vaultSecretId: true, appId: true },
    })
    for (const connection of own)
      await disconnect(scope, db, connection).catch((error: unknown) =>
        console.warn(`removing ${membership.id}: ${connection.id} not disconnected`, error),
      )
  }
  await prisma.member.deleteMany({ where: { id: membership.id } })
  await prisma.authSession.updateMany({
    where: { userId, activeOrganizationId: membership.organizationId },
    data: { activeOrganizationId: null, activeWorkspaceId: null },
  })
  await audit({
    organizationId: membership.organizationId,
    workspaceId: null,
    actor: by.actor,
    action: 'member.removed',
    target: { type: 'member', id: membership.id },
    data: { reason: by.reason, userId },
  })
}
