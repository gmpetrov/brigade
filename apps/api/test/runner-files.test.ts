import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import pg from 'pg'

// The images a reply shows, put in the thread's bucket folder by its runner
// (src/routes/runner-files.ts), against a real database: the local one of apps/api/.env,
// in an organization of its own that it removes at the end. Without a database to
// reach, it is skipped. No R2 here: the image goes through the API, as in development.
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
process.env.BUCKET_DIR = mkdtempSync(join(tmpdir(), 'runner-files-'))

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select "computerId" from "Runner" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { prisma } = await import('../src/db.js')
const { hashToken } = await import('../src/hub.js')
const { getObject, threadFileKey } = await import('../src/bucket.js')
const { runnerFiles } = await import('../src/routes/runner-files.js')

const id = randomUUID().slice(0, 8)
const ids = {
  organization: `org-files-${id}`,
  user: `user-files-${id}`,
  member: `mem-files-${id}`,
}
const token = `runner-token-${id}`
const otherToken = `other-runner-token-${id}`
let scope: { organizationId: string; workspaceId: string }
let threadId: string

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(100, 1),
])
const name = `${createHash('sha256').update(PNG).digest('hex')}.png`

before(async () => {
  if (skip) return
  await prisma.organization.create({
    data: { id: ids.organization, name: 'Files test', slug: ids.organization },
  })
  await prisma.user.create({
    data: { id: ids.user, name: 'Ada', email: `${ids.user}@example.com` },
  })
  await prisma.member.create({
    data: { id: ids.member, organizationId: ids.organization, userId: ids.user, role: 'owner' },
  })
  const workspace = await prisma.workspace.create({
    data: { organizationId: ids.organization, name: 'Files test' },
  })
  scope = { organizationId: ids.organization, workspaceId: workspace.id }
  const teammate = await prisma.teammate.create({ data: { ...scope, name: 'Riley' } })
  const computers = []
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
    computers.push(computer)
  }
  const thread = await prisma.session.create({
    data: {
      ...scope,
      startedByMemberId: ids.member,
      computerId: computers[0]!.id,
      teammateId: teammate.id,
      title: 'Images',
      status: 'idle',
      origin: 'member',
    } as never,
  })
  threadId = thread.id
})

after(async () => {
  if (skip) return
  await prisma.organization.deleteMany({ where: { id: ids.organization } })
  await prisma.user.deleteMany({ where: { id: ids.user } })
  await prisma.$disconnect()
})

const call = (path: string, init: RequestInit & { as?: string } = {}) =>
  runnerFiles.request(path, {
    ...init,
    headers: { authorization: `Bearer ${init.as ?? token}`, ...init.headers },
  })
const ticket = (path: string, size: number, as?: string) =>
  call(`${path}/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ size }),
    ...(as ? { as } : {}),
  })

test(
  "the thread's runner puts a reply's image in the thread's bucket folder",
  { skip },
  async () => {
    const path = `/${threadId}/${name}`
    const answer = await ticket(path, PNG.length)
    assert.equal(answer.status, 200)
    // No R2 here: through the API itself.
    assert.deepEqual(await answer.json(), { url: null })
    const put = await call(path, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: new Uint8Array(PNG),
    })
    assert.equal(put.status, 200)
    const stored = await getObject(threadFileKey(scope, threadId, name))
    assert.deepEqual(Buffer.from(stored!), PNG)
  },
)

test('another computer, a bad name, a PDF or a deleted thread is refused', { skip }, async () => {
  assert.equal((await ticket(`/${threadId}/${name}`, PNG.length, otherToken)).status, 404)
  assert.equal((await ticket(`/${threadId}/shot.png`, PNG.length)).status, 400)
  assert.equal((await ticket(`/${threadId}/${name.replace('.png', '.pdf')}`, 10)).status, 400)
  assert.equal((await ticket(`/${threadId}/${name}`, 11 * 1024 * 1024)).status, 400)
  assert.equal((await ticket(`/missing-${id}/${name}`, PNG.length)).status, 410)
  assert.equal((await ticket(`/${threadId}/${name}`, PNG.length, 'unknown')).status, 401)
})
