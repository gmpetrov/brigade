import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'

// A project's decisions (src/decisions.ts, docs/projects.md) and Brigade's own skills in Settings
// (src/builtin-skills.ts), against the API's development database (apps/api/.env), in an
// organization of its own removed at the end; skipped when no database answers:
// - the project page reads each spec's status line and each design's design.json, under its
//   folder only, and flags what has none (under decisions/ and designs/) or looks behind;
// - a pull request links the specs and designs it ships or is part of, those its author may change;
// - once merged, those it ships are marked shipped with its number, the others get its number,
//   credited to its author, once, even when tried again;
// - an admin turns brigade-library off and on; the other skills stay on.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL || undefined
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1 from "SpecPull" limit 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

const spec = (title: string, line: string) => `# ${title}\n\n${line}\n\nWhy.\n`
const manifest = (fields: Record<string, unknown>) => JSON.stringify(fields, null, 2)

describe('decisions', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<'org' | 'user' | 'member' | 'workspace' | 'riley' | 'reader', string>
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }
  let decisions: typeof import('../src/decisions.js')
  let library: typeof import('../src/library.js')

  const save = (path: string, text: string) =>
    library.saveLibraryFile(
      db,
      scope,
      { type: 'member', id: ids.member },
      { path, bytes: new TextEncoder().encode(text) },
    )
  const read = async (path: string) => {
    const row = await db.document.findFirst({ where: { path, kind: 'library', deletedAt: null } })
    return library.documentText(scope, row!)
  }
  const pull = (number: number, authorTeammateId: string) =>
    db.pullRequest.create({
      data: {
        repository: 'acme/app',
        number,
        title: `#${number}`,
        headRef: `b${number}`,
        baseRef: 'main',
        authorTeammateId,
      },
    } as never)

  before(async () => {
    decisions = await import('../src/decisions.js')
    library = await import('../src/library.js')
    ids.org = `org-decisions-${suffix}`
    ids.user = `user-decisions-${suffix}`
    ids.member = `m-decisions-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Decisions', slug: `decisions-${suffix}` },
    })
    await prisma.user.create({
      data: { id: ids.user, name: 'Ada', email: `${ids.user}@test.local` },
    })
    await prisma.member.create({
      data: { id: ids.member, organizationId: ids.org, userId: ids.user, role: 'owner' },
    })
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Decisions' } })
    ).id
    scope = { organizationId: ids.org, workspaceId: ids.workspace }
    db = scoped(scope)
    ids.riley = (
      await db.teammate.create({ data: { name: 'Riley', libraryAccess: 'read_write' } } as never)
    ).id
    ids.reader = (
      await db.teammate.create({ data: { name: 'Sam', libraryAccess: 'read' } } as never)
    ).id
    await save(
      'Projects/Acme/decisions/later-spec.md',
      spec('Later threads', 'Spec, 2026-10-19. Status: accepted. Decided with Ada.'),
    )
    await save('Projects/Acme/decisions/old-note.md', '# Old note\n\nNo status here.\n')
    await save('Projects/Acme/decisions/README.md', '# Decisions\n\nAn introduction.\n')
    await save(
      'Projects/Acme/why.md',
      spec('Why Acme', 'Note, 2026-10-01. Status: shipped (#3). The code is the truth.'),
    )
    await save('Projects/Acme/notes.md', '# Notes\n\nJust notes, no status: not a decision.\n')
    await save('Projects/Acme/designs/home.design/design.json', manifest({ title: 'Home' }))
    await save('Projects/Acme/designs/home.design/index.html', '<h1>Home</h1>')
    await save(
      'Projects/Acme/landing.design/design.json',
      manifest({ title: 'Landing', status: 'draft', boards: [{ file: 'index.html' }] }),
    )
    await save(
      'Projects/Acme/designs/home.options/a-bold.design/design.json',
      manifest({ title: 'Bold', status: 'draft' }),
    )
    await save(
      'Projects/Other/spec.md',
      spec('Elsewhere', 'Spec, 2026-10-02. Status: draft. Another project.'),
    )
  })

  after(async () => {
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.libraryObject.deleteMany({ where: { organizationId: ids.org } })
    await prisma.libraryObjectFolder.deleteMany({ where: { organizationId: ids.org } })
    await prisma.auditEntry.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({ where: { id: ids.user } })
  })

  test("the project page reads each spec's line and each design's design.json, under its folder", async () => {
    const found = await decisions.projectDecisions(scope, 'Projects/Acme')
    const byPath = new Map(found.map((d) => [d.path, d]))
    assert.deepEqual(
      [...byPath.keys()].sort(),
      [
        'Projects/Acme/decisions/later-spec.md',
        'Projects/Acme/decisions/old-note.md',
        'Projects/Acme/designs/home.design',
        'Projects/Acme/landing.design',
        'Projects/Acme/why.md',
      ],
      'no README, no file without a status outside decisions/, no option, no other project',
    )
    const later = byPath.get('Projects/Acme/decisions/later-spec.md')!
    assert.deepEqual(
      [later.type, later.title, later.kind, later.date, later.status, later.detail, later.flags],
      ['spec', 'Later threads', 'Spec', '2026-10-19', 'accepted', 'Decided with Ada.', []],
    )
    assert.deepEqual(byPath.get('Projects/Acme/decisions/old-note.md')!.flags, ['no_status'])
    assert.deepEqual(byPath.get('Projects/Acme/why.md')!.flags, ['no_reference'])
    assert.deepEqual(byPath.get('Projects/Acme/why.md')!.pullRequests, [3])
    const home = byPath.get('Projects/Acme/designs/home.design')!
    assert.deepEqual(
      [home.type, home.title, home.status, home.flags],
      ['design', 'Home', null, ['no_status']],
    )
    assert.equal(byPath.get('Projects/Acme/landing.design')!.status, 'draft')
  })

  test('a merged pull request ships the specs and designs it names, once, credited to its author', async () => {
    const p = await pull(241, ids.riley)
    const missed = await decisions.linkPullSpecs(db, p.id, ids.riley, {
      ships: ['Projects/Acme/decisions/later-spec.md', 'Projects/Acme/designs/home.design/'],
      partOf: ['Projects/Acme/why.md', 'Projects/Acme/decisions/later-spec.md', 'Nope/missing.md'],
    })
    assert.deepEqual(missed, ['Nope/missing.md'])
    const links = await db.specPull.findMany({
      where: { pullRequestId: p.id },
      select: { ships: true, document: { select: { path: true } } },
    })
    assert.deepEqual(
      links.map((l) => [l.document.path, l.ships]).sort(),
      [
        ['Projects/Acme/decisions/later-spec.md', true],
        ['Projects/Acme/designs/home.design/design.json', true],
        ['Projects/Acme/why.md', false],
      ],
      'named in both: shipped',
    )
    await db.pullRequest.updateMany({ where: { id: p.id }, data: { state: 'merged' } })
    // Merged and not settled yet: the page says the spec looks behind.
    const behind = await decisions.projectDecisions(scope, 'Projects/Acme')
    assert.deepEqual(
      behind.find((d) => d.path === 'Projects/Acme/decisions/later-spec.md')!.flags,
      ['merged_not_shipped'],
    )
    const settled = { id: p.id, number: 241, sessionId: null }
    await decisions.settleSpecsOnMerge(db, scope, settled)
    assert.equal(
      await read('Projects/Acme/decisions/later-spec.md'),
      spec('Later threads', 'Spec, 2026-10-19. Status: shipped (#241). Decided with Ada.'),
    )
    assert.equal(
      await read('Projects/Acme/why.md'),
      spec('Why Acme', 'Note, 2026-10-01. Status: shipped (#241, #3). The code is the truth.'),
    )
    assert.deepEqual(JSON.parse(await read('Projects/Acme/designs/home.design/design.json')), {
      title: 'Home',
      status: 'shipped',
      pullRequests: [241],
    })
    const row = await db.document.findFirst({
      where: { path: 'Projects/Acme/decisions/later-spec.md' },
      select: { id: true, updatedByType: true, updatedById: true },
    })
    assert.deepEqual([row!.updatedByType, row!.updatedById], ['teammate', ids.riley])
    assert.equal(await db.specPull.count({ where: { pullRequestId: p.id, settledAt: null } }), 0)
    // Tried again (the sweep, a second webhook): nothing more is written.
    const versions = await db.documentVersion.count({ where: { documentId: row!.id } })
    await db.specPull.updateMany({ where: { pullRequestId: p.id }, data: { settledAt: null } })
    await decisions.settleSpecsOnMerge(db, scope, settled)
    assert.equal(await db.documentVersion.count({ where: { documentId: row!.id } }), versions)
    const after = await decisions.projectDecisions(scope, 'Projects/Acme')
    assert.deepEqual(
      after.find((d) => d.path === 'Projects/Acme/decisions/later-spec.md')!.flags,
      ['no_reference'],
      'shipped now; its line names no reference yet',
    )
  })

  test('a teammate that may only read the library links nothing, and a file it cannot read is left alone', async () => {
    const p = await pull(300, ids.reader)
    const missed = await decisions.linkPullSpecs(db, p.id, ids.reader, {
      ships: ['Projects/Acme/landing.design'],
    })
    assert.deepEqual(missed, ['Projects/Acme/landing.design'])
    assert.equal(await db.specPull.count({ where: { pullRequestId: p.id } }), 0)
    // A spec whose line Brigade cannot read: settled, and left as it was.
    await save('Projects/Acme/decisions/broken.md', '# Broken\n\nStatus: shipped, sort of.\n')
    const q = await pull(301, ids.riley)
    await decisions.linkPullSpecs(db, q.id, ids.riley, {
      ships: ['Projects/Acme/decisions/broken.md'],
    })
    await db.pullRequest.updateMany({ where: { id: q.id }, data: { state: 'merged' } })
    await decisions.settleSpecsOnMerge(db, scope, { id: q.id, number: 301, sessionId: null })
    assert.equal(
      await read('Projects/Acme/decisions/broken.md'),
      '# Broken\n\nStatus: shipped, sort of.\n',
    )
    assert.equal(await db.specPull.count({ where: { pullRequestId: q.id, settledAt: null } }), 0)
  })

  test('an admin turns brigade-library off and on; the others are always on', async () => {
    const { builtinSkillViews, setBuiltinSkill } = await import('../src/builtin-skills.js')
    const ada = { type: 'member' as const, id: ids.member }
    const on = await builtinSkillViews(db)
    assert.deepEqual(
      on.map((s) => [s.name, s.enabled, s.switchable]),
      [
        ['brigade-library', true, true],
        ['brigade-designs', true, false],
        ['brigade-design-systems', true, false],
        ['brigade-previews', true, false],
        ['brigade-teach', true, false],
      ],
    )
    assert.match(on[0]!.instructions ?? '', /## The status line/)
    assert.equal(on[1]!.instructions, null, 'built per thread: not shown whole')
    await setBuiltinSkill(scope, ada, 'brigade-library', false)
    await setBuiltinSkill(scope, ada, 'brigade-library', false)
    const workspace = await db.workspace.findFirst({ select: { builtinSkillsOff: true } })
    assert.deepEqual(workspace?.builtinSkillsOff, ['brigade-library'], 'once, turned off twice')
    const off = (await builtinSkillViews(db))[0]!
    assert.equal(off.enabled, false)
    assert.equal(off.offBy?.name, 'Ada')
    await setBuiltinSkill(scope, ada, 'brigade-library', true)
    assert.deepEqual(
      (await db.workspace.findFirst({ select: { builtinSkillsOff: true } }))?.builtinSkillsOff,
      [],
    )
    await assert.rejects(setBuiltinSkill(scope, ada, 'brigade-previews', false), /always on/)
    await assert.rejects(setBuiltinSkill(scope, ada, 'brigade-nope', false), /no skill/)
  })
})
