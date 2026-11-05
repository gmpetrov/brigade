import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import type { z } from 'zod'
import { auth } from './auth.js'
import { env } from './config.js'
import { prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { beingRemoved } from './member-fence.js'
import { requireNotViewer } from './viewers.js'

/** A viewer reads only (src/viewers.ts). */
export type Role = 'owner' | 'admin' | 'member' | 'viewer'

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

/** A request's session, with the headers Better Auth answered it with (src/auth.ts). */
type SessionReader = (headers: Headers) => Promise<{
  headers: Headers
  response: {
    user: { id: string }
    session: { id: string; activeOrganizationId?: string | null; activeWorkspaceId?: string | null }
  } | null
}>

/**
 * Resolve the signed-in user from the session cookie, and keep the cookie alive with the session.
 * About once a day, reading the session pushes its end back 7 days in the database and renews
 * the cookie to match; called as a function, Better Auth only returns that cookie, so it goes on
 * this response here. Without it, the dashboard (which never calls /api/auth/get-session) lost
 * its cookie 7 days after signing in, however often the person came back.
 */
export const userFrom = (read: SessionReader) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const { headers, response: session } = await read(c.req.raw.headers)
    if (!session) throw new HTTPException(401, { message: 'Sign in first' })
    c.set('userId', session.user.id)
    c.set('authSessionId', session.session.id)
    c.set('activeOrganizationId', session.session.activeOrganizationId ?? null)
    c.set('activeWorkspaceId', session.session.activeWorkspaceId ?? null)
    await next()
    // After next: a handler may answer with a Response of its own, which drops headers set before.
    for (const cookie of headers.getSetCookie()) c.header('set-cookie', cookie, { append: true })
  })

export const requireUser = userFrom((headers) =>
  auth.api.getSession({ headers, returnHeaders: true }),
)

/**
 * Before requireUser on the pages a provider sends the browser back to after its sign-in
 * (OAuth callbacks): with no Brigade session in this browser, say a tab where the person
 * never signed in to Brigade, Brigade's sign-in, which comes back here to finish.
 */
export const signInFirst = createMiddleware<AppEnv>(async (c, next) => {
  // Only whether there is one, no refresh: requireUser, after it, renews the session and its cookie.
  const query = { disableRefresh: true }
  if (
    c.req.method === 'GET' &&
    !(await auth.api.getSession({ headers: c.req.raw.headers, query }))
  ) {
    const here = `${env.API_URL}${c.req.path}${new URL(c.req.url).search}`
    return c.redirect(`${env.WEB_URL[0]}/sign-in?next=${encodeURIComponent(here)}`)
  }
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
  // Shut out from the moment their removal starts (src/member-remove.ts).
  if (!member || !workspace || beingRemoved(member)) return null
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
  requireNotViewer(scope.role, c.req.method, c.req.path)
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
