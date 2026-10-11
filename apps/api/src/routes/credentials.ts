// The vault's credentials, from the dashboard. Secrets go in and are never
// shown again: every response carries only the non-secret details.
import {
  CreateCredential,
  CredentialSecret,
  SECRET_FIELD,
  SetCredentialAccess,
  SetCredentialGrant,
  UpdateCredential,
} from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { audit } from '../audit.js'
import { mayManage, replaceCredentialSecret, summarize } from '../credentials.js'
import type { ScopedDb } from '../db.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'
import { openSecret, replaceSecret, sealSecret } from '../vault.js'

export const credentials = new Hono<AppEnv>()
  .use(requireUser)
  .use(requireWorkspace)

  /** Each with the teammates granted it. */
  .get('/', async (c) => {
    const rows = await c.var.db.credential.findMany({
      orderBy: { name: 'asc' },
      include: { grants: { select: { teammateId: true, withoutAsking: true } } },
    })
    return c.json(rows.map((r) => ({ ...summarize(r), grants: r.grants })))
  })

  /** Any member may add one. Its secret goes straight into the vault. */
  .post('/', async (c) => {
    const { scope, db } = c.var
    const input = await parseBody(c.req.raw, CreateCredential)
    const vaultSecretId = await sealSecret(db, scope, {
      [SECRET_FIELD[input.kind]]: input.secret[SECRET_FIELD[input.kind]],
    })
    const grants = input.access ? await checkGrants(db, input.access.grants) : []
    const row = await db.credential.create({
      data: {
        kind: input.kind,
        name: input.name,
        details: input.details,
        access: input.access?.access ?? 'all',
        vaultSecretId,
        createdByMemberId: scope.memberId,
      } as never,
    })
    if (grants.length)
      await db.credentialGrant.createMany({
        data: grants.map((g) => ({ ...g, credentialId: row.id })) as never,
      })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'credential.created',
      target: { type: 'credential', id: row.id },
      data: {
        kind: input.kind,
        name: input.name,
        access: row.access,
        ...(grants.length ? { grants } : {}),
      },
    })
    return c.json(summarize(row), 201)
  })

  /** Rename, change details, or replace the secret. Its creator or an admin. */
  .patch('/:id', async (c) => {
    const { scope, db } = c.var
    const row = await editable(c.var, c.req.param('id'))
    const input = await parseBody(c.req.raw, UpdateCredential)
    const field = SECRET_FIELD[row.kind]
    if (input.secret) {
      const value = input.secret[field]
      if (!value) throw new HTTPException(400, { message: `A ${field} is required` })
      // Keeps the one before, to restore.
      await replaceCredentialSecret(db, scope, row, value)
    }
    const updated = await db.credential.update({
      where: { id: row.id },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.details ? { details: input.details } : {}),
      },
    })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'credential.updated',
      target: { type: 'credential', id: row.id },
      data: { secretReplaced: Boolean(input.secret), fields: Object.keys(input) },
    })
    return c.json(summarize(updated))
  })

  .delete('/:id', async (c) => {
    const { scope, db } = c.var
    const row = await editable(c.var, c.req.param('id'))
    // Deleting the secret deletes the credential with it.
    await db.vaultSecret.deleteMany({
      where: {
        id: {
          in: [
            row.vaultSecretId,
            ...(row.previousVaultSecretId ? [row.previousVaultSecretId] : []),
          ],
        },
      },
    })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'credential.deleted',
      target: { type: 'credential', id: row.id },
      data: { name: row.name },
    })
    return c.body(null, 204)
  })

  /** Who may use it: every teammate, or those granted it. Its creator or an admin. */
  .put('/:id/access', async (c) => {
    const { scope, db } = c.var
    const row = await editable(c.var, c.req.param('id'))
    const input = await parseBody(c.req.raw, SetCredentialAccess)
    const grants = await checkGrants(db, input.grants)
    await db.credential.updateMany({ where: { id: row.id }, data: { access: input.access } })
    await db.credentialGrant.deleteMany({ where: { credentialId: row.id } })
    if (grants.length)
      await db.credentialGrant.createMany({
        data: grants.map((g) => ({ ...g, credentialId: row.id })) as never,
      })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'credential.access_set',
      target: { type: 'credential', id: row.id },
      data: { access: input.access, grants },
    })
    return c.json({ ok: true })
  })

  /** One teammate's grant: a cell of the access matrix. Its creator or an admin. */
  .put('/:id/grants', async (c) => {
    const { scope, db } = c.var
    const row = await editable(c.var, c.req.param('id'))
    const input = await parseBody(c.req.raw, SetCredentialGrant)
    await checkGrants(db, [{ teammateId: input.teammateId, withoutAsking: false }])
    const where = { credentialId: row.id, teammateId: input.teammateId }
    if (input.level === 'none') await db.credentialGrant.deleteMany({ where })
    else
      await db.credentialGrant.upsert({
        where: { credentialId_teammateId: where },
        create: { ...where, withoutAsking: input.level === 'without_asking' } as never,
        update: { withoutAsking: input.level === 'without_asking' },
      })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: input.level === 'none' ? 'credential.revoked' : 'credential.granted',
      target: { type: 'credential', id: row.id },
      data: { teammateId: input.teammateId, level: input.level },
    })
    return c.json({ ok: true })
  })

  /** Put back the secret from before its last replacement; the replaced one can be restored in turn. */
  .post('/:id/restore', async (c) => {
    const { scope, db } = c.var
    const row = await editable(c.var, c.req.param('id'))
    if (!row.previousVaultSecretId)
      throw new HTTPException(409, { message: 'There is no earlier value to restore' })
    const current = await openSecret<CredentialSecret>(db, scope, row.vaultSecretId)
    const previous = await openSecret<CredentialSecret>(db, scope, row.previousVaultSecretId)
    await replaceSecret(db, scope, row.vaultSecretId, previous)
    await replaceSecret(db, scope, row.previousVaultSecretId, current)
    const updated = await db.credential.update({
      where: { id: row.id },
      data: { updatedAt: new Date() },
    })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'credential.restored',
      target: { type: 'credential', id: row.id },
    })
    return c.json(summarize(updated))
  })

  /** Who used it, in which thread, and whether a mention, a grant or a person allowed it. */
  .get('/:id/uses', async (c) => {
    const { db } = c.var
    const row = await db.credential.findFirst({ where: { id: c.req.param('id') } })
    if (!row) throw new HTTPException(404, { message: 'Secret not found' })
    const entries = await db.auditEntry.findMany({
      where: { targetType: 'credential', targetId: row.id, action: 'credential.released' },
      orderBy: { at: 'desc' },
      take: 200,
    })
    const teammates = new Map(
      (
        await db.teammate.findMany({
          where: { id: { in: [...new Set(entries.map((e) => e.actorId))] } },
          select: { id: true, name: true },
        })
      ).map((t) => [t.id, t.name]),
    )
    return c.json(
      entries.map((e) => {
        const data = (e.data ?? {}) as {
          sessionId?: string
          use?: string
          via?: string
          approvedBy?: string
        }
        return {
          id: String(e.id),
          at: e.at.toISOString(),
          teammate: teammates.get(e.actorId) ?? 'a former teammate',
          sessionId: data.sessionId ?? null,
          use: data.use ?? null,
          via:
            data.via === 'mention' || data.via === 'grant' || data.via === 'thread'
              ? data.via
              : 'approval',
        }
      }),
    )
  })

async function editable({ scope, db }: Pick<AppEnv['Variables'], 'scope' | 'db'>, id: string) {
  const row = await db.credential.findFirst({ where: { id } })
  if (!row) throw new HTTPException(404, { message: 'Secret not found' })
  if (!mayManage(scope, row))
    throw new HTTPException(403, { message: 'Only its creator or an admin can change this' })
  return row
}

/** Grants for this workspace's own, active teammates, one each. */
async function checkGrants(db: ScopedDb, grants: { teammateId: string; withoutAsking: boolean }[]) {
  const unique = [...new Map(grants.map((g) => [g.teammateId, g])).values()]
  const found = await db.teammate.count({
    where: { id: { in: unique.map((g) => g.teammateId) }, archivedAt: null },
  })
  if (found !== unique.length) throw new HTTPException(400, { message: 'Unknown teammate' })
  return unique
}
