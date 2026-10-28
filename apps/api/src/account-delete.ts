// Deleting a person's Brigade account. An organization they are alone in goes with them, each of
// its workspaces as src/workspace-delete.ts deletes one. One shared with others stays: the
// threads they started there go with their files, then their membership, and what hangs off it
// (schedules, tasks, their own machines and AI accounts) with it. Then the user. Everything is
// checked first, so a refusal changes nothing; a step that fails later leaves the account there
// to delete again.
import { HTTPException } from 'hono/http-exception'
import { audit } from './audit.js'
import { billingEnabled, entitles, workspacePlan } from './billing.js'
import { prisma, scoped } from './db.js'
import type { SessionStatus } from './generated/prisma/enums.js'
import type { WorkspaceScope } from './scope.js'
import { deleteThread } from './thread-delete.js'
import { checkWorkspaceIdle, deleteWorkspace } from './workspace-delete.js'

const BUSY: SessionStatus[] = ['starting', 'running']

type Membership = {
  id: string
  role: string
  organizationId: string
  organization: { name: string }
}

/** How each of the person's organizations goes: with them, or without them. */
async function planFor(userId: string) {
  const memberships: Membership[] = await prisma.member.findMany({
    where: { userId },
    select: {
      id: true,
      role: true,
      organizationId: true,
      organization: { select: { name: true } },
    },
  })
  const alone: Membership[] = []
  const leaving: Membership[] = []
  for (const membership of memberships) {
    const others = await prisma.member.findMany({
      where: { organizationId: membership.organizationId, userId: { not: userId } },
      select: { role: true },
    })
    if (others.length === 0) {
      alone.push(membership)
      continue
    }
    if (membership.role === 'owner' && !others.some((o) => o.role === 'owner'))
      throw new HTTPException(409, {
        message: `Make someone else an owner of ${membership.organization.name}, or delete its workspaces, first`,
      })
    leaving.push(membership)
  }
  return { alone, leaving }
}

/** Refuse what would stop the deletion halfway: work under way, a plan still billed. */
async function check(plan: Awaited<ReturnType<typeof planFor>>) {
  for (const membership of plan.alone) {
    const workspaces = await prisma.workspace.findMany({
      where: { organizationId: membership.organizationId },
      select: { id: true, name: true },
    })
    for (const workspace of workspaces) {
      await checkWorkspaceIdle(workspace.id)
      const current = billingEnabled() ? await workspacePlan(workspace.id) : null
      if (current?.stripeSubscriptionId && entitles(current.status))
        throw new HTTPException(409, {
          message: `${workspace.name} has Brigade Cloud. Cancel Brigade Cloud in Settings › Billing first; you can delete your account once it has ended`,
        })
    }
  }
  for (const membership of plan.leaving) {
    const busy = await prisma.session.count({
      where: {
        organizationId: membership.organizationId,
        status: { in: BUSY },
        OR: [
          { startedByMemberId: membership.id },
          { parent: { startedByMemberId: membership.id } },
        ],
      },
    })
    if (busy)
      throw new HTTPException(409, {
        message: `A teammate is working in a thread you started in ${membership.organization.name}. Stop it first, or wait for it to finish.`,
      })
  }
}

/**
 * The person leaves an organization others stay in: the threads they started go first, each with
 * its files (their rows would go with the membership, but not what they left in the bucket), and
 * the accounts they connected for themselves alone are disconnected.
 */
async function leave(userId: string, membership: Membership) {
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
        console.warn(`deleting ${userId}: ${connection.id} not disconnected`, error),
      )
  }
  await prisma.member.deleteMany({ where: { id: membership.id } })
  await audit({
    organizationId: membership.organizationId,
    workspaceId: null,
    actor: { type: 'member', id: membership.id },
    action: 'member.removed',
    target: { type: 'member', id: membership.id },
    data: { reason: 'account deleted', userId },
  })
}

/** Delete the person's account, and the organizations they are alone in. */
export async function deleteAccount(userId: string) {
  const plan = await planFor(userId)
  await check(plan)
  for (const membership of plan.alone) {
    const by = { userId, memberId: membership.id }
    const workspaces = await prisma.workspace.findMany({
      where: { organizationId: membership.organizationId },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    })
    // The last one takes the organization with it.
    for (const { id } of workspaces)
      await deleteWorkspace({ organizationId: membership.organizationId, workspaceId: id }, by)
    if (!workspaces.length) {
      await prisma.organization.deleteMany({ where: { id: membership.organizationId } })
      await audit({
        organizationId: membership.organizationId,
        workspaceId: null,
        actor: { type: 'member', id: membership.id },
        action: 'organization.deleted',
        target: { type: 'organization', id: membership.organizationId },
        data: { reason: 'account deleted', userId },
      })
    }
  }
  for (const membership of plan.leaving) await leave(userId, membership)
  // Their sign-ins, sessions, devices and the invitations they sent go with them.
  await prisma.user.deleteMany({ where: { id: userId } })
}
