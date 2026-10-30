import assert from 'node:assert/strict'
import { test } from 'node:test'

// designs.ts reads the API's config when imported; the database here is a stub.
process.env.DATABASE_URL ??= 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { findDesign, listDesignOptions } = await import('../src/designs.js')
type Db = Parameters<typeof findDesign>[0]

const OPTIONS = 'Projects/Acme/designs/landing.options'

type Pick = { from: string; to: string; at?: Date }

/**
 * A library holding these files, after these picks (oldest first) and with these
 * folders sent to the trash (by when): as the audit log keeps them, past the trash.
 */
function db(files: string[], picks: Pick[] = [], trashedFolders: Record<string, Date> = {}) {
  return {
    document: {
      findFirst: async ({ where }: { where: { path: string; deletedAt: unknown } }) =>
        where.deletedAt === null && files.includes(where.path) ? { path: where.path } : null,
    },
    auditEntry: {
      findFirst: async ({
        where,
      }: {
        where: { action: string; targetId: string; at?: { gt: Date } }
      }) => {
        if (where.action === 'library.folder_trashed') {
          const at = trashedFolders[where.targetId]
          return at && (!where.at || at > where.at.gt) ? { at } : null
        }
        const pick = picks
          .filter((p) => where.action === 'design.picked' && p.to === where.targetId)
          .at(-1)
        return pick ? { data: { from: pick.from, to: pick.to }, at: pick.at ?? new Date(0) } : null
      },
    },
  } as unknown as Db
}

test('a design that is there is itself', async () => {
  const a = `${OPTIONS}/a-bold.design`
  assert.deepEqual(await findDesign(db([`${a}/index.html`]), `${a}/`), { path: a, trashed: false })
  const plain = 'Projects/Acme/designs/home.design'
  assert.deepEqual(await findDesign(db([]), plain), { path: plain, trashed: false })
})

test('the picked option is now the design', async () => {
  const b = `${OPTIONS}/b-the-pass.design`
  const to = 'Projects/Acme/designs/landing.design'
  assert.deepEqual(await findDesign(db([`${to}/index.html`], [{ from: b, to }]), b), {
    path: to,
    trashed: false,
  })
})

test('the options not picked are in the trash', async () => {
  const to = 'Projects/Acme/designs/landing.design'
  const a = `${OPTIONS}/a-bold.design`
  const found = await findDesign(db([], [{ from: `${OPTIONS}/b-the-pass.design`, to }]), a)
  assert.deepEqual(found, { path: a, trashed: true })
})

test('an option missing with no pick stays where it was', async () => {
  const a = `${OPTIONS}/a-bold.design`
  assert.deepEqual(await findDesign(db([]), a), { path: a, trashed: false })
})

test('an option cleared when the design itself was saved leads to that design', async () => {
  const a = `${OPTIONS}/a-bold.design`
  const to = 'Projects/Acme/designs/landing.design'
  assert.deepEqual(await findDesign(db([`${to}/index.html`]), a), { path: to, trashed: false })
})

test('an option of a later round, settled by saving the design, leads to it despite an older pick', async () => {
  const to = 'Projects/Acme/designs/landing.design'
  const old = { from: `${OPTIONS}/a-old.design`, to, at: new Date('2026-10-01') }
  const b = `${OPTIONS}/b-new.design`
  // Still so once the trash is emptied: only the audit says when the folder went.
  const later = { [OPTIONS]: new Date('2026-10-20') }
  assert.deepEqual(await findDesign(db([`${to}/index.html`], [old], later), b), {
    path: to,
    trashed: false,
  })
})

test('an option trashed by a pick, before it was recorded, stays in the trash', async () => {
  const to = 'Projects/Acme/designs/landing.design'
  const at = new Date('2026-10-20T10:00:00Z')
  const a = `${OPTIONS}/a-bold.design`
  const before = { [OPTIONS]: new Date('2026-10-20T09:59:59Z') }
  const pick = { from: `${OPTIONS}/b-the-pass.design`, to, at }
  assert.deepEqual(await findDesign(db([`${to}/index.html`], [pick], before), a), {
    path: a,
    trashed: true,
  })
})

test('the options offered with a design, in the order offered, those with a page only', async () => {
  const files = [
    `${OPTIONS}/b-the-pass.design/index.html`,
    `${OPTIONS}/a-bold.design/styles.css`,
    `${OPTIONS}/a-bold.design/index.html`,
    // Saving, no page yet.
    `${OPTIONS}/c-calm.design/design.json`,
    `${OPTIONS}/notes.md`,
  ]
  const library = {
    document: {
      findMany: async ({ where }: { where: { path: { startsWith: string } } }) =>
        files
          .filter((path) => path.startsWith(where.path.startsWith))
          .sort()
          .map((path) => ({ path })),
    },
  } as unknown as Db
  const scope = {} as Parameters<typeof listDesignOptions>[1]
  assert.deepEqual(await listDesignOptions(library, scope, `${OPTIONS}/b-the-pass.design`), [
    { path: `${OPTIONS}/a-bold.design`, title: null },
    { path: `${OPTIONS}/b-the-pass.design`, title: null },
  ])
  assert.deepEqual(await listDesignOptions(library, scope, 'Projects/Acme/designs/home.design'), [])
})
