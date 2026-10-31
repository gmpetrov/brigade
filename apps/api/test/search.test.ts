import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import type { SearchResult } from '@brigade/contracts'
import { Hono } from 'hono'

// The dashboard's ⌘K search (src/routes/search.ts) against the API's development database
// (apps/api/.env), in two organizations of its own removed at the end; skipped when no database
// answers:
// - a name found despite a typo ("launch cecklist" finds launch-checklist.md), through pg_trgm;
// - a file named as typed scores above threads that only share a word with it;
// - another workspace's rows never turn up, whatever matches;
// - punctuation separates words, as in a file's name, and matches nothing on its own.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL || undefined
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1 from pg_extension where extname = 'pg_trgm'`.then(
    (rows) => (rows as unknown[]).length > 0,
  ),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

describe('search', { skip: !database && 'no database answers, or without pg_trgm' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const orgs = [`org-search-${suffix}`, `org-search-other-${suffix}`]
  const user = `user-search-${suffix}`
  const workspaces: string[] = []
  let app: Hono
  let restore: () => void

  /** A workspace with a teammate, a computer and these threads and files. */
  async function workspace(org: string, threads: string[], files: string[]) {
    await prisma.organization.create({ data: { id: org, name: org, slug: org } })
    const member = (
      await prisma.member.create({
        data: { id: `m-${org}`, organizationId: org, userId: user, role: 'owner' },
      })
    ).id
    const id = (await prisma.workspace.create({ data: { organizationId: org, name: org } })).id
    workspaces.push(id)
    const db = scoped({ organizationId: org, workspaceId: id })
    const computer = (
      await db.computer.create({
        data: { kind: 'member_machine', memberId: member, name: 'Laptop', status: 'running' },
      } as never)
    ).id
    const teammate = (await db.teammate.create({ data: { name: 'Riley' } } as never)).id
    for (const title of threads)
      await db.session.create({
        data: { title, teammateId: teammate, startedByMemberId: member, computerId: computer },
      } as never)
    for (const path of files)
      await db.document.create({ data: { path, contentType: 'text/markdown', size: 0 } } as never)
    return id
  }

  before(async () => {
    const { auth } = await import('../src/auth.js')
    const { search } = await import('../src/routes/search.js')
    await prisma.user.create({ data: { id: user, name: 'Ada', email: `${user}@test.local` } })
    await workspace(
      orgs[0]!,
      ['Checklist release officielle', 'Oubli de la checklist ?', 'Launch checklist review'],
      ['Projects/Brigade/launch-checklist.md', 'Projects/Brigade/pricing.md', 'notes/100% done.md'],
    )
    // Same names elsewhere: never shown here.
    await workspace(orgs[1]!, ['Launch checklist elsewhere'], ['launch-checklist.md'])
    const getSession = auth.api.getSession
    ;(auth.api as { getSession: unknown }).getSession = async () => ({
      user: { id: user },
      session: {
        id: `session-${suffix}`,
        activeOrganizationId: orgs[0],
        activeWorkspaceId: workspaces[0],
      },
    })
    restore = () => ((auth.api as { getSession: unknown }).getSession = getSession)
    app = new Hono().route('/api/search', search)
  })

  after(async () => {
    restore?.()
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } })
    await prisma.member.deleteMany({ where: { organizationId: { in: orgs } } })
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } })
    await prisma.user.deleteMany({ where: { id: user } })
  })

  async function find(q: string) {
    const response = await app.request(`/api/search?q=${encodeURIComponent(q)}`)
    assert.equal(response.status, 200, await response.clone().text())
    return (await response.json()) as SearchResult[]
  }
  const titles = (results: SearchResult[], kind: SearchResult['kind']) =>
    results.filter((r) => r.kind === kind).map((r) => r.title)

  test('a typo still finds the file, and nothing that lacks a word', async () => {
    const results = await find('launch cecklist')
    assert.deepEqual(titles(results, 'file'), ['Projects/Brigade/launch-checklist.md'])
    assert.deepEqual(titles(results, 'thread'), ['Launch checklist review'])
  })

  test('one word with a typo finds every title close to it', async () => {
    const results = await find('cecklist')
    assert.deepEqual(titles(results, 'thread').sort(), [
      'Checklist release officielle',
      'Launch checklist review',
      'Oubli de la checklist ?',
    ])
    assert.deepEqual(titles(results, 'file'), ['Projects/Brigade/launch-checklist.md'])
  })

  test('the file named as typed scores highest', async () => {
    const results = await find('launch checklist')
    const best = results.reduce((a, b) => (b.score > a.score ? b : a))
    assert.equal(best.kind, 'file')
    assert.equal(best.title, 'Projects/Brigade/launch-checklist.md')
    assert.ok(
      results.filter((r) => r.kind === 'thread').every((r) => r.score < best.score),
      'threads below it',
    )
  })

  test("another workspace's rows never turn up", async () => {
    const results = await find('elsewhere')
    assert.deepEqual(results, [])
    const files = titles(await find('launch checklist'), 'file')
    assert.ok(!files.includes('launch-checklist.md'))
  })

  test('punctuation separates words and matches nothing on its own', async () => {
    assert.deepEqual(titles(await find('launch-checklist'), 'file'), [
      'Projects/Brigade/launch-checklist.md',
    ])
    assert.deepEqual(titles(await find('100% done'), 'file'), ['notes/100% done.md'])
    assert.deepEqual(await find('%_'), [])
  })
})
