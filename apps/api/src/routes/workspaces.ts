import { randomUUID } from 'node:crypto'
import {
  AccountDeletionCode,
  CHIEF_NAME,
  CreateWorkspace,
  DeleteAccount,
  DeleteWorkspace,
  OnboardingAnswers,
  SetAutoMerge,
  ChiefRuleDecision,
  SetPreviewMachines,
  SetChief,
  SetSuggestions,
  SwitchOrganization,
  SwitchWorkspace,
  UpdateProfile,
  UpdateWorkspace,
  WorkspaceDeletionCode,
} from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { deleteAccount } from '../account-delete.js'
import { usableBy } from '../account-sharing.js'
import { audit } from '../audit.js'
import { passView } from '../chief-pass.js'
import { chiefSettings, decideRule, setChief } from '../chief-rules.js'
import { auth } from '../auth.js'
import { workspaceLogoKey } from '../bucket.js'
import { ensureChief } from '../chief.js'
import { createWorkspaceComputer } from '../cloud.js'
import { recordOnboardingAnswers } from '../analytics.js'
import { prisma, Prisma } from '../db.js'
import { checkDeletionCode, sendDeletionCode, type DeletionTarget } from '../deletion-code.js'
import { placeNewHub } from '../platform/node.js'
import { LOGO_HEADERS, readLogo } from '../logos.js'
import {
  parseBody,
  pinnedWorkspace,
  requireRole,
  requireUser,
  requireWorkspace,
  resolveScope,
  type AppEnv,
  type WorkspaceScope,
} from '../scope.js'
import { readAvatar, shownImage, updateProfile } from '../profile.js'
import { deleteWorkspace } from '../workspace-delete.js'
import { updateWorkspace } from '../workspace-settings.js'
import { featuresOf, featuresOfMember, requireFeature, withLegacyNames } from '../features.js'
import { z } from 'zod'

const SetSidebarOrder = z.object({
  list: z.enum(['teammates', 'projects']),
  ids: z.array(z.string().max(100)).max(500),
})
type SidebarList = z.infer<typeof SetSidebarOrder>['list']

/** The active workspace, for its owner who typed its name: what a deletion code is for. */
async function workspaceToDelete(scope: WorkspaceScope, userId: string, name: string) {
  if (scope.role !== 'owner')
    throw new HTTPException(403, { message: 'Only an owner can delete the workspace' })
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: scope.workspaceId } })
  if (name.trim() !== workspace.name.trim())
    throw new HTTPException(400, { message: 'Type the workspace’s name to confirm' })
  return {
    kind: 'workspace',
    userId,
    workspaceId: workspace.id,
    name: workspace.name,
  } satisfies DeletionTarget
}

/** The signed-in person, who typed their email address. */
async function accountToDelete(userId: string, email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
  if (email.trim().toLowerCase() !== user.email.toLowerCase())
    throw new HTTPException(400, { message: 'Type your email address to confirm' })
  return user
}

/** For tests only: a failure after the first workspace's commit, as a cut request. */
export const firstWorkspaceFaults: { afterCommit?: () => void | Promise<void> } = {}

/**
 * An organization made by POST /me/first-workspace whose workspace is not set up yet: marked in
 * Organization.metadata, which nothing else writes, from its transaction until its setup is done.
 */
const SETUP_PENDING = JSON.stringify({ firstWorkspaceSetup: 'pending' })
function setupPending(metadata: string | null) {
  if (!metadata) return false
  try {
    return (
      (JSON.parse(metadata) as { firstWorkspaceSetup?: string }).firstWorkspaceSetup === 'pending'
    )
  } catch {
    return false
  }
}

/** The name of someone's first workspace, and of its organization: "Ada's workspace". */
export function firstWorkspaceName(userName: string) {
  const first = userName.trim().split(/\s+/)[0]?.slice(0, 40)
  return first && !first.includes('@') ? `${first}'s workspace` : 'My workspace'
}

const organizationSlug = (name: string) =>
  `${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'org'
  }-${randomUUID().slice(0, 4)}`

/**
 * What a new workspace gets once made: its hub, its audit line, Chief and its cloud computer. No
 * list: Today's Get started card shows its first steps, worked out from what it has.
 */
async function setUpWorkspace(
  workspace: { id: string; organizationId: string; name: string },
  memberId: string,
  // Done again to finish a cut setup (POST /me/first-workspace): the audit line only once, and
  // the hub only while it is not in its object yet.
  again: { audit: boolean; placeHub: boolean } = { audit: true, placeHub: true },
) {
  const { organizationId } = workspace
  // Its hub in an object of its own from the start (docs/workspace-hubs-plan.md), before
  // anything below asks it for something.
  if (again.placeHub) await placeNewHub(workspace.id)
  if (again.audit)
    await audit({
      organizationId,
      workspaceId: workspace.id,
      actor: { type: 'member', id: memberId },
      action: 'workspace.created',
      target: { type: 'workspace', id: workspace.id },
      data: { name: workspace.name },
    })
  await ensureChief(workspace)
  // Every workspace gets its own cloud computer (when a provider is configured), unless
  // billing is on: then with its Cloud plan (src/billing.ts).
  await createWorkspaceComputer(workspace)
}

export const workspaces = new Hono<AppEnv>()
  .use(requireUser)

  /** Everything the dashboard needs to render its shell. */
  .get('/me', async (c) => {
    const [user, memberships] = await Promise.all([
      prisma.user.findUniqueOrThrow({
        where: { id: c.var.userId },
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          avatar: true,
          onboardingAnswers: true,
          guest: true,
        },
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
    // Nothing runs without an AI account: onboarding asks for one first, unless the workspace
    // shares one already (src/account-sharing.ts).
    // A viewer runs nothing (src/viewers.ts): ready as they are.
    const aiReady = !scope
      ? false
      : scope.role === 'viewer' ||
        (await prisma.account.count({
          where: {
            workspaceId: scope.workspaceId,
            AND: [
              usableBy(scope.memberId),
              // Signed in once is enough: a login that expires later opens a ticket instead.
              {
                OR: [
                  { status: { in: ['ready', 'exhausted', 'unverified'] } },
                  { sessions: { some: {} } },
                ],
              },
            ],
          },
        })) > 0
    const { onboardingAnswers, guest, avatar, ...person } = user
    return c.json({
      // `image`: the picture they chose (a path under /api), else their sign-in's (src/profile.ts).
      user: { ...person, image: shownImage({ ...person, avatar }) },
      // A guest (src/guests.ts): made by Brigade.app without a sign-in, until saved with an email.
      guest,
      // What they answered to onboarding's questions; null: never asked.
      onboardingAnswers: onboardingAnswers as OnboardingAnswers | null,
      aiReady,
      organizations: memberships.map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        role: m.role,
      })),
      activeOrganizationId: membership ? orgId : null,
      role: membership?.role ?? null,
      // Their first workspace's setup was cut (POST /me/first-workspace): onboarding asks again.
      setupPending: membership?.role === 'owner' && setupPending(membership.organization.metadata),
      workspaces: workspaceList.map((w) => ({ id: w.id, name: w.name, logo: w.logo })),
      activeWorkspaceId: scope?.workspaceId ?? null,
      memberId: scope?.memberId ?? null,
      suggestions: membership?.suggestions ?? true,
      autoMerge: membership?.autoMerge ?? false,
      // Their threads' previews run on a machine of their own (docs/previews.md), while they have
      // the preview_machines feature: the preference shows only to them.
      previewMachines: membership?.previewMachines ?? false,
      // Chief's daily pass for them (docs/chief-answers.md): Today shows what it did.
      chiefPass: membership?.chiefPass ?? false,
      // Features hidden until ready that this person has (src/features.ts).
      features: withLegacyNames([
        ...(await featuresOf({ email: user.email, workspaceId: scope?.workspaceId ?? null })),
      ]),
    })
  })

  /**
   * Onboarding's questions, answered (or skipped: `{}`) by someone who just made their project.
   * Kept once (User.onboardingAnswers): the first answers stand, a second send changes nothing.
   */
  .post('/me/onboarding', async (c) => {
    const answers = await parseBody(c.req.raw, OnboardingAnswers)
    const { count } = await prisma.user.updateMany({
      where: { id: c.var.userId, onboardingAnswers: { equals: Prisma.DbNull } },
      data: { onboardingAnswers: answers },
    })
    if (count > 0) recordOnboardingAnswers(c.var.userId, answers)
    return c.body(null, 204)
  })

  /** The person changes their own name or picture (Settings › Profile, src/profile.ts). */
  .patch('/me/profile', requireWorkspace, async (c) => {
    const input = await parseBody(c.req.raw, UpdateProfile)
    return c.json(await updateProfile(c.var.scope, input))
  })

  /** A person's chosen picture, for anyone who shares an organization with them. */
  .get('/users/:id/avatar', async (c) => {
    const avatar = await readAvatar(c.var.userId, c.req.param('id'))
    if (!avatar) throw new HTTPException(404, { message: 'No picture' })
    return c.body(avatar.bytes as Uint8Array<ArrayBuffer>, 200, {
      'content-type': avatar.type,
      ...LOGO_HEADERS,
    })
  })

  /** The member's message box suggests their next message, or stops (Member.suggestions). */
  .put('/me/suggestions', requireWorkspace, async (c) => {
    const { suggestions } = await parseBody(c.req.raw, SetSuggestions)
    await prisma.member.update({ where: { id: c.var.scope.memberId }, data: { suggestions } })
    return c.body(null, 204)
  })

  /**
   * Brigade merges the pull requests teammates open in this member's threads once ready, or
   * stops (Member.autoMerge). Only those who may merge: owners and admins.
   */
  .put('/me/auto-merge', requireWorkspace, async (c) => {
    const { autoMerge } = await parseBody(c.req.raw, SetAutoMerge)
    const { scope } = c.var
    if (autoMerge && scope.role !== 'owner' && scope.role !== 'admin')
      throw new HTTPException(403, { message: 'Only owners and admins can merge pull requests' })
    await prisma.member.update({ where: { id: scope.memberId }, data: { autoMerge } })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: autoMerge ? 'member.auto_merge_on' : 'member.auto_merge_off',
      target: { type: 'member', id: scope.memberId },
    })
    return c.body(null, 204)
  })

  /**
   * The previews of the threads this member starts run on a machine of their own, or on the cloud
   * computer as before (Member.previewMachines, docs/previews.md). Only for members who have the
   * preview_machines feature: 404 for the others, as if it were not there.
   */
  .put('/me/preview-machines', requireWorkspace, async (c) => {
    const { previewMachines } = await parseBody(c.req.raw, SetPreviewMachines)
    const { scope } = c.var
    requireFeature(await featuresOfMember(scope.memberId, scope.workspaceId), 'preview_machines')
    await prisma.member.update({ where: { id: scope.memberId }, data: { previewMachines } })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: previewMachines ? 'member.preview_machines_on' : 'member.preview_machines_off',
      target: { type: 'member', id: scope.memberId },
    })
    return c.body(null, 204)
  })

  /**
   * What this member set for Chief (docs/chief-answers.md): their daily pass, their rules, and the
   * timezone their pass runs in.
   */
  .get('/me/chief', requireWorkspace, async (c) => {
    return c.json(await chiefSettings(c.var.db, c.var.scope))
  })

  /**
   * Turn this member's daily pass on or off, set their rules, or say their timezone. Theirs alone:
   * Chief acts in their name. Off, with no rules, Brigade is as before.
   */
  .put('/me/chief', requireWorkspace, async (c) => {
    const input = await parseBody(c.req.raw, SetChief)
    return c.json(await setChief(c.var.db, c.var.scope, input))
  })

  /** Take a rule Chief's pass proposed into this member's rules, or refuse it. */
  .post('/me/chief/rules', requireWorkspace, async (c) => {
    const input = await parseBody(c.req.raw, ChiefRuleDecision)
    return c.json(await decideRule(c.var.db, c.var.scope, input))
  })

  /** This member's latest daily pass here, as Today shows it; null when none ran lately. */
  .get('/me/chief/pass', requireWorkspace, async (c) => {
    return c.json({ pass: await passView(c.var.db, c.var.scope) })
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
    await prisma.authSession.update({
      where: { id: c.var.authSessionId },
      data: { activeWorkspaceId: workspace.id },
    })
    await setUpWorkspace(workspace, member.id)
    return c.json({ id: workspace.id, name: workspace.name }, 201)
  })

  /**
   * Onboarding's first step, with nothing to fill: someone in no organization gets one of their
   * own and its first workspace, named after them, and the session moves there. Once per person,
   * whatever the tabs or reloads: under a lock on them, the organization, its owner, the
   * workspace and its Chief are made in one transaction, or found when made already. What
   * follows (hub, cloud computer) stays marked pending on the organization
   * until done: /me says so (setupPending), and onboarding calls again to finish it.
   */
  .post('/me/first-workspace', async (c) => {
    const { userId, authSessionId } = c.var
    const made = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`first-workspace:${userId}`}, 0))`
        // One this route left pending first, whichever organization is the oldest of theirs (an
        // invitation taken meanwhile is not it), else the oldest.
        const memberSelect = {
          id: true,
          organizationId: true,
          role: true,
          organization: true,
        } as const
        const existing =
          (await tx.member.findFirst({
            where: { userId, role: 'owner', organization: { metadata: SETUP_PENDING } },
            orderBy: { createdAt: 'asc' },
            select: memberSelect,
          })) ??
          (await tx.member.findFirst({
            where: { userId },
            orderBy: { createdAt: 'asc' },
            select: memberSelect,
          }))
        if (existing) {
          // Set up again only what this route made and left unfinished: never another
          // organization's workspace, whoever they are in it.
          const resume = existing.role === 'owner' && setupPending(existing.organization.metadata)
          const workspace = await tx.workspace.findFirst({
            where: { organizationId: existing.organizationId },
            orderBy: { createdAt: 'asc' },
            select: { id: true, organizationId: true, name: true, hubMode: true },
          })
          return { created: false, resume, member: existing, workspace }
        }
        const user = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: { name: true },
        })
        const name = firstWorkspaceName(user.name)
        const organization = await tx.organization.create({
          data: {
            id: randomUUID(),
            name,
            slug: organizationSlug(name),
            metadata: SETUP_PENDING,
          },
        })
        const member = await tx.member.create({
          data: { id: randomUUID(), organizationId: organization.id, userId, role: 'owner' },
          select: { id: true, organizationId: true },
        })
        const workspace = await tx.workspace.create({
          data: { organizationId: organization.id, name },
          select: { id: true, organizationId: true, name: true, hubMode: true },
        })
        await tx.teammate.create({
          data: {
            organizationId: organization.id,
            workspaceId: workspace.id,
            name: CHIEF_NAME,
            kind: 'chief',
          },
        })
        return { created: true, resume: true, member, workspace }
      },
      { timeout: 15_000 },
    )
    const { created, resume, member, workspace } = made
    // The session first: whatever follows fails, /me shows this workspace, and onboarding sees
    // its setup pending (setupPending) and asks this route to finish it.
    await prisma.authSession.update({
      where: { id: authSessionId },
      data: {
        activeOrganizationId: member.organizationId,
        ...(workspace && { activeWorkspaceId: workspace.id }),
      },
    })
    if (created)
      await audit({
        organizationId: member.organizationId,
        workspaceId: null,
        actor: { type: 'member', id: member.id },
        action: 'organization.created',
        target: { type: 'organization', id: member.organizationId },
        data: { name: workspace!.name },
      })
    if (resume && workspace) {
      await firstWorkspaceFaults.afterCommit?.()
      await setUpWorkspace(workspace, member.id, {
        audit: created,
        placeHub: workspace.hubMode !== 'object',
      })
      await prisma.organization.updateMany({
        where: { id: member.organizationId, metadata: SETUP_PENDING },
        data: { metadata: null },
      })
    }
    return created
      ? c.json({ created: true, id: workspace!.id, name: workspace!.name }, 201)
      : c.json({ created: false })
  })

  /**
   * Make another workspace the session's scope: of the active organization, or of another one the
   * person is a member of (a notification, or Open in Brigade from an installed app's window,
   * names a workspace of any of their organizations), which becomes the active one too.
   */
  .post('/workspaces/switch', async (c) => {
    const { workspaceId } = await parseBody(c.req.raw, SwitchWorkspace)
    const scope = await resolveScope({ ...c.var, activeWorkspaceId: workspaceId })
    const elsewhere = scope ? null : await pinnedWorkspace(c.var.userId, workspaceId)
    if (!scope && !elsewhere) throw new HTTPException(404, { message: 'Workspace not found' })
    await prisma.authSession.update({
      where: { id: c.var.authSessionId },
      data: scope
        ? { activeWorkspaceId: scope.workspaceId }
        : { activeOrganizationId: elsewhere!.organizationId, activeWorkspaceId: elsewhere!.id },
    })
    return c.json({ ok: true })
  })

  /**
   * Make another organization the person belongs to the session's, in its first workspace: for
   * someone in several (one of their own, and one they were invited to).
   */
  .post('/organizations/switch', async (c) => {
    const { organizationId } = await parseBody(c.req.raw, SwitchOrganization)
    const member = await prisma.member.findUnique({
      where: { organizationId_userId: { organizationId, userId: c.var.userId } },
    })
    if (!member) throw new HTTPException(404, { message: 'Organization not found' })
    const workspace = await prisma.workspace.findFirst({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    await prisma.authSession.update({
      where: { id: c.var.authSessionId },
      data: { activeOrganizationId: organizationId, activeWorkspaceId: workspace?.id ?? null },
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
   * Mail the owner a code to delete the active workspace (src/deletion-code.ts), once they typed
   * its name: the dialog asks for it next.
   */
  .post('/workspace/deletion-code', requireWorkspace, async (c) => {
    const { name } = await parseBody(c.req.raw, WorkspaceDeletionCode)
    const target = await workspaceToDelete(c.var.scope, c.var.userId, name)
    const user = await prisma.user.findUniqueOrThrow({ where: { id: c.var.userId } })
    await sendDeletionCode(user.email, target)
    return c.body(null, 204)
  })

  /**
   * Delete the active workspace for good: owners only, typing its name and the code mailed to
   * them to confirm. The session moves to another workspace of the organization, or to none
   * (onboarding) when it was the last, which takes the organization with it.
   */
  .delete('/workspace', requireWorkspace, async (c) => {
    const scope = c.var.scope
    const { name, code } = await parseBody(c.req.raw, DeleteWorkspace)
    const target = await workspaceToDelete(scope, c.var.userId, name)
    const used = await checkDeletionCode(target, code)
    const { organizationGone } = await deleteWorkspace(scope, scope)
    await used()
    const session = await prisma.authSession.findUnique({
      where: { id: c.var.authSessionId },
      select: { activeWorkspaceId: true },
    })
    return c.json({ activeWorkspaceId: session?.activeWorkspaceId ?? null, organizationGone })
  })

  /** Mail the person a code to delete their account, once they typed their email address. */
  .post('/me/deletion-code', async (c) => {
    const { email } = await parseBody(c.req.raw, AccountDeletionCode)
    const user = await accountToDelete(c.var.userId, email)
    await sendDeletionCode(user.email, { kind: 'account', userId: user.id })
    return c.body(null, 204)
  })

  /**
   * Delete the signed-in person's account for good, typing their email address and the code
   * mailed to them to confirm (src/account-delete.ts). Signed out in the same answer.
   */
  .delete('/me', async (c) => {
    const { email, code } = await parseBody(c.req.raw, DeleteAccount)
    const user = await accountToDelete(c.var.userId, email)
    const used = await checkDeletionCode({ kind: 'account', userId: user.id }, code)
    await deleteAccount(user.id)
    await used()
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
