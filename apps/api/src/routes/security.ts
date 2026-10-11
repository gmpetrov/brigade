// The Security page: who may reach what (connections, credentials, the
// library) across every teammate, and what happened. Changes go through the
// routes that own each grant: teammates (connections, library, policy) and
// credentials (access and grants).
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { summarize } from '../credentials.js'
import { folderRules } from '../library-folders.js'
import { requireRole, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

/** Audit actions the Activity feed shows, by category. */
const CATEGORIES = {
  credentials: ['credential.'],
  connections: ['connection.', 'grant.set'],
  approvals: ['approval.', 'cap.'],
  teammates: ['teammate.', 'library.folder_access_changed'],
  members: ['member.', 'invitation.', 'takeover.'],
} as const
type Category = keyof typeof CATEGORIES
const ALL_PREFIXES = Object.values(CATEGORIES).flat()
const PAGE = 50

const startsWithAny = (prefixes: readonly string[]) =>
  prefixes.map((p) => ({ action: p.endsWith('.') ? { startsWith: p } : { equals: p } }))

export const security = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  /** Every teammate's access to every connection, credential and the library, in one answer. */
  .get('/access', async (c) => {
    const { db } = c.var
    const [
      teammates,
      connections,
      connectionGrants,
      credentials,
      members,
      connectionUse,
      credentialUse,
    ] = await Promise.all([
      db.teammate.findMany({
        where: { archivedAt: null },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          name: true,
          harness: true,
          libraryAccess: true,
          permissionPolicy: true,
        },
      }),
      db.connection.findMany({
        where: { status: { not: 'removed' }, kind: { not: 'webhook' } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, kind: true, label: true, externalAccount: true, status: true },
      }),
      db.grant.findMany({ select: { teammateId: true, connectionId: true, scope: true } }),
      db.credential.findMany({
        orderBy: { name: 'asc' },
        include: { grants: { select: { teammateId: true, withoutAsking: true } } },
      }),
      db.member.findMany({ select: { id: true, user: { select: { name: true } } } }),
      db.connectionCall.groupBy({
        by: ['connectionId'],
        where: { result: 'ok' },
        _max: { createdAt: true },
      }),
      db.auditEntry.groupBy({
        by: ['targetId'],
        where: { action: 'credential.released', targetType: 'credential' },
        _max: { at: true },
      }),
    ])
    const connectionLast = new Map(connectionUse.map((u) => [u.connectionId, u._max.createdAt]))
    const credentialLast = new Map(credentialUse.map((u) => [u.targetId, u._max.at]))
    const memberIds = new Set(members.map((m) => m.id))
    return c.json({
      teammates: teammates.map((t) => ({
        id: t.id,
        name: t.name,
        harness: t.harness,
        libraryAccess: t.libraryAccess,
        connectorWrites:
          (t.permissionPolicy as { connectorWrites?: 'allow' | 'ask' | 'deny' } | null)
            ?.connectorWrites ?? 'allow',
      })),
      connections: connections.map((cn) => ({
        ...cn,
        lastUsedAt: connectionLast.get(cn.id)?.toISOString() ?? null,
      })),
      connectionGrants,
      credentials: credentials.map((cr) => ({
        ...summarize(cr),
        grants: cr.grants,
        lastUsedAt: credentialLast.get(cr.id)?.toISOString() ?? null,
        creatorActive: memberIds.has(cr.createdByMemberId),
      })),
      members: Object.fromEntries(members.map((m) => [m.id, m.user.name])),
      libraryFolders: await folderRules(db),
    })
  })

  /**
   * Security-relevant audit entries, newest first, and connector calls that were
   * denied. Admins only: it shows who approved what.
   */
  .get('/activity', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const { db } = c.var
    const category = c.req.query('category') as Category | undefined
    if (category && !(category in CATEGORIES))
      throw new HTTPException(400, { message: 'Unknown category' })
    const teammateId = c.req.query('teammateId') || undefined
    const before = c.req.query('before') ? new Date(c.req.query('before')!) : undefined
    if (before && Number.isNaN(before.getTime()))
      throw new HTTPException(400, { message: 'Bad cursor' })

    const prefixes = category ? CATEGORIES[category] : ALL_PREFIXES
    const entries = await db.auditEntry.findMany({
      where: {
        AND: [
          { OR: startsWithAny(prefixes) },
          ...(before ? [{ at: { lt: before } }] : []),
          ...(teammateId
            ? [
                {
                  OR: [
                    { actorId: teammateId },
                    { targetId: teammateId },
                    { data: { path: ['teammateId'], equals: teammateId } },
                  ],
                },
              ]
            : []),
        ],
      },
      orderBy: { at: 'desc' },
      take: PAGE,
    })
    const denied =
      !category || category === 'connections'
        ? await db.connectionCall.findMany({
            where: {
              result: 'denied',
              ...(teammateId ? { teammateId } : {}),
              ...(before ? { createdAt: { lt: before } } : {}),
            },
            orderBy: { createdAt: 'desc' },
            take: PAGE,
          })
        : []

    const items = [
      ...entries.map((e) => ({
        id: `a${e.id}`,
        at: e.at.toISOString(),
        actor: { type: e.actorType, id: e.actorId },
        action: e.action,
        target: { type: e.targetType, id: e.targetId },
        data: (e.data ?? {}) as Record<string, unknown>,
      })),
      ...denied.map((d) => ({
        id: `c${d.id}`,
        at: d.createdAt.toISOString(),
        actor: { type: 'teammate' as const, id: d.teammateId },
        action: 'connection.call_denied',
        target: { type: 'connection', id: d.connectionId },
        data: {
          sessionId: d.sessionId,
          operation: d.operation,
          target: d.target,
          ...(d.error ? { error: d.error } : {}),
        } as Record<string, unknown>,
      })),
    ]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, PAGE)

    // Names for what the entries mention, including teammates and credentials since removed.
    const ids = (type: string) => [
      ...new Set(
        items.flatMap((i) => [
          ...(i.actor.type === type ? [i.actor.id] : []),
          ...(i.target.type === type ? [i.target.id] : []),
          ...(type === 'teammate' && typeof i.data.teammateId === 'string'
            ? [i.data.teammateId]
            : []),
        ]),
      ),
    ]
    const [teammates, members, credentials, connections] = await Promise.all([
      db.teammate.findMany({
        where: { id: { in: ids('teammate') } },
        select: { id: true, name: true },
      }),
      db.member.findMany({
        where: { id: { in: ids('member') } },
        select: { id: true, user: { select: { name: true } } },
      }),
      db.credential.findMany({
        where: { id: { in: ids('credential') } },
        select: { id: true, name: true },
      }),
      db.connection.findMany({
        where: { id: { in: ids('connection') } },
        select: { id: true, label: true, externalAccount: true },
      }),
    ])
    return c.json({
      items,
      names: {
        teammate: Object.fromEntries(teammates.map((t) => [t.id, t.name])),
        member: Object.fromEntries(members.map((m) => [m.id, m.user.name])),
        credential: Object.fromEntries(credentials.map((cr) => [cr.id, cr.name])),
        connection: Object.fromEntries(
          connections.map((cn) => [cn.id, cn.externalAccount ?? cn.label]),
        ),
      },
      // Older entries exist when either source filled its page.
      next: entries.length === PAGE || denied.length === PAGE ? (items.at(-1)?.at ?? null) : null,
    })
  })
