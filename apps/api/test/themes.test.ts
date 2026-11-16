import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'

// Themes (src/themes.ts, docs/themes.md) against the API's development database (apps/api/.env),
// in an organization of its own removed at the end; skipped when no database answers. Files go
// to the bucket's local stand-in, in a folder of the test's own.
// - a teammate's theme_set saves and wears a theme, edits it, wears another or none;
// - every change is kept with the look right after it: undo by steps or to a change, a redo;
// - deleting the worn theme brings the dashboard's own look back;
// - a stylesheet that loads from elsewhere, or a file that is not what its name says, is refused;
// - only in a thread a person started, and only with the themes feature;
// - one member's look is theirs: another's history and themes stay apart.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const bucketDir = mkdtempSync(join(tmpdir(), 'themes-bucket-'))
process.env.BUCKET_DIR = bucketDir

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

describe('themes', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const org = `org-themes-${suffix}`
  const ada = `m-ada-${suffix}`
  const bob = `m-bob-${suffix}`
  let workspaceId: string
  let computerId: string
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }
  let themes: typeof import('../src/themes.js')
  const riley = { id: 'teammate', name: 'Riley' }
  let flagBefore: Awaited<ReturnType<typeof prisma.featureFlag.findUnique>> = null

  const session = (memberId = ada, origin = 'member') => ({
    id: `s-${randomUUID().slice(0, 8)}`,
    origin,
    startedByMemberId: memberId,
    computerId,
    playbookRunId: null,
  })
  const call = (op: Parameters<typeof themes.handleThemeCall>[4], s = session()) =>
    themes.handleThemeCall(db, scope, s, riley, op) as Promise<Record<string, unknown>>

  const open = (workspaceIds: string[]) =>
    prisma.featureFlag.upsert({
      where: { key: 'themes' },
      create: { key: 'themes', workspaceIds },
      update: { everyone: false, emails: [], workspaceIds },
    })

  before(async () => {
    themes = await import('../src/themes.js')
    flagBefore = await prisma.featureFlag.findUnique({ where: { key: 'themes' } })
    await prisma.organization.create({ data: { id: org, name: 'Themes', slug: org } })
    for (const [id, name] of [
      [ada, 'Ada'],
      [bob, 'Bob'],
    ] as const) {
      await prisma.user.create({
        data: { id: `u-${id}`, name, email: `${id}@test.local` },
      })
      await prisma.member.create({
        data: { id, organizationId: org, userId: `u-${id}`, role: 'owner' },
      })
    }
    workspaceId = (await prisma.workspace.create({ data: { organizationId: org, name: 'Themes' } }))
      .id
    scope = { organizationId: org, workspaceId }
    db = scoped(scope)
    computerId = (
      await db.computer.create({
        data: { kind: 'member_machine', memberId: ada, name: 'Laptop' } as never,
      })
    ).id
    await open([workspaceId])
  })

  after(async () => {
    if (!database) return
    if (flagBefore)
      await prisma.featureFlag.update({
        where: { key: 'themes' },
        data: {
          everyone: flagBefore.everyone,
          emails: flagBefore.emails,
          workspaceIds: flagBefore.workspaceIds,
        },
      })
    else await prisma.featureFlag.deleteMany({ where: { key: 'themes' } })
    await prisma.organization.delete({ where: { id: org } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: { in: [`u-${ada}`, `u-${bob}`] } } })
    rmSync(bucketDir, { recursive: true, force: true })
    await prisma.$disconnect()
  })

  test('a teammate saves and wears a theme, edits it, then wears none', async () => {
    const made = await call({
      name: 'theme_set',
      theme: { name: 'Solarized Dark', canvas: '#002b36', accent: '#b58900' },
    })
    assert.equal(made.id, 'solarized-dark')
    assert.equal(made.member, ada)
    assert.match(String(made.text), /Saved the theme Solarized Dark/)
    let worn = await themes.wornTheme(db, scope, ada)
    assert.equal(worn?.id, 'solarized-dark')
    assert.equal(worn?.theme.canvas, '#002b36')

    // As JSON text, as some harnesses send an object.
    const edited = await call({
      name: 'theme_set',
      id: 'solarized-dark',
      theme: JSON.stringify({ name: 'Solarized Dark', canvas: '#002b36', accent: '#268bd2' }),
    })
    assert.match(String(edited.text), /Updated/)
    worn = await themes.wornTheme(db, scope, ada)
    assert.equal(worn?.theme.accent, '#268bd2')

    const off = await call({ name: 'theme_set', id: 'none' })
    assert.match(String(off.text), /theme is off/)
    assert.equal(await themes.wornTheme(db, scope, ada), null)

    const read = await call({ name: 'theme_read' })
    assert.match(String(read.current), /none/)
    assert.deepEqual(
      (read.history as { what: string }[]).map((h) => h.what),
      ['took the theme off', 'edited Solarized Dark', 'made Solarized Dark and wore it'],
    )
    assert.match(String(read.guide), /Stable selectors/)
  })

  test('going back: by steps, to a change, and an undo undone', async () => {
    const before = (await themes.listThemes(db, ada)).history[0]!.seq
    // Back one: the edited theme, worn again.
    const one = await call({ name: 'theme_undo' })
    assert.match(String(one.text), /wear Solarized Dark/)
    assert.equal((await themes.wornTheme(db, scope, ada))?.theme.accent, '#268bd2')
    // An undo is a change: undoing it again takes the theme back off.
    await call({ name: 'theme_undo' })
    assert.equal(await themes.wornTheme(db, scope, ada), null)
    // To the look right after the first change: the first accent.
    const first = before - 2
    await call({ name: 'theme_undo', seq: first })
    assert.equal((await themes.wornTheme(db, scope, ada))?.theme.accent, '#b58900')
    // Before any change: the dashboard's own look.
    await call({ name: 'theme_undo', seq: 0 })
    assert.equal(await themes.wornTheme(db, scope, ada), null)
    const nothing = await call({ name: 'theme_undo', seq: 9999 })
    assert.match(String(nothing.error), /No change 9999/)
  })

  test('a stylesheet that loads from elsewhere changes nothing', async () => {
    const seq = (await themes.listThemes(db, ada)).history[0]!.seq
    for (const css of [
      '@import url("https://evil.example/a.css");',
      'body { background: url(https://evil.example/leak.png) }',
      'body { background: \\75 rl(https://evil.example/leak.png) }',
    ]) {
      const refused = await call({ name: 'theme_set', theme: { name: 'Leaky', css } })
      assert.match(String(refused.error), /^Nothing changed/)
    }
    const colour = await call({
      name: 'theme_set',
      theme: { name: 'Leaky', colors: { background: 'url(https://evil.example/x.png)' } },
    })
    assert.match(String(colour.error), /a colour, not a file/)
    const id = await call({ name: 'theme_set', id: 'system', theme: { name: 'System' } })
    assert.match(String(id.error), /built-in look/)
    assert.equal((await themes.listThemes(db, ada)).history[0]!.seq, seq)
  })

  test('a file is checked to be what its name says, then named by its signed address', async () => {
    await call({
      name: 'theme_set',
      theme: {
        name: 'Paper',
        canvas: '#f4efe6',
        css: 'body { background: url("theme:paper.png") }',
      },
    })
    const { putObject } = await import('../src/bucket.js')
    const { uploadBytesKey } = await import('../src/uploads.js')
    const s = session()
    const upload = async (bytes: Uint8Array, owner = s) => {
      const row = await db.upload.create({
        data: {
          purpose: 'theme_file',
          name: 'paper.png',
          contentType: 'image/png',
          size: bytes.byteLength,
          status: 'ready',
          checked: 'c1',
          computerId: owner.computerId,
          sessionId: owner.id,
        } as never,
      })
      await putObject(uploadBytesKey(scope, row), bytes, 'image/png')
      return row.id
    }
    const fake = await call(
      {
        name: 'theme_add_file',
        id: 'paper',
        path: 'paper.png',
        upload: { id: await upload(new TextEncoder().encode('<svg onload=alert(1)>')) },
      },
      s,
    )
    assert.match(String(fake.error), /not a png image/)
    const svg = await call(
      { name: 'theme_add_file', id: 'paper', path: 'logo.svg', upload: { id: 'x' } },
      s,
    )
    assert.match(String(svg.error), /No SVG/)
    // Another thread's upload is not this one's.
    const elsewhere = await call(
      { name: 'theme_add_file', id: 'paper', path: 'paper.png', upload: { id: await upload(PNG) } },
      session(),
    )
    assert.match(String(elsewhere.error), /Upload not found/)

    const added = await call(
      { name: 'theme_add_file', id: 'paper', path: 'Paper.PNG', upload: { id: await upload(PNG) } },
      s,
    )
    assert.match(String(added.text), /url\("theme:paper.png"\)/)
    const worn = await themes.wornTheme(db, scope, ada)
    // Without R2, the API's own address of the file.
    assert.match(worn!.files['paper.png']!, /^\/api\/themes\/files\//)
    const read = await call({ name: 'theme_read', id: 'paper' })
    assert.deepEqual(
      (read.theme as { files: { name: string }[] }).files.map((f) => f.name),
      ['paper.png'],
    )
  })

  test('deleting the worn theme brings the own look back, its files gone', async () => {
    await themes.deleteTheme(db, scope, ada, 'paper')
    assert.equal(await themes.wornTheme(db, scope, ada), null)
    assert.equal(await db.themeAsset.count({ where: { theme: { memberId: ada } } }), 0)
    const { history } = await themes.listThemes(db, ada)
    assert.equal(history[0]!.kind, 'deleted')
    // Going back wears it again as it was, saved again; its file is named as missing.
    const back = await themes.undo(db, scope, ada, { steps: 1 }, null)
    assert.deepEqual(back.missing, ['paper.png'])
    assert.equal((await themes.wornTheme(db, scope, ada))?.id, 'paper')
  })

  test('one member’s look is theirs alone', async () => {
    await call({ name: 'theme_set', theme: { name: 'Bob’s', accent: '#22c55e' } }, session(bob))
    assert.equal((await themes.wornTheme(db, scope, bob))?.theme.name, 'Bob’s')
    assert.equal((await themes.wornTheme(db, scope, ada))?.id, 'paper')
    const bobs = await themes.listThemes(db, bob)
    assert.deepEqual(
      bobs.themes.map((t) => t.id),
      ['bob-s'],
    )
    assert.equal(bobs.history.length, 1)
  })

  test('a thread another member asks in changes nobody’s look', async () => {
    const teammate = await db.teammate.create({ data: { name: 'Riley' } as never })
    const shared = await db.session.create({
      data: {
        teammateId: teammate.id,
        startedByMemberId: ada,
        askedByMemberId: bob,
        computerId,
        title: 'Shared',
        origin: 'member',
      } as never,
    })
    const s = { ...session(), id: shared.id }
    const before = (await themes.listThemes(db, ada)).history[0]!.seq
    const refused = await call(
      {
        name: 'theme_set',
        theme: { name: 'Hidden', css: '[data-look="chat-card"] { display: none }' },
      },
      s,
    )
    assert.match(String(refused.error), /Several people ask in this thread/)
    assert.match(String((await call({ name: 'theme_undo' }, s)).error), /Several people/)
    assert.equal((await themes.listThemes(db, ada)).history[0]!.seq, before)
    // Ada alone again (her own thread): she may.
    await db.session.update({ where: { id: shared.id }, data: { askedByMemberId: ada } })
    assert.equal((await call({ name: 'theme_read' }, s)).error, undefined)
  })

  test('an import is all or nothing: a bad file leaves the theme it would replace as it was', async () => {
    const { putObject } = await import('../src/bucket.js')
    const { uploadBytesKey } = await import('../src/uploads.js')
    const upload = async (name: string, bytes: Uint8Array) => {
      const row = await db.upload.create({
        data: {
          purpose: 'theme_file',
          name,
          contentType: 'image/png',
          size: bytes.byteLength,
          status: 'ready',
          checked: 'c1',
          memberId: ada,
        } as never,
      })
      await putObject(uploadBytesKey(scope, row), bytes, 'image/png')
      return row.id
    }
    const first = await themes.importTheme(db, scope, ada, {
      theme: {
        name: 'Imported',
        canvas: '#ffffff',
        css: 'body { background: url("theme:a.png") }',
      },
      files: { 'a.png': await upload('a.png', PNG) },
    })
    assert.equal(first.slug, 'imported')
    const assetsBefore = await db.themeAsset.findMany({
      where: { theme: { memberId: ada, slug: 'imported' } },
    })
    assert.deepEqual(
      assetsBefore.map((a) => [a.name, a.status]),
      [['a.png', 'ready']],
    )
    const seq = (await themes.listThemes(db, ada)).history[0]!.seq
    // Over it: a good a.png, then a b.png that is not a PNG.
    await assert.rejects(
      themes.importTheme(db, scope, ada, {
        theme: { name: 'Imported', canvas: '#000000' },
        files: {
          'a.png': await upload('a.png', PNG),
          'b.png': await upload('b.png', new TextEncoder().encode('not an image')),
        },
      }),
      /b\.png is not a png image/,
    )
    const after = await db.themeAsset.findMany({
      where: { theme: { memberId: ada, slug: 'imported' } },
    })
    assert.deepEqual(
      after.map((a) => a.id),
      assetsBefore.map((a) => a.id),
    )
    const saved = await themes.readTheme(db, ada, 'imported')
    assert.equal(saved?.theme.canvas, '#ffffff')
    assert.equal((await themes.listThemes(db, ada)).history[0]!.seq, seq)
    // A new theme whose file is refused is not left behind.
    await assert.rejects(
      themes.importTheme(db, scope, ada, {
        theme: { name: 'Never' },
        files: { 'c.png': await upload('c.png', new TextEncoder().encode('nope')) },
      }),
      /is not a png image/,
    )
    assert.equal(await themes.readTheme(db, ada, 'never'), null)
  })

  test('two replacements of one file at once leave one, the later', async () => {
    const { getObject, putObject, themeFileKey } = await import('../src/bucket.js')
    const { uploadBytesKey } = await import('../src/uploads.js')
    await themes.saveAndWear(db, scope, ada, { slug: 'race', theme: { name: 'Race' }, by: null })
    const upload = async () => {
      const row = await db.upload.create({
        data: {
          purpose: 'theme_file',
          name: 'r.png',
          contentType: 'image/png',
          size: PNG.byteLength,
          status: 'ready',
          checked: 'c1',
          memberId: ada,
        } as never,
      })
      await putObject(uploadBytesKey(scope, row), PNG, 'image/png')
      return row.id
    }
    const ids = [await upload(), await upload()]
    // Both copied before either publishes: the interleaving that lost both.
    let arrived = 0
    let release!: () => void
    const both = new Promise<void>((resolve) => (release = resolve))
    themes.onThemeFilesPublish(async () => {
      if (++arrived === 2) release()
      await both
    })
    try {
      await Promise.all(
        ids.map((uploadId) =>
          themes.addFile(db, scope, ada, {
            slug: 'race',
            name: 'r.png',
            uploadId,
            owner: { memberId: ada },
          }),
        ),
      )
    } finally {
      themes.onThemeFilesPublish(undefined)
    }
    const rows = await db.themeAsset.findMany({
      where: { theme: { memberId: ada, slug: 'race' }, name: 'r.png' },
    })
    assert.deepEqual(
      rows.map((r) => r.status),
      ['ready'],
    )
    assert.ok(await getObject(themeFileKey(scope, rows[0]!.id)), 'its bytes are kept')
  })

  test('only in a thread a person started, with the themes feature', async () => {
    const trigger = await call({ name: 'theme_read' }, session(ada, 'trigger'))
    assert.match(String(trigger.error), /thread a person started/)
    await open([])
    try {
      const closed = await call({ name: 'theme_read' })
      assert.match(String(closed.error), /not open/)
    } finally {
      await open([workspaceId])
    }
  })

  test('a member leaving takes their themes and files with them', async () => {
    // The imported theme's file, among others.
    assert.ok((await db.themeAsset.count({ where: { theme: { memberId: ada } } })) > 0)
    await call({ name: 'theme_set', theme: { name: 'Leaving', canvas: '#101010' } })
    await themes.removeMemberThemes(db, scope, ada)
    assert.equal(await db.theme.count({ where: { memberId: ada } }), 0)
    assert.equal(await db.themeAsset.count({ where: { theme: { memberId: ada } } }), 0)
    // Bob's stay.
    assert.equal(await db.theme.count({ where: { memberId: bob } }), 1)
  })

  test('only the last changes are kept', async () => {
    const { THEME_LIMITS } = await import('@brigade/contracts')
    for (let i = 0; i < THEME_LIMITS.history + 3; i++)
      await themes.wear(db, scope, bob, i % 2 ? 'bob-s' : null, null)
    const { history } = await themes.listThemes(db, bob)
    assert.equal(history.length, THEME_LIMITS.history)
    // The oldest kept is no longer the very first: there is no going back past it.
    await assert.rejects(
      themes.undo(db, scope, bob, { steps: THEME_LIMITS.history }, null),
      /steps must be a whole number from 1 to 29/,
    )
  })
})
