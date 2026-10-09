// The vault's credentials, from the dashboard. Secrets go in and are never
// shown again: every response carries only the non-secret details.
import {
  CreateCredential,
  CredentialSecret,
  SECRET_FIELD,
  UpdateCredential,
} from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { audit } from '../audit.js'
import { summarize } from '../credentials.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'
import { openSecret, replaceSecret, sealSecret } from '../vault.js'

export const credentials = new Hono<AppEnv>()
  .use(requireUser)
  .use(requireWorkspace)

  .get('/', async (c) => {
    const rows = await c.var.db.credential.findMany({ orderBy: { name: 'asc' } })
    return c.json(rows.map(summarize))
  })

  /** Any member may add one. Its secret goes straight into the vault. */
  .post('/', async (c) => {
    const { scope, db } = c.var
    const input = await parseBody(c.req.raw, CreateCredential)
    const vaultSecretId = await sealSecret(db, scope, {
      [SECRET_FIELD[input.kind]]: input.secret[SECRET_FIELD[input.kind]],
    })
    const row = await db.credential.create({
      data: {
        kind: input.kind,
        name: input.name,
        details: input.details,
        vaultSecretId,
        createdByMemberId: scope.memberId,
      } as never,
    })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'credential.created',
      target: { type: 'credential', id: row.id },
      data: { kind: input.kind, name: input.name },
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
      // Keep any other stored field; replace this kind's secret.
      const stored = await openSecret<CredentialSecret>(db, scope, row.vaultSecretId)
      await replaceSecret(db, scope, row.vaultSecretId, { ...stored, [field]: value })
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
    await db.vaultSecret.deleteMany({ where: { id: row.vaultSecretId } })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'credential.deleted',
      target: { type: 'credential', id: row.id },
      data: { name: row.name },
    })
    return c.body(null, 204)
  })

  /** Who used it, in which thread, and whether a mention or a person allowed it. */
  .get('/:id/uses', async (c) => {
    const { db } = c.var
    const row = await db.credential.findFirst({ where: { id: c.req.param('id') } })
    if (!row) throw new HTTPException(404, { message: 'Credential not found' })
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
          via: data.via === 'mention' ? 'mention' : 'approval',
        }
      }),
    )
  })

async function editable({ scope, db }: Pick<AppEnv['Variables'], 'scope' | 'db'>, id: string) {
  const row = await db.credential.findFirst({ where: { id } })
  if (!row) throw new HTTPException(404, { message: 'Credential not found' })
  const isAdmin = scope.role === 'owner' || scope.role === 'admin'
  if (!isAdmin && row.createdByMemberId !== scope.memberId)
    throw new HTTPException(403, { message: 'Only its creator or an admin can change this' })
  return row
}
