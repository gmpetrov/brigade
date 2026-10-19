// Grouped approvals (spec "Validations groupées"): a playbook's open approval tickets are one
// item wherever something waits on a person, opened here to decide each, or all of one action
// at once. Each ticket is decided through resolveTicket, as from its thread; one decided in
// bulk is marked decidedInBulk first, so the measured trust of its action leaves it out.
import {
  playbookApprovalOf,
  type DecidedPlaybookApprovals,
  type DecidePlaybookApprovals,
  type PlaybookApprovalsView,
  type PlaybookManifest,
} from '@brigade/contracts'
import { audit } from './audit.js'
import { Prisma, prisma, scoped, type ScopedDb } from './db.js'
import { resolveTicket } from './decide.js'
import { requireInstallation } from './playbooks.js'
import type { WorkspaceScope } from './scope.js'

/** An installation's open approvals, oldest first. Not those of an archived thread: put away, they wait on no one. */
async function openApprovals(db: ScopedDb, installationId: string) {
  const tickets = await db.ticket.findMany({
    where: {
      type: 'approval',
      status: 'open',
      payload: { path: ['playbookInstallationId'], equals: installationId },
      session: { is: { archivedAt: null } },
    },
    include: {
      session: {
        select: {
          id: true,
          title: true,
          startedByMemberId: true,
          teammate: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })
  return tickets.filter((t) => playbookApprovalOf(t)?.installationId === installationId)
}

/** A JSON value JavaScript reads as true, as playbookApprovalOf tests it. */
const truthy = (key: string) =>
  Prisma.raw(
    `COALESCE(t.payload -> '${key}', 'null'::jsonb) NOT IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)`,
  )

/** Ticket `t` is a playbook approval (playbookApprovalOf), in SQL. */
export const PLAYBOOK_APPROVAL_SQL = Prisma.sql`(
  t.type = 'approval'
  AND COALESCE(jsonb_typeof(t.payload -> 'playbookInstallationId') = 'string', FALSE)
  AND COALESCE(jsonb_typeof(t.payload -> 'playbookRunId') = 'string', FALSE)
  AND NOT (${truthy('playbookActivation')} OR ${truthy('playbookPromotion')}
    OR ${truthy('skillAction')} OR ${truthy('credentialAction')})
)`

/** The most ordinary tickets listed (open ones, then as many decided ones with status=all). */
const TICKETS_LISTED = 200

const TICKET_SESSION = {
  select: {
    id: true,
    title: true,
    origin: true,
    startedByMemberId: true,
    projectId: true,
    // A child's ticket also marks its parent, which shows the child.
    parentId: true,
    // Archived: it no longer waits on anyone (waitsOn), though the Tickets page lists it.
    archivedAt: true,
    teammate: { select: { id: true, name: true } },
  },
} as const

/**
 * The tickets a workspace lists as waiting (GET /tickets): each playbook's open approvals as
 * one, its latest (the latest this member decides, when there is one), with how many the group
 * holds (`count`) and how many of them wait on this member (`yours`: all for an owner or admin,
 * else those of threads they started, as waitsOn reads it); then the other tickets, newest
 * first, at most TICKETS_LISTED open ones. Grouped in the database, so however many approvals
 * one playbook asks, every other group and ticket is still listed, and Home, Needs you, the
 * sidebar's count and the badge (notifications.ts, which counts every open ticket) agree.
 * Approvals of an archived thread are left out: they wait on no one, and the group opened
 * (playbookApprovals) leaves them out too.
 */
export async function waitingTickets(
  scope: WorkspaceScope,
  options: { all: boolean; project: { projectId?: string | null } },
) {
  const db = scoped(scope)
  const admin = scope.role === 'owner' || scope.role === 'admin'
  const inProject =
    'projectId' in options.project
      ? options.project.projectId === null
        ? Prisma.sql`AND s.id IS NOT NULL AND s."projectId" IS NULL`
        : Prisma.sql`AND s."projectId" = ${options.project.projectId}`
      : Prisma.empty
  const mine = admin ? Prisma.sql`TRUE` : Prisma.sql`s."startedByMemberId" = ${scope.memberId}`
  const ordinary = (open: boolean) => Prisma.sql`
    SELECT t.id FROM "Ticket" t
    LEFT JOIN "Session" s ON s.id = t."sessionId"
    WHERE t."organizationId" = ${scope.organizationId}
      AND t."workspaceId" = ${scope.workspaceId}
      AND ${open ? Prisma.sql`t.status = 'open' AND NOT ${PLAYBOOK_APPROVAL_SQL}` : Prisma.sql`t.status <> 'open'`}
      ${inProject}
    ORDER BY t."createdAt" DESC, t.id DESC
    LIMIT ${TICKETS_LISTED}`
  const [groups, open, decided] = await Promise.all([
    prisma.$queryRaw<{ installationId: string; count: number; yours: number; latest: string }[]>`
      WITH a AS (
        SELECT t.id, t."createdAt", t.payload ->> 'playbookInstallationId' AS inst,
          COALESCE(${mine}, FALSE) AS mine
        FROM "Ticket" t
        LEFT JOIN "Session" s ON s.id = t."sessionId"
        WHERE t."organizationId" = ${scope.organizationId}
          AND t."workspaceId" = ${scope.workspaceId}
          AND t.status = 'open'
          AND ${PLAYBOOK_APPROVAL_SQL}
          AND s."archivedAt" IS NULL
          ${inProject}
      )
      SELECT inst AS "installationId", count(*)::int AS count,
        (count(*) FILTER (WHERE mine))::int AS yours,
        COALESCE(
          (array_agg(id ORDER BY "createdAt" DESC, id DESC) FILTER (WHERE mine))[1],
          (array_agg(id ORDER BY "createdAt" DESC, id DESC))[1]
        ) AS latest
      FROM a GROUP BY inst`,
    prisma.$queryRaw<{ id: string }[]>(ordinary(true)),
    options.all ? prisma.$queryRaw<{ id: string }[]>(ordinary(false)) : [],
  ])
  const ids = [...groups.map((g) => g.latest), ...[...open, ...decided].map((r) => r.id)]
  const [rows, installations] = await Promise.all([
    ids.length
      ? db.ticket.findMany({
          where: { id: { in: ids } },
          include: { session: TICKET_SESSION },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        })
      : [],
    groups.length
      ? db.playbookInstallation.findMany({
          where: { id: { in: groups.map((g) => g.installationId) } },
          select: { id: true, manifest: true },
        })
      : [],
  ])
  const names = new Map(
    installations.map((i) => [i.id, (i.manifest as PlaybookManifest).name] as const),
  )
  const byLatest = new Map(groups.map((g) => [g.latest, g] as const))
  return rows.map((t) => {
    const group = byLatest.get(t.id)
    return {
      ...t,
      playbook: group
        ? {
            id: group.installationId,
            name: names.get(group.installationId) ?? 'Playbook',
            count: group.count,
            yours: group.yours,
          }
        : null,
    }
  })
}

/** The group opened: each approval with what it will do, its run and whether this member decides it. */
export async function playbookApprovals(
  db: ScopedDb,
  scope: WorkspaceScope,
  installationId: string,
): Promise<PlaybookApprovalsView> {
  const installation = await requireInstallation(db, installationId)
  const manifest = installation.manifest as PlaybookManifest
  const [tickets, teammate] = await Promise.all([
    openApprovals(db, installationId),
    db.teammate.findFirst({
      where: { id: installation.teammateId },
      select: { id: true, name: true },
    }),
  ])
  const runIds = [...new Set(tickets.map((t) => playbookApprovalOf(t)!.runId))]
  const runs = await db.playbookRun.findMany({
    where: { id: { in: runIds } },
    select: { id: true, rootSession: { select: { title: true } } },
  })
  const admin = scope.role === 'owner' || scope.role === 'admin'
  return {
    installation: {
      id: installation.id,
      name: manifest.name,
      teammate: teammate ?? { id: installation.teammateId, name: 'Teammate' },
    },
    items: tickets.map((t) => {
      const ref = playbookApprovalOf(t)!
      const p = t.payload as Record<string, unknown>
      const text = (key: string) => (typeof p[key] === 'string' ? (p[key] as string) : null)
      const tool = text('operation') ?? text('toolName')
      const spec = manifest.actions.find((a) => a.key === ref.actionKey)
      const session = t.session!
      return {
        ticketId: t.id,
        title: t.title,
        createdAt: t.createdAt.toISOString(),
        action: {
          key: ref.actionKey,
          label: spec?.label ?? (tool ? tool.replace(/_/g, ' ') : 'Other actions'),
        },
        operation: text('operation'),
        connection: text('connection'),
        target: text('target'),
        toolName: text('toolName'),
        input: p.input ?? null,
        reason: text('reason'),
        run: {
          id: ref.runId,
          title: runs.find((r) => r.id === ref.runId)?.rootSession?.title ?? session.title,
        },
        thread: { id: session.id, title: session.title },
        teammate: session.teammate,
        // As resolveTicket decides a run's approval: the thread's starter, or an owner or admin.
        canDecide: admin || session.startedByMemberId === scope.memberId,
      }
    }),
  }
}

/**
 * Decide several of an installation's approvals, one at a time, each as its own decision
 * would be (resolveTicket: who may, what runs next). Marked decidedInBulk before it is
 * decided, so whatever counts the decision as it lands already leaves it out of the trust;
 * one that could not be decided loses the mark, so its own decision later counts.
 */
export async function decidePlaybookApprovals(
  scope: WorkspaceScope,
  installationId: string,
  input: DecidePlaybookApprovals,
): Promise<DecidedPlaybookApprovals> {
  const db = scoped(scope)
  await requireInstallation(db, installationId)
  const decided: string[] = []
  const failed: DecidedPlaybookApprovals['failed'] = []
  for (const ticketId of new Set(input.ticketIds)) {
    const ticket = await db.ticket.findFirst({
      where: { id: ticketId, type: 'approval', status: 'open' },
    })
    if (!ticket || playbookApprovalOf(ticket)?.installationId !== installationId) {
      failed.push({ ticketId, error: 'Not an open approval of this playbook' })
      continue
    }
    const marked = await db.ticket.updateMany({
      where: { id: ticketId, status: 'open' },
      data: {
        payload: { ...(ticket.payload as Record<string, unknown>), decidedInBulk: true } as never,
      },
    })
    if (!marked.count) {
      failed.push({ ticketId, error: 'Already decided' })
      continue
    }
    try {
      await resolveTicket(scope, ticketId, {
        approved: input.approve,
        ...(input.reason ? { reason: input.reason } : {}),
      })
      decided.push(ticketId)
    } catch (error) {
      const after = await db.ticket.findFirst({
        where: { id: ticketId },
        select: { status: true, resolvedByMemberId: true, payload: true },
      })
      // Closed by this decision before something after it failed: decided, in bulk.
      if (after && after.status !== 'open' && after.resolvedByMemberId === scope.memberId) {
        decided.push(ticketId)
        continue
      }
      const { decidedInBulk: _, ...rest } = (after?.payload ?? {}) as Record<string, unknown>
      await db.ticket.updateMany({ where: { id: ticketId }, data: { payload: rest as never } })
      failed.push({ ticketId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  if (decided.length)
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: input.approve ? 'playbook.approvals_approved' : 'playbook.approvals_denied',
      target: { type: 'playbook', id: installationId },
      data: { ticketIds: decided, ...(input.reason ? { reason: input.reason } : {}) },
    })
  return { decided, failed }
}
