import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import type { z } from 'zod'
import { auth } from './auth.js'
import { prisma, scoped, type Scope, type ScopedDb } from './db.js'

export type Role = 'owner' | 'admin' | 'member'

export type WorkspaceScope = Scope & {
  userId: string
  memberId: string
  role: Role
}

export type AppEnv = {
  Variables: {
    userId: string
    authSessionId: string
    activeOrganizationId: string | null
    activeWorkspaceId: string | null
    scope: WorkspaceScope
    db: ScopedDb
  }
}

/** Resolve the signed-in user from the session cookie. */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) throw new HTTPException(401, { message: 'Sign in first' })
  c.set('userId', session.user.id)
  c.set('authSessionId', session.session.id)
  c.set('activeOrganizationId', session.session.activeOrganizationId ?? null)
  c.set(
    'activeWorkspaceId',
    (session.session as { activeWorkspaceId?: string | null }).activeWorkspaceId ?? null,
  )
  await next()
})

/**
 * Resolve the organization and workspace from the authenticated session,
 * never from request input, and check membership.
 */
export async function resolveScope(input: {
  userId: string
  activeOrganizationId: string | null
  activeWorkspaceId: string | null
}): Promise<WorkspaceScope | null> {
  const { userId, activeOrganizationId, activeWorkspaceId } = input
  if (!activeOrganizationId || !activeWorkspaceId) return null
  const [member, workspace] = await Promise.all([
    prisma.member.findUnique({
      where: { organizationId_userId: { organizationId: activeOrganizationId, userId } },
    }),
    prisma.workspace.findFirst({
      where: { id: activeWorkspaceId, organizationId: activeOrganizationId },
    }),
  ])
  if (!member || !workspace) return null
  return {
    organizationId: activeOrganizationId,
    workspaceId: workspace.id,
    userId,
    memberId: member.id,
    role: member.role as Role,
  }
}

export const requireWorkspace = createMiddleware<AppEnv>(async (c, next) => {
  const scope = await resolveScope({
    userId: c.var.userId,
    activeOrganizationId: c.var.activeOrganizationId,
    activeWorkspaceId: c.var.activeWorkspaceId,
  })
  if (!scope) throw new HTTPException(409, { message: 'no_workspace' })
  c.set('scope', scope)
  c.set('db', scoped(scope))
  await next()
})

export function requireRole(scope: WorkspaceScope, ...roles: Role[]) {
  if (!roles.includes(scope.role))
    throw new HTTPException(403, { message: 'Only an owner or admin can do this' })
}

export async function parseBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  const json = await request.json().catch(() => {
    throw new HTTPException(400, { message: 'Expected a JSON body' })
  })
  const parsed = schema.safeParse(json)
  if (!parsed.success)
    throw new HTTPException(400, { message: parsed.error.issues.map((i) => i.message).join('; ') })
  return parsed.data
}
