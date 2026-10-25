// The one bucket (Cloudflare R2, through its S3 API). Every key starts with
// the organization and workspace (spec hard constraint 5); callers pass a
// scope and a document id, never a path from request input.
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { STORED_FILE_NAME } from '@brigade/contracts'
import { AwsClient } from 'aws4fetch'
import { env } from './config.js'
import type { Scope } from './db.js'
import { fixedLength } from './platform/node.js'

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

/** The bucket key of a saved version of a library file. */
export function versionKey(scope: Scope, versionId: string) {
  for (const part of [scope.organizationId, scope.workspaceId, versionId])
    if (!SAFE.test(part)) throw new Error('Invalid bucket key part')
  return `${scope.organizationId}/${scope.workspaceId}/library-versions/${versionId}`
}

/** The bucket key of an attachment's bytes: a file given to a thread. */
export function attachmentKey(scope: Scope, attachmentId: string) {
  for (const part of [scope.organizationId, scope.workspaceId, attachmentId])
    if (!SAFE.test(part)) throw new Error('Invalid bucket key part')
  return `${scope.organizationId}/${scope.workspaceId}/attachments/${attachmentId}`
}

/** The bucket key of a file put in a document from the editor. */
export function assetKey(scope: Scope, assetId: string) {
  for (const part of [scope.organizationId, scope.workspaceId, assetId])
    if (!SAFE.test(part)) throw new Error('Invalid bucket key part')
  return `${scope.organizationId}/${scope.workspaceId}/assets/${assetId}`
}

/** The bucket key of a project's logo: one per project, replaced by a new one. */
export function projectLogoKey(scope: Scope, projectId: string) {
  for (const part of [scope.organizationId, scope.workspaceId, projectId])
    if (!SAFE.test(part)) throw new Error('Invalid bucket key part')
  return `${scope.organizationId}/${scope.workspaceId}/project-logos/${projectId}`
}

/** The bucket key of a version of a workspace's logo ("k2x9f1.png"): a new one gets a key of its own. */
export function workspaceLogoKey(scope: Scope, version: string) {
  for (const part of [scope.organizationId, scope.workspaceId])
    if (!SAFE.test(part)) throw new Error('Invalid bucket key part')
  if (!/^[a-z0-9]{1,16}\.[a-z]{2,4}$/.test(version)) throw new Error('Invalid logo version')
  return `${scope.organizationId}/${scope.workspaceId}/workspace-logos/${version}`
}

/** The bucket key of a skill's file, by its SHA-256: the same bytes are kept once. */
export function skillFileKey(scope: Scope, sha256: string) {
  for (const part of [scope.organizationId, scope.workspaceId])
    if (!SAFE.test(part)) throw new Error('Invalid bucket key part')
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('Invalid bucket key part')
  return `${scope.organizationId}/${scope.workspaceId}/skill-files/${sha256}`
}

/** The bucket folder of the images and PDFs a thread's events refer to (event-files.ts). */
export function threadFilesPrefix(scope: Scope, sessionId: string) {
  for (const part of [scope.organizationId, scope.workspaceId, sessionId])
    if (!SAFE.test(part)) throw new Error('Invalid bucket key part')
  return `${scope.organizationId}/${scope.workspaceId}/thread-files/${sessionId}/`
}

/** The bucket key of a file a thread's events refer to, by its name: `<sha256>.<ext>`. */
export function threadFileKey(scope: Scope, sessionId: string, name: string) {
  if (!STORED_FILE_NAME.test(name)) throw new Error('Invalid bucket key part')
  return `${threadFilesPrefix(scope, sessionId)}${name}`
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

/** The bucket key of a thread folder a computer cleared to free disk, kept until the thread comes back. */
export function folderArchiveKey(scope: Scope, folder: { sessionId: string; teammateId: string }) {
  for (const part of [scope.organizationId, scope.workspaceId, folder.sessionId, folder.teammateId])
    if (!SAFE.test(part)) throw new Error('Invalid bucket key part')
  return `${scope.organizationId}/${scope.workspaceId}/folders/${folder.sessionId}/${folder.teammateId}.tar.gz`
}

const url = (key: string) => `${r2!.base}/${key.split('/').map(encodeURIComponent).join('/')}`

/** Browsers can upload straight to the bucket: only with R2, not the local stand-in. */
export const directUploads = Boolean(r2)

/** How long a signed upload URL works. */
const UPLOAD_URL_SECONDS = 10 * 60

/**
 * A short-lived URL a browser can PUT one object to, without credentials.
 * Size and type are signed: R2 refuses a body of any other length or type.
 */
export async function presignPut(key: string, size: number, contentType: string) {
  if (!r2) throw new Error('Direct uploads need R2')
  const headers = { 'content-type': contentType, 'content-length': String(size) }
  const signed = await r2.client.sign(`${url(key)}?X-Amz-Expires=${UPLOAD_URL_SECONDS}`, {
    method: 'PUT',
    headers,
    aws: { signQuery: true, allHeaders: true },
  })
  // The browser sets content-length itself; it only sends the type.
  return { url: signed.url, headers: { 'content-type': contentType } }
}

/** How long a signed download URL works. */
const DOWNLOAD_URL_SECONDS = 5 * 60

/**
 * A short-lived URL the browser can GET one object from, served with the
 * given type and disposition. The bucket answers range requests, so video
 * seeks without the API in the way.
 */
export async function presignGet(
  key: string,
  response: { contentType: string; disposition: string },
) {
  if (!r2) throw new Error('Signed downloads need R2')
  const query = new URLSearchParams({
    'X-Amz-Expires': String(DOWNLOAD_URL_SECONDS),
    'response-content-type': response.contentType,
    'response-content-disposition': response.disposition,
  })
  const signed = await r2.client.sign(`${url(key)}?${query}`, {
    method: 'GET',
    aws: { signQuery: true },
  })
  return { url: signed.url, seconds: DOWNLOAD_URL_SECONDS }
}

/** The object's size, or null when it is not there. Without reading it. */
export async function objectSize(key: string): Promise<number | null> {
  if (!r2)
    return stat(join(env.BUCKET_DIR, key)).then(
      (s) => s.size,
      () => null,
    )
  const response = await r2.client.fetch(url(key), { method: 'HEAD' })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`bucket head failed: ${response.status}`)
  return Number(response.headers.get('content-length'))
}

/**
 * The body's own bytes in an ArrayBuffer of their size. A Node Buffer under 4 KB
 * is a view into a shared 8 KB pool, and its `slice()` is another view: its
 * `.buffer` would upload the whole pool.
 */
export const exactBytes = (body: Uint8Array) => new Uint8Array(body).buffer

export async function putObject(key: string, body: Uint8Array, contentType: string) {
  if (!r2) {
    const file = join(env.BUCKET_DIR, key)
    await mkdir(dirname(file), { recursive: true })
    return writeFile(file, body)
  }
  const response = await r2.client.fetch(url(key), {
    method: 'PUT',
    body: exactBytes(body),
    headers: { 'content-type': contentType },
  })
  if (!response.ok) throw new Error(`bucket put failed: ${response.status}`)
}

/**
 * Put an object from a stream of exactly `size` bytes, never held whole: the bytes go on to the
 * bucket as they arrive (a signed PUT, whose length R2 checks).
 */
export async function putObjectStream(
  key: string,
  body: ReadableStream<Uint8Array>,
  size: number,
  contentType: string,
) {
  if (!r2) {
    const file = join(env.BUCKET_DIR, key)
    await mkdir(dirname(file), { recursive: true })
    return pipeline(Readable.fromWeb(body as never), createWriteStream(file))
  }
  const signed = await presignPut(key, size, contentType)
  const sized = fixedLength(body, size)
  const response = await fetch(signed.url, {
    method: 'PUT',
    headers: { ...signed.headers, ...sized.headers },
    body: sized.body,
    duplex: 'half',
  } as RequestInit)
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

/** The object's bytes as they arrive, or null when it is gone: for files too large to hold. */
export async function streamObject(key: string): Promise<ReadableStream<Uint8Array> | null> {
  if (!r2) {
    const file = join(env.BUCKET_DIR, key)
    if (!(await stat(file).catch(() => null))) return null
    return Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>
  }
  const response = await r2.client.fetch(url(key))
  if (response.status === 404) return null
  if (!response.ok || !response.body) throw new Error(`bucket get failed: ${response.status}`)
  return response.body
}

/**
 * Bytes `start` to `end` (inclusive) of the object as they arrive, or null when it is gone: a
 * file served through the API is never held whole.
 */
export async function streamRange(
  key: string,
  start: number,
  end: number,
): Promise<ReadableStream<Uint8Array> | null> {
  if (!r2) {
    const file = join(env.BUCKET_DIR, key)
    if (!(await stat(file).catch(() => null))) return null
    return Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>
  }
  const response = await r2.client.fetch(url(key), { headers: { range: `bytes=${start}-${end}` } })
  if (response.status === 404) return null
  if (!response.ok || !response.body) throw new Error(`bucket get failed: ${response.status}`)
  return response.body
}

/** The keys of every object in a folder, such as `threadFilesPrefix`: it ends with a slash. */
export async function listObjects(prefix: string): Promise<string[]> {
  if (!prefix.endsWith('/')) throw new Error('List a folder')
  if (!r2) {
    const entries = await readdir(join(env.BUCKET_DIR, prefix), { withFileTypes: true }).catch(
      () => [],
    )
    return entries.filter((e) => e.isFile()).map((e) => `${prefix}${e.name}`)
  }
  const keys: string[] = []
  let token: string | undefined
  do {
    const query = new URLSearchParams({ 'list-type': '2', prefix })
    if (token) query.set('continuation-token', token)
    const response = await r2.client.fetch(`${r2.base}?${query}`)
    if (!response.ok) throw new Error(`bucket list failed: ${response.status}`)
    const xml = await response.text()
    for (const [, key] of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(unescapeXml(key!))
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? unescapeXml(xml.match(/<NextContinuationToken>([^<]*)</)?.[1] ?? '') || undefined
      : undefined
  } while (token)
  return keys
}

const unescapeXml = (text: string) =>
  text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')

export async function deleteObject(key: string) {
  if (!r2) return rm(join(env.BUCKET_DIR, key), { force: true })
  const response = await r2.client.fetch(url(key), { method: 'DELETE' })
  if (!response.ok && response.status !== 404)
    throw new Error(`bucket delete failed: ${response.status}`)
}
