import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'

// Disconnecting an App signed in with Brigade's Google client for agents (routes/connections.ts):
// Google revokes a whole grant, every App of that Google account on that client, so the token is
// revoked only with the last such connection. An MCP App on another client is revoked as before.
// Against the API's development database (apps/api/.env), in an organization of its own removed
// at the end, with the revocation endpoint faked; skipped when no database answers.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
process.env.GOOGLE_MCP_CLIENT_ID = 'google-agents-client'
process.env.GOOGLE_MCP_CLIENT_SECRET = 'google-agents-secret'

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

const REVOKE = 'https://oauth2.googleapis.com/revoke'

describe(
  "Google's MCP Apps share one grant per account",
  { skip: !database && 'no database answers' },
  () => {
    const suffix = randomUUID().slice(0, 8)
    const org = `org-gmcp-${suffix}`
    const account = `ada-${suffix}@example.com`
    const userId = `ada-${suffix}`
    const memberId = `m-ada-${suffix}`
    let workspaceId = ''
    const revoked: string[] = []
    const realFetch = globalThis.fetch
    let scope: Parameters<typeof scoped>[0] & {
      userId: string
      memberId: string
      role: 'owner'
    }

    before(async () => {
      await prisma.organization.create({ data: { id: org, name: 'Google MCP', slug: org } })
      workspaceId = (
        await prisma.workspace.create({ data: { organizationId: org, name: 'Google MCP' } })
      ).id
      await prisma.user.create({ data: { id: userId, name: 'Ada', email: account } })
      await prisma.member.create({
        data: { id: memberId, organizationId: org, userId, role: 'owner' },
      })
      scope = { organizationId: org, workspaceId, userId, memberId, role: 'owner' }
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).startsWith('https://revoke.example/') || String(url) === REVOKE)
          revoked.push(new URLSearchParams(String(init?.body)).get('token') ?? '')
        return new Response('{}', { status: 200 })
      }) as typeof fetch
    })

    after(async () => {
      globalThis.fetch = realFetch
      await prisma.connection.deleteMany({ where: { organizationId: org } })
      await prisma.app.deleteMany({ where: { organizationId: org } })
      await prisma.workspace.deleteMany({ where: { organizationId: org } })
      await prisma.member.deleteMany({ where: { organizationId: org } })
      await prisma.organization.deleteMany({ where: { id: org } })
      await prisma.user.deleteMany({ where: { id: userId } })
    })

    /** An account of an MCP App signed in as Ada, with its token in the vault. */
    async function connect(kind: string, token: string, clientId = 'google-agents-client') {
      const db = scoped(scope)
      const { sealSecret } = await import('../src/vault.js')
      const app =
        (await db.app.findFirst({ where: { key: kind } })) ??
        (await db.app.create({ data: { key: kind, createdByMemberId: memberId } as never }))
      return db.connection.create({
        data: {
          appId: app.id,
          kind,
          label: kind,
          externalAccount: account,
          createdByMemberId: memberId,
          vaultSecretId: await sealSecret(db, scope, {
            accessToken: `${token}-access`,
            refreshToken: token,
            expiresAt: Date.now() + 3600_000,
            clientId,
            clientSecret: 'secret',
            tokenEndpoint: 'https://oauth2.googleapis.com/token',
            revocationEndpoint:
              clientId === 'google-agents-client' ? REVOKE : 'https://revoke.example/',
            resource: 'https://example.googleapis.com/mcp/v1',
          }),
        } as never,
      })
    }

    const remove = async (connection: { id: string }) => {
      const { disconnect } = await import('../src/routes/connections.js')
      const db = scoped(scope)
      const row = await db.connection.findFirstOrThrow({ where: { id: connection.id } })
      await disconnect(scope, db, row)
    }

    test('removing Drive leaves the grant Docs still uses; removing the last one revokes it', async () => {
      const drive = await connect('google_drive_mcp', 'drive')
      const docs = await connect('google_docs_mcp', 'docs')
      await remove(drive)
      assert.deepEqual(revoked, [], 'Docs still signs in with the same grant')
      assert.equal(
        (await prisma.connection.findUniqueOrThrow({ where: { id: drive.id } })).status,
        'removed',
      )
      await remove(docs)
      assert.deepEqual(revoked, ['docs'])
    })

    test('Google Cloud on the same client counts as sharing the grant', async () => {
      revoked.length = 0
      const sheets = await connect('google_sheets_mcp', 'sheets')
      const cloud = await connect('google_cloud', 'cloud')
      await remove(sheets)
      assert.deepEqual(revoked, [])
      await remove(cloud)
      assert.deepEqual(revoked, ['cloud'])
    })

    test('an MCP App on another client is revoked whatever Google connections remain', async () => {
      revoked.length = 0
      const drive = await connect('google_drive_mcp', 'drive2')
      const neon = await connect('neon', 'neon', 'neon-client')
      await remove(neon)
      assert.deepEqual(revoked, ['neon'])
      await remove(drive)
      assert.deepEqual(revoked, ['neon', 'drive2'])
    })
  },
)
