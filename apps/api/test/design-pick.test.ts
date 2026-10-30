import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'

// Picking one of a thread's design options (applyPick in src/designs.ts), against the API's
// development database (apps/api/.env), in an organization of its own removed at the end; skipped
// when no database answers. The pick is copied to the design and the options stay: the thread's
// choices card still shows each of them.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL || undefined
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
process.env.BUCKET_DIR = mkdtempSync(join(tmpdir(), 'design-pick-'))

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1 from "LibraryObject" limit 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

const encode = (text: string) => new TextEncoder().encode(text)
const OPTIONS = 'acme/pricing.options'
const DESIGN = 'acme/pricing.design'

describe('design picks', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<'org' | 'user' | 'member' | 'workspace', string>
  const threadId = `thread-pick-${suffix}`
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string; memberId: string }
  let library: typeof import('../src/library.js')
  let designs: typeof import('../src/designs.js')
  const member = () => ({ type: 'member' as const, id: ids.member })
  const teammate = { type: 'teammate' as const, id: `t-pick-${suffix}` }
  const save = (path: string, text: string, actor: { type: 'member' | 'teammate'; id: string }) =>
    library.saveLibraryFile(db, scope, actor, { path, bytes: encode(text) })
  const text = async (path: string) => {
    const row = await db.document.findFirst({ where: { kind: 'library', path, deletedAt: null } })
    return row && new TextDecoder().decode(await library.readLibraryFile(scope, row))
  }
  /** A pick as the thread's message sends it, past checkPick (which reads the offer). */
  const pick = (folder: string, replaces: boolean) =>
    designs.applyPick(db, scope, member(), {
      threadId,
      folder,
      options: OPTIONS,
      to: DESIGN,
      replaces,
    })

  before(async () => {
    library = await import('../src/library.js')
    designs = await import('../src/designs.js')
    ids.org = `org-pick-${suffix}`
    ids.user = `user-pick-${suffix}`
    ids.member = `m-pick-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Pick', slug: `pick-${suffix}` },
    })
    await prisma.user.create({
      data: { id: ids.user, name: 'Ada', email: `${ids.user}@test.local` },
    })
    await prisma.member.create({
      data: { id: ids.member, organizationId: ids.org, userId: ids.user, role: 'owner' },
    })
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Pick' } })
    ).id
    scope = { organizationId: ids.org, workspaceId: ids.workspace, memberId: ids.member }
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

  test('the pick is copied to the design and every option stays', async () => {
    for (const name of ['a-bold', 'b-calm']) {
      await save(`${OPTIONS}/${name}.design/index.html`, `<p>${name}</p>`, teammate)
      await save(`${OPTIONS}/${name}.design/thumbnail.png`, `png ${name}`, teammate)
    }
    await pick(`${OPTIONS}/a-bold.design`, false)
    assert.equal(await text(`${DESIGN}/index.html`), '<p>a-bold</p>')
    assert.equal(await text(`${DESIGN}/thumbnail.png`), 'png a-bold')
    assert.equal(await text(`${OPTIONS}/a-bold.design/index.html`), '<p>a-bold</p>')
    assert.equal(await text(`${OPTIONS}/b-calm.design/index.html`), '<p>b-calm</p>')
    for (const name of ['a-bold', 'b-calm'])
      assert.deepEqual(await designs.findDesign(db, `${OPTIONS}/${name}.design`), {
        path: `${OPTIONS}/${name}.design`,
        trashed: false,
      })
  })

  test("the copy is the thread's, not a person's edit its next save would stop at", async () => {
    const thread = { id: threadId, createdAt: new Date(Date.now() - 60_000) }
    assert.deepEqual(await designs.personEdits(db, thread, DESIGN), [])
  })

  test('picking again replaces the design, keeping its history, and the options stay', async () => {
    await save(`${DESIGN}/extra.html`, '<p>only in the design</p>', teammate)
    const index = await db.document.findFirst({
      where: { kind: 'library', path: `${DESIGN}/index.html`, deletedAt: null },
    })
    // Later than saves of the same author and thread fold into one version.
    await prisma.$executeRaw`update "DocumentVersion" set "updatedAt" = now() - interval '1 day' where "documentId" = ${index!.id}`
    await pick(`${OPTIONS}/b-calm.design`, true)
    assert.equal(await text(`${DESIGN}/index.html`), '<p>b-calm</p>')
    assert.equal(await text(`${DESIGN}/extra.html`), null, 'what the option lacks is trashed')
    const versions = await db.documentVersion.count({ where: { documentId: index!.id } })
    assert.ok(versions >= 2, 'the design keeps its earlier version')
    assert.equal(await text(`${OPTIONS}/a-bold.design/index.html`), '<p>a-bold</p>')
    assert.equal(await text(`${OPTIONS}/b-calm.design/index.html`), '<p>b-calm</p>')
  })
})
