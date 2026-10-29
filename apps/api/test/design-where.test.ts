import assert from 'node:assert/strict'
import { test } from 'node:test'

// designs.ts reads the API's config when imported; the database here is a stub.
process.env.DATABASE_URL ??= 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { findDesign } = await import('../src/designs.js')
type Db = Parameters<typeof findDesign>[0]

const OPTIONS = 'Projects/Acme/designs/landing.options'

/** A library holding these files, after these picks (oldest first). */
function db(files: string[], picks: { from: string; to: string }[] = []) {
  return {
    document: {
      findFirst: async ({ where }: { where: { path: string } }) =>
        files.includes(where.path) ? { path: where.path } : null,
    },
    auditEntry: {
      findFirst: async ({ where }: { where: { action: string; targetId: string } }) => {
        const pick = picks
          .filter((p) => where.action === 'design.picked' && p.to === where.targetId)
          .at(-1)
        return pick ? { data: pick } : null
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
