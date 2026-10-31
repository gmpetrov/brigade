// A person leaves an organization others stay in: removed by an owner or admin
// (src/routes/members.ts), or when they delete their account (src/account-delete.ts). The threads
// they started go with their files, the accounts they connected for themselves alone are
// disconnected, then their membership goes, and what hangs off it (schedules, tasks, their own
// machines and AI accounts) with it.
//
// Changes to an organization's members take turns (lockMembers), so that two at once never
// leave it without an owner. A removal takes long: its fence, Member.removingAt, set in its turn,
// shuts the member out at once (src/scope.ts) and keeps their role as it is until they are gone.
import { HTTPException } from 'hono/http-exception'
import { audit } from './audit.js'
import { prisma, scoped, type Prisma } from './db.js'
import type { SessionStatus } from './generated/prisma/enums.js'
import { hubs } from './hub.js'
import { beingRemoved } from './member-fence.js'
import type { WorkspaceScope } from './scope.js'
import { deleteThread } from './thread-delete.js'

export { beingRemoved }

const BUSY: SessionStatus[] = ['starting', 'running']

export type Membership = {
  id: string
  role: string
  organizationId: string
  organization: { name: string }
}

/** In a transaction: the organization's member changes wait for this one. */
export async function lockMembers(tx: Prisma.TransactionClient, organizationId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`members:${organizationId}`}, 0))`
}

/** An organization's owners, but those being removed. */
export async function ownersLeft(tx: Prisma.TransactionClient, organizationId: string) {
  const owners = await tx.member.findMany({
    where: { organizationId, role: 'owner' },
    select: { removingAt: true },
  })
  return owners.filter((o) => !beingRemoved(o)).length
}

/** Their dashboards in each workspace of the organization close, to connect again or not. */
export async function dropMemberSockets(organizationId: string, memberId: string) {
  const workspaces = await prisma.workspace.findMany({
    where: { organizationId },
    select: { id: true },
  })
  for (const { id } of workspaces) await hubs.get(id).dropMember(memberId)
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
 * In its turn, `check` passes (who removes whom), the organization keeps an owner and the fence
 * goes up: from then on they reach nothing of it. Then the threads they started go, each with its
 * files (their rows would go with the membership, but not what they left in the bucket), and the
 * accounts they connected for themselves alone are disconnected. Then the membership, and the
 * organization stops being the active one of their sessions. A failure lowers the fence.
 */
export async function removeMember(
  userId: string,
  membership: Membership,
  by: {
    actor: { type: 'member'; id: string }
    reason: string
    check?: (tx: Prisma.TransactionClient) => Promise<void>
  },
  whose?: string,
) {
  await prisma.$transaction(async (tx) => {
    await lockMembers(tx, membership.organizationId)
    const member = await tx.member.findUnique({
      where: { id: membership.id },
      select: { role: true, removingAt: true },
    })
    if (!member) throw new HTTPException(404, { message: 'They are no longer a member' })
    if (beingRemoved(member))
      throw new HTTPException(409, { message: 'They are being removed already' })
    await by.check?.(tx)
    if (member.role === 'owner' && (await ownersLeft(tx, membership.organizationId)) <= 1)
      throw new HTTPException(409, {
        message: `Make someone else an owner of ${membership.organization.name} first: it needs one`,
      })
    await checkMemberIdle(membership, whose)
    await tx.member.update({ where: { id: membership.id }, data: { removingAt: new Date() } })
  })
  try {
    await dropMemberSockets(membership.organizationId, membership.id)
    await cleanUp(userId, membership)
  } catch (error) {
    await prisma.member
      .updateMany({ where: { id: membership.id }, data: { removingAt: null } })
      .catch(() => {})
    throw error
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

/** What they started and connected for themselves, in each workspace of the organization. */
async function cleanUp(userId: string, membership: Membership) {
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
}
