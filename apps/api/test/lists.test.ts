import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'

// Lists (src/lists.ts, docs/lists.md) against the API's development database (apps/api/.env), in
// an organization of its own removed at the end; skipped when no database answers:
// - lines handed to a teammate get their markers in the file, their rows, and one thread that
//   carries them, whose teammate is told them (ThreadSpec.items);
// - a list shows each line's threads and where it stands;
// - a teammate reads a list, ticks a line by its text, adds one under another, attaches lines;
// - a merged pull request ticks the items it closes, not those it is only part of;
// - a person unticks one; a line removed from the file shows as gone, its thread still naming it.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL || undefined
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1 from "ListItem" limit 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

type Sent = { type: string; [key: string]: unknown }

const until = async (check: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${what}`)
}

const CHECKLIST = [
  '# Launch',
  '',
  '## Tech',
  '',
  '* [ ] Neon backups: 7 days and a tested restore',
  '* [ ] Documented rollback',
  '* [ ] Light load test',
  '',
  '## Security',
  '',
  '* [ ] SECURITY.md and security.txt',
  '* [x] Secret scan of the whole history',
  '',
].join('\n')

describe('lists', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<
    'org' | 'user' | 'member' | 'workspace' | 'computer' | 'runner' | 'riley' | 'file',
    string
  >
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }
  let sent: Sent[]
  let close: () => void
  let lists: typeof import('../src/lists.js')
  let library: typeof import('../src/library.js')
  let riley: { id: string; name: string; libraryAccess: 'read_write' }
  let threadId: string

  const text = async () => {
    const row = await db.document.findFirst({ where: { id: ids.file } })
    return library.documentText(scope, row!)
  }

  before(async () => {
    lists = await import('../src/lists.js')
    library = await import('../src/library.js')
    ids.org = `org-lists-${suffix}`
    ids.user = `user-lists-${suffix}`
    ids.member = `m-lists-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Lists', slug: `lists-${suffix}` },
    })
    await prisma.user.create({
      data: { id: ids.user, name: 'Ada', email: `${ids.user}@test.local` },
    })
    await prisma.member.create({
      data: { id: ids.member, organizationId: ids.org, userId: ids.user, role: 'owner' },
    })
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Lists' } })
    ).id
    scope = { organizationId: ids.org, workspaceId: ids.workspace }
    db = scoped(scope)
    ids.computer = (
      await db.computer.create({
        data: { kind: 'member_machine', memberId: ids.member, name: 'Laptop', status: 'running' },
      } as never)
    ).id
    ids.runner = (
      await db.runner.create({
        data: { computerId: ids.computer, tokenHash: `hash-${suffix}` },
      } as never)
    ).id
    await db.account.create({
      data: {
        memberId: ids.member,
        computerId: ids.computer,
        provider: 'claude_code',
        label: 'Claude',
        status: 'ready',
      },
    } as never)
    const teammate = await db.teammate.create({
      data: { name: `Riley ${suffix}`, libraryAccess: 'read_write' },
    } as never)
    ids.riley = teammate.id
    riley = { id: teammate.id, name: teammate.name, libraryAccess: 'read_write' }
    ids.file = (
      await library.saveLibraryFile(
        db,
        scope,
        { type: 'member', id: ids.member },
        { path: 'Projects/Acme/launch.md', bytes: new TextEncoder().encode(CHECKLIST) },
      )
    ).id
    sent = []
    close = await connect()
  })

  /** Ada's computer, its runner connected: what it is sent goes in `sent`. */
  async function connect() {
    const { runnerSocket } = await import('../src/hub.js')
    const { PROTOCOL_VERSION } = await import('@brigade/contracts')
    const handle = runnerSocket({ id: ids.runner, computerId: ids.computer, ...scope })
    const ws = { send: (raw: string) => sent.push(JSON.parse(raw)), close: () => {} }
    handle.onMessage(
      JSON.stringify({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        version: '0.0.0',
        platform: 'linux-x64',
      }),
      ws as never,
    )
    await until(() => sent.some((m) => m.type === 'welcome'), 'the welcome')
    return () => handle.onClose()
  }

  after(async () => {
    close?.()
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.libraryObject.deleteMany({ where: { organizationId: ids.org } })
    await prisma.libraryObjectFolder.deleteMany({ where: { organizationId: ids.org } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({ where: { id: ids.user } })
  })

  test('lines handed over get their markers, their rows, and one thread that carries them', async () => {
    const picked = [
      { id: 'aaaaaaaaaaaaaaaa', text: 'Neon backups: 7 days and a tested restore' },
      { id: 'bbbbbbbbbbbbbbbb', text: 'Documented rollback' },
    ]
    const { threadIds } = await lists.handOff(db, scope, ids.member, ids.file, {
      teammateId: ids.riley,
      items: picked,
      mode: 'together',
    })
    assert.equal(threadIds.length, 1)
    threadId = threadIds[0]!
    const lines = (await text()).split('\n')
    assert.equal(
      lines[4],
      '* [ ] Neon backups: 7 days and a tested restore <!-- item:aaaaaaaaaaaaaaaa -->',
    )
    assert.equal(lines[5], '* [ ] Documented rollback <!-- item:bbbbbbbbbbbbbbbb -->')
    assert.equal(lines[6], '* [ ] Light load test', 'lines not picked keep no marker')
    const links = await db.listItemThread.findMany({ where: { sessionId: threadId } })
    assert.deepEqual(links.map((l) => l.itemId).sort(), ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'])
    // The teammate is told them with its first prompt, and the message names them.
    await until(
      () =>
        sent.some(
          (m) =>
            m.type === 'thread.prompt' &&
            (m.thread as { sessionId?: string }).sessionId === threadId,
        ),
      'the first prompt',
    )
    const prompt = sent.find(
      (m) =>
        m.type === 'thread.prompt' && (m.thread as { sessionId?: string }).sessionId === threadId,
    )!
    const items = (prompt.thread as { items?: { id: string; text: string; done: boolean }[] }).items
    assert.deepEqual(
      items?.map((i) => [i.id, i.text, i.done]),
      [
        ['aaaaaaaaaaaaaaaa', 'Neon backups: 7 days and a tested restore', false],
        ['bbbbbbbbbbbbbbbb', 'Documented rollback', false],
      ],
    )
    assert.match(String(prompt.text), /Please take these items of @\[Projects\/Acme\/launch\.md\]/)
    assert.match(String(prompt.text), /- Documented rollback/)
    // The sidebar shows the thread under its list.
    assert.deepEqual((await lists.threadLists(db, [threadId])).get(threadId), {
      documentId: ids.file,
      title: 'Launch',
    })
  })

  test('a pinned list sits under Pinned with its threads, in one order with pinned threads', async () => {
    const member = { ...scope, memberId: ids.member }
    // A thread pinned first, then the list: the list goes after it.
    await db.threadPin.create({
      data: { ...scope, memberId: ids.member, sessionId: threadId, position: 0 },
    } as never)
    await lists.pinList(db, member, ids.file)
    await lists.pinList(db, member, ids.file)
    assert.deepEqual(
      (await lists.pinnedLists(db, ids.member)).map((l) => [l.documentId, l.title, l.position]),
      [[ids.file, 'Launch', 1]],
      'pinned once, after the pinned thread, with its title',
    )
    assert.equal(await lists.nextPinPosition(db, ids.member), 2)
    assert.deepEqual(await lists.pinnedListThreads(db, ids.member), [threadId])
    // A newer thread on 200 of its items takes one place, not 200: the older one stays.
    const newer = await db.session.create({
      data: {
        teammateId: ids.riley,
        startedByMemberId: ids.member,
        computerId: ids.computer,
        title: 'On many items',
        status: 'idle',
      },
    } as never)
    const many = Array.from({ length: 200 }, (_, i) => ({
      ...scope,
      id: `pinned-${suffix}-${i}`,
      documentId: ids.file,
      text: `Item ${i}`,
    }))
    await db.listItem.createMany({ data: many })
    await db.listItemThread.createMany({
      data: many.map((item) => ({ ...scope, itemId: item.id, sessionId: newer.id })),
    })
    assert.deepEqual(
      (await lists.pinnedListThreads(db, ids.member)).sort(),
      [newer.id, threadId].sort(),
    )
    await db.listItem.deleteMany({ where: { id: { in: many.map((i) => i.id) } } })
    await db.session.deleteMany({ where: { id: newer.id } })
    await assert.rejects(lists.pinList(db, member, 'no-such-file'), /No Markdown file/)
    await db.threadPin.deleteMany({ where: { memberId: ids.member } })
    await db.listPin.deleteMany({ where: { memberId: ids.member } })
    assert.deepEqual(await lists.pinnedListThreads(db, ids.member), [])
  })

  test('a list shows its lines with their threads and where each stands', async () => {
    const detail = await lists.listDetail(db, scope, ids.file)
    assert.equal(detail.title, 'Launch')
    assert.equal(detail.total, 5)
    assert.equal(detail.done, 1)
    assert.deepEqual(
      detail.items.map((i) => [i.id, i.section, i.threads.map((t) => t.id)]),
      [
        ['aaaaaaaaaaaaaaaa', 'Tech', [threadId]],
        ['bbbbbbbbbbbbbbbb', 'Tech', [threadId]],
      ],
    )
    await db.session.updateMany({ where: { id: threadId }, data: { status: 'waiting' } })
    const waiting = await lists.listDetail(db, scope, ids.file)
    assert.deepEqual(
      waiting.items.map((i) => i.state),
      ['needs_you', 'needs_you'],
    )
    assert.equal(waiting.needsYou, 2)
    const [summary] = await lists.listSummaries(db, scope)
    assert.equal(summary?.documentId, ids.file)
    assert.equal(summary?.next.length, 2)
    assert.equal(summary?.projectId, null)
    // Lists groups a list under the project whose folder holds it.
    const acme = await db.project.create({
      data: { name: 'Acme', folder: 'Projects/Acme' },
    } as never)
    const [grouped] = await lists.listSummaries(db, scope)
    assert.equal(grouped?.projectId, acme.id)
    await db.project.delete({ where: { id: acme.id } })
    await db.session.updateMany({ where: { id: threadId }, data: { status: 'idle' } })
  })

  test('a teammate reads a list, ticks a line by its text, adds one under another, attaches lines', async () => {
    const session = { id: threadId }
    const read = (await lists.handleListCall(db, scope, session, riley, {
      name: 'list_items',
      path: 'Projects/Acme/launch.md',
    })) as { lines: { id: string | null; text: string; threads?: string[] }[] }
    assert.equal(read.lines.length, 5)
    assert.equal(read.lines[0]!.id, 'aaaaaaaaaaaaaaaa')
    assert.equal(read.lines[2]!.id, null)

    const ticked = (await lists.handleListCall(db, scope, session, riley, {
      name: 'complete_item',
      item: 'SECURITY.md',
      path: 'Projects/Acme/launch.md',
      note: 'Published, 29 Oct',
    })) as { ticked: { id: string; done: boolean } }
    assert.equal(ticked.ticked.done, true)
    const line = (await text()).split('\n')[10]!
    assert.match(
      line,
      /^\* \[x\] SECURITY\.md and security\.txt \*Published, 29 Oct\* <!-- item:[a-z0-9]{16} -->$/,
    )
    const row = await db.listItem.findFirst({ where: { id: ticked.ticked.id } })
    assert.equal(row?.doneByType, 'teammate')
    assert.equal(row?.doneById, ids.riley)

    const added = (await lists.handleListCall(db, scope, session, riley, {
      name: 'add_item',
      path: 'Projects/Acme/launch.md',
      text: 'Restore drill on a throwaway branch',
      after: 'aaaaaaaaaaaaaaaa',
      nested: true,
    })) as { added: { id: string } }
    assert.equal(
      (await text()).split('\n')[5],
      `  * [ ] Restore drill on a throwaway branch <!-- item:${added.added.id} -->`,
    )
    assert.ok(
      await db.listItemThread.findFirst({ where: { itemId: added.added.id, sessionId: threadId } }),
    )

    const linked = (await lists.handleListCall(db, scope, session, riley, {
      name: 'link_items',
      path: 'Projects/Acme/launch.md',
      items: ['light load'],
    })) as { linked: { id: string }[] }
    assert.equal(linked.linked.length, 1)
    assert.match((await text()).split('\n')[7]!, /^\* \[ \] Light load test <!-- item:/)

    const unknown = (await lists.handleListCall(db, scope, session, riley, {
      name: 'complete_item',
      item: 'Nothing like this',
      path: 'Projects/Acme/launch.md',
    })) as { error: string }
    assert.match(unknown.error, /No checklist line matches/)

    // A teammate kept from the folder reads nothing of it.
    await db.libraryFolder.create({ data: { path: 'Projects/Acme', restricted: true } } as never)
    const kept = (await lists.handleListCall(
      db,
      scope,
      session,
      { ...riley, id: 'someone' },
      {
        name: 'list_items',
        path: 'Projects/Acme/launch.md',
      },
    )) as { error: string }
    assert.match(kept.error, /may not read/)
    await db.libraryFolder.deleteMany({ where: { path: 'Projects/Acme' } })
  })

  test('a merged pull request ticks the items it closes, not those it is only part of', async () => {
    const pull = await db.pullRequest.create({
      data: {
        repository: 'acme/app',
        number: 491,
        title: 'Rollback runbook',
        headRef: 'rollback',
        baseRef: 'main',
        sessionId: threadId,
        authorTeammateId: ids.riley,
      },
    } as never)
    await lists.linkPullItems(db, pull.id, threadId, ids.riley, {
      closes: ['bbbbbbbbbbbbbbbb'],
      partOf: ['aaaaaaaaaaaaaaaa', 'not-an-item'],
    })
    const before = await lists.listDetail(db, scope, ids.file)
    assert.deepEqual(
      before.items.find((i) => i.id === 'bbbbbbbbbbbbbbbb')?.pulls.map((p) => [p.number, p.closes]),
      [[491, true]],
    )
    assert.equal(before.items.find((i) => i.id === 'bbbbbbbbbbbbbbbb')?.state, 'in_progress')
    await db.pullRequest.updateMany({ where: { id: pull.id }, data: { state: 'merged' } })
    await lists.settleItemsOnMerge(db, scope, { id: pull.id, number: 491, sessionId: threadId })
    const lines = (await text()).split('\n')
    assert.match(
      lines[6]!,
      /^\* \[x\] Documented rollback \*PR #491, \d+ \w+\* <!-- item:bbbbbbbbbbbbbbbb -->$/,
    )
    assert.match(lines[4]!, /^\* \[ \] Neon backups/, 'only part of it: still open')
  })

  test('a person unticks an item; a line removed from the file shows as gone', async () => {
    await lists.setItemDone(
      db,
      scope,
      { type: 'member', id: ids.member },
      'bbbbbbbbbbbbbbbb',
      false,
    )
    assert.match((await text()).split('\n')[6]!, /^\* \[ \] Documented rollback/)
    const row = await db.listItem.findFirst({ where: { id: 'bbbbbbbbbbbbbbbb' } })
    assert.equal(row?.doneAt, null)

    const without = (await text())
      .split('\n')
      .filter((l) => !l.includes('item:aaaaaaaaaaaaaaaa'))
      .join('\n')
    await library.saveLibraryFile(
      db,
      scope,
      { type: 'member', id: ids.member },
      { path: 'Projects/Acme/launch.md', bytes: new TextEncoder().encode(without) },
    )
    const items = await lists.threadItems(db, scope, threadId)
    const gone = items.find((i) => i.id === 'aaaaaaaaaaaaaaaa')
    assert.equal(gone?.missing, true)
    assert.equal(gone?.text, 'Neon backups: 7 days and a tested restore')
    await assert.rejects(
      lists.setItemDone(db, scope, { type: 'member', id: ids.member }, 'aaaaaaaaaaaaaaaa', true),
      /no longer in its list/,
    )
  })
})

// What a review found (PR #487), each through the code that was fixed:
// - two ticks at once in one file both land (the file's lock);
// - an id the editor gives that another workspace's item has is never taken over;
// - a thread's items and a pull request's closes keep to the teammate's folder access;
// - a tick a merge could not make is tried again;
// - a line copied with its marker is a new line, not the same item.
describe('lists, under review', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<'org' | 'user' | 'member' | 'workspace' | 'other', string>
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }
  let lists: typeof import('../src/lists.js')
  let library: typeof import('../src/library.js')
  let teammate: { id: string; name: string; libraryAccess: 'read_write' }
  let sessionId: string
  const actor = () => ({ type: 'member' as const, id: ids.member })
  const save = (path: string, text: string, inScope = scope, inDb = db) =>
    library.saveLibraryFile(inDb, inScope, actor(), {
      path,
      bytes: new TextEncoder().encode(text),
    })
  const read = async (id: string, inScope = scope, inDb = db) =>
    library.documentText(inScope, (await inDb.document.findFirst({ where: { id } }))!)

  before(async () => {
    lists = await import('../src/lists.js')
    library = await import('../src/library.js')
    ids.org = `org-lists-review-${suffix}`
    ids.user = `user-lists-review-${suffix}`
    ids.member = `m-lists-review-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Review', slug: `lists-review-${suffix}` },
    })
    await prisma.user.create({
      data: { id: ids.user, name: 'Ada', email: `${ids.user}@test.local` },
    })
    await prisma.member.create({
      data: { id: ids.member, organizationId: ids.org, userId: ids.user, role: 'owner' },
    })
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Review' } })
    ).id
    ids.other = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Other' } })
    ).id
    scope = { organizationId: ids.org, workspaceId: ids.workspace }
    db = scoped(scope)
    const made = await db.teammate.create({
      data: { name: `Riley ${suffix}`, libraryAccess: 'read_write' },
    } as never)
    teammate = { id: made.id, name: made.name, libraryAccess: 'read_write' }
    const computer = await db.computer.create({
      data: { kind: 'member_machine', memberId: ids.member, name: 'Laptop', status: 'running' },
    } as never)
    sessionId = (
      await db.session.create({
        data: {
          teammateId: made.id,
          computerId: computer.id,
          startedByMemberId: ids.member,
          title: 'Review',
        },
      } as never)
    ).id
  })

  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: [ids.workspace, ids.other] } } })
    await prisma.libraryObject.deleteMany({ where: { organizationId: ids.org } })
    await prisma.libraryObjectFolder.deleteMany({ where: { organizationId: ids.org } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({ where: { id: ids.user } })
  })

  test('two ticks at once in one file both land', async () => {
    const a = 'raceaaaaaaaaaaaa'
    const b = 'racebbbbbbbbbbbb'
    const file = await save(
      'Race/list.md',
      `* [ ] First <!-- item:${a} -->\n* [ ] Second <!-- item:${b} -->\n`,
    )
    await db.listItem.createMany({
      data: [
        { id: a, documentId: file.id, text: 'First' },
        { id: b, documentId: file.id, text: 'Second' },
      ],
    } as never)
    // Each tick's read of the file waits for the other's, or a second at most: without the lock
    // both read the same text, and the second write loses the first tick.
    let arrivals = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const racing = new Proxy(db, {
      get(target, key) {
        if (key !== 'document') return Reflect.get(target, key)
        return new Proxy(target.document, {
          get(delegate, op) {
            if (op !== 'findFirst') return Reflect.get(delegate, op)
            return async (args: { where?: { id?: string; kind?: string } }) => {
              const found = await delegate.findFirst(args as never)
              if (args.where?.id === file.id && args.where.kind === 'library') {
                if (++arrivals === 2) release()
                await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 1_000))])
              }
              return found
            }
          },
        })
      },
    }) as typeof db
    await Promise.all([
      lists.setItemDone(racing, scope, actor(), a, true),
      lists.setItemDone(racing, scope, actor(), b, true),
    ])
    assert.equal(((await read(file.id)).match(/\[x\]/g) ?? []).length, 2)
  })

  test("an id another workspace's item has is never taken over", async () => {
    const secret = await save(
      'Restricted/release.md',
      '* [ ] Confidential release <!-- item:secretitem123456 -->\n',
    )
    await db.listItem.create({
      data: { id: 'secretitem123456', documentId: secret.id, text: 'Confidential release' },
    } as never)
    const otherScope = { organizationId: ids.org, workspaceId: ids.other }
    const otherDb = scoped(otherScope)
    const otherTeammate = await otherDb.teammate.create({ data: { name: 'Other' } } as never)
    const otherComputer = await otherDb.computer.create({
      data: { kind: 'member_machine', memberId: ids.member, name: 'Other' },
    } as never)
    const otherThread = await otherDb.session.create({
      data: {
        teammateId: otherTeammate.id,
        computerId: otherComputer.id,
        startedByMemberId: ids.member,
        title: 'Other',
      },
    } as never)
    const copy = await save('Copied.md', '* [ ] A public copy\n', otherScope, otherDb)
    const linked = await lists.linkToThread(otherDb, otherScope, ids.member, copy.id, {
      sessionId: otherThread.id,
      items: [{ id: 'secretitem123456', text: 'A public copy' }],
    })
    assert.notEqual(linked.itemIds[0], 'secretitem123456')
    const items = await lists.specItems(otherDb, otherThread.id)
    assert.deepEqual(
      items.map((i) => [i.path, i.text]),
      [['Copied.md', 'A public copy']],
    )
    assert.match(await read(copy.id, otherScope, otherDb), new RegExp(`item:${linked.itemIds[0]}`))
    // The first workspace's item is as it was.
    const original = await prisma.listItem.findFirst({ where: { id: 'secretitem123456' } })
    assert.equal(original?.documentId, secret.id)
  })

  test("a thread's items and a pull request's closes keep to the teammate's folder access", async () => {
    const file = await save('Restricted/plan.md', '* [ ] Ship it <!-- item:planitem12345678 -->\n')
    await db.listItem.create({
      data: { id: 'planitem12345678', documentId: file.id, text: 'Ship it' },
    } as never)
    await db.listItemThread.create({
      data: { itemId: 'planitem12345678', sessionId },
    } as never)
    // Readable, not writable: a pull request is only part of the work there.
    const folder = await db.libraryFolder.create({
      data: { path: 'Restricted', restricted: true },
    } as never)
    await db.libraryFolderGrant.create({
      data: { folderId: folder.id, teammateId: teammate.id, access: 'read' },
    } as never)
    const readOnly = await db.pullRequest.create({
      data: {
        repository: 'acme/app',
        number: 11,
        title: 'Ship',
        headRef: 'ship',
        baseRef: 'main',
        sessionId,
        authorTeammateId: teammate.id,
      },
    } as never)
    await lists.linkPullItems(db, readOnly.id, sessionId, teammate.id, {
      closes: ['planitem12345678'],
    })
    const link = await db.listItemPull.findFirst({ where: { pullRequestId: readOnly.id } })
    assert.equal(link?.closes, false)
    // Writable when the pull request was opened, not when it merged: nothing is ticked.
    await db.libraryFolderGrant.updateMany({
      where: { folderId: folder.id },
      data: { access: 'read_write' },
    })
    const revoked = await db.pullRequest.create({
      data: {
        repository: 'acme/app',
        number: 12,
        title: 'Ship again',
        headRef: 'ship-2',
        baseRef: 'main',
        sessionId,
        authorTeammateId: teammate.id,
        state: 'merged',
      },
    } as never)
    await lists.linkPullItems(db, revoked.id, sessionId, teammate.id, {
      closes: ['planitem12345678'],
    })
    assert.equal(
      (await db.listItemPull.findFirst({ where: { pullRequestId: revoked.id } }))?.closes,
      true,
    )
    await db.libraryFolderGrant.deleteMany({ where: { folderId: folder.id } })
    await lists.settleItemsOnMerge(db, scope, { id: revoked.id, number: 12, sessionId })
    assert.match(await read(file.id), /^\* \[ \] Ship it/)
    // Out of its reach now: neither its tools nor its instructions name the item.
    const out = (await lists.handleListCall(
      db,
      scope,
      { id: sessionId },
      { ...teammate, libraryAccess: 'read_write' },
      {
        name: 'list_items',
      },
    )) as { items: unknown[] }
    assert.deepEqual(out.items, [])
    await db.libraryFolder.deleteMany({ where: { path: 'Restricted' } })
  })

  test('a tick a merge could not make is tried again', async () => {
    const file = await save('Retry/list.md', '* [ ] Deploy <!-- item:retryitem1234567 -->\n')
    await db.listItem.create({
      data: { id: 'retryitem1234567', documentId: file.id, text: 'Deploy' },
    } as never)
    const pull = await db.pullRequest.create({
      data: {
        repository: 'acme/app',
        number: 21,
        title: 'Deploy',
        headRef: 'deploy',
        baseRef: 'main',
        sessionId,
        authorTeammateId: teammate.id,
        state: 'merged',
      },
    } as never)
    await lists.linkPullItems(db, pull.id, sessionId, teammate.id, { closes: ['retryitem1234567'] })
    const failing = new Proxy(db, {
      get(target, key) {
        if (key !== 'document') return Reflect.get(target, key)
        return new Proxy(target.document, {
          get(delegate, op) {
            if (op !== 'findFirst') return Reflect.get(delegate, op)
            return async (args: { where?: { id?: string } }) => {
              if (args.where?.id === file.id) throw new Error('storage is out')
              return delegate.findFirst(args as never)
            }
          },
        })
      },
    }) as typeof db
    await lists.settleItemsOnMerge(failing, scope, { id: pull.id, number: 21, sessionId })
    assert.match(await read(file.id), /^\* \[ \] Deploy/)
    assert.equal(
      (await db.listItemPull.findFirst({ where: { pullRequestId: pull.id } }))?.settledAt,
      null,
    )
    await lists.sweepListMerges()
    assert.match(await read(file.id), /^\* \[x\] Deploy \*PR #21, /)
    assert.ok((await db.listItemPull.findFirst({ where: { pullRequestId: pull.id } }))?.settledAt)
  })

  test('a line copied with its marker is a new line, and gets an id of its own when handed over', async () => {
    const file = await save(
      'Copy/list.md',
      '* [ ] Original <!-- item:dupitem123456789 -->\n* [ ] Copied and reworded <!-- item:dupitem123456789 -->\n',
    )
    await db.listItem.create({
      data: { id: 'dupitem123456789', documentId: file.id, text: 'Original' },
    } as never)
    await lists.setItemDone(db, scope, actor(), 'dupitem123456789', true)
    const detail = await lists.listDetail(db, scope, file.id)
    assert.deepEqual(
      detail.items.map((i) => [i.text, i.done]),
      [['Original', true]],
    )
    // The editor hands the copy over with the marker it carries.
    const linked = await lists.linkToThread(db, scope, ids.member, file.id, {
      sessionId,
      items: [{ id: 'dupitem123456789', text: 'Copied and reworded' }],
    })
    assert.notEqual(linked.itemIds[0], 'dupitem123456789')
    const lines = (await read(file.id)).split('\n')
    assert.equal(lines[0], '* [x] Original <!-- item:dupitem123456789 -->')
    assert.equal(lines[1], `* [ ] Copied and reworded <!-- item:${linked.itemIds[0]} -->`)
  })

  test('five changes of one file at once all land, on a pool of three connections', async () => {
    const { newPrismaClient, withPrismaClient } = await import('../src/db.js')
    const client = newPrismaClient(process.env.DATABASE_URL!, { max: 3 })
    const ids5 = [
      'pool000000000001',
      'pool000000000002',
      'pool000000000003',
      'pool000000000004',
      'pool000000000005',
    ]
    const file = await save(
      'Pool/list.md',
      ids5.map((id, i) => `* [ ] Line ${i} <!-- item:${id} -->`).join('\n'),
    )
    await db.listItem.createMany({
      data: ids5.map((id, i) => ({ id, documentId: file.id, text: `Line ${i}` })),
    } as never)
    try {
      await withPrismaClient(client, () =>
        Promise.all(ids5.map((id) => lists.setItemDone(scoped(scope), scope, actor(), id, true))),
      )
    } finally {
      await client.$disconnect()
    }
    assert.equal(((await read(file.id)).match(/\[x\]/g) ?? []).length, 5)
  })

  test('a holder past its lease writes nothing more, and the next one takes the lock', async () => {
    const file = await save('Lease/list.md', '* [ ] Slow\n')
    const order: string[] = []
    const slow = library.withLibraryLock(
      scope,
      file.id,
      async (lease) => {
        order.push('slow in')
        await new Promise((resolve) => setTimeout(resolve, 700))
        lease.check()
        order.push('slow wrote')
      },
      { leaseMs: 300 },
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    const next = library.withLibraryLock(scope, file.id, async () => {
      order.push('next in')
    })
    await assert.rejects(slow, /took too long/)
    await next
    assert.deepEqual(order, ['slow in', 'next in'])
  })

  test("a line pasted with another workspace's marker gets an id of its own", async () => {
    const source = await save(
      'Original.md',
      '* [ ] Copied content <!-- item:sharedmarker12345 -->\n',
    )
    await db.listItem.create({
      data: { id: 'sharedmarker12345', documentId: source.id, text: 'Copied content' },
    } as never)
    const otherScope = { organizationId: ids.org, workspaceId: ids.other }
    const otherDb = scoped(otherScope)
    const otherTeammate = await otherDb.teammate.create({ data: { name: 'Pasted' } } as never)
    const otherComputer = await otherDb.computer.create({
      data: { kind: 'member_machine', memberId: ids.member, name: 'Pasted' },
    } as never)
    const thread = await otherDb.session.create({
      data: {
        teammateId: otherTeammate.id,
        computerId: otherComputer.id,
        startedByMemberId: ids.member,
        title: 'Pasted',
      },
    } as never)
    const copy = await save(
      'Pasted.md',
      '* [ ] Copied content <!-- item:sharedmarker12345 -->\n',
      otherScope,
      otherDb,
    )
    const linked = await lists.linkToThread(otherDb, otherScope, ids.member, copy.id, {
      sessionId: thread.id,
      items: [{ id: 'sharedmarker12345', text: 'Copied content' }],
    })
    assert.notEqual(linked.itemIds[0], 'sharedmarker12345')
    assert.equal(
      (await read(copy.id, otherScope, otherDb)).split('\n')[0],
      `* [ ] Copied content <!-- item:${linked.itemIds[0]} -->`,
    )
    assert.equal(
      (await prisma.listItem.findFirst({ where: { id: 'sharedmarker12345' } }))?.documentId,
      source.id,
    )
  })

  test("a write that outlives its lease does not undo a newer save's bytes", async () => {
    const fs = (await import('node:fs/promises')).default
    const { syncBuiltinESMExports } = await import('node:module')
    const { createHash } = await import('node:crypto')
    const encode = (text: string) => new TextEncoder().encode(text)
    const file = await save('Lease/stall.md', '* [ ] Initial\n')
    const original = fs.writeFile
    let entered!: () => void
    const stalled = new Promise<void>((resolve) => (entered = resolve))
    // The slow save's bucket write starts within its lease, then stalls past it.
    ;(fs as { writeFile: unknown }).writeFile = async (
      ...args: Parameters<typeof fs.writeFile>
    ) => {
      const bytes = args[1]
      if (
        String(args[0]).includes(`/library-objects/${file.id}/`) &&
        bytes instanceof Uint8Array &&
        new TextDecoder().decode(bytes).includes('Slow stale edit')
      ) {
        entered()
        await new Promise((resolve) => setTimeout(resolve, 2500))
      }
      return original(...args)
    }
    syncBuiltinESMExports()
    try {
      const slow = library.withLibraryLock(
        scope,
        file.id,
        (lease) =>
          library.saveLibraryFile(
            db,
            scope,
            actor(),
            { path: 'Lease/stall.md', bytes: encode('* [x] Slow stale edit\n') },
            {},
            { lease },
          ),
        { leaseMs: 1500 },
      )
      // Its failure is taken as it comes: the newer save may still be running then.
      const failed = slow.then(
        () => null,
        (error: unknown) => error,
      )
      await stalled
      await new Promise((resolve) => setTimeout(resolve, 1600))
      await save('Lease/stall.md', '* [x] New winning edit\n')
      assert.match(String(await failed), /took too long/)
    } finally {
      ;(fs as { writeFile: unknown }).writeFile = original
      syncBuiltinESMExports()
    }
    const row = await db.document.findFirst({ where: { id: file.id } })
    const bytes = await read(file.id)
    assert.equal(row?.text, '* [x] New winning edit\n')
    assert.equal(bytes, '* [x] New winning edit\n')
    assert.equal(createHash('sha256').update(bytes).digest('hex'), row?.sha256)
  })

  /** A save under a 1.5 s lease whose bucket write stalls past it while a newer save lands. */
  async function lateSave(path: string, padding: string) {
    const fs = (await import('node:fs/promises')).default
    const { syncBuiltinESMExports } = await import('node:module')
    const encode = (text: string) => new TextEncoder().encode(text + padding)
    const file = await save(path, '* [ ] Initial\n' + padding)
    const original = fs.writeFile
    let entered!: () => void
    const stalled = new Promise<void>((resolve) => (entered = resolve))
    const has = (bytes: unknown, text: string) =>
      bytes instanceof Uint8Array && new TextDecoder().decode(bytes.subarray(0, 64)).includes(text)
    ;(fs as { writeFile: unknown }).writeFile = async (
      ...args: Parameters<typeof fs.writeFile>
    ) => {
      if (
        String(args[0]).includes(`/library-objects/${file.id}/`) &&
        has(args[1], 'Slow stale edit')
      ) {
        entered()
        await new Promise((resolve) => setTimeout(resolve, 2500))
      }
      return original(...args)
    }
    syncBuiltinESMExports()
    try {
      const slow = library.withLibraryLock(
        scope,
        file.id,
        (lease) =>
          library.saveLibraryFile(
            db,
            scope,
            actor(),
            { path, bytes: encode('* [x] Slow stale edit\n') },
            {},
            { lease },
          ),
        { leaseMs: 1500 },
      )
      // Its failure is taken as it comes: the newer save may still be running then.
      const failed = slow.then(
        () => null,
        (error: unknown) => error,
      )
      await stalled
      await new Promise((resolve) => setTimeout(resolve, 1600))
      await library.saveLibraryFile(db, scope, actor(), {
        path,
        bytes: encode('* [x] New winning edit\n'),
      })
      assert.match(String(await failed), /took too long/)
    } finally {
      ;(fs as { writeFile: unknown }).writeFile = original
      syncBuiltinESMExports()
    }
    return file
  }

  const consistent = async (id: string) => {
    const { createHash } = await import('node:crypto')
    const row = await db.document.findFirst({ where: { id } })
    const bytes = await read(id)
    assert.match(bytes.slice(0, 30), /New winning edit/)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), row?.sha256)
    assert.equal(row?.bytesStaleAt, null)
  }

  test("a late write to a file larger than the row's text leaves the newer save's bytes", async () => {
    const file = await lateSave('Lease/large.md', '\n' + 'x'.repeat(400_001))
    await consistent(file.id)
  })
})
