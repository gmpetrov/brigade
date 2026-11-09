import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// Which client Brigade signs in to an MCP server as, against a real database (the local one
// of apps/api/.env; skipped without one). The provider is played by a fake fetch, answering as
// Vercel's does: dynamic client registration refused for an unapproved redirect URI, and a
// client ID metadata document accepted.
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
// A metadata document is only served over HTTPS.
process.env.API_URL = 'https://api.brigade.test'

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select 1 from "McpClient" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { mcpAuthUrl, mcpClientDocumentUrl } = await import('../src/connectors/mcp.js')

const realFetch = globalThis.fetch
const AUTH = 'https://auth.vercel.test'
let documentSupported = true
let registrations = 0

before(() => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (url.href.includes('/.well-known/oauth-protected-resource'))
      return json({ resource: 'https://mcp.vercel.test/', authorization_servers: [AUTH] })
    if (url.origin === AUTH && url.pathname.includes('.well-known'))
      return json({
        issuer: AUTH,
        authorization_endpoint: `${AUTH}/oauth/authorize`,
        token_endpoint: `${AUTH}/oauth/token`,
        registration_endpoint: `${AUTH}/oauth/register`,
        scopes_supported: ['openid', 'email', 'offline_access', 'profile'],
        client_id_metadata_document_supported: documentSupported,
      })
    if (url.origin === AUTH && url.pathname === '/oauth/register') {
      registrations++
      return json(
        {
          error: 'invalid_redirect_uri',
          error_description:
            'The provided redirect URIs are not approved for use by this authorization server.',
        },
        400,
      )
    }
    return new Response(null, { status: 401 })
  }) as typeof fetch
})

after(() => {
  globalThis.fetch = realFetch
})

const server = { url: 'https://mcp.vercel.test', tools: {} }

test(
  'registering refused: Brigade signs in with its client ID metadata document',
  { skip },
  async () => {
    documentSupported = true
    registrations = 0
    const url = new URL(await mcpAuthUrl(server, 'state', 'verifier'))
    assert.equal(url.origin + url.pathname, `${AUTH}/oauth/authorize`)
    assert.equal(url.searchParams.get('client_id'), mcpClientDocumentUrl())
    assert.equal(registrations, 1)
    // Nothing kept: the next sign-in asks to register again, in case the provider approved it.
    await mcpAuthUrl(server, 'state', 'verifier')
    assert.equal(registrations, 2)
  },
)

test('registering refused and no metadata document: the error says so', { skip }, async () => {
  documentSupported = false
  await assert.rejects(mcpAuthUrl(server, 'state', 'verifier'), /not approved/)
})
