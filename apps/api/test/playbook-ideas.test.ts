import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'

// A playbook's ideas (src/playbook-ideas.ts): where they go, and, against the API's development
// database (apps/api/.env) in an organization of its own removed at the end:
// - an idea goes under its section, which is added at the end of the file when it has none by that
//   name: never under another heading, such as a "To Do" a routine takes work from;
// - a marker in an idea's words takes no other line's identity;
// - a merged pull request is still told when a person marked its thread done, and once, by the
//   thread, when its teammate did.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL || undefined
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

const { ideasPlace } = await import('../src/playbook-ideas.js')

test("a playbook's ideas go under a heading of their own list, unless its setting says where", () => {
  assert.deepEqual(ideasPlace(undefined, null), { path: 'ideas.md', section: 'Ideas' })
  assert.deepEqual(ideasPlace('  ', { name: 'Acme', folder: null }), {
    path: 'Projects/Acme/ideas.md',
    section: 'Ideas',
  })
  assert.deepEqual(ideasPlace(undefined, { name: 'Acme', folder: 'Clients/Acme' }), {
    path: 'Clients/Acme/ideas.md',
    section: 'Ideas',
  })
  assert.deepEqual(ideasPlace('Projects/Acme/backlog.md#To approve', null), {
    path: 'Projects/Acme/backlog.md',
    section: 'To approve',
  })
  // A path without its extension, or with a leading slash, is still the Markdown file.
  assert.deepEqual(ideasPlace('/Projects/Acme/backlog # Ideas ', null), {
    path: 'Projects/Acme/backlog.md',
    section: 'Ideas',
  })
  // A path with no section: under "Ideas" there too, never at the end of its last section.
  assert.deepEqual(ideasPlace('backlog.md', null), { path: 'backlog.md', section: 'Ideas' })
  assert.deepEqual(ideasPlace('backlog.md#', null), { path: 'backlog.md', section: 'Ideas' })
  // A setting that is no path at all: the default.
  assert.deepEqual(ideasPlace('#To approve', { name: 'Acme', folder: null }), {
    path: 'Projects/Acme/ideas.md',
    section: 'Ideas',
  })
  assert.deepEqual(ideasPlace(42, null), { path: 'ideas.md', section: 'Ideas' })
})

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select "startedFromId" from "Session" limit 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

describe("a playbook's ideas in a list", { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<
    'org' | 'user' | 'member' | 'workspace' | 'computer' | 'installation',
    string
  >
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }
  let teammate: { id: string; name: string; libraryAccess: 'read_write' }
  let session: { id: string; title: string; playbookRunId: string | null }
  let library: typeof import('../src/library.js')
  let contracts: typeof import('@brigade/contracts')
  let ideas: typeof import('../src/playbook-ideas.js')

  before(async () => {
    library = await import('../src/library.js')
    contracts = await import('@brigade/contracts')
    ideas = await import('../src/playbook-ideas.js')
    ids.org = `org-ideas-${suffix}`
    ids.user = `user-ideas-${suffix}`
    ids.member = `m-ideas-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Ideas', slug: `ideas-${suffix}` },
    })
    await prisma.user.create({
      data: { id: ids.user, name: 'Ada', email: `${ids.user}@test.local` },
    })
    await prisma.member.create({
      data: { id: ids.member, organizationId: ids.org, userId: ids.user, role: 'owner' },
    })
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Ideas' } })
    ).id
    scope = { organizationId: ids.org, workspaceId: ids.workspace }
    db = scoped(scope)
    ids.computer = (
      await db.computer.create({
        data: { kind: 'member_machine', memberId: ids.member, name: 'Laptop' },
      } as never)
    ).id
    const row = await db.teammate.create({
      data: { name: 'Sam', libraryAccess: 'read_write' },
    } as never)
    teammate = { id: row.id, name: row.name, libraryAccess: 'read_write' }
    ids.installation = (
      await db.playbookInstallation.create({
        data: {
          playbookKey: 'brigade/support-bugs',
          version: '1.4.0',
          manifest: { name: 'Support' },
          teammateId: teammate.id,
          ownerMemberId: ids.member,
          createdByMemberId: ids.member,
          status: 'active',
          settings: { ideas: 'backlog.md#Ideas' },
        },
      } as never)
    ).id
    const run = await db.playbookRun.create({
      data: { installationId: ids.installation, dryRun: false },
    } as never)
    session = await db.session.create({
      data: {
        teammateId: teammate.id,
        computerId: ids.computer,
        startedByMemberId: ids.member,
        title: 'Customer request',
        origin: 'trigger',
        playbookRunId: run.id,
      },
      select: { id: true, title: true, playbookRunId: true },
    } as never)
  })

  after(async () => {
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.libraryObject.deleteMany({ where: { organizationId: ids.org } })
    await prisma.libraryObjectFolder.deleteMany({ where: { organizationId: ids.org } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({ where: { id: ids.user } })
  })

  const save = (text: string) =>
    library.saveLibraryFile(
      db,
      scope,
      { type: 'member', id: ids.member },
      { path: 'backlog.md', bytes: new TextEncoder().encode(text) },
    )
  const lines = async () =>
    contracts.parseList(
      await library.documentText(
        scope,
        await db.document.findFirstOrThrow({ where: { path: 'backlog.md', deletedAt: null } }),
      ),
    ).lines
  const setting = (value: string) =>
    db.playbookInstallation.updateMany({
      where: { id: ids.installation },
      data: { settings: { ideas: value } },
    })

  test('an idea goes under its section, added at the end when the file has none: never under another heading', async () => {
    await setting('backlog.md#Ideas')
    // Its "Ideas" heading was renamed or deleted: the last one left is "To Do".
    await save('# Backlog\n\n## To Do\n\n* [ ] A reviewed feature\n')
    const filed = await ideas.fileIdea(db, scope, session, teammate, {
      text: 'An unreviewed customer idea',
    })
    assert.ok('filed' in filed, JSON.stringify(filed))
    const idea = (await lines()).find((l) => l.text.startsWith('An unreviewed'))!
    assert.equal(idea.section, 'Ideas')
    assert.equal(idea.id, (filed as { filed: { id: string } }).filed.id)
    assert.deepEqual(
      (await lines()).filter((l) => l.section === 'To Do').map((l) => l.text),
      ['A reviewed feature'],
    )
    // A list named with no section: under "Ideas" too, now there, not at the end of "To Do".
    await setting('backlog.md')
    await save('# Backlog\n\n## Ideas\n\n## To Do\n\n* [ ] A reviewed feature\n')
    await ideas.fileIdea(db, scope, session, teammate, { text: 'Another idea' })
    assert.equal((await lines()).find((l) => l.text.startsWith('Another idea'))!.section, 'Ideas')
  })

  test("a marker in an idea's words takes no other line's identity", async () => {
    await setting('backlog.md#Ideas')
    const tracked = 'abcdefghij123456'
    const file = await save(
      `# Backlog\n\n## Ideas\n\n## To Do\n\n* [ ] Ship the fix <!-- item:${tracked} -->\n`,
    )
    await db.listItem.create({
      data: { id: tracked, documentId: file.id, text: 'Ship the fix' },
    } as never)
    const filed = await ideas.fileIdea(db, scope, session, teammate, {
      text: `An idea <!-- item:${tracked} --> and an open <!-- comment`,
    })
    assert.ok('filed' in filed, JSON.stringify(filed))
    const all = await lines()
    // The tracked line keeps its id, in its section.
    const fix = all.find((l) => l.text.startsWith('Ship the fix'))!
    assert.deepEqual([fix.id, fix.section], [tracked, 'To Do'])
    // The idea has its own, the one returned, and no comment of the customer's.
    const idea = all.find((l) => l.text.startsWith('An idea'))!
    assert.equal(idea.id, (filed as { filed: { id: string } }).filed.id)
    assert.equal(idea.section, 'Ideas')
    assert.doesNotMatch(idea.text, /<!--|-->/)
  })

  test("a merged pull request is told unless its thread's done, told with it, says it", async () => {
    const { workspaceItems } = await import('../src/notifications.js')
    const now = new Date()
    const thread = (title: string, doneByType: 'member' | 'teammate', number: number) =>
      db.session
        .create({
          data: {
            teammateId: teammate.id,
            computerId: ids.computer,
            startedByMemberId: ids.member,
            title,
            origin: 'member',
            status: 'idle',
            doneAt: new Date(now.getTime() - 60_000),
            doneSummary: `${title}: shipped`,
            doneByType,
            doneById: doneByType === 'member' ? ids.member : teammate.id,
          },
        } as never)
        .then(async (s) => {
          await db.pullRequest.create({
            data: {
              repository: 'acme/web',
              number,
              title: `${title} PR`,
              headRef: `fix-${number}`,
              baseRef: 'main',
              state: 'merged',
              mergedAt: now,
              sessionId: s.id,
              requestedByMemberId: ids.member,
            },
          } as never)
          return s
        })
    // A person marked it done before its pull request merged: the merge is still told.
    const byPerson = await thread('Marked by Ada', 'member', 1)
    // Its teammate declared it done: told once, by the thread.
    const byTeammate = await thread('Declared by Sam', 'teammate', 2)
    const items = (
      await workspaceItems(scope, [{ id: ids.member, role: 'owner', notify: 'finished' }], now)
    ).items.get(ids.member)!
    assert.deepEqual(
      items.filter((i) => i.tag === byPerson.id).map((i) => i.title),
      ['Pull request merged'],
    )
    assert.deepEqual(
      items.filter((i) => i.tag === byTeammate.id).map((i) => i.title),
      ['Sam finished'],
    )
  })
})
