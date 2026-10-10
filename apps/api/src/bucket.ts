// The one bucket (Cloudflare R2, through its S3 API). Every key starts with
// the organization and workspace (spec hard constraint 5); callers pass a
// scope and a document id, never a path from request input.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AwsClient } from 'aws4fetch'
import { env } from './config.js'
import type { Scope } from './db.js'

const r2 =
  env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET
    ? {
        client: new AwsClient({
          accessKeyId: env.R2_ACCESS_KEY_ID,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY,
          service: 's3',
          region: 'auto',
        }),
        base: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}`,
      }
    : null

if (!r2) {
  if (process.env.NODE_ENV === 'production') throw new Error('Set R2_* to use the library')
  console.warn(`R2 is not configured: library files go to ${env.BUCKET_DIR}`)
}

const SAFE = /^[A-Za-z0-9_-]{1,64}$/

/** The bucket key of a library file's bytes. */
export function documentKey(scope: Scope, documentId: string) {
  for (const part of [scope.organizationId, scope.workspaceId, documentId])
    if (!SAFE.test(part)) throw new Error('Invalid bucket key part')
  return `${scope.organizationId}/${scope.workspaceId}/library/${documentId}`
}

const REPO_PART = /^[a-z0-9_.-]{1,100}$/

/**
 * The bucket key of a thread's git backup: a bundle of what a teammate had not
 * pushed in one checkout, kept when GitHub would not take it.
 */
export function repoBackupKey(
  scope: Scope,
  backup: { repository: string; sessionId: string; teammateId: string; folder: string },
) {
  const [owner = '', name = ''] = backup.repository.split('/')
  for (const part of [scope.organizationId, scope.workspaceId, backup.sessionId, backup.teammateId])
    if (!SAFE.test(part)) throw new Error('Invalid bucket key part')
  for (const part of [owner, name, backup.folder])
    if (!REPO_PART.test(part) || part === '.' || part === '..')
      throw new Error('Invalid bucket key part')
  return `${scope.organizationId}/${scope.workspaceId}/repos/${owner}/${name}/${backup.sessionId}/${backup.teammateId}/${backup.folder}.bundle`
}

const url = (key: string) => `${r2!.base}/${key.split('/').map(encodeURIComponent).join('/')}`

export async function putObject(key: string, body: Uint8Array, contentType: string) {
  if (!r2) {
    const file = join(env.BUCKET_DIR, key)
    await mkdir(dirname(file), { recursive: true })
    return writeFile(file, body)
  }
  const response = await r2.client.fetch(url(key), {
    method: 'PUT',
    body: body.slice().buffer,
    headers: { 'content-type': contentType },
  })
  if (!response.ok) throw new Error(`bucket put failed: ${response.status}`)
}

/** The object's bytes, or null when it is gone. */
export async function getObject(key: string): Promise<Uint8Array | null> {
  if (!r2) return readFile(join(env.BUCKET_DIR, key)).catch(() => null)
  const response = await r2.client.fetch(url(key))
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`bucket get failed: ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

export async function deleteObject(key: string) {
  if (!r2) return rm(join(env.BUCKET_DIR, key), { force: true })
  const response = await r2.client.fetch(url(key), { method: 'DELETE' })
  if (!response.ok && response.status !== 404)
    throw new Error(`bucket delete failed: ${response.status}`)
}
