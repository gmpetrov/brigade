import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import { sessionStub } from './session-stub.js'

// One library file by its id (GET /library/:id), which the dashboard's file panel reads to know
// how to show a file it has only the id of: as the list shows it, 404 in the trash or in another
// workspace, and the routes beside it (the tree, a file's versions) still theirs. Against the
// API's development database (apps/api/.env), in an organization of its own removed at the end;
// skipped when no database answers.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL || undefined
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
process.env.BUCKET_DIR = mkdtempSync(join(tmpdir(), 'library-file-'))

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1 from "Document" limit 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

const { Hono } = await import('hono')
const { HTTPException } = await import('hono/http-exception')
const { auth } = await import('../src/auth.js')
const library = await import('../src/library.js')
const { library: libraryRoutes } = await import('../src/routes/library.js')

const app = new Hono()
app.route('/api/library', libraryRoutes)
app.onError((error, c) =>
  error instanceof HTTPException
    ? c.json({ error: error.message }, error.status)
    : c.json({ error: String(error) }, 500),
)

const run = randomUUID().slice(0, 8)
const org = `org-file-${run}`
const member = `m-file-${run}`
const user = `u-file-${run}`
const getSession = auth.api.getSession
const call = (path: string) => app.request(path)

describe('one library file', { skip: !database && 'no database answers' }, () => {
  let workspaceId: string
  const files = {} as Record<'doc' | 'csv' | 'png' | 'trashed' | 'elsewhere', string>
  const encode = (text: string) => new TextEncoder().encode(text)

  before(async () => {
    await prisma.organization.create({ data: { id: org, name: 'File', slug: org } })
    await prisma.user.create({ data: { id: user, name: 'Ada', email: `${user}@example.com` } })
    await prisma.member.create({
      data: { id: member, organizationId: org, userId: user, role: 'member' },
    })
    workspaceId = (await prisma.workspace.create({ data: { organizationId: org, name: 'Acme' } }))
      .id
    const otherWorkspaceId = (
      await prisma.workspace.create({ data: { organizationId: org, name: 'Other' } })
    ).id
    const scope = { organizationId: org, workspaceId }
    const db = scoped(scope)
    const actor = { type: 'member' as const, id: member }
    const save = async (path: string, bytes: Uint8Array, contentType?: string) =>
      (await library.saveLibraryFile(db, scope, actor, { path, bytes, contentType })).id
    files.doc = await save('Sales/proposal.md', encode('# Proposal\n'))
    files.csv = await save('Sales/numbers.csv', encode('a,b\n1,2\n'))
    files.png = await save('Brand/logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png')
    files.trashed = await save('Sales/old.md', encode('# Old\n'))
    await db.document.update({ where: { id: files.trashed }, data: { deletedAt: new Date() } })
    const elsewhere = { organizationId: org, workspaceId: otherWorkspaceId }
    files.elsewhere = (
      await library.saveLibraryFile(scoped(elsewhere), elsewhere, actor, {
        path: 'secret.md',
        bytes: encode('# Secret'),
      })
    ).id
    ;(auth.api as { getSession: unknown }).getSession = sessionStub(() => ({
      user: { id: user },
      session: { id: `s-file-${run}`, activeOrganizationId: org, activeWorkspaceId: workspaceId },
    }))
  })

  after(async () => {
    ;(auth.api as { getSession: unknown }).getSession = getSession
    await prisma.workspace.deleteMany({ where: { organizationId: org } })
    await prisma.libraryObjectFolder.deleteMany({ where: { organizationId: org } })
    await prisma.libraryObject.deleteMany({ where: { organizationId: org } })
    await prisma.auditEntry.deleteMany({ where: { organizationId: org } })
    await prisma.member.deleteMany({ where: { organizationId: org } })
    await prisma.organization.deleteMany({ where: { id: org } })
    await prisma.user.deleteMany({ where: { id: user } })
  })

  test('a file reads as the list shows it', async () => {
    const listed = (await (await call('/api/library')).json()) as { id: string }[]
    for (const id of [files.doc, files.csv, files.png]) {
      const response = await call(`/api/library/${id}`)
      assert.equal(response.status, 200)
      assert.deepEqual(
        await response.json(),
        listed.find((f) => f.id === id),
      )
    }
    const [doc, csv, png] = await Promise.all(
      [files.doc, files.csv, files.png].map(async (id) =>
        (await call(`/api/library/${id}`)).json(),
      ),
    )
    assert.deepEqual(
      [doc, csv, png].map((f) => {
        const { path, contentType, editable } = f as Record<string, unknown>
        return { path, contentType, editable }
      }),
      [
        { path: 'Sales/proposal.md', contentType: 'text/markdown', editable: true },
        { path: 'Sales/numbers.csv', contentType: 'text/csv', editable: true },
        { path: 'Brand/logo.png', contentType: 'image/png', editable: false },
      ],
    )
    assert.equal((doc as { createdBy: { name: string } }).createdBy.name, 'Ada')
  })

  test('a file in the trash, in another workspace or unknown: not found', async () => {
    for (const id of [files.trashed, files.elsewhere, 'nope']) {
      const response = await call(`/api/library/${id}`)
      assert.equal(response.status, 404, id)
      assert.deepEqual(await response.json(), { error: 'File not found' })
    }
  })

  test('the routes beside it stay theirs', async () => {
    const tree = await call('/api/library/tree')
    assert.equal(tree.status, 200)
    assert.ok(Array.isArray(((await tree.json()) as { files: unknown[] }).files))
    const versions = await call(`/api/library/${files.doc}/versions`)
    assert.equal(versions.status, 200)
    assert.ok(Array.isArray(await versions.json()))
  })
})
