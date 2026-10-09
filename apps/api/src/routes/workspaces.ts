import { CreateWorkspace, SwitchWorkspace } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { audit } from '../audit.js'
import { createWorkspaceComputer } from '../cloud.js'
import { prisma } from '../db.js'
import { parseBody, requireUser, resolveScope, type AppEnv } from '../scope.js'

export const workspaces = new Hono<AppEnv>()
  .use(requireUser)

  /** Everything the dashboard needs to render its shell. */
  .get('/me', async (c) => {
    const [user, memberships] = await Promise.all([
      prisma.user.findUniqueOrThrow({
        where: { id: c.var.userId },
        select: { id: true, name: true, email: true },
      }),
      prisma.member.findMany({ where: { userId: c.var.userId }, include: { organization: true } }),
    ])
    // A fresh session has no scope yet: default to the first organization and workspace.
    const membership =
      memberships.find((m) => m.organizationId === c.var.activeOrganizationId) ?? memberships[0]
    const orgId = membership?.organizationId ?? null
    const workspaceList = membership
      ? await prisma.workspace.findMany({
          where: { organizationId: membership.organizationId },
          orderBy: { createdAt: 'asc' },
        })
      : []
    let scope = await resolveScope(c.var)
    if (!scope && membership) {
      const workspaceId =
        workspaceList.find((w) => w.id === c.var.activeWorkspaceId)?.id ??
        workspaceList[0]?.id ??
        null
      await prisma.authSession.update({
        where: { id: c.var.authSessionId },
        data: { activeOrganizationId: membership.organizationId, activeWorkspaceId: workspaceId },
      })
      scope = await resolveScope({
        userId: c.var.userId,
        activeOrganizationId: membership.organizationId,
        activeWorkspaceId: workspaceId,
      })
    }
    return c.json({
      user,
      organizations: memberships.map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        role: m.role,
      })),
      activeOrganizationId: membership ? orgId : null,
      role: membership?.role ?? null,
      workspaces: workspaceList.map((w) => ({ id: w.id, name: w.name })),
      activeWorkspaceId: scope?.workspaceId ?? null,
      memberId: scope?.memberId ?? null,
    })
  })

  /** Create a workspace in the active organization and switch to it. */
  .post('/workspaces', async (c) => {
    const { name } = await parseBody(c.req.raw, CreateWorkspace)
    const organizationId = c.var.activeOrganizationId
    if (!organizationId) throw new HTTPException(409, { message: 'Choose an organization first' })
    const member = await prisma.member.findUnique({
      where: { organizationId_userId: { organizationId, userId: c.var.userId } },
    })
    if (!member) throw new HTTPException(403, { message: 'Not a member of this organization' })
    if (member.role !== 'owner' && member.role !== 'admin') {
      throw new HTTPException(403, { message: 'Only an owner or admin can create a workspace' })
    }
    const workspace = await prisma.workspace.create({ data: { organizationId, name } })
    await prisma.authSession.update({
      where: { id: c.var.authSessionId },
      data: { activeWorkspaceId: workspace.id },
    })
    await audit({
      organizationId,
      workspaceId: workspace.id,
      actor: { type: 'member', id: member.id },
      action: 'workspace.created',
      target: { type: 'workspace', id: workspace.id },
      data: { name },
    })
    // Every workspace gets its own cloud computer (when a provider is configured).
    await createWorkspaceComputer(workspace)
    return c.json({ id: workspace.id, name: workspace.name }, 201)
  })

  /** Make another workspace of the active organization the session's scope. */
  .post('/workspaces/switch', async (c) => {
    const { workspaceId } = await parseBody(c.req.raw, SwitchWorkspace)
    const scope = await resolveScope({ ...c.var, activeWorkspaceId: workspaceId })
    if (!scope) throw new HTTPException(404, { message: 'Workspace not found' })
    await prisma.authSession.update({
      where: { id: c.var.authSessionId },
      data: { activeWorkspaceId: scope.workspaceId },
    })
    return c.json({ ok: true })
  })
