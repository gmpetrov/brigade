// Deleting a workspace for good: what it reached outside Brigade first (its cloud computer, its
// mail domains, its Apps' tokens and webhooks), then its rows, then every object it left in the
// bucket. Each step before the rows go is safe to run again: should one fail, the workspace
// is still there, and deleting it again picks up where this stopped. Its rows go last, in one
// transaction with the promise to empty its bucket folder (WorkspaceCleanup), which a sweep keeps
// until nothing is left there, late uploads included.
import { DELETE_PROTOCOL } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit } from './audit.js'
import { guardWorkspaceDeletion } from './billing.js'
import { deleteObject, listObjects, workspacePrefix } from './bucket.js'
import { cloudAvailable, destroyComputerVm, forgetPreviewAddress } from './cloud.js'
import { notifyCollab } from './collab.js'
import { Prisma, prisma, scoped } from './db.js'
import { BEING_DELETED, lowerFence, raiseFence } from './deletion-fence.js'
import type { SessionStatus } from './generated/prisma/enums.js'
import { hubs } from './hub.js'
import { removeFromResend } from './mail/domains.js'
import { enqueue } from './platform/node.js'
import type { WorkspaceScope } from './scope.js'
import { LATE_UPLOADS_MS } from './thread-delete.js'

/** While a teammate works in it, a thread's computer is still writing to it. */
const BUSY: SessionStatus[] = ['starting', 'running']

/** A replacement of the cloud computer under way makes a new VM: none may be left behind. */
const REPLACING = ['backing_up', 'creating', 'restoring']

const VM_NOT_DELETED = 'The cloud computer could not be deleted: try again later'

/** Who deletes it: an owner of its organization. */
type Deleter = { userId: string; memberId: string }

/**
 * Refuse, before anything is changed, what would leave work or a VM behind: a thread at work, a
 * cloud computer being made or replaced. The same checks run again in deleteWorkspace.
 */
export async function checkWorkspaceIdle(workspaceId: string) {
  const busy = await prisma.session.count({ where: { workspaceId, status: { in: BUSY } } })
  if (busy)
    throw new HTTPException(409, {
      message:
        busy === 1
          ? 'A teammate is working in a thread of this workspace. Stop it first, or wait for it to finish.'
          : `Teammates are working in ${busy} threads of this workspace. Stop them first, or wait for them to finish.`,
    })
  const replacing = await prisma.computerReplacement.count({
    where: { workspaceId, phase: { in: REPLACING } },
  })
  const creating = await prisma.computer.findMany({
    where: { workspaceId, kind: 'cloud', status: 'creating' },
    select: { id: true },
  })
  const hub = hubs.get(workspaceId)
  for (const computer of creating)
    if (await hub.isProvisioning(computer.id))
      throw new HTTPException(409, {
        message: 'The cloud computer is being set up. Try again in a few minutes.',
      })
  if (replacing)
    throw new HTTPException(409, {
      message: 'The cloud computer is being replaced. Try again once it is done.',
    })
}

/**
 * Delete a workspace and everything in it. The last workspace of its organization takes the
 * organization with it, unless `keepOrganization` (the organization is being deleted anyway).
 */
export async function deleteWorkspace(
  target: { organizationId: string; workspaceId: string },
  by: Deleter,
  options: { keepOrganization?: boolean } = {},
) {
  const { organizationId, workspaceId } = target
  const workspace = await prisma.workspace.findFirst({
    where: { id: workspaceId, organizationId },
  })
  if (!workspace) throw new HTTPException(404, { message: 'Workspace not found' })
  const scope: WorkspaceScope = {
    organizationId,
    workspaceId,
    userId: by.userId,
    memberId: by.memberId,
    role: 'owner',
  }

  // From here on no new work starts in it (src/deletion-fence.ts): what runs already is refused
  // below, and what starts meanwhile is caught by the second check before its rows go.
  if (!(await raiseFence(workspaceId)))
    throw new HTTPException(409, { message: `${BEING_DELETED} already` })
  try {
    return await deleteFenced(workspace, scope, options)
  } catch (error) {
    // Refused or failed: the workspace works again, and its deletion can be tried again.
    await lowerFence(workspaceId).catch((failure: unknown) =>
      console.warn(`deleting ${workspaceId}: fence not lowered`, failure),
    )
    throw error
  }
}

async function deleteFenced(
  workspace: { id: string; name: string },
  scope: WorkspaceScope,
  options: { keepOrganization?: boolean },
) {
  const { organizationId, workspaceId } = scope
  const by = { userId: scope.userId, memberId: scope.memberId }
  const db = scoped(scope)
  const actor = { type: 'member' as const, id: by.memberId }

  await checkWorkspaceIdle(workspaceId)
  // No Checkout may start from here on, and a plan still running refuses the deletion: it
  // would go on billing a workspace that is gone. Its Stripe customer stays, with its invoices.
  const liftClosing = await guardWorkspaceDeletion(organizationId, workspaceId)
  try {
    const hub = hubs.get(workspaceId)
    const computers = await prisma.computer.findMany({ where: { workspaceId } })

    // Read now, while its rows say where its hub and its threads are; used once they are gone.
    // Runners on members' own machines are told each thread went, so its folders go there too.
    // Their AI accounts' logins stay: they are the member's own.
    const told: { computerId: string; sessionIds: string[] }[] = []
    for (const computer of computers) {
      if (computer.kind !== 'member_machine') continue
      const protocol = await hub.runnerProtocol(computer.id).catch(() => null)
      if ((protocol ?? 0) < DELETE_PROTOCOL) continue
      const sessions = await prisma.session.findMany({
        where: { workspaceId, computerId: computer.id },
        select: { id: true },
      })
      told.push({ computerId: computer.id, sessionIds: sessions.map((s) => s.id) })
    }
    // Previews have an address on the gateway only once opened from a cloud computer.
    const previews = await prisma.auditEntry.findMany({
      where: { organizationId, workspaceId, action: 'preview.opened', targetType: 'thread' },
      select: { targetId: true },
      distinct: ['targetId'],
    })
    const documents = await prisma.document.findMany({
      where: { workspaceId },
      select: { id: true },
    })

    // Its cloud computer's VM, its disk with it, and any VM a replacement left stopped: none
    // may outlive the workspace with its data. When the provider fails, a 502: the workspace
    // stays, and deleting it again destroys what is left.
    const replaced = await prisma.computerReplacement.findMany({
      where: { workspaceId, oldProviderRef: { not: Prisma.AnyNull } },
      select: { id: true, oldProviderRef: true },
    })
    // A VM this API has no provider to reach would be left running, and billed, with nothing
    // pointing to it any more: refused, its reference kept, until a provider is configured.
    const vms =
      computers.filter((c) => c.kind === 'cloud' && c.providerRef).length + replaced.length
    if (vms && !cloudAvailable()) {
      console.error(`deleting ${workspaceId}: ${vms} VM(s) but no cloud provider configured`)
      throw new HTTPException(503, { message: VM_NOT_DELETED })
    }
    try {
      for (const computer of computers) {
        if (computer.kind !== 'cloud' || !computer.providerRef) continue
        if (!(await destroyComputerVm(computer)))
          throw new HTTPException(503, { message: VM_NOT_DELETED })
        await hub.dropRunner(computer.id)
        await prisma.computer.update({
          where: { id: computer.id },
          data: { status: 'destroyed', providerRef: Prisma.DbNull },
        })
      }
      for (const old of replaced) {
        if (!(await destroyComputerVm({ providerRef: old.oldProviderRef })))
          throw new HTTPException(503, { message: VM_NOT_DELETED })
        await prisma.computerReplacement.update({
          where: { id: old.id },
          data: { oldProviderRef: Prisma.DbNull },
        })
      }
    } catch (error) {
      if (error instanceof HTTPException) throw error
      console.error(`deleting ${workspaceId}: the cloud computer was not destroyed`, error)
      throw new HTTPException(502, {
        message:
          'The cloud computer’s provider did not delete it. Nothing else was deleted: try again in a moment.',
      })
    }

    // Its Apps: tokens revoked, webhooks and watches unsubscribed at the vendor, while the
    // credentials still work. A provider that fails is logged: it must not keep the workspace's
    // data here for good.
    const { disconnect } = await import('./routes/connections.js')
    const connections = await db.connection.findMany({
      where: { status: { not: 'removed' } },
      select: { id: true, kind: true, vaultSecretId: true, appId: true },
    })
    for (const connection of connections)
      await disconnect(scope, db, connection).catch((error: unknown) =>
        console.warn(`deleting ${workspaceId}: ${connection.id} not disconnected`, error),
      )

    // Its mail domains leave Resend, or another workspace could never add them again: a 502
    // when Resend did not remove one, and the deletion can be tried again. Its addresses stop
    // receiving; their names stay reserved for good (MailAddress), their public addresses go.
    const domains = await db.mailDomain.findMany({ where: { resendDomainId: { not: null } } })
    for (const domain of domains) {
      await removeFromResend(domain.name, domain.resendDomainId!)
      await db.mailDomain.updateMany({ where: { id: domain.id }, data: { resendDomainId: null } })
    }
    await prisma.mailAddress.updateMany({
      where: { workspaceId, releasedAt: null },
      data: { releasedAt: new Date() },
    })
    await prisma.mailAddress.updateMany({
      where: { workspaceId },
      data: { connectionId: null, publicAddress: null, domainId: null },
    })

    // Checked again: a thread may have started meanwhile.
    await checkWorkspaceIdle(workspaceId)

    // The rows, in one go with the promise to empty its bucket folder: never one without the
    // other. Sessions on it move to another workspace of the organization, or to none.
    const prefix = workspacePrefix(scope)
    // Renewed for the last step, however long the ones before took.
    await raiseFence(workspaceId, true)
    const deletedAt = new Date()
    const organizationGone = await prisma.$transaction(
      async (tx) => {
        await tx.workspaceCleanup.upsert({
          where: { workspaceId },
          create: { organizationId, workspaceId, prefix, notBefore: deletedAt },
          update: { notBefore: deletedAt },
        })
        // Rows of its own with no link to it (their files are in its folder).
        await tx.documentAsset.deleteMany({ where: { workspaceId } })
        await tx.upload.deleteMany({ where: { workspaceId } })
        await tx.workspace.deleteMany({ where: { id: workspaceId } })
        const next = await tx.workspace.findFirst({
          where: { organizationId },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        })
        if (next || options.keepOrganization) {
          await tx.authSession.updateMany({
            where: { activeWorkspaceId: workspaceId },
            data: { activeWorkspaceId: next?.id ?? null },
          })
          return false
        }
        await tx.authSession.updateMany({
          where: {
            OR: [{ activeOrganizationId: organizationId }, { activeWorkspaceId: workspaceId }],
          },
          data: { activeOrganizationId: null, activeWorkspaceId: null },
        })
        await tx.organization.deleteMany({ where: { id: organizationId } })
        return true
      },
      // A large workspace's rows take a while to go.
      { timeout: 120_000, maxWait: 10_000 },
    )

    // Its own audit entries went with it: the organization keeps that it was deleted, and by whom.
    await audit({
      organizationId,
      workspaceId: null,
      actor,
      action: 'workspace.deleted',
      target: { type: 'workspace', id: workspaceId },
      data: { name: workspace.name, byUserId: by.userId },
    })
    if (organizationGone)
      await audit({
        organizationId,
        workspaceId: null,
        actor,
        action: 'organization.deleted',
        target: { type: 'organization', id: organizationId },
        data: { with: { type: 'workspace', id: workspaceId }, byUserId: by.userId },
      })

    // Best effort from here: the rows are gone, and each of these has a fallback of its own.
    for (const { computerId, sessionIds } of told) {
      for (const sessionId of sessionIds)
        await hub
          .sendToRunner(computerId, { type: 'thread.deleted', sessionId }, { touch: false })
          .catch((error: unknown) =>
            console.warn(`deleting ${workspaceId}: ${computerId} not told of ${sessionId}`, error),
          )
      // Its token went with the workspace: its socket closes too.
      await hub.dropRunner(computerId).catch(() => undefined)
    }
    // A room someone opens again finds its document gone and forgets itself too.
    for (const { id } of documents) notifyCollab(id, 'delete')
    // The VM is gone, and the gateway drops an address another preview takes.
    for (const { targetId } of previews) forgetPreviewAddress(targetId)
    // Most of its files go at once; the sweep finishes, and empties the folder again later.
    await enqueue({ job: 'deleted-workspace-sweep', key: workspaceId }).catch((error: unknown) =>
      console.warn(`deleting ${workspaceId}: sweep not queued`, error),
    )
    return { organizationGone }
  } finally {
    await liftClosing().catch((error: unknown) =>
      console.warn(`deleting ${workspaceId}: billing closing not lifted`, error),
    )
  }
}

/** How many objects one run of the sweep deletes, at most: each is a request to the bucket. */
export const SWEEP_DELETES = 1000

/** Deleted workspaces whose bucket folder is still to be emptied. */
export async function dueWorkspaceCleanups(now = new Date()) {
  const rows = await prisma.workspaceCleanup.findMany({
    where: { notBefore: { lte: now } },
    select: { workspaceId: true },
    orderBy: { notBefore: 'asc' },
    take: 500,
  })
  return rows.map((r) => r.workspaceId)
}

/**
 * Empty the bucket folders of deleted workspaces (WorkspaceCleanup), in batches: at most
 * `budget` objects per run. A row goes only once a listing made after the late-upload margin
 * finds its folder empty; one a run could not finish is tried again by the next, however long
 * the bucket refuses. A row whose workspace is still there (its deletion failed after the row
 * was kept) just goes: the files are the workspace's again.
 */
export async function sweepDeletedWorkspaces(
  workspaceId?: string,
  now = Date.now(),
  budget = SWEEP_DELETES,
) {
  const due = await prisma.workspaceCleanup.findMany({
    where: { notBefore: { lte: new Date(now) }, ...(workspaceId ? { workspaceId } : {}) },
    orderBy: { notBefore: 'asc' },
    take: 100,
  })
  let left = budget
  for (const row of due) {
    if (left <= 0) break
    try {
      const still = await prisma.workspace.findUnique({
        where: { id: row.workspaceId },
        select: { id: true },
      })
      if (still) {
        await prisma.workspaceCleanup.deleteMany({ where: { id: row.id } })
        continue
      }
      // Upload URLs issued before the deletion work until then.
      const settled = now >= row.notBefore.getTime() + LATE_UPLOADS_MS
      while (left > 0) {
        const keys = await listObjects(row.prefix, { limit: left })
        if (keys.length === 0) {
          if (settled) await prisma.workspaceCleanup.deleteMany({ where: { id: row.id } })
          break
        }
        for (const key of keys) {
          await deleteObject(key)
          left--
        }
      }
    } catch (error) {
      console.warn(`deleted workspace ${row.workspaceId}: files not emptied yet: ${String(error)}`)
    }
  }
  const removed = budget - left
  if (removed > 0) console.log(`deleted workspaces: removed ${removed} file(s)`)
  return removed
}
