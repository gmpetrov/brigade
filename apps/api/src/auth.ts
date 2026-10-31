import { type BetterAuthPlugin, betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { APIError } from 'better-auth/api'
import { captcha, emailOTP, organization } from 'better-auth/plugins'
import { createAccessControl } from 'better-auth/plugins/access'
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from 'better-auth/plugins/organization/access'
import { HTTPException } from 'hono/http-exception'
import { recordSignup } from './analytics.js'
import { audit } from './audit.js'
import { guardOrganizationDeletion } from './billing.js'
import { env } from './config.js'
import { prisma } from './db.js'
import { desktopSignIn } from './desktop-sign-in.js'
import { INVITATION_DAYS, sendInvitation } from './invitation-mail.js'
import { passwordSignIn } from './password-sign-in.js'
import { CODE_MINUTES, sendSignInCode } from './sign-in-code.js'

/** Audit actors are members. Fall back to the user when no membership exists yet. */
async function memberActor(organizationId: string, userId: string) {
  const member = await prisma.member.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  })
  return { type: 'member' as const, id: member?.id ?? userId }
}

/**
 * The limit on an auth request, or none. better-auth's defaults stand for signing in and
 * mailing a code (3 in 10 seconds, 3 a minute per visitor), and 100 in 10 seconds for the rest.
 */
function limitOf(request: Request, rule: { window: number; max: number }) {
  // Locally and in previews, no request says who sent it: all would share one count.
  if (!request.headers.has('cf-connecting-ip')) return false as const
  const path = new URL(request.url).pathname.slice('/api/auth'.length)
  // Session reads: every page asks, and each count is a write.
  if (path === '/get-session' || path.startsWith('/organization/')) return false as const
  // A few typos; each code also takes only 5 tries (allowedAttempts).
  if (path === '/sign-in/email-otp') return { window: 60, max: 10 }
  return rule
}

/** The organization plugin's roles: its default three, and a viewer. */
const access = createAccessControl(defaultStatements)

export const auth = betterAuth({
  baseURL: env.API_URL,
  basePath: '/api/auth',
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: env.WEB_URL,
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  // No sign-up with a password in production (config.ts): an address is only ever proven by
  // its mail, with a code (emailOTP below) or by Google. Signing in with one stays open to the
  // accounts given a password by hand (src/password-sign-in.ts).
  emailAndPassword: { enabled: true, disableSignUp: !env.PASSWORD_SIGN_IN },
  // Counted in the database, so a restart doesn't reset the counts, per visitor as
  // Cloudflare saw them (X-Forwarded-For is whatever the client sent).
  rateLimit: {
    enabled: true,
    storage: 'database',
    customRules: { '/**': limitOf },
  },
  // The OAuth client connections use (src/connectors/google-oauth.ts), with the
  // redirect URI {API_URL}/api/auth/callback/google added to it.
  ...(env.GOOGLE_CLIENT_ID &&
    env.GOOGLE_CLIENT_SECRET && {
      socialProviders: {
        google: {
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          prompt: 'select_account',
          // Keep the name and profile picture current: an account made with a
          // password and later signed in with Google gets its picture too.
          overrideUserInfoOnSignIn: true,
        },
      },
    }),
  session: {
    modelName: 'authSession',
    additionalFields: {
      // The workspace every request is scoped to. Changed only through
      // POST /api/workspaces/switch, which checks membership.
      activeWorkspaceId: { type: 'string', required: false, input: false },
    },
  },
  account: { modelName: 'authAccount' },
  // Where a new person came from (src/signup-source.ts), kept on them, and `signed_up`
  // (src/analytics.ts). After the user's row is written; never fails the sign-up.
  databaseHooks: {
    user: {
      create: {
        after: async (user, context) => {
          await recordSignup(user, context).catch((error: unknown) =>
            console.warn(`sign-up of ${user.id} not recorded: ${String(error)}`),
          )
        },
      },
    },
  },
  advanced: {
    ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    ...(env.CROSS_SITE_COOKIES && {
      defaultCookieAttributes: { sameSite: 'none', secure: true, partitioned: true },
    }),
  },
  plugins: [
    desktopSignIn(),
    passwordSignIn(),
    emailOTP({
      otpLength: 6,
      expiresIn: CODE_MINUTES * 60,
      allowedAttempts: 5,
      storeOTP: 'hashed',
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type === 'sign-in') await sendSignInCode(email, otp)
      },
    }),
    // In the list either way: a spread would cost the organization plugin's types.
    env.TURNSTILE_SECRET_KEY
      ? captcha({
          provider: 'cloudflare-turnstile',
          secretKey: env.TURNSTILE_SECRET_KEY,
          endpoints: ['/email-otp/send-verification-otp', '/sign-up/email'],
        })
      : ({ id: 'no-captcha' } satisfies BetterAuthPlugin),
    organization({
      // The default roles, and a viewer, who reads the workspace and changes nothing in it
      // (src/viewers.ts): in the organization's own terms, what a member may.
      ac: access,
      roles: {
        owner: access.newRole(ownerAc.statements),
        admin: access.newRole(adminAc.statements),
        member: access.newRole(memberAc.statements),
        viewer: access.newRole(memberAc.statements),
      },
      // An invitation goes to an address: only its proven owner may take it.
      requireEmailVerificationOnInvitation: true,
      invitationExpiresIn: INVITATION_DAYS * 24 * 60 * 60,
      // Inviting again with another role replaces the open invitation (src/routes/members.ts).
      cancelPendingInvitationsOnReInvite: true,
      // Settings › Members invites (src/routes/members.ts); the link leads to /invite/<id>.
      sendInvitationEmail: ({ id, email, role, organization, inviter }) =>
        sendInvitation({
          id,
          email,
          role,
          organization: organization.name,
          inviter: { name: inviter.user.name, email: inviter.user.email },
        }),
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
        // Not while a workspace of it is still billed (src/billing.ts). Then each workspace goes
        // as one deleted on its own does, with what it reached outside and its files: its rows
        // alone would go with the organization.
        beforeDeleteOrganization: async ({ organization, user }) => {
          try {
            await guardOrganizationDeletion(organization.id)
            const { deleteWorkspace } = await import('./workspace-delete.js')
            const { id: memberId } = await memberActor(organization.id, user.id)
            const workspaces = await prisma.workspace.findMany({
              where: { organizationId: organization.id },
              select: { id: true },
            })
            for (const { id } of workspaces)
              await deleteWorkspace(
                { organizationId: organization.id, workspaceId: id },
                { userId: user.id, memberId },
                { keepOrganization: true },
              )
          } catch (error) {
            if (error instanceof HTTPException)
              throw new APIError('CONFLICT', { message: error.message })
            throw error
          }
        },
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
        afterCancelInvitation: async ({ invitation, cancelledBy, organization }) =>
          audit({
            organizationId: organization.id,
            workspaceId: null,
            actor: await memberActor(organization.id, cancelledBy.id),
            action: 'invitation.canceled',
            target: { type: 'invitation', id: invitation.id },
            data: { email: invitation.email },
          }),
        // Joined by their invitation: the same entry as a member added, by the one who joined.
        afterAcceptInvitation: async ({ invitation, member, organization }) =>
          audit({
            organizationId: organization.id,
            workspaceId: null,
            actor: { type: 'member', id: member.id },
            action: 'member.added',
            target: { type: 'member', id: member.id },
            data: { role: member.role, invitationId: invitation.id },
          }),
      },
    }),
  ],
})

export type AuthSession = typeof auth.$Infer.Session

/**
 * The plugin's invitation and member routes, closed over HTTP: the dashboard invites, cancels
 * and joins through src/routes/members.ts, which keeps the sending budget
 * (src/invitation-budget.ts) and calls them with auth.api, and changes roles and removes members
 * there too, where a removed member's threads and files go with them (src/member-remove.ts).
 */
const CLOSED_ROUTES =
  /^\/api\/auth\/organization\/(invite-member|accept-invitation|reject-invitation|cancel-invitation|update-member-role|remove-member|leave)\/?$/

export const authRouteClosed = (request: Request) =>
  CLOSED_ROUTES.test(new URL(request.url).pathname)
