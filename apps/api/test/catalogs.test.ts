import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { parseEnv } from 'node:util'
import { Hono } from 'hono'

// An App's catalog (src/catalogs.ts, CATALOG_PROTOCOL): a thread's spec names each granted App's
// catalog by a version instead of carrying its operations, and the runner fetches it (GET
// /runner/catalogs/<connectionId>), only its own workspace's, for the scope it was granted. A
// runner before CATALOG_PROTOCOL still gets the operations in the spec. Against the API's
// development database (apps/api/.env), in an organization of its own removed at the end;
// skipped when no database answers. Then the size limits, without a database.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL || undefined
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

type Sent = { type: string; [key: string]: unknown }
type Grant = {
  connectionId: string
  catalog?: { version: string }
  operations: { name: string; write: boolean }[]
}

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${what}`)
}

describe("an App's catalog", { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const token = `token-${suffix}`
  const ids = {} as Record<
    'org' | 'user' | 'member' | 'workspace' | 'computer' | 'runner' | 'riley' | 'app' | 'gmail',
    string
  >
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }
  let threadsApp: Hono
  let catalogsApp: Hono
  let restore: () => void
  let sent: Sent[]
  let close: (() => void) | undefined

  before(async () => {
    const { auth } = await import('../src/auth.js')
    const { threads } = await import('../src/routes/threads.js')
    const { runnerCatalogs } = await import('../src/routes/runner-catalogs.js')
    const { hashToken } = await import('../src/hub.js')
    ids.org = `org-catalog-${suffix}`
    ids.user = `user-catalog-${suffix}`
    ids.member = `m-catalog-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Catalogs', slug: `catalogs-${suffix}` },
    })
    await prisma.user.create({
      data: { id: ids.user, name: 'Ada', email: `${ids.user}@test.local` },
    })
    await prisma.member.create({
      data: { id: ids.member, organizationId: ids.org, userId: ids.user, role: 'owner' },
    })
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Catalogs' } })
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
        data: { computerId: ids.computer, tokenHash: hashToken(token) },
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
    ids.riley = (await db.teammate.create({ data: { name: `Riley ${suffix}` } } as never)).id
    ids.app = (
      await db.app.create({ data: { key: 'gmail', createdByMemberId: ids.member } } as never)
    ).id
    ids.gmail = (
      await db.connection.create({
        data: {
          appId: ids.app,
          kind: 'gmail',
          label: 'Gmail',
          externalAccount: 'ada@test.local',
          createdByMemberId: ids.member,
        },
      } as never)
    ).id
    await db.grant.create({
      data: { teammateId: ids.riley, connectionId: ids.gmail, scope: 'read_write' },
    } as never)
    // Signed in as Ada, without a cookie: the session is the test's.
    const getSession = auth.api.getSession
    ;(auth.api as { getSession: unknown }).getSession = async () => ({
      user: { id: ids.user },
      session: {
        id: `session-${suffix}`,
        activeOrganizationId: ids.org,
        activeWorkspaceId: ids.workspace,
      },
    })
    restore = () => ((auth.api as { getSession: unknown }).getSession = getSession)
    threadsApp = new Hono().route('/api/threads', threads)
    catalogsApp = new Hono().route('/runner/catalogs', runnerCatalogs)
    sent = []
  })

  /** Ada's computer, its runner connected at this protocol: what it is sent goes in `sent`. */
  async function connect(protocolVersion: number) {
    close?.()
    const { runnerSocket } = await import('../src/hub.js')
    const handle = runnerSocket({ id: ids.runner, computerId: ids.computer, ...scope })
    const ws = { send: (raw: string) => sent.push(JSON.parse(raw)), close: () => {} }
    const welcomed = sent.filter((m) => m.type === 'welcome').length
    handle.onMessage(
      JSON.stringify({ type: 'hello', protocolVersion, version: '0.0.0', platform: 'linux-x64' }),
      ws as never,
    )
    await until(() => sent.filter((m) => m.type === 'welcome').length > welcomed, 'the welcome')
    close = () => handle.onClose()
  }

  after(async () => {
    close?.()
    restore?.()
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({ where: { id: ids.user } })
  })

  /** A new thread's first prompt as its runner got it: its Gmail grant. */
  async function startedGrant(text: string): Promise<Grant> {
    const res = await threadsApp.request('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ teammateId: ids.riley, computerId: ids.computer, text }),
    })
    assert.equal(res.status, 201, await res.clone().text())
    const { id } = (await res.json()) as { id: string }
    let prompt: Sent | undefined
    await until(() => {
      prompt = sent.find(
        (m) =>
          m.type === 'thread.prompt' &&
          (m.thread as { sessionId?: string } | undefined)?.sessionId === id,
      )
      return Boolean(prompt)
    }, 'the prompt on its runner')
    const spec = prompt!.thread as { connectors: Grant[]; parts?: Record<string, string> }
    assert.equal(spec.parts?.connectors, undefined, 'a few names stay in the spec')
    const grant = spec.connectors.find((c) => c.connectionId === ids.gmail)
    assert.ok(grant, 'the Gmail grant is in the spec')
    return grant
  }

  const fetchCatalog = (connectionId: string, query: string, bearer = token) =>
    catalogsApp.request(`/runner/catalogs/${connectionId}?${query}`, {
      headers: { authorization: `Bearer ${bearer}` },
    })

  test('a spec names the catalog; the runner gets its operations from the API', async () => {
    const { PROTOCOL_VERSION } = await import('@brigade/contracts')
    const { operationSpecs } = await import('../src/connectors/index.js')
    await connect(PROTOCOL_VERSION)
    const grant = await startedGrant('Read my mail')
    assert.deepEqual(grant.operations, [])
    assert.match(grant.catalog?.version ?? '', /^[0-9a-f]{32}$/)

    const res = await fetchCatalog(ids.gmail, `scope=read_write&version=${grant.catalog!.version}`)
    assert.equal(res.status, 200, await res.clone().text())
    assert.deepEqual(await res.json(), operationSpecs('gmail', 'read_write'))
    // Asked for shared (CATALOG_SHARED_PARAM): its repeated subschemas written once, the same
    // operations once written out whole.
    const { unsharedSubschemas } = await import('@brigade/contracts')
    const shared = (await (
      await fetchCatalog(ids.gmail, `scope=read_write&version=x&schemas=shared`)
    ).json()) as { inputSchema: Record<string, unknown> }[]
    assert.match(JSON.stringify(shared), /"\$ref"/)
    assert.deepEqual(
      shared.map((o) => ({ ...o, inputSchema: unsharedSubschemas(o.inputSchema) })),
      operationSpecs('gmail', 'read_write'),
    )
    const reads = (await (await fetchCatalog(ids.gmail, 'scope=read&version=x')).json()) as Grant[]
    assert.ok(reads.length > 0)
    assert.ok(
      reads.every((o) => !(o as unknown as { write: boolean }).write),
      'read: no writes',
    )
  })

  test('a tool switched off turns the version over and leaves the catalog', async () => {
    const { catalogVersion } = await import('../src/catalogs.js')
    const load = () =>
      db.connection.findFirstOrThrow({
        where: { id: ids.gmail },
        include: { app: { select: { disabledTools: true, mcp: true, updatedAt: true } } },
      })
    const before = catalogVersion(await load())
    const all = (await (await fetchCatalog(ids.gmail, 'scope=read_write&version=a')).json()) as {
      name: string
    }[]
    const off = all[0]!.name
    await db.app.updateMany({ where: { id: ids.app }, data: { disabledTools: [off] } })
    const now = catalogVersion(await load())
    assert.notEqual(now, before)
    const res = await fetchCatalog(ids.gmail, `scope=read_write&version=${now}`)
    const names = ((await res.json()) as { name: string }[]).map((o) => o.name)
    assert.ok(!names.includes(off))
    assert.equal(names.length, all.length - 1)
    await db.app.updateMany({ where: { id: ids.app }, data: { disabledTools: [] } })
  })

  test('only a runner of the workspace, for a connection of it, and a scope', async () => {
    assert.equal((await fetchCatalog(ids.gmail, 'scope=read', 'not-a-token')).status, 401)
    assert.equal((await fetchCatalog('another-workspaces', 'scope=read')).status, 404)
    assert.equal((await fetchCatalog(ids.gmail, 'scope=admin')).status, 400)
  })

  test('a runner before CATALOG_PROTOCOL gets the operations in the spec', async () => {
    const { CATALOG_PROTOCOL } = await import('@brigade/contracts')
    await connect(CATALOG_PROTOCOL - 1)
    const grant = await startedGrant('Read my mail, old runner')
    assert.equal(grant.catalog, undefined)
    assert.ok(grant.operations.length > 0)
  })

  test('a command kept for a newer runner is sent whole to an older one', async () => {
    const { CATALOG_PROTOCOL } = await import('@brigade/contracts')
    const { inlineCatalogs } = await import('../src/catalogs.js')
    const { operationSpecs } = await import('../src/connectors/index.js')
    const prompt = {
      type: 'thread.prompt' as const,
      commandId: randomUUID(),
      thread: {
        connectors: [
          {
            connectionId: ids.gmail,
            kind: 'gmail',
            label: 'Gmail',
            externalAccount: null,
            scope: 'read' as const,
            catalog: { version: 'v' },
            operations: [],
          },
        ],
      },
      then: [],
      text: 'hi',
      memberId: null,
      attachments: [],
    }
    const whole = await inlineCatalogs(ids.workspace, prompt as never)
    const grant = (whole as unknown as { thread: { connectors: Grant[] } }).thread.connectors[0]!
    assert.equal(grant.catalog, undefined)
    assert.deepEqual(grant.operations, operationSpecs('gmail', 'read'))
    assert.ok(CATALOG_PROTOCOL > 0)
  })

  test('an MCP server that cannot list its tools now is asked again at the next fetch', async () => {
    const { CATALOG_INCOMPLETE_HEADER } = await import('@brigade/contracts')
    let up = false
    let listings = 0
    let asked = 0
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const message = JSON.parse(body || '{}') as { id?: number; method: string }
        asked++
        if (message.method === 'tools/list') listings++
        if (!up) return res.writeHead(503).end()
        if (message.id === undefined) return res.writeHead(202).end()
        const result =
          message.method === 'initialize'
            ? {
                protocolVersion: '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: 'notes' },
              }
            : message.method === 'tools/list'
              ? {
                  tools: [
                    { name: 'search', description: 'Search', inputSchema: { type: 'object' } },
                  ],
                }
              : {}
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
    try {
      const app = await db.app.create({
        data: {
          key: `notes-${suffix}`,
          createdByMemberId: ids.member,
          mcp: { url, transport: 'streamable', auth: 'none', prefix: 'notes' },
        },
      } as never)
      const connection = await db.connection.create({
        data: { appId: app.id, kind: 'mcp', label: 'Notes', createdByMemberId: ids.member },
      } as never)
      const get = () => fetchCatalog(connection.id, 'scope=read_write&version=v')

      // Down: empty, said incomplete, and asked again next time rather than kept.
      const down = await get()
      assert.equal(down.status, 200)
      assert.equal(down.headers.get(CATALOG_INCOMPLETE_HEADER), '1')
      assert.deepEqual(await down.json(), [])
      const once = asked
      await get()
      assert.ok(once > 0 && asked > once, 'asked again')

      // Back: its tools, complete, and kept for this version.
      up = true
      const back = await get()
      assert.equal(back.headers.get(CATALOG_INCOMPLETE_HEADER), null)
      assert.deepEqual(
        ((await back.json()) as { name: string }[]).map((o) => o.name),
        ['notes_search'],
      )
      const listed = listings
      up = false
      const kept = await get()
      assert.equal(kept.headers.get(CATALOG_INCOMPLETE_HEADER), null)
      assert.equal(((await kept.json()) as unknown[]).length, 1)
      assert.equal(listings, listed, 'not listed again')
    } finally {
      server.close()
    }
  })
})

describe('catalog sizes', () => {
  test('past the warning it is reported; past the limit its last tools are left out', async () => {
    const { catalogText, CATALOG_MAX_CHARS, CATALOG_WARN_CHARS } =
      await import('../src/catalogs.js')
    const { failuresOf } = await import('../src/ops/failures.js')
    const tool = (name: string, chars: number) => ({
      name,
      description: 'x'.repeat(chars),
      write: false,
      inputSchema: {},
    })
    const small = [tool('a', 10)]
    assert.equal(catalogText('c-small', 'gmail', small), JSON.stringify(small))
    assert.equal(failuresOf('catalog-size', 60_000).length, 0)

    const large = [tool('a', CATALOG_WARN_CHARS)]
    assert.equal(catalogText('c-large', 'posthog', large), JSON.stringify(large))
    assert.equal(failuresOf('catalog-size', 60_000).length, 1)

    const half = Math.floor(CATALOG_MAX_CHARS / 2)
    const huge = [tool('a', half), tool('b', half), tool('c', 10)]
    const kept = JSON.parse(catalogText('c-huge', 'posthog', huge)) as { name: string }[]
    assert.deepEqual(
      kept.map((o) => o.name),
      ['a'],
    )
    const reported = failuresOf('catalog-size', 60_000)
    assert.equal(reported.length, 2)
    assert.match(reported[1]!.message, /2 of 3 left out/)
  })

  test("a schema's repeated subschemas are written once, and mean the same", async () => {
    const { catalogText } = await import('../src/catalogs.js')
    const { sharedSubschemas, unsharedSubschemas } = await import('@brigade/contracts')
    const filter = {
      type: 'object',
      description: 'A property filter, long enough to be worth a reference of its own.',
      properties: {
        key: { type: 'string' },
        operator: { type: 'string', enum: ['exact', 'is_not', 'icontains'] },
      },
      required: ['key'],
    }
    const series = { type: 'array', items: { anyOf: [filter, { type: 'null' }] } }
    const schema = {
      type: 'object',
      properties: {
        properties: { type: 'array', items: filter },
        series: { type: 'object', properties: { a: series, b: series } },
        // Data, never a schema: left as it is, even when it looks like one.
        mode: { type: 'object', default: filter, enum: [filter, filter] },
      },
    }
    const shared = sharedSubschemas(schema)
    assert.ok(JSON.stringify(shared).length < JSON.stringify(schema).length)
    // The series is written once, and the filter once, inside it and outside.
    assert.equal(Object.keys(shared.$defs as object).length, 2)
    assert.deepEqual((shared.properties as Record<string, unknown>).mode, schema.properties.mode)
    assert.deepEqual(unsharedSubschemas(shared), schema)

    // Nothing worth sharing, or references of its own: the schema as it is, both ways.
    const small = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } }
    assert.equal(sharedSubschemas(small), small)
    const own = { ...schema, $defs: { x: filter } }
    assert.equal(sharedSubschemas(own), own)
    assert.equal(unsharedSubschemas(own), own)

    const [operation] = JSON.parse(
      catalogText('c-shared', 'posthog', [
        { name: 'query', description: 'Run a query.', write: false, inputSchema: schema },
      ]),
    ) as { inputSchema: Record<string, unknown> }[]
    assert.deepEqual(operation!.inputSchema, shared)
  })
})
