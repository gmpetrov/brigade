// The vault: customer secrets, encrypted at rest with a key per organization.
// Secrets are decrypted only inside this process, for the call that needs them,
// and are never sent to a computer or written to an event, a log or a thread.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { env } from './config.js'
import type { ScopedDb, Scope } from './db.js'

const KEY_VERSION = 1

function organizationKey(organizationId: string, version: number) {
  return Buffer.from(
    hkdfSync(
      'sha256',
      env.VAULT_KEY,
      Buffer.from('brigade-vault'),
      `org:${organizationId}:v${version}`,
      32,
    ),
  )
}

function encrypt(scope: Scope, value: unknown) {
  const iv = randomBytes(12)
  const cipher = createCipheriv(
    'aes-256-gcm',
    organizationKey(scope.organizationId, KEY_VERSION),
    iv,
  )
  // The workspace is bound into the ciphertext: a secret cannot be moved to another workspace.
  cipher.setAAD(Buffer.from(scope.workspaceId))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: KEY_VERSION }
}

/** Store a secret. Returns its id; the value never leaves the API. */
export async function sealSecret(db: ScopedDb, scope: Scope, value: unknown): Promise<string> {
  const row = await db.vaultSecret.create({ data: encrypt(scope, value) as never })
  return row.id
}

export async function replaceSecret(db: ScopedDb, scope: Scope, id: string, value: unknown) {
  await db.vaultSecret.updateMany({ where: { id }, data: encrypt(scope, value) })
}

/** Decrypt a secret of the session's workspace. */
export async function openSecret<T>(db: ScopedDb, scope: Scope, id: string): Promise<T> {
  const row = await db.vaultSecret.findFirst({ where: { id } })
  if (!row) throw new Error('Secret not found')
  const decipher = createDecipheriv(
    'aes-256-gcm',
    organizationKey(scope.organizationId, row.keyVersion),
    row.iv,
  )
  decipher.setAAD(Buffer.from(scope.workspaceId))
  decipher.setAuthTag(row.authTag)
  return JSON.parse(
    Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8'),
  ) as T
}

export async function deleteSecret(db: ScopedDb, id: string) {
  await db.vaultSecret.deleteMany({ where: { id } })
}
