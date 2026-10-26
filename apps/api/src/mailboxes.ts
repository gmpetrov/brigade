// Mailboxes (Inbox › Mailboxes): whatever receives mail for the workspace, in one list, each with
// where its mail arrives, who handles it (its rules and playbooks, in the order they apply) and
// who reads and replies from it. Brigade's addresses (an agent's, a project's) and Gmail accounts
// alike; the ids are the Inbox's sources' (src/inbox.ts).
import type { MailboxDetail, MailboxRule, MailboxSummary } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import type { Prisma, ScopedDb } from './db.js'
import { addressOf } from './mail/names.js'
import type { WorkspaceScope } from './scope.js'

const admin = (scope: WorkspaceScope) => scope.role === 'owner' || scope.role === 'admin'

/** The Gmail accounts this member may see: shared ones, and their own. */
const gmailWhere = (scope: WorkspaceScope): Prisma.ConnectionWhereInput => ({
  kind: 'gmail',
  status: { not: 'removed' },
  OR: [
    { reach: 'workspace' as const },
    { reach: 'mine' as const, createdByMemberId: scope.memberId },
  ],
})

async function rows(
  db: ScopedDb,
  scope: WorkspaceScope,
  only?: { email?: string; gmail?: string },
) {
  const [addresses, gmail, teammates, projects] = await Promise.all([
    only?.gmail
      ? []
      : db.mailAddress.findMany({
          where: {
            releasedAt: null,
            connectionId: { not: null },
            ...(only?.email ? { id: only.email } : {}),
          },
          include: { domain: true },
          orderBy: { createdAt: 'asc' },
        }),
    only?.email
      ? []
      : db.connection.findMany({
          where: { ...gmailWhere(scope), ...(only?.gmail ? { id: only.gmail } : {}) },
          orderBy: { createdAt: 'asc' },
        }),
    db.teammate.findMany({ select: { id: true, name: true } }),
    db.project.findMany({ select: { id: true, name: true } }),
  ])
  const find = (list: { id: string; name: string }[], id: string | null) =>
    id ? (list.find((x) => x.id === id) ?? null) : null
  return [
    ...addresses.map((a) => {
      const teammate = a.kind === 'agent' ? find(teammates, a.teammateId) : null
      const project = a.kind === 'inbox' ? find(projects, a.projectId) : null
      return {
        id: `email:${a.id}`,
        kind: a.kind,
        name:
          a.kind === 'agent'
            ? (teammate?.name ?? a.name)
            : `${a.displayName ?? a.name}${project ? ` · ${project.name}` : ''}`,
        address: addressOf(a.name),
        publicAddress: a.publicAddress,
        project,
        teammate,
        visibility: 'workspace' as const,
        showAll: true,
        addressId: a.id as string | null,
        connectionId: a.connectionId!,
        manages: admin(scope),
        accountOwner: false,
        reach: null,
      }
    }),
    ...gmail.map((c) => ({
      id: `gmail:${c.id}`,
      kind: 'gmail' as const,
      name: c.externalAccount ?? c.label,
      address: c.externalAccount ?? c.label,
      publicAddress: null,
      project: null,
      teammate: null,
      visibility: c.reach === 'workspace' ? ('workspace' as const) : ('you' as const),
      showAll: c.reach === 'workspace' && c.inbox,
      addressId: null as string | null,
      connectionId: c.id,
      manages: admin(scope),
      accountOwner: c.createdByMemberId === scope.memberId,
      reach: c.reach as 'workspace' | 'mine',
    })),
  ]
}

const summary = (
  row: Awaited<ReturnType<typeof rows>>[number],
  ruleCount: number,
): MailboxSummary => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  address: row.address,
  publicAddress: row.publicAddress,
  project: row.project,
  teammate: row.teammate,
  ruleCount,
  visibility: row.visibility,
  showAll: row.showAll,
})

/** Every mailbox this member may see, with how many rules and playbooks handle each. */
export async function listMailboxes(db: ScopedDb, scope: WorkspaceScope) {
  const all = await rows(db, scope)
  const counts = await db.trigger.groupBy({
    by: ['connectionId'],
    where: { event: 'email_received', connectionId: { in: all.map((r) => r.connectionId) } },
    _count: { _all: true },
  })
  return all.map((r) =>
    summary(r, counts.find((c) => c.connectionId === r.connectionId)?._count._all ?? 0),
  )
}

/** One mailbox, whole, or a 404 (another member's own Gmail is never one of yours). */
export async function readMailbox(
  db: ScopedDb,
  scope: WorkspaceScope,
  id: string,
): Promise<MailboxDetail> {
  const [kind, key] = id.split(':')
  if ((kind !== 'email' && kind !== 'gmail') || !key)
    throw new HTTPException(404, { message: 'No such mailbox' })
  const [row] = await rows(db, scope, kind === 'email' ? { email: key } : { gmail: key })
  if (!row) throw new HTTPException(404, { message: 'No such mailbox' })
  const [triggers, grants] = await Promise.all([
    db.trigger.findMany({
      where: { connectionId: row.connectionId, event: 'email_received' },
      include: {
        teammate: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
        playbookInstallation: { select: { id: true, manifest: true, status: true } },
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    }),
    db.grant.findMany({
      where: { connectionId: row.connectionId, teammate: { archivedAt: null } },
      select: { teammate: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  ])
  const rules: MailboxRule[] = triggers.map((t) => ({
    id: t.id,
    label: t.label,
    teammate: t.teammate,
    options: (t.options ?? {}) as Record<string, string>,
    instructions: t.instructions,
    position: t.position,
    project: t.project,
    playbook: t.playbookInstallation
      ? {
          id: t.playbookInstallation.id,
          name: (t.playbookInstallation.manifest as { name?: string } | null)?.name ?? 'A playbook',
          status: t.playbookInstallation.status,
        }
      : null,
  }))
  return {
    ...summary(row, rules.length),
    addressId: row.addressId,
    connectionId: row.connectionId,
    manages: row.manages,
    accountOwner: row.accountOwner,
    rules,
    readers: grants.map((g) => g.teammate),
    reach: row.reach,
  }
}
