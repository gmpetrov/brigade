import {
  CreateWorkspace,
  DeleteAccount,
  DeleteWorkspace,
  SetSuggestions,
  SwitchWorkspace,
  UpdateWorkspace,
} from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { deleteAccount } from '../account-delete.js'
import { audit } from '../audit.js'
import { auth } from '../auth.js'
import { workspaceLogoKey } from '../bucket.js'
import { ensureChief } from '../chief.js'
import { createWorkspaceComputer } from '../cloud.js'
import { prisma } from '../db.js'
import { placeNewHub } from '../platform/node.js'
import { LOGO_HEADERS, readLogo } from '../logos.js'
import {
  parseBody,
  requireRole,
  requireUser,
  requireWorkspace,
  resolveScope,
  type AppEnv,
} from '../scope.js'
import { deleteWorkspace } from '../workspace-delete.js'
import { updateWorkspace } from '../workspace-settings.js'
import { z } from 'zod'

const SetSidebarOrder = z.object({
  list: z.enum(['teammates', 'projects']),
  ids: z.array(z.string().max(100)).max(500),
})
type SidebarList = z.infer<typeof SetSidebarOrder>['list']

export const workspaces = new Hono<AppEnv>()
  .use(requireUser)

  /** Everything the dashboard needs to render its shell. */
  .get('/me', async (c) => {
    const [user, memberships] = await Promise.all([
      prisma.user.findUniqueOrThrow({
        where: { id: c.var.userId },
        select: { id: true, name: true, email: true, image: true },
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
    // Nothing runs without an AI account: onboarding asks for one first.
    const aiReady = scope
      ? (await prisma.account.count({
          where: {
            workspaceId: scope.workspaceId,
            memberId: scope.memberId,
            // Signed in once is enough: a login that expires later opens a ticket instead.
            OR: [
              { status: { in: ['ready', 'exhausted', 'unverified'] } },
              { sessions: { some: {} } },
            ],
          },
        })) > 0
      : false
    return c.json({
      user,
      aiReady,
      organizations: memberships.map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        role: m.role,
      })),
      activeOrganizationId: membership ? orgId : null,
      role: membership?.role ?? null,
      workspaces: workspaceList.map((w) => ({ id: w.id, name: w.name, logo: w.logo })),
      activeWorkspaceId: scope?.workspaceId ?? null,
      memberId: scope?.memberId ?? null,
      suggestions: membership?.suggestions ?? true,
    })
  })

  /** The member's message box suggests their next message, or stops (Member.suggestions). */
  .put('/me/suggestions', requireWorkspace, async (c) => {
    const { suggestions } = await parseBody(c.req.raw, SetSuggestions)
    await prisma.member.update({ where: { id: c.var.scope.memberId }, data: { suggestions } })
    return c.body(null, 204)
  })

  /** The order this member dragged their sidebar's teammates and projects to, in this workspace. */
  .get('/me/sidebar-order', requireWorkspace, async (c) => {
    const { scope, db } = c.var
    const rows = await db.sidebarOrder.findMany({ where: { memberId: scope.memberId } })
    const of = (list: SidebarList) => rows.find((r) => r.list === list)?.ids ?? []
    return c.json({ teammates: of('teammates'), projects: of('projects') })
  })
  .put('/me/sidebar-order', requireWorkspace, async (c) => {
    const { scope, db } = c.var
    const { list, ids } = await parseBody(c.req.raw, SetSidebarOrder)
    await db.sidebarOrder.upsert({
      where: {
        memberId_workspaceId_list: {
          memberId: scope.memberId,
          workspaceId: scope.workspaceId,
          list,
        },
      },
      create: {
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        memberId: scope.memberId,
        list,
        ids,
      },
      update: { ids },
    })
    return c.body(null, 204)
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
    // Its hub in an object of its own from the start (docs/workspace-hubs-plan.md), before
    // anything below asks it for something.
    await placeNewHub(workspace.id)
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
    await ensureChief(workspace)
    // Every workspace gets its own cloud computer (when a provider is configured), unless
    // billing is on: then with its Cloud plan (src/billing.ts).
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

  /** Rename the active workspace or change its logo: owners and admins. */
  .patch('/workspace', requireWorkspace, async (c) => {
    const scope = c.var.scope
    requireRole(scope, 'owner', 'admin')
    const input = await parseBody(c.req.raw, UpdateWorkspace)
    const workspace = await updateWorkspace(scope, input)
    return c.json({ id: workspace.id, name: workspace.name, logo: workspace.logo })
  })

  /**
   * Delete the active workspace for good: owners only, typing its name to confirm. The session
   * moves to another workspace of the organization, or to none (onboarding) when it was the last,
   * which takes the organization with it.
   */
  .delete('/workspace', requireWorkspace, async (c) => {
    const scope = c.var.scope
    if (scope.role !== 'owner')
      throw new HTTPException(403, { message: 'Only an owner can delete the workspace' })
    const { name } = await parseBody(c.req.raw, DeleteWorkspace)
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: scope.workspaceId } })
    if (name.trim() !== workspace.name.trim())
      throw new HTTPException(400, { message: 'Type the workspace’s name to confirm' })
    const { organizationGone } = await deleteWorkspace(scope, scope)
    const session = await prisma.authSession.findUnique({
      where: { id: c.var.authSessionId },
      select: { activeWorkspaceId: true },
    })
    return c.json({ activeWorkspaceId: session?.activeWorkspaceId ?? null, organizationGone })
  })

  /**
   * Delete the signed-in person's account for good, typing their email address to confirm
   * (src/account-delete.ts). Signed out in the same answer.
   */
  .delete('/me', async (c) => {
    const { email } = await parseBody(c.req.raw, DeleteAccount)
    const user = await prisma.user.findUniqueOrThrow({ where: { id: c.var.userId } })
    if (email.trim().toLowerCase() !== user.email.toLowerCase())
      throw new HTTPException(400, { message: 'Type your email address to confirm' })
    await deleteAccount(user.id)
    // Its session is gone already: this only clears the cookie.
    const signedOut = await auth.api
      .signOut({ headers: c.req.raw.headers, returnHeaders: true })
      .catch(() => null)
    for (const cookie of signedOut?.headers.getSetCookie() ?? [])
      c.header('set-cookie', cookie, { append: true })
    return c.body(null, 204)
  })

  /** A workspace's logo, for any member of its organization (the switcher shows them all). */
  .get('/workspaces/:id/logo', async (c) => {
    const scope = await resolveScope({ ...c.var, activeWorkspaceId: c.req.param('id') })
    if (!scope) throw new HTTPException(404, { message: 'Workspace not found' })
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: scope.workspaceId } })
    const logo =
      workspace.logo && (await readLogo(workspaceLogoKey(scope, workspace.logo), workspace.logo))
    if (!logo) throw new HTTPException(404, { message: 'No logo' })
    return c.body(logo.bytes as Uint8Array<ArrayBuffer>, 200, {
      'content-type': logo.type,
      ...LOGO_HEADERS,
    })
  })
