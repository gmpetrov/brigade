// Deleting a person's Brigade account. An organization they are alone in goes with them, each of
// its workspaces as src/workspace-delete.ts deletes one. One shared with others stays: the
// threads they started there go with their files, then their membership, and what hangs off it
// (schedules, tasks, their own machines and AI accounts) with it. Then the user. Everything is
// checked first, so a refusal changes nothing; a step that fails later leaves the account there
// to delete again.
import { HTTPException } from 'hono/http-exception'
import { audit } from './audit.js'
import { billingEnabled, entitles, workspacePlan } from './billing.js'
import { prisma } from './db.js'
import { checkMemberIdle, removeMember, type Membership } from './member-remove.js'
import { checkWorkspaceIdle, deleteWorkspace } from './workspace-delete.js'

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
  for (const membership of plan.leaving) await checkMemberIdle(membership)
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
  for (const membership of plan.leaving)
    await removeMember(userId, membership, {
      actor: { type: 'member', id: membership.id },
      reason: 'account deleted',
    })
  // Their sign-ins, sessions, devices and the invitations they sent go with them.
  await prisma.user.deleteMany({ where: { id: userId } })
}
