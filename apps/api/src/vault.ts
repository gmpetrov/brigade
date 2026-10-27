// The vault: customer secrets, encrypted at rest with a key per organization.
// Secrets are decrypted only inside this process, for the call that needs them,
// and are never written to an event, a log or a thread. They reach a thread's
// computer only as a credential released to it, or a preview's variables.
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

/** A value sealed as the vault seals secrets, for a table of its own (AccountLoginBackup, say). */
export function sealValue(scope: Scope, value: unknown) {
  return encrypt(scope, value)
}

/** A value sealValue sealed, for the same workspace. */
export function openValue<T>(
  scope: Scope,
  row: { ciphertext: Uint8Array; iv: Uint8Array; authTag: Uint8Array; keyVersion: number },
): T {
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

/**
 * The key a workspace's cloud computer encrypts its backups with before they go to the bucket
 * (thread folders, teammates' tasks and browsers), derived from the vault's: the bucket alone
 * never holds them readable. Handed to that computer's runner only.
 */
export function backupKey(scope: Scope) {
  return Buffer.from(
    hkdfSync(
      'sha256',
      env.VAULT_KEY,
      Buffer.from('brigade-backups'),
      `org:${scope.organizationId}:workspace:${scope.workspaceId}:v1`,
      32,
    ),
  )
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
