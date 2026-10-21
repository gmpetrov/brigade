import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import pg from 'pg'

// A workspace's logo (src/workspace-settings.ts) against a real database: changes that cross
// never leave the row naming bytes that are gone, nor bytes no row names. The local one of
// apps/api/.env, in an organization of its own that it removes at the end. Without a
// database to reach, it is skipped.
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
// The logos' bytes, in a folder of the test's own.
process.env.BUCKET_DIR = mkdtempSync(join(tmpdir(), 'workspace-logo-'))

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select "logo" from "Workspace" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { prisma } = await import('../src/db.js')
const { listObjects, workspaceLogoKey } = await import('../src/bucket.js')
const { readLogo } = await import('../src/logos.js')
const { updateWorkspace } = await import('../src/workspace-settings.js')

const id = randomUUID().slice(0, 8)
const ids = { organization: `org-logo-${id}`, user: `user-logo-${id}`, member: `mem-logo-${id}` }
let scope: Parameters<typeof updateWorkspace>[0]

const PNG = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64')}`
const SVG = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64')}`

before(async () => {
  if (skip) return
  await prisma.organization.create({
    data: { id: ids.organization, name: 'Logo test', slug: ids.organization },
  })
  await prisma.user.create({
    data: { id: ids.user, name: 'Ada', email: `${ids.user}@example.com` },
  })
  await prisma.member.create({
    data: { id: ids.member, organizationId: ids.organization, userId: ids.user, role: 'owner' },
  })
  const workspace = await prisma.workspace.create({
    data: { organizationId: ids.organization, name: 'Logo test' },
  })
  scope = {
    organizationId: ids.organization,
    workspaceId: workspace.id,
    userId: ids.user,
    memberId: ids.member,
    role: 'owner',
  }
})

after(async () => {
  if (skip) return
  await prisma.organization.deleteMany({ where: { id: ids.organization } })
  await prisma.user.deleteMany({ where: { id: ids.user } })
  await prisma.$disconnect()
})

/** The row names bytes that are there, and the bucket keeps nothing else. */
async function consistent() {
  const { logo } = await prisma.workspace.findUniqueOrThrow({ where: { id: scope.workspaceId } })
  const kept = await listObjects(`${scope.organizationId}/${scope.workspaceId}/workspace-logos/`)
  if (!logo) return assert.deepEqual(kept, [])
  assert.ok(await readLogo(workspaceLogoKey(scope, logo), logo), `${logo} is in the bucket`)
  assert.deepEqual(kept, [workspaceLogoKey(scope, logo)])
}

test(
  'a new logo replaces the old one, and removing it leaves nothing behind',
  { skip },
  async () => {
    const first = await updateWorkspace(scope, { logo: PNG })
    assert.match(first.logo!, /\.png$/)
    await consistent()
    const second = await updateWorkspace(scope, { name: 'Renamed', logo: SVG })
    assert.match(second.logo!, /\.svg$/)
    assert.equal(second.name, 'Renamed')
    await consistent()
    assert.equal((await updateWorkspace(scope, { logo: null })).logo, null)
    await consistent()
  },
)

test(
  'an upload and a removal that cross leave the row and the bucket agreeing',
  { skip },
  async () => {
    for (let round = 0; round < 10; round++) {
      await updateWorkspace(scope, { logo: PNG }).catch(() => undefined)
      const results = await Promise.allSettled([
        updateWorkspace(scope, { logo: round % 2 ? SVG : PNG }),
        updateWorkspace(scope, { logo: null }),
        updateWorkspace(scope, { logo: SVG }),
      ])
      for (const r of results)
        if (r.status === 'rejected') assert.match(String(r.reason), /just changed/)
      await consistent()
    }
  },
)

test('a rename alone does not wait on the logo', { skip }, async () => {
  const [renamed] = await Promise.all([
    updateWorkspace(scope, { name: 'Acme' }),
    updateWorkspace(scope, { logo: PNG }),
  ])
  assert.equal(renamed.name, 'Acme')
  await consistent()
})
