import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// Later (src/later.ts) against a real database: the local one of apps/api/.env, in an
// organization of its own that it removes at the end. Without a database to reach, it is skipped.
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

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select 1 from "ThreadLater" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { prisma, scoped } = await import('../src/db.js')
const { bringBackFromLater, laterKey, latersIn, latersOf, setLater } =
  await import('../src/later.js')
const { setThreadArchived } = await import('../src/thread-archive.js')
const { homeFor } = await import('../src/home.js')
const { needsAttention } = await import('../src/pull-requests.js')

const id = randomUUID().slice(0, 8)
const ids = {
  organization: `org-later-${id}`,
  users: [`user-later-${id}`, `user-later-b-${id}`],
  members: [`mem-later-${id}`, `mem-later-b-${id}`],
}
let scope: { organizationId: string; workspaceId: string }
let teammateId: string
let computerId: string

before(async () => {
  if (skip) return
  await prisma.organization.create({
    data: { id: ids.organization, name: 'Later test', slug: ids.organization },
  })
  for (const [i, userId] of ids.users.entries()) {
    await prisma.user.create({
      data: { id: userId, name: `Member ${i}`, email: `${userId}@example.com` },
    })
    await prisma.member.create({
      data: { id: ids.members[i]!, organizationId: ids.organization, userId, role: 'owner' },
    })
  }
  const workspace = await prisma.workspace.create({
    data: { organizationId: ids.organization, name: 'Later test' },
  })
  scope = { organizationId: ids.organization, workspaceId: workspace.id }
  teammateId = (await prisma.teammate.create({ data: { ...scope, name: 'Riley' } })).id
  computerId = (
    await prisma.computer.create({
      data: { ...scope, kind: 'member_machine', memberId: ids.members[0], name: 'Laptop' },
    })
  ).id
})

after(async () => {
  if (skip) return
  await prisma.organization.deleteMany({ where: { id: ids.organization } })
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } })
  await prisma.$disconnect()
})

let titles = 0
const thread = (parentId?: string) =>
  prisma.session.create({
    data: {
      ...scope,
      teammateId,
      startedByMemberId: ids.members[0]!,
      computerId,
      title: `Thread ${++titles}`,
      status: 'idle',
      origin: parentId ? 'child' : 'member',
      ...(parentId ? { parentId, parentTeammateId: teammateId } : {}),
    },
  })
const as = (member: number) => ({ ...scope, memberId: ids.members[member]! })
const later = (member: number) => latersOf(scoped(scope), ids.members[member]!)
/** The scoped write hooks run after the write, not awaited: let them finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 200))

test(
  'putting a thread away for later is each member’s own, and Move back undoes it',
  { skip },
  async () => {
    const t = await thread()
    await setLater(scoped(scope), as(0), t, true)
    assert.ok((await later(0)).has(t.id))
    assert.equal((await later(1)).has(t.id), false)
    assert.ok((await latersIn(scope.workspaceId)).has(laterKey(ids.members[0]!, t.id)))
    await setLater(scoped(scope), as(0), t, false)
    assert.equal((await later(0)).has(t.id), false)
  },
)

test(
  'a ticket opened in it, or in one of its children, brings it back for everyone',
  { skip },
  async () => {
    const t = await thread()
    const child = await thread(t.id)
    await setLater(scoped(scope), as(0), t, true)
    await setLater(scoped(scope), as(1), t, true)
    await scoped(scope).ticket.create({
      data: { ...scope, sessionId: child.id, type: 'question', title: 'Which plan?' },
    } as never)
    await settle()
    assert.equal((await later(0)).has(t.id), false)
    assert.equal((await later(1)).has(t.id), false)
  },
)

test('a pull request opened in it brings it back', { skip }, async () => {
  const t = await thread()
  await setLater(scoped(scope), as(0), t, true)
  await scoped(scope).pullRequest.create({
    data: {
      ...scope,
      sessionId: t.id,
      repository: 'acme/web',
      number: titles,
      title: 'Fix',
      headRef: 'fix',
      baseRef: 'main',
    },
  } as never)
  await settle()
  assert.equal((await later(0)).has(t.id), false)
})

test(
  'a message or a turn brings it back (what the hub calls on its events)',
  { skip },
  async () => {
    const t = await thread()
    await setLater(scoped(scope), as(0), t, true)
    await bringBackFromLater(scope, t.id)
    assert.equal((await later(0)).has(t.id), false)
  },
)

test('archiving it is no longer for later', { skip }, async () => {
  const t = await thread()
  await setLater(scoped(scope), as(0), t, true)
  await setThreadArchived(scope, t.id, true)
  assert.equal((await later(0)).has(t.id), false)
})

test('Home’s threads leave out those put away for later', { skip }, async () => {
  const t = await thread()
  const listed = async () =>
    JSON.stringify(await homeFor(scoped(scope), ids.members[0]!)).includes(t.id)
  await prisma.sessionEvent.create({
    data: {
      ...scope,
      sessionId: t.id,
      seq: 1,
      at: new Date(),
      type: 'turn.completed',
      data: { type: 'turn.completed' },
    },
  } as never)
  assert.ok(await listed())
  await setLater(scoped(scope), as(0), t, true)
  assert.equal(await listed(), false)
})

test(
  'pull requests waiting on a person leave out those of a thread put away, and its children',
  { skip },
  async () => {
    const t = await thread()
    const child = await thread(t.id)
    const other = await thread()
    const pr = (sessionId: string | null, n: number) =>
      prisma.pullRequest.create({
        data: {
          ...scope,
          sessionId,
          repository: 'acme/api',
          number: n,
          title: `PR ${n}`,
          headRef: `b${n}`,
          baseRef: 'main',
          mergeStatus: sessionId ? 'none' : 'stuck',
        },
      } as never)
    await pr(t.id, 101)
    await pr(child.id, 102)
    await pr(other.id, 103)
    await pr(null, 104)
    const numbers = async (putAway: string[]) =>
      (await needsAttention(scoped(scope), putAway))
        .filter((p) => p.repository === 'acme/api')
        .map((p) => p.number)
        .sort()
    assert.deepEqual(await numbers([]), [101, 102, 103, 104])
    assert.deepEqual(await numbers([t.id]), [103, 104])
  },
)
