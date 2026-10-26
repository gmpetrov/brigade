import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Hono } from 'hono'
import pg from 'pg'

// What a runner uploads straight to the bucket, then has the API check: a teammate's
// connector-call files (routes/runner-attachments.ts), git backup bundles
// (routes/runner-backups.ts), a thread's images and PDFs (routes/runner-files.ts), folder
// archives (routes/runner-folders.ts), and the editor's assets (assets.ts). Against a real
// database: the local one of apps/api/.env, in an organization of its own that it removes at
// the end. Without a database to reach, it is skipped. No R2 here: the signed URLs are the
// API's stand-in (routes/bucket.ts), and the bytes stream to a temporary folder.
const fromEnvFile = () => {
  try {
    const line = readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('DATABASE_URL='))
    return line?.slice('DATABASE_URL='.length).replace(/^"|"$/g, '') || undefined
  } catch {
    return undefined
  }
}
process.env.DATABASE_URL ??= fromEnvFile() ?? 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
process.env.BUCKET_DIR = mkdtempSync(join(tmpdir(), 'runner-direct-'))

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select "sha256" from "DocumentAsset" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { prisma, scoped } = await import('../src/db.js')
const { hashToken } = await import('../src/hub.js')
const {
  assetKey,
  attachmentKey,
  folderArchiveKey,
  getObject,
  putObject,
  repoBackupKey,
  threadFileKey,
} = await import('../src/bucket.js')
const { finishAssetUpload } = await import('../src/assets.js')
const { localBucket } = await import('../src/routes/bucket.js')
const { runnerAttachments } = await import('../src/routes/runner-attachments.js')
const { runnerBackups } = await import('../src/routes/runner-backups.js')
const { runnerFiles } = await import('../src/routes/runner-files.js')
const { runnerFolders } = await import('../src/routes/runner-folders.js')

const app = new Hono()
  .route('/api/bucket', localBucket)
  .route('/runner/attachments', runnerAttachments)
  .route('/runner/backups', runnerBackups)
  .route('/runner/files', runnerFiles)
  .route('/runner/folders', runnerFolders)

const id = randomUUID().slice(0, 8)
const ids = {
  organization: `org-direct-${id}`,
  user: `user-direct-${id}`,
  member: `mem-direct-${id}`,
}
const token = `runner-token-direct-${id}`
const otherToken = `other-runner-token-direct-${id}`
let scope: { organizationId: string; workspaceId: string }
let threadId: string
let otherThreadId: string
let teammateId: string

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const PNG = new Uint8Array(
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(100, 1),
  ]),
)
const PDF = new Uint8Array(Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 0x20)]))
const BUNDLE = new Uint8Array(
  Buffer.from('# v2 git bundle\n0123456789abcdef0123456789abcdef01234567 refs/heads/main\n\nPACK'),
)

before(async () => {
  if (skip) return
  await prisma.organization.create({
    data: { id: ids.organization, name: 'Direct uploads test', slug: ids.organization },
  })
  await prisma.user.create({
    data: { id: ids.user, name: 'Ada', email: `${ids.user}@example.com` },
  })
  await prisma.member.create({
    data: { id: ids.member, organizationId: ids.organization, userId: ids.user, role: 'owner' },
  })
  const workspace = await prisma.workspace.create({
    data: { organizationId: ids.organization, name: 'Direct uploads test' },
  })
  scope = { organizationId: ids.organization, workspaceId: workspace.id }
  const teammate = await prisma.teammate.create({ data: { ...scope, name: 'Riley' } })
  teammateId = teammate.id
  const threads: string[] = []
  for (const [n, t] of [
    ['Laptop', token],
    ['Other', otherToken],
  ] as const) {
    const computer = await prisma.computer.create({
      data: { ...scope, kind: 'member_machine', memberId: ids.member, name: n },
    })
    await prisma.runner.create({
      data: { ...scope, computerId: computer.id, tokenHash: hashToken(t) },
    })
    const thread = await prisma.session.create({
      data: {
        ...scope,
        startedByMemberId: ids.member,
        computerId: computer.id,
        teammateId: teammate.id,
        title: n,
        status: 'idle',
        origin: 'member',
      } as never,
    })
    await scoped(scope).threadTeammate.create({
      data: { sessionId: thread.id, teammateId: teammate.id } as never,
    })
    threads.push(thread.id)
  }
  ;[threadId, otherThreadId] = threads as [string, string]
})

after(async () => {
  if (skip) return
  await prisma.organization.deleteMany({ where: { id: ids.organization } })
  await prisma.user.deleteMany({ where: { id: ids.user } })
  await prisma.$disconnect()
})

const call = (path: string, init: RequestInit & { as?: string } = {}) =>
  app.request(path, {
    ...init,
    headers: { authorization: `Bearer ${init.as ?? token}`, ...init.headers },
  })
const post = (path: string, body: unknown, as?: string) =>
  call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(as ? { as } : {}),
  })
/** PUT to a signed URL, as the runner does: here a path of the API's stand-in. */
const putTo = (ticket: { url: string; headers: Record<string, string> }, bytes: Uint8Array) =>
  app.request(ticket.url, { method: 'PUT', headers: ticket.headers, body: bytes })

// Connector-call files (B6).

async function startAttachment(bytes: Uint8Array, name = 'report.pdf') {
  const answer = await post('/runner/attachments/uploads', {
    sessionId: threadId,
    teammateId,
    name,
    size: bytes.byteLength,
    sha256: sha256(bytes),
  })
  assert.equal(answer.status, 201)
  const ticket = (await answer.json()) as {
    id: string
    url: string
    method: string
    headers: Record<string, string>
  }
  assert.equal(ticket.method, 'PUT')
  assert.match(ticket.url, /^\/api\/bucket\?/)
  return ticket
}

test(
  "a teammate's file goes straight to the bucket, then is checked and ready",
  { skip },
  async () => {
    const ticket = await startAttachment(PDF)
    assert.equal((await putTo(ticket, PDF)).status, 200)
    const done = await post(`/runner/attachments/${ticket.id}/complete`, { sha256: sha256(PDF) })
    assert.equal(done.status, 200)
    assert.deepEqual(await done.json(), {
      id: ticket.id,
      name: 'report.pdf',
      size: PDF.byteLength,
      contentType: 'application/pdf',
    })
    const row = await prisma.attachment.findUnique({ where: { id: ticket.id } })
    assert.equal(row?.status, 'ready')
    assert.equal(row?.sha256, sha256(PDF))
    // Completing it again changes nothing.
    const again = await post(`/runner/attachments/${ticket.id}/complete`, { sha256: sha256(PDF) })
    assert.equal(again.status, 200)
  },
)

test('a file whose bytes are not the SHA-256 given is removed', { skip }, async () => {
  const ticket = await startAttachment(PDF)
  assert.equal((await putTo(ticket, PDF)).status, 200)
  const done = await post(`/runner/attachments/${ticket.id}/complete`, { sha256: sha256(PNG) })
  assert.equal(done.status, 400)
  assert.equal(await getObject(attachmentKey(scope, ticket.id)), null)
  assert.equal(await prisma.attachment.findUnique({ where: { id: ticket.id } }), null)
})

test('a file not yet in the bucket is 409, and can be completed once it is', { skip }, async () => {
  const ticket = await startAttachment(PDF)
  const early = await post(`/runner/attachments/${ticket.id}/complete`, { sha256: sha256(PDF) })
  assert.equal(early.status, 409)
  assert.equal((await putTo(ticket, PDF)).status, 200)
  const done = await post(`/runner/attachments/${ticket.id}/complete`, { sha256: sha256(PDF) })
  assert.equal(done.status, 200)
})

test(
  "another computer's thread or file, or a teammate not in it, is refused",
  { skip },
  async () => {
    const start = (body: Record<string, unknown>, as?: string) =>
      post(
        '/runner/attachments/uploads',
        { sessionId: threadId, name: 'a.pdf', size: 10, sha256: sha256(PDF), ...body },
        as,
      )
    assert.equal((await start({ sessionId: otherThreadId })).status, 404)
    assert.equal((await start({ teammateId: `nobody-${id}` })).status, 403)
    assert.equal((await start({ size: 26 * 1024 * 1024 })).status, 400)
    assert.equal((await start({ sha256: 'not-a-hash' })).status, 400)
    assert.equal((await start({}, 'unknown')).status, 401)
    // Its file, completed by the other computer's runner.
    const ticket = await startAttachment(PDF)
    assert.equal((await putTo(ticket, PDF)).status, 200)
    const done = await post(
      `/runner/attachments/${ticket.id}/complete`,
      { sha256: sha256(PDF) },
      otherToken,
    )
    assert.equal(done.status, 404)
  },
)

test('old runners still send the bytes to the API', { skip }, async () => {
  const answer = await call(
    `/runner/attachments?sessionId=${threadId}&teammateId=${teammateId}&name=old.pdf`,
    { method: 'POST', body: PDF },
  )
  assert.equal(answer.status, 201)
  const body = (await answer.json()) as { name: string; size: number; contentType: string }
  assert.equal(body.name, 'old.pdf')
  assert.equal(body.size, PDF.byteLength)
})

// Git backups (B7).

const backupPath = () => `/runner/backups/acme/site/${threadId}/${teammateId}/site`

async function uploadBundle(bytes: Uint8Array) {
  const answer = await post(`${backupPath()}/upload`, {
    size: bytes.byteLength,
    sha256: sha256(bytes),
  })
  assert.equal(answer.status, 200)
  const ticket = (await answer.json()) as { url: string; headers: Record<string, string> }
  assert.equal((await putTo(ticket, bytes)).status, 200)
}
const bundleKey = () =>
  repoBackupKey(scope, { repository: 'acme/site', sessionId: threadId, teammateId, folder: 'site' })

test('a backup bundle goes straight to the bucket, then is checked', { skip }, async () => {
  await uploadBundle(BUNDLE)
  const done = await post(`${backupPath()}/done`, {
    size: BUNDLE.byteLength,
    sha256: sha256(BUNDLE),
  })
  assert.equal(done.status, 200)
  assert.deepEqual(Buffer.from((await getObject(bundleKey()))!), Buffer.from(BUNDLE))
  const audited = await prisma.auditEntry.findFirst({
    where: { organizationId: ids.organization, action: 'repo.backed_up' },
  })
  assert.ok(audited)
  // And it is restored from there.
  const restored = await call(backupPath())
  assert.equal(restored.status, 200)
  assert.deepEqual(Buffer.from(await restored.arrayBuffer()), Buffer.from(BUNDLE))
})

test('what is not a git bundle, or not its SHA-256, is removed', { skip }, async () => {
  const notBundle = new Uint8Array(Buffer.from('#!/bin/sh\necho hello\n'))
  await uploadBundle(notBundle)
  const refused = await post(`${backupPath()}/done`, {
    size: notBundle.byteLength,
    sha256: sha256(notBundle),
  })
  assert.equal(refused.status, 400)
  assert.equal(await getObject(bundleKey()), null)

  await uploadBundle(BUNDLE)
  const wrong = await post(`${backupPath()}/done`, {
    size: BUNDLE.byteLength,
    sha256: sha256(PNG),
  })
  assert.equal(wrong.status, 400)
  assert.equal(await getObject(bundleKey()), null)

  const missing = await post(`${backupPath()}/done`, {
    size: BUNDLE.byteLength,
    sha256: sha256(BUNDLE),
  })
  assert.equal(missing.status, 409)
  // Another computer's thread.
  const other = await post(
    `${backupPath()}/upload`,
    { size: BUNDLE.byteLength, sha256: sha256(BUNDLE) },
    otherToken,
  )
  assert.equal(other.status, 404)
})

// A thread's images and PDFs (A3, B8).

const filePath = (bytes: Uint8Array, ext: string) =>
  `/runner/files/${threadId}/${sha256(bytes)}.${ext}`
async function putFile(path: string, bytes: Uint8Array) {
  const ticket = await post(`${path}/upload`, { size: bytes.byteLength })
  assert.equal(ticket.status, 200)
  // No R2 here: through the API itself.
  assert.deepEqual(await ticket.json(), { url: null })
  assert.equal((await call(path, { method: 'PUT', body: bytes })).status, 200)
}

test('an image and a PDF of a thread are checked once uploaded', { skip }, async () => {
  for (const [bytes, ext] of [
    [PNG, 'png'],
    [PDF, 'pdf'],
  ] as const) {
    const path = filePath(bytes, ext)
    await putFile(path, bytes)
    const done = await post(`${path}/complete`, { size: bytes.byteLength })
    assert.equal(done.status, 200)
  }
})

test("a file whose bytes are not its name's is removed", { skip }, async () => {
  // A PDF's bytes, named as the PNG it hashes to: wrong hash and wrong type.
  const path = filePath(PNG, 'png')
  await putFile(path, PDF)
  const done = await post(`${path}/complete`, { size: PDF.byteLength })
  assert.equal(done.status, 400)
  assert.equal(await getObject(threadFileKey(scope, threadId, `${sha256(PNG)}.png`)), null)
  const missing = await post(`${path}/complete`, { size: PDF.byteLength })
  assert.equal(missing.status, 409)
  // The right hash, but not the type its extension says.
  const misnamed = filePath(PDF, 'png')
  await putFile(misnamed, PDF)
  assert.equal((await post(`${misnamed}/complete`, { size: PDF.byteLength })).status, 400)
  // Another size than said.
  const pdf = filePath(PDF, 'pdf')
  await putFile(pdf, PDF)
  assert.equal((await post(`${pdf}/complete`, { size: PDF.byteLength + 1 })).status, 400)
})

// Folder archives (A4).

test('a folder archive that is not gzip is removed', { skip }, async () => {
  const path = `/runner/folders/${threadId}/${teammateId}`
  const key = folderArchiveKey(scope, { sessionId: threadId, teammateId })
  const notGzip = new Uint8Array(Buffer.from('not an archive at all'))
  await putObject(key, notGzip, 'application/gzip')
  const refused = await post(`${path}/done`, { size: notGzip.byteLength })
  assert.equal(refused.status, 409)
  assert.equal(await getObject(key), null)

  const gzip = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4])
  await putObject(key, gzip, 'application/gzip')
  assert.equal((await post(`${path}/done`, { size: gzip.byteLength })).status, 200)
})

// Editor assets (A2).

async function pendingAsset(name: string, contentType: string, bytes: Uint8Array) {
  const db = scoped(scope)
  const document = await db.document.create({
    data: {
      path: `notes-${randomUUID().slice(0, 6)}.md`,
      contentType: 'text/markdown',
      size: 10,
    } as never,
  })
  const row = await db.documentAsset.create({
    data: {
      documentId: document.id,
      name,
      contentType,
      size: bytes.byteLength,
      status: 'pending',
      uploadedByMemberId: ids.member,
    } as never,
  })
  await putObject(assetKey(scope, row.id), bytes, contentType)
  return row
}

test(
  "an asset's upload is read back: its SHA-256 kept, its type by its bytes",
  { skip },
  async () => {
    const db = scoped(scope)
    const image = await pendingAsset('shot.png', 'image/png', PNG)
    const ready = await finishAssetUpload(db, scope, image.id, ids.member)
    assert.equal(ready.status, 'ready')
    assert.equal(ready.sha256, sha256(PNG))
    assert.equal(ready.contentType, 'image/png')

    // Named a PNG, but a PDF's bytes: not shown inline as an image.
    const fake = await pendingAsset('fake.png', 'image/png', PDF)
    const sniffed = await finishAssetUpload(db, scope, fake.id, ids.member)
    assert.equal(sniffed.contentType, 'application/octet-stream')

    // Another size than announced: removed.
    const short = await pendingAsset('short.png', 'image/png', PNG)
    await db.documentAsset.update({ where: { id: short.id }, data: { size: PNG.byteLength + 5 } })
    await assert.rejects(finishAssetUpload(db, scope, short.id, ids.member), { status: 400 })
    assert.equal(await getObject(assetKey(scope, short.id)), null)
    assert.equal(await prisma.documentAsset.findUnique({ where: { id: short.id } }), null)
  },
)
