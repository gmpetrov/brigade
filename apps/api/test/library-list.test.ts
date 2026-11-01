import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'

// The library as the dashboard lists it (GET /library and /library/tree), against the API's
// development database (apps/api/.env), in an organization of its own removed at the end; skipped
// when no database answers. A listing reads only the columns a listed file is made from: before,
// it read every file's `text` too, which no list shows, and the dashboard lists the library again
// on each of its changes. Here a listing from those columns is the one from whole rows.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL || undefined
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
process.env.BUCKET_DIR = mkdtempSync(join(tmpdir(), 'library-list-'))

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1 from "Document" limit 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

describe('library listing', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<'org' | 'user' | 'member' | 'workspace', string>
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }
  let library: typeof import('../src/library.js')

  before(async () => {
    library = await import('../src/library.js')
    ids.org = `org-list-${suffix}`
    ids.user = `user-list-${suffix}`
    ids.member = `m-list-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'List', slug: `list-${suffix}` },
    })
    await prisma.user.create({
      data: { id: ids.user, name: 'Ada', email: `${ids.user}@test.local` },
    })
    await prisma.member.create({
      data: { id: ids.member, organizationId: ids.org, userId: ids.user, role: 'owner' },
    })
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'List' } })
    ).id
    scope = { organizationId: ids.org, workspaceId: ids.workspace }
    db = scoped(scope)
  })

  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.libraryObjectFolder.deleteMany({ where: { organizationId: ids.org } })
    await prisma.libraryObject.deleteMany({ where: { organizationId: ids.org } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({ where: { id: ids.user } })
  })

  test('a listing reads no text, and lists files as whole rows do', async () => {
    const actor = { type: 'member' as const, id: ids.member }
    const encode = (text: string) => new TextEncoder().encode(text)
    await library.saveLibraryFile(db, scope, actor, {
      path: 'Projects/Notes/plan.md',
      bytes: encode('# Plan\n' + 'A long line of the plan.\n'.repeat(2000)),
    })
    await library.saveLibraryFile(db, scope, actor, {
      path: 'Projects/Notes/data.csv',
      bytes: encode('a,b\n1,2\n'),
    })
    const deleted = await library.saveLibraryFile(db, scope, actor, {
      path: 'Projects/Notes/gone.md',
      bytes: encode('Gone'),
    })
    await db.document.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } })

    const where = { kind: 'library', deletedAt: null }
    const listed = await db.document.findMany({
      where,
      orderBy: { path: 'asc' },
      select: library.LIBRARY_FILE_COLUMNS,
    })
    assert.ok(
      listed.every((row) => !('text' in row)),
      'no listed row carries its text',
    )

    const whole = await db.document.findMany({ where, orderBy: { path: 'asc' } })
    assert.ok(
      whole.some((row) => row.text.length > 1000),
      'a file has text to leave out',
    )
    const files = await library.libraryFiles(db, listed)
    assert.deepEqual(files, await library.libraryFiles(db, whole))
    assert.deepEqual(
      files.map((f) => [f.path, f.createdBy?.name]),
      [
        ['Projects/Notes/data.csv', 'Ada'],
        ['Projects/Notes/plan.md', 'Ada'],
      ],
    )
  })
})
