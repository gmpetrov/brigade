import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { Hono } from 'hono'
import pg from 'pg'

// Files uploaded straight to the bucket, then checked and used by their id (src/uploads.ts):
// a member's (routes/uploads.ts, then the library, a design's picture, a skill import, a
// logo) and a runner's (routes/runner-uploads.ts, then library.call). Against a real
// database: the local one of apps/api/.env, in an organization of its own that it removes
// at the end. Without a database to reach, it is skipped. No R2 here: the bytes go to the
// API's stand-in (routes/bucket.ts), PUT at the signed path a ticket gives, as they would
// to R2's signed URL.
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
process.env.BUCKET_DIR = mkdtempSync(join(tmpdir(), 'direct-uploads-'))

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select "purpose" from "Upload" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { prisma, scoped } = await import('../src/db.js')
const { auth } = await import('../src/auth.js')
const { hashToken } = await import('../src/hub.js')
const { objectSize, putObject, skillFileKey, uploadKey, workspaceLogoKey } =
  await import('../src/bucket.js')
const { fileKey } = await import('../src/library-objects.js')
const { localBucket } = await import('../src/routes/bucket.js')
const { uploads } = await import('../src/routes/uploads.js')
const { library } = await import('../src/routes/library.js')
const { designs } = await import('../src/routes/designs.js')
const { skills } = await import('../src/routes/skills.js')
const { runnerUploads } = await import('../src/routes/runner-uploads.js')
const { handleLibraryCall } = await import('../src/library-calls.js')
const { readSkills, readSkillsStream } = await import('../src/skill-import.js')
const { decideSkillProposal } = await import('../src/skills.js')
const { readLogo } = await import('../src/logos.js')
const { updateWorkspace } = await import('../src/workspace-settings.js')
const { search } = await import('../src/library.js')

const id = randomUUID().slice(0, 8)
const ids = { organization: `org-up-${id}`, user: `user-up-${id}`, member: `mem-up-${id}` }
const token = `runner-token-up-${id}`
let scope: Parameters<typeof updateWorkspace>[0]
let seat: { sessionId: string; teammateId: string; computerId: string }

// A member signed in, without a cookie: the session is the test's.
const realGetSession = auth.api.getSession
const app = new Hono()
  .route('/api/bucket', localBucket)
  .route('/api/uploads', uploads)
  .route('/api/library', library)
  .route('/api/designs', designs)
  .route('/api/skills', skills)
  .route('/runner/uploads', runnerUploads)

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})
const runner = { authorization: `Bearer ${token}` }

/** Start, PUT and complete an upload as the member; the completion's response. */
async function upload(
  purpose: string,
  name: string,
  bytes: Uint8Array,
  contentType = '',
  { size = bytes.byteLength, sha256 }: { size?: number; sha256?: string } = {},
) {
  const start = await app.request(
    '/api/uploads',
    json({ purpose, name, size, contentType, ...(sha256 ? { sha256 } : {}) }),
  )
  assert.equal(start.status, 201, await start.clone().text())
  const ticket = (await start.json()) as {
    id: string
    url: string
    headers: Record<string, string>
  }
  const put = await app.request(ticket.url, {
    method: 'PUT',
    headers: ticket.headers,
    body: bytes,
  })
  return {
    id: ticket.id,
    put,
    complete: () => app.request(`/api/uploads/${ticket.id}/complete`, { method: 'POST' }),
  }
}
/** Whether an upload can still be used: one used, refused or discarded is kept a while, blocked. */
const usable = async (id: string) =>
  ((await prisma.upload.findUnique({ where: { id } }))?.status ?? 'blocked') !== 'blocked'

async function ready(purpose: string, name: string, bytes: Uint8Array, contentType = '') {
  const u = await upload(purpose, name, bytes, contentType)
  assert.equal(u.put.status, 200)
  const done = await u.complete()
  assert.equal(done.status, 200, await done.clone().text())
  return u.id
}

before(async () => {
  if (skip) return
  await prisma.organization.create({
    data: { id: ids.organization, name: 'Uploads test', slug: ids.organization },
  })
  await prisma.user.create({
    data: { id: ids.user, name: 'Ada', email: `${ids.user}@example.com` },
  })
  await prisma.member.create({
    data: { id: ids.member, organizationId: ids.organization, userId: ids.user, role: 'owner' },
  })
  const workspace = await prisma.workspace.create({
    data: { organizationId: ids.organization, name: 'Uploads test' },
  })
  scope = {
    organizationId: ids.organization,
    workspaceId: workspace.id,
    userId: ids.user,
    memberId: ids.member,
    role: 'owner',
  }
  ;(auth.api as { getSession: unknown }).getSession = async () => ({
    user: { id: ids.user },
    session: {
      id: `session-${id}`,
      activeOrganizationId: ids.organization,
      activeWorkspaceId: workspace.id,
    },
  })
  const where = { organizationId: ids.organization, workspaceId: workspace.id }
  const teammate = await prisma.teammate.create({
    data: { ...where, name: 'Riley', libraryAccess: 'read_write' },
  })
  const computer = await prisma.computer.create({
    data: { ...where, kind: 'member_machine', memberId: ids.member, name: 'Laptop' },
  })
  await prisma.runner.create({
    data: { ...where, computerId: computer.id, tokenHash: hashToken(token) },
  })
  const thread = await prisma.session.create({
    data: {
      ...where,
      startedByMemberId: ids.member,
      computerId: computer.id,
      teammateId: teammate.id,
      title: 'Uploads',
      status: 'idle',
      origin: 'member',
    } as never,
  })
  await prisma.threadTeammate.create({
    data: { ...where, sessionId: thread.id, teammateId: teammate.id },
  })
  seat = { sessionId: thread.id, teammateId: teammate.id, computerId: computer.id }
})

after(async () => {
  ;(auth.api as { getSession: unknown }).getSession = realGetSession
  if (skip) return
  await prisma.upload.deleteMany({ where: { organizationId: ids.organization } })
  await prisma.libraryObject.deleteMany({ where: { organizationId: ids.organization } })
  await prisma.organization.deleteMany({ where: { id: ids.organization } })
  await prisma.user.deleteMany({ where: { id: ids.user } })
  await prisma.$disconnect()
})

test('an upload is started, PUT to its signed URL, then checked', { skip }, async () => {
  const bytes = strToU8('# Notes\n\nzanzibar quokka\n')
  const u = await upload('library', 'Notes/one.md', bytes, 'text/markdown')
  assert.equal(u.put.status, 200)
  // Not usable before it is complete.
  const early = await app.request(
    '/api/library/files',
    json({ path: 'Notes/one.md', uploadId: u.id }),
  )
  assert.equal(early.status, 409)
  const done = await u.complete()
  assert.equal(done.status, 200)
  const info = (await done.json()) as { sha256: string; size: number; contentType: string }
  assert.equal(info.sha256, sha(bytes))
  assert.equal(info.size, bytes.byteLength)
  const row = await prisma.upload.findUniqueOrThrow({ where: { id: u.id } })
  assert.equal(row.status, 'ready')
  assert.match(row.text, /zanzibar quokka/)
})

test('a completion that does not match the file is refused and removed', { skip }, async () => {
  const bytes = strToU8('hello')
  // A SHA-256 given at start that the bytes do not bear out.
  const wrongHash = await upload('library', 'a.txt', bytes, 'text/plain', {
    sha256: sha(strToU8('other')),
  })
  assert.equal(wrongHash.put.status, 200)
  assert.equal((await wrongHash.complete()).status, 400)
  assert.equal(await usable(wrongHash.id), false)
  assert.equal(await objectSize(uploadKey(scope, wrongHash.id)), null)

  // Other bytes than it started with, put at its key behind the signed URL's back.
  const wrongSize = await upload('library', 'b.txt', bytes, 'text/plain')
  await putObject(uploadKey(scope, wrongSize.id), strToU8('hello, longer'), 'text/plain')
  assert.equal((await wrongSize.complete()).status, 400)
  assert.equal(await usable(wrongSize.id), false)

  // The signed URL takes exactly its size.
  const short = await upload('library', 'c.txt', bytes, 'text/plain', { size: 10 })
  assert.equal(short.put.status, 400)
  assert.equal((await short.complete()).status, 409)
})

test('the library saves an upload, with a version, once for the same bytes', { skip }, async () => {
  const bytes = strToU8('# Plan\n\nplatypus orbit\n')
  const first = await ready('library', 'Plans/plan.md', bytes, 'text/markdown')
  const saved = await app.request(
    '/api/library/files',
    json({ path: 'Plans/plan.md', uploadId: first }),
  )
  assert.equal(saved.status, 201, await saved.clone().text())
  const file = (await saved.json()) as { id: string; size: number }
  assert.equal(file.size, bytes.byteLength)
  const doc = await prisma.document.findUniqueOrThrow({ where: { id: file.id } })
  assert.equal(doc.sha256, sha(bytes))
  assert.equal(await objectSize(fileKey(scope, doc)), bytes.byteLength)
  // A version, pointing to the object the upload was copied to inside the bucket.
  const versions = await prisma.documentVersion.findMany({ where: { documentId: file.id } })
  assert.equal(versions.length, 1)
  assert.ok(doc.objectKey)
  assert.equal(versions[0]!.objectKey, doc.objectKey)
  assert.ok(existsSync(join(process.env.BUCKET_DIR!, doc.objectKey)))
  // The upload is gone once used.
  assert.equal(await usable(first), false)
  assert.equal(await objectSize(uploadKey(scope, first)), null)
  // Its text is searchable.
  const hits = await search(scope, { query: 'platypus', limit: 5, memberId: ids.member })
  assert.ok(
    hits.some((h) => (h as { path?: string }).path === 'Plans/plan.md'),
    JSON.stringify(hits),
  )

  // The same bytes again: nothing new.
  const again = await ready('library', 'Plans/plan.md', bytes, 'text/markdown')
  const resaved = await app.request(
    '/api/library/files',
    json({ path: 'Plans/plan.md', uploadId: again }),
  )
  assert.equal(resaved.status, 201)
  assert.equal(await prisma.documentVersion.count({ where: { documentId: file.id } }), 1)

  // Someone else's upload, or one for another purpose, is not found.
  const logo = await ready('logo', 'logo.png', PNG)
  const wrong = await app.request('/api/library/files', json({ path: 'x.png', uploadId: logo }))
  assert.equal(wrong.status, 404)
})

const PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...new Array(64).fill(1),
])

test("a design's picture is saved from an upload, a PNG only", { skip }, async () => {
  const db = scoped(scope)
  const { saveLibraryFile } = await import('../src/library.js')
  await saveLibraryFile(
    db,
    scope,
    { type: 'member', id: ids.member },
    {
      path: 'Designs/home.design/index.html',
      bytes: strToU8('<html></html>'),
    },
  )
  const png = await ready('library', 'thumbnail.png', PNG)
  const put = (body: unknown) =>
    app.request('/api/designs/thumbnail', { ...json(body), method: 'PUT' })
  assert.equal((await put({ path: 'Designs/home.design', uploadId: png })).status, 204)
  const thumb = await prisma.document.findFirstOrThrow({
    where: { path: 'Designs/home.design/thumbnail.png', organizationId: ids.organization },
  })
  assert.equal(thumb.sha256, sha(PNG))
  assert.equal(thumb.contentType, 'image/png')

  const fake = await ready('library', 'thumbnail.png', strToU8('not a png at all'))
  assert.equal((await put({ path: 'Designs/home.design', uploadId: fake })).status, 400)
  assert.equal(await usable(fake), false)
  // Not a design folder.
  const other = await ready('library', 'thumbnail.png', PNG)
  assert.equal((await put({ path: 'Plans', uploadId: other })).status, 400)
  // Both, or neither: refused.
  assert.equal((await put({ path: 'Designs/home.design' })).status, 400)
})

test('a skill pack is read from an upload as it streams, as from its bytes', { skip }, async () => {
  const zip = zipSync({
    'skills/pdf/SKILL.md': strToU8('---\nname: pdf\ndescription: Read PDFs\n---\nRead them.'),
    'skills/pdf/scripts/read.py': strToU8('print(1)'),
    'skills/pdf/.DS_Store': strToU8('x'),
    'skills/pdf/empty.txt': new Uint8Array(0),
    'skills/notes/SKILL.md': strToU8('---\ndescription: Take notes\n---\nWrite them.'),
    'skills/notes/big.bin': new Uint8Array(10 * 1024 * 1024 + 1),
  })
  const streamed = await readSkillsStream('pack.zip', new Response(zip).body!)
  const whole = readSkills('pack.zip', zip)
  const strip = (found: typeof whole) =>
    found.map((f) => ({ ...f, files: f.files.map((x) => ({ path: x.path, sha: sha(x.bytes) })) }))
  assert.deepEqual(strip(streamed), strip(whole))
  assert.deepEqual(whole.find((f) => f.name === 'notes')!.skipped, ['big.bin'])

  const uploadId = await ready('skill_pack', 'pack.zip', zip, 'application/zip')
  const response = await app.request('/api/skills/import/upload', json({ uploadId }))
  assert.equal(response.status, 200, await response.clone().text())
  const preview = (await response.json()) as {
    skills: { name: string; files: { path: string; sha256: string }[]; skipped: string[] }[]
  }
  const pdf = preview.skills.find((s) => s.name === 'pdf')!
  assert.deepEqual(pdf.files.map((f) => f.path).sort(), ['empty.txt', 'scripts/read.py'])
  const script = pdf.files.find((f) => f.path === 'scripts/read.py')!
  assert.equal(await objectSize(skillFileKey(scope, script.sha256)), 8)
  assert.deepEqual(preview.skills.find((s) => s.name === 'notes')!.skipped, ['big.bin'])
  assert.equal(await usable(uploadId), false)

  // A lone SKILL.md.
  const md = await ready(
    'skill_pack',
    'triage.md',
    strToU8('---\ndescription: Sort\n---\nSort them.'),
  )
  const lone = await app.request('/api/skills/import/upload', json({ uploadId: md }))
  assert.equal(lone.status, 200)
  assert.equal(((await lone.json()) as { skills: { name: string }[] }).skills[0]!.name, 'triage')
})

test('a zip that unpacks past the limit is refused', { skip }, async () => {
  // About 60 MB of zeros, compressed to little: a zip bomb's shape.
  const zeros = new Uint8Array(6 * 1024 * 1024)
  const files: Record<string, Uint8Array> = {
    'a/SKILL.md': strToU8('---\ndescription: A\n---\nA.'),
  }
  for (let i = 0; i < 10; i++) files[`a/f${i}.bin`] = zeros
  const zip = zipSync(files, { level: 9 })
  await assert.rejects(
    readSkillsStream('bomb.zip', new Response(zip).body!),
    (e: Error & { status?: number }) => {
      assert.equal(e.status, 413)
      return true
    },
  )
})

test('a logo is kept from an upload, by the type its bytes bear out', { skip }, async () => {
  const logo = await ready('logo', 'logo.png', PNG)
  const workspace = await updateWorkspace(scope, { logo: `upload:${logo}` })
  assert.match(workspace.logo!, /\.png$/)
  const kept = await readLogo(workspaceLogoKey(scope, workspace.logo!), workspace.logo!)
  assert.equal(sha(kept!.bytes), sha(PNG))
  assert.equal(await usable(logo), false)

  const text = await ready('logo', 'logo.png', strToU8('hello, not an image'))
  await assert.rejects(updateWorkspace(scope, { logo: `upload:${text}` }), /PNG, JPEG/)
  assert.equal(await usable(text), false)
  await assert.rejects(updateWorkspace(scope, { logo: 'upload:nope' }), /Upload not found/)
})

/** Start, PUT and complete an upload as the runner. */
async function runnerUpload(purpose: string, name: string, bytes: Uint8Array, sha256 = sha(bytes)) {
  const start = await app.request(
    '/runner/uploads',
    json(
      {
        purpose,
        sessionId: seat.sessionId,
        teammateId: seat.teammateId,
        name,
        size: bytes.byteLength,
        sha256,
      },
      runner,
    ),
  )
  assert.equal(start.status, 201, await start.clone().text())
  const ticket = (await start.json()) as {
    id: string
    url: string
    headers: Record<string, string>
  }
  assert.equal(
    (await app.request(ticket.url, { method: 'PUT', headers: ticket.headers, body: bytes })).status,
    200,
  )
  return {
    id: ticket.id,
    complete: await app.request(`/runner/uploads/${ticket.id}/complete`, {
      method: 'POST',
      headers: runner,
    }),
  }
}

const libraryCall = (operation: unknown) =>
  new Promise<{ ok: boolean; output?: unknown; error?: string }>((resolve, reject) => {
    handleLibraryCall(
      {
        computerId: seat.computerId,
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
      },
      {
        type: 'library.call',
        callId: randomUUID(),
        sessionId: seat.sessionId,
        teammateId: seat.teammateId,
        operation,
      } as never,
      (reply) => resolve(reply as never),
    ).catch(reject)
  })

test("a runner's library file is uploaded, checked, then saved by its id", { skip }, async () => {
  const bytes = strToU8('Report: wombat ledger\n')
  const wrong = await runnerUpload('library', 'Reports/r.txt', bytes, sha(strToU8('other')))
  assert.equal(wrong.complete.status, 400)

  const { id: uploadId, complete } = await runnerUpload('library', 'Reports/r.txt', bytes)
  assert.equal(complete.status, 200)
  const reply = await libraryCall({ name: 'save', path: 'Reports/r.txt', upload: { id: uploadId } })
  assert.equal(reply.ok, true, reply.error)
  const doc = await prisma.document.findFirstOrThrow({
    where: { path: 'Reports/r.txt', organizationId: ids.organization },
  })
  assert.equal(doc.sha256, sha(bytes))
  assert.equal(doc.updatedInSessionId, seat.sessionId)
  assert.equal(await usable(uploadId), false)
  // Used once.
  const again = await libraryCall({ name: 'save', path: 'Reports/r.txt', upload: { id: uploadId } })
  assert.equal(again.ok, false)
})

test(
  "a skill proposal names files its runner uploaded; approved, they are the skill's",
  { skip },
  async () => {
    const script = strToU8('echo hi\n')
    const { complete } = await runnerUpload('skill_file', 'run.sh', script)
    assert.equal(complete.status, 200)
    assert.equal(await objectSize(skillFileKey(scope, sha(script))), script.byteLength)

    const skill = { name: 'greet', description: 'Say hi', instructions: 'Run run.sh.', files: [] }
    const missing = await libraryCall({
      name: 'skill_proposal',
      proposal: { skill, refs: [{ path: 'other.sh', sha256: sha(strToU8('nope')), size: 4 }] },
    })
    assert.equal(missing.ok, false)
    assert.match(missing.error!, /other\.sh was not uploaded/)

    const proposed = await libraryCall({
      name: 'skill_proposal',
      proposal: { skill, refs: [{ path: 'run.sh', sha256: sha(script), size: script.byteLength }] },
    })
    assert.equal(proposed.ok, true, proposed.error)
    const { ticketId } = proposed.output as { ticketId: string }
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })
    await decideSkillProposal(scoped(scope), scope, ticket, true)
    const saved = await prisma.skill.findFirstOrThrow({
      where: { name: 'greet', organizationId: ids.organization },
    })
    assert.deepEqual(saved.files, [
      { path: 'run.sh', sha256: sha(script), size: script.byteLength },
    ])
  },
)

test(
  'a PUT replayed after completion changes nothing that was checked, and the sweep removes it',
  { skip },
  async () => {
    const original = strToU8('trusted text')
    const replacement = strToU8('changed text')
    const start = await app.request(
      '/api/uploads',
      json({ purpose: 'library', name: 'replay.txt', size: original.length }),
    )
    const ticket = (await start.json()) as {
      id: string
      url: string
      headers: Record<string, string>
    }
    const put = (body: Uint8Array) =>
      app.request(ticket.url, { method: 'PUT', headers: ticket.headers, body })
    assert.equal((await put(original)).status, 200)
    assert.equal(
      (await app.request(`/api/uploads/${ticket.id}/complete`, { method: 'POST' })).status,
      200,
    )
    // The signed URL still works for a while: a replay lands, but not where the checked bytes are.
    assert.equal((await put(replacement)).status, 200)
    const saved = await app.request(
      '/api/library/files',
      json({ path: 'replay.txt', uploadId: ticket.id }),
    )
    assert.equal(saved.status, 201, await saved.clone().text())
    const row = await scoped(scope).document.findFirstOrThrow({ where: { path: 'replay.txt' } })
    const { getObject } = await import('../src/bucket.js')
    assert.equal(row.sha256, sha(original))
    assert.equal(sha((await getObject(fileKey(scope, row)))!), sha(original))
    // Used: its row stays, refused for another use, until its URL no longer works.
    const used = await scoped(scope).upload.findFirstOrThrow({ where: { id: ticket.id } })
    assert.equal(used.status, 'blocked')
    const again = await app.request(
      '/api/library/files',
      json({ path: 'replay-2.txt', uploadId: ticket.id }),
    )
    assert.equal(again.status, 409)
    assert.equal((await put(replacement)).status, 200)
    // Past the URL's life, the sweep removes what the late PUT left, then the row.
    await prisma.upload.update({
      where: { id: ticket.id },
      data: { createdAt: new Date(Date.now() - 16 * 60_000) },
    })
    const { sweepFileUploads } = await import('../src/uploads.js')
    await sweepFileUploads()
    assert.equal(await objectSize(uploadKey(scope, ticket.id)), null)
    assert.equal(await scoped(scope).upload.count({ where: { id: ticket.id } }), 0)
  },
)

test('bytes changed between their check and their copy are refused', { skip }, async () => {
  const { copyObject, openObject, putObject } = await import('../src/bucket.js')
  await putObject('org-x/ws-x/uploads/raced', strToU8('first'), 'text/plain')
  const read = await openObject('org-x/ws-x/uploads/raced')
  await read!.body.cancel()
  await new Promise((resolve) => setTimeout(resolve, 5))
  await putObject('org-x/ws-x/uploads/raced', strToU8('other'), 'text/plain')
  assert.equal(
    await copyObject('org-x/ws-x/uploads/raced', 'org-x/ws-x/uploads-checked/raced', undefined, {
      ifMatch: read!.etag,
    }),
    false,
  )
  assert.equal(await objectSize('org-x/ws-x/uploads-checked/raced'), null)
})

test('saves that overlap keep each version the bytes its hash names', { skip }, async () => {
  const { saveLibraryFile } = await import('../src/library.js')
  const { getObject } = await import('../src/bucket.js')
  const { versionBytesKey } = await import('../src/library-objects.js')
  const { readyUpload, uploadBytesKey } = await import('../src/uploads.js')
  const db = scoped(scope)
  const actor = { type: 'member' as const, id: ids.member }
  await saveLibraryFile(db, scope, actor, { path: 'race.txt', bytes: strToU8('initial') })
  const a = await readyUpload(
    db,
    { memberId: ids.member },
    await ready('library', 'race.txt', strToU8('version A')),
    'library',
  )
  const b = await readyUpload(
    db,
    { memberId: ids.member },
    await ready('library', 'race.txt', strToU8('version B')),
    'library',
  )
  // B is saved between A's commit and A's version.
  let raced = false
  const racing = new Proxy(db, {
    get(target, prop) {
      if (prop !== 'documentVersion') return Reflect.get(target, prop)
      return new Proxy(target.documentVersion, {
        get(model, key) {
          if (key !== 'findFirst') return Reflect.get(model, key)
          return async (args: { orderBy?: unknown }) => {
            if (args.orderBy && !raced) {
              raced = true
              await saveLibraryFile(db, scope, actor, {
                path: 'race.txt',
                upload: { key: uploadBytesKey(scope, b), ...b },
              })
            }
            return model.findFirst(args as never)
          }
        },
      })
    },
  })
  await saveLibraryFile(racing, scope, actor, {
    path: 'race.txt',
    upload: { key: uploadBytesKey(scope, a), ...a },
  })
  const row = await db.document.findFirstOrThrow({ where: { path: 'race.txt' } })
  const versions = await db.documentVersion.findMany({ where: { documentId: row.id } })
  assert.ok(raced)
  assert.ok(versions.length >= 1)
  for (const v of versions)
    assert.equal(sha((await getObject(versionBytesKey(scope, v)))!), v.sha256)
  assert.equal(sha((await getObject(fileKey(scope, row)))!), row.sha256)
})

test(
  'completions that overlap: the ready upload names the very bytes it checked',
  { skip },
  async () => {
    const { completeFileUpload, readyUpload, uploadBytesKey } = await import('../src/uploads.js')
    const { getObject, listObjects, checkedUploadsPrefix } = await import('../src/bucket.js')
    const db = scoped(scope)
    const owner = { memberId: ids.member }
    const first = strToU8('version one')
    const start = await app.request(
      '/api/uploads',
      json({ purpose: 'library', name: 'two.txt', size: first.length }),
    )
    const ticket = (await start.json()) as {
      id: string
      url: string
      headers: Record<string, string>
    }
    const put = (body: Uint8Array) =>
      app.request(ticket.url, { method: 'PUT', headers: ticket.headers, body })
    assert.equal((await put(first)).status, 200)
    // A has checked and copied the first bytes; before it marks the upload ready, the URL is
    // replayed with others of the same size and B checks, copies and marks those.
    const pausing = new Proxy(db, {
      get(target, prop) {
        if (prop !== 'upload') return Reflect.get(target, prop)
        return new Proxy(target.upload, {
          get(model, key) {
            if (key !== 'updateMany') return Reflect.get(model, key)
            return async (args: never) => {
              await put(strToU8('version two'))
              await completeFileUpload(db, scope, owner, ticket.id)
              return model.updateMany(args)
            }
          },
        })
      },
    })
    await completeFileUpload(pausing, scope, owner, ticket.id)
    const row = await readyUpload(db, owner, ticket.id, 'library')
    assert.equal(row.sha256, sha(strToU8('version two')))
    assert.equal(sha((await getObject(uploadBytesKey(scope, row)))!), row.sha256)
    // A's copy is not left behind.
    assert.deepEqual(await listObjects(checkedUploadsPrefix(scope, ticket.id)), [
      uploadBytesKey(scope, row),
    ])
  },
)

test('the sweep removes upload bytes no row names, whenever they landed', { skip }, async () => {
  const { sweepOrphanUploads } = await import('../src/uploads.js')
  const { checkedUploadKey } = await import('../src/bucket.js')
  // A slow PUT that finished after its row was swept, and a checked copy whose delete failed.
  await putObject(uploadKey(scope, 'gone1'), strToU8('late'), 'text/plain')
  await putObject(checkedUploadKey(scope, 'gone2', 'a1'), strToU8('left'), 'text/plain')
  // An upload under way keeps its bytes.
  const live = await ready('library', 'live.txt', strToU8('still here'))
  const row = await prisma.upload.findUniqueOrThrow({ where: { id: live } })
  await sweepOrphanUploads()
  assert.equal(await objectSize(uploadKey(scope, 'gone1')), null)
  assert.equal(await objectSize(checkedUploadKey(scope, 'gone2', 'a1')), null)
  assert.equal(await objectSize(checkedUploadKey(scope, live, row.checked)), 'still here'.length)
})
