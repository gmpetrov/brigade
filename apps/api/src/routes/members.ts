// Settings › Members: who belongs to the organization, and the invitations still open. Inviting
// and taking an invitation go through better-auth's organization plugin (src/auth.ts), which
// checks roles (an admin invites members and admins, only an owner invites an owner), mails the
// link and lets only the proven owner of the invited address join, at /invite/<id>.
import { CreateInvitation } from '@brigade/contracts'
import { APIError } from 'better-auth/api'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { auth } from '../auth.js'
import { prisma } from '../db.js'
import { spendInvitation } from '../invitation-budget.js'
import { parseBody, requireRole, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

/** The plugin's messages, said the way the dashboard says things. */
const SAID: Record<string, string> = {
  'User is already a member of this organization': 'They are a member already',
  'You are not allowed to invite a user with this role': 'Only an owner can invite an owner',
  'You are not allowed to invite users to this organization':
    'Only an owner or admin can invite people',
  'You are not allowed to cancel this invitation': 'Only an owner or admin can cancel it',
  'Invitation not found': 'This invitation is no longer open',
  'Invitation not found!': 'This invitation is no longer open',
  'Inviter is no longer a member of the organization':
    'Whoever invited you is no longer a member: ask another one to invite you again',
  'Invitation limit reached': 'Too many open invitations: cancel some first',
}

/** A call to the plugin, its refusals as the API's own errors. */
async function plugin<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (!(error instanceof APIError)) throw error
    const message = error.body?.message ?? error.message
    throw new HTTPException(error.statusCode as ContentfulStatusCode, {
      message: SAID[message] ?? message,
    })
  }
}

/** Open: pending and not yet expired. */
const openNow = () => ({ status: 'pending', expiresAt: { gt: new Date() } })

export const members = new Hono<AppEnv>()
  .use(requireUser)

  /** The organization's members; its open invitations for owners and admins. */
  .get('/members', requireWorkspace, async (c) => {
    const { scope } = c.var
    const [rows, invitations] = await Promise.all([
      prisma.member.findMany({
        where: { organizationId: scope.organizationId },
        include: { user: { select: { name: true, email: true, image: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      scope.role === 'member'
        ? []
        : prisma.invitation.findMany({
            where: { organizationId: scope.organizationId, ...openNow() },
            include: { inviter: { select: { name: true } } },
            orderBy: { createdAt: 'desc' },
          }),
    ])
    return c.json({
      members: rows.map((m) => ({
        id: m.id,
        name: m.user.name,
        email: m.user.email,
        image: m.user.image,
        role: m.role,
        joinedAt: m.createdAt,
      })),
      invitations: invitations.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role ?? 'member',
        invitedBy: i.inviter.name,
        expiresAt: i.expiresAt,
      })),
    })
  })

  /**
   * Invite an address, or mail its open invitation again (its week starts over). With another
   * role than the open one, a new invitation replaces it: the plugin's resend keeps the old role.
   */
  .post('/members/invitations', requireWorkspace, async (c) => {
    const { scope } = c.var
    requireRole(scope, 'owner', 'admin')
    const { email, role } = await parseBody(c.req.raw, CreateInvitation)
    const open = await prisma.invitation.findFirst({
      where: { organizationId: scope.organizationId, email, ...openNow() },
      select: { role: true },
    })
    await spendInvitation(scope.organizationId, email)
    const invitation = await plugin(() =>
      auth.api.createInvitation({
        headers: c.req.raw.headers,
        body: {
          email,
          role,
          organizationId: scope.organizationId,
          resend: !!open && (open.role ?? 'member') === role,
        },
      }),
    )
    return c.json({ id: invitation.id, email: invitation.email }, 201)
  })

  .delete('/members/invitations/:id', requireWorkspace, async (c) => {
    const { scope } = c.var
    requireRole(scope, 'owner', 'admin')
    const invitation = await prisma.invitation.findFirst({
      where: { id: c.req.param('id'), organizationId: scope.organizationId },
    })
    if (!invitation) throw new HTTPException(404, { message: 'Invitation not found' })
    await plugin(() =>
      auth.api.cancelInvitation({
        headers: c.req.raw.headers,
        body: { invitationId: invitation.id },
      }),
    )
    return c.body(null, 204)
  })

  /** The invitations open for the signed-in address: onboarding offers to join them. */
  .get('/invitations', async (c) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: c.var.userId } })
    // Only a proven address sees what was sent to it.
    if (!user.emailVerified) return c.json([])
    const rows = await prisma.invitation.findMany({
      where: { email: user.email.toLowerCase(), ...openNow() },
      include: { organization: { select: { name: true } }, inviter: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    })
    return c.json(
      rows.map((i) => ({
        id: i.id,
        organization: i.organization.name,
        invitedBy: i.inviter.name,
        role: i.role ?? 'member',
      })),
    )
  })

  /** One invitation, for the signed-in owner of its address only: what /invite/<id> shows. */
  .get('/invitations/:id', async (c) => {
    const id = c.req.param('id')
    const invitation = await prisma.invitation.findUnique({
      where: { id },
      include: { organization: { select: { name: true } }, inviter: { select: { name: true } } },
    })
    if (!invitation || invitation.status !== 'pending' || invitation.expiresAt < new Date())
      throw new HTTPException(404, { message: 'This invitation is no longer open' })
    const user = await prisma.user.findUniqueOrThrow({ where: { id: c.var.userId } })
    const member = await prisma.member.findUnique({
      where: {
        organizationId_userId: { organizationId: invitation.organizationId, userId: user.id },
      },
    })
    if (invitation.email.toLowerCase() !== user.email.toLowerCase()) {
      // Neither where it goes nor who sent it: only that it is for another address.
      return c.json({ id, forYou: false as const, signedInAs: user.email })
    }
    return c.json({
      id,
      forYou: true as const,
      signedInAs: user.email,
      organization: invitation.organization.name,
      invitedBy: invitation.inviter.name,
      role: invitation.role ?? 'member',
      member: !!member,
    })
  })

  /** Join: a member of the organization, in its first workspace. */
  .post('/invitations/:id/accept', async (c) => {
    const { member } = await plugin(() =>
      auth.api.acceptInvitation({
        headers: c.req.raw.headers,
        body: { invitationId: c.req.param('id') },
      }),
    )
    if (!member) throw new HTTPException(409, { message: 'Could not join' })
    // The plugin made the organization the session's; its first workspace goes with it.
    const workspace = await prisma.workspace.findFirst({
      where: { organizationId: member.organizationId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    await prisma.authSession.update({
      where: { id: c.var.authSessionId },
      data: {
        activeOrganizationId: member.organizationId,
        activeWorkspaceId: workspace?.id ?? null,
      },
    })
    return c.json({ organizationId: member.organizationId, workspaceId: workspace?.id ?? null })
  })
