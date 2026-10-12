// Preview variables: values people give a repository's preview, beside the
// setup a teammate saved for it. A setting's value is kept as it is; a
// secret's is sealed in the vault (not the credentials people see on the
// Vault page) and never read back by anyone: only the runner gets it, to put
// in the app's environment when its preview starts. Any member sets or
// replaces one; an owner, an admin or whoever set it last removes it.
import { randomBytes } from 'node:crypto'
import type { PreviewVariable, SetPreviewVariables } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit } from './audit.js'
import type { Scope, ScopedDb } from './db.js'
import type { WorkspaceScope } from './scope.js'
import { deleteSecret, openSecret, replaceSecret, sealSecret } from './vault.js'

type Row = {
  name: string
  kind: PreviewVariable['kind']
  value: string | null
  description: string | null
  updatedByMemberId: string | null
  updatedAt: Date
}

/** The variables of these repositories (all when unset), by repository, as people see them. */
export async function listVariables(db: ScopedDb, repositories?: string[]) {
  const rows = await db.previewVariable.findMany({
    ...(repositories ? { where: { repository: { in: repositories } } } : {}),
    orderBy: [{ repository: 'asc' }, { name: 'asc' }],
  })
  const memberIds = [...new Set(rows.flatMap((r) => r.updatedByMemberId ?? []))]
  const members = memberIds.length
    ? await db.member.findMany({
        where: { id: { in: memberIds } },
        select: { id: true, user: { select: { name: true } } },
      })
    : []
  const shown = (row: Row): PreviewVariable => {
    const member = members.find((m) => m.id === row.updatedByMemberId)
    return {
      name: row.name,
      kind: row.kind,
      ...(row.kind === 'setting' && row.value !== null ? { value: row.value } : {}),
      ...(row.description ? { description: row.description } : {}),
      updatedBy: member ? { id: member.id, name: member.user.name } : null,
      updatedAt: row.updatedAt.toISOString(),
    }
  }
  const byRepository = new Map<string, PreviewVariable[]>()
  for (const row of rows)
    byRepository.set(row.repository, [...(byRepository.get(row.repository) ?? []), shown(row)])
  return byRepository
}

/** Set some of a repository's variables: new ones added, the others replaced. */
export async function setVariables(
  db: ScopedDb,
  scope: WorkspaceScope,
  repository: string,
  input: SetPreviewVariables,
) {
  const names = input.variables.map((v) => v.name)
  if (new Set(names).size !== names.length)
    throw new HTTPException(400, { message: 'Each variable once' })
  // A whole .env file at once: the rows it replaces, read in one go.
  const rows = await db.previewVariable.findMany({ where: { repository, name: { in: names } } })
  for (const variable of input.variables) {
    const existing = rows.find((r) => r.name === variable.name)
    const secret =
      variable.kind === 'setting'
        ? null
        : variable.kind === 'secret'
          ? variable.value
          : randomBytes(32).toString('base64url')
    let vaultSecretId = existing?.vaultSecretId ?? null
    if (secret === null) vaultSecretId = null
    else if (vaultSecretId) await replaceSecret(db, scope, vaultSecretId, secret)
    else vaultSecretId = await sealSecret(db, scope, secret)
    const data = {
      kind: variable.kind,
      value: variable.kind === 'setting' ? variable.value : null,
      vaultSecretId,
      ...(variable.description !== undefined ? { description: variable.description || null } : {}),
      updatedByMemberId: scope.memberId,
    }
    if (existing) {
      await db.previewVariable.updateMany({ where: { id: existing.id }, data })
      // A secret that became a setting: its sealed value goes.
      if (existing.vaultSecretId && !vaultSecretId) await deleteSecret(db, existing.vaultSecretId)
    } else
      await db.previewVariable.create({
        data: { repository, name: variable.name, ...data } as never,
      })
  }
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'preview.variables_set',
    target: { type: 'repository', id: repository },
    data: { names },
  })
}

/** Remove one of a repository's variables. */
export async function removeVariable(
  db: ScopedDb,
  scope: WorkspaceScope,
  repository: string,
  name: string,
) {
  const row = await db.previewVariable.findFirst({ where: { repository, name } })
  if (!row) throw new HTTPException(404, { message: 'No such variable' })
  const admin = scope.role === 'owner' || scope.role === 'admin'
  if (!admin && row.updatedByMemberId !== scope.memberId)
    throw new HTTPException(403, {
      message: 'Only whoever set it last, an owner or an admin can remove it',
    })
  // The secret's row goes with the variable's (and the variable's with it).
  if (row.vaultSecretId) await deleteSecret(db, row.vaultSecretId)
  await db.previewVariable.deleteMany({ where: { id: row.id } })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'preview.variable_removed',
    target: { type: 'repository', id: repository },
    data: { name },
  })
}

/** The names and kinds of a repository's variables: what a teammate may know of them. */
export async function variableNames(db: ScopedDb, repository: string) {
  return db.previewVariable.findMany({
    where: { repository },
    select: { name: true, kind: true },
    orderBy: { name: 'asc' },
  })
}

/** A repository's variables with their values, for the runner to start its preview with. */
export async function variableValues(db: ScopedDb, scope: Scope, repository: string) {
  const rows = await db.previewVariable.findMany({ where: { repository } })
  const env: Record<string, string> = {}
  const secrets: string[] = []
  for (const row of rows) {
    if (row.vaultSecretId) {
      env[row.name] = await openSecret<string>(db, scope, row.vaultSecretId)
      secrets.push(row.name)
    } else if (row.value !== null) env[row.name] = row.value
  }
  return { env, secrets }
}
