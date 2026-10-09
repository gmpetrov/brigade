import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { organization } from 'better-auth/plugins'
import { audit } from './audit.js'
import { env } from './config.js'
import { prisma } from './db.js'

/** Audit actors are members. Fall back to the user when no membership exists yet. */
async function memberActor(organizationId: string, userId: string) {
  const member = await prisma.member.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  })
  return { type: 'member' as const, id: member?.id ?? userId }
}

export const auth = betterAuth({
  baseURL: env.API_URL,
  basePath: '/api/auth',
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: env.WEB_URL,
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  emailAndPassword: { enabled: true },
  session: {
    modelName: 'authSession',
    additionalFields: {
      // The workspace every request is scoped to. Changed only through
      // POST /api/workspaces/switch, which checks membership.
      activeWorkspaceId: { type: 'string', required: false, input: false },
    },
  },
  account: { modelName: 'authAccount' },
  plugins: [
    organization({
      organizationHooks: {
        afterCreateOrganization: async ({ organization, user }) =>
          audit({
            organizationId: organization.id,
            workspaceId: null,
            actor: await memberActor(organization.id, user.id),
            action: 'organization.created',
            target: { type: 'organization', id: organization.id },
            data: { name: organization.name },
          }),
        afterUpdateOrganization: async ({ organization, user }) => {
          if (!organization) return
          await audit({
            organizationId: organization.id,
            workspaceId: null,
            actor: await memberActor(organization.id, user.id),
            action: 'organization.updated',
            target: { type: 'organization', id: organization.id },
          })
        },
        afterAddMember: async ({ member, user, organization }) =>
          audit({
            organizationId: organization.id,
            workspaceId: null,
            actor: await memberActor(organization.id, user.id),
            action: 'member.added',
            target: { type: 'member', id: member.id },
            data: { role: member.role },
          }),
        afterRemoveMember: async ({ member, user, organization }) =>
          audit({
            organizationId: organization.id,
            workspaceId: null,
            actor: await memberActor(organization.id, user.id),
            action: 'member.removed',
            target: { type: 'member', id: member.id },
          }),
        afterUpdateMemberRole: async ({ member, previousRole, user, organization }) =>
          audit({
            organizationId: organization.id,
            workspaceId: null,
            actor: await memberActor(organization.id, user.id),
            action: 'member.role_changed',
            target: { type: 'member', id: member.id },
            data: { from: previousRole, to: member.role },
          }),
        afterCreateInvitation: async ({ invitation, inviter, organization }) =>
          audit({
            organizationId: organization.id,
            workspaceId: null,
            actor: await memberActor(organization.id, inviter.id),
            action: 'invitation.created',
            target: { type: 'invitation', id: invitation.id },
            data: { email: invitation.email, role: invitation.role },
          }),
      },
    }),
  ],
})

export type AuthSession = typeof auth.$Infer.Session
