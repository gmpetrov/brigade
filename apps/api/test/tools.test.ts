import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import { sessionStub } from './session-stub.js'

// Tools (src/tools.ts, docs/tools.md), through the API's own routes: a tool's page on the sandbox
// host, its state, the library folders it reads, and App accounts attached to it, called for the
// member viewing it (an MCP server of the test's own answers). Against the API's development
// database (apps/api/.env), in an organization of its own removed at the end; skipped when none
// answers.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL || undefined
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
process.env.BUCKET_DIR = mkdtempSync(join(tmpdir(), 'tools-'))

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1 from "ToolState" limit 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

const { Hono } = await import('hono')
const { HTTPException } = await import('hono/http-exception')
const { auth } = await import('../src/auth.js')
const { env } = await import('../src/config.js')
const { designFiles } = await import('../src/designs.js')
const library = await import('../src/library.js')
const { tools: toolRoutes } = await import('../src/routes/tools.js')
const { toolPages } = await import('../src/tools.js')

const app = new Hono()
app.route('/api/tools', toolRoutes)
app.route('/t', toolPages)
app.route('/v', designFiles)
app.onError((error, c) =>
  error instanceof HTTPException
    ? (error.res ?? c.json({ error: error.message }, error.status))
    : c.json({ error: String(error) }, 500),
)

const designHost = new URL(env.DESIGN_URL).host
const run = randomUUID().slice(0, 8)
const org = `org-tools-${run}`
const people = ['ada', 'bob', 'vic'] as const
type Person = (typeof people)[number]
const roles: Record<Person, string> = { ada: 'admin', bob: 'member', vic: 'viewer' }
const member = (p: Person) => `m-tools-${p}-${run}`
const user = (p: Person) => `u-tools-${p}-${run}`
const email = (p: Person) => `${user(p)}@example.com`
let as: Person = 'ada'
const getSession = auth.api.getSession

const post = async (path: string, body: unknown, who: Person = 'ada') => {
  as = who
  const response = await app.request(`/api/tools${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} }
}
const page = (url: string) => {
  const { pathname } = new URL(url)
  return app.request(pathname, { headers: { host: designHost } })
}

const TOOL = 'Film/review.tool'

describe('tools', { skip: !database && 'no database answers' }, () => {
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }
  let workspaceId: string
  let shared: string
  let personal: string
  let flagBefore: { workspaceIds: string[] } | null
  const encode = (text: string) => new TextEncoder().encode(text)
  const save = (path: string, text: string) =>
    library.saveLibraryFile(
      db,
      scope,
      { type: 'member', id: member('ada') },
      {
        path,
        bytes: encode(text),
      },
    )
  // The MCP server the accounts reach: `search` reads, `add_note` writes.
  const notes: string[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const message = JSON.parse(body || '{}') as {
        id?: number
        method: string
        params?: { name?: string; arguments?: { text?: string } }
      }
      if (message.id === undefined) return res.writeHead(202).end()
      const text = (t: string) => ({ content: [{ type: 'text', text: t }] })
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
                  {
                    name: 'search',
                    description: 'Search notes',
                    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
                    annotations: { readOnlyHint: true },
                  },
                  {
                    name: 'add_note',
                    description: 'Add a note',
                    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
                  },
                ],
              }
            : message.method === 'tools/call' && message.params?.name === 'search'
              ? text(`found ${notes.length}`)
              : message.method === 'tools/call' && message.params?.name === 'add_note'
                ? (notes.push(message.params.arguments?.text ?? ''), text('added'))
                : {}
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
  })

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
    await prisma.organization.create({ data: { id: org, name: 'Tools', slug: org } })
    for (const p of people) {
      await prisma.user.create({ data: { id: user(p), name: p, email: email(p) } })
      await prisma.member.create({
        data: { id: member(p), organizationId: org, userId: user(p), role: roles[p] },
      })
    }
    workspaceId = (await prisma.workspace.create({ data: { organizationId: org, name: 'Acme' } }))
      .id
    scope = { organizationId: org, workspaceId }
    db = scoped(scope)
    // The feature, for this workspace.
    flagBefore = await prisma.featureFlag.findUnique({
      where: { key: 'tools' },
      select: { workspaceIds: true },
    })
    await prisma.featureFlag.upsert({
      where: { key: 'tools' },
      create: { key: 'tools', workspaceIds: [workspaceId], note: 'tools.test' },
      update: { workspaceIds: [...(flagBefore?.workspaceIds ?? []), workspaceId] },
    })
    const notesApp = await db.app.create({
      data: {
        key: `notes-${run}`,
        createdByMemberId: member('bob'),
        mcp: { url, transport: 'streamable', auth: 'none', prefix: 'notes' },
      },
    } as never)
    // Bob's, open to the workspace; Ada's own.
    shared = (
      await db.connection.create({
        data: {
          appId: notesApp.id,
          kind: 'mcp',
          label: 'Team notes',
          createdByMemberId: member('bob'),
        },
      } as never)
    ).id
    personal = (
      await db.connection.create({
        data: {
          appId: notesApp.id,
          kind: 'mcp',
          label: 'Ada notes',
          reach: 'mine',
          createdByMemberId: member('ada'),
        },
      } as never)
    ).id
    await save(
      `${TOOL}/index.html`,
      '<!doctype html><html><head><title>Review</title></head><body><script src="app.js"></script></body></html>',
    )
    await save(`${TOOL}/app.js`, 'console.log(1)')
    await save(
      `${TOOL}/tool.json`,
      JSON.stringify({
        title: 'Clip review',
        reads: ['Film/clips'],
        apps: [{ kind: 'notes', access: 'read_write' }],
        hosts: ['https://api.example.com', 'http://insecure.example.com'],
      }),
    )
    await save('Film/clips/a.txt', 'clip a')
    await save('Film/clips/run.js', 'alert(1)')
    await save('Film/secret/b.txt', 'secret b')
    ;(auth.api as { getSession: unknown }).getSession = sessionStub(() => ({
      user: { id: user(as) },
      session: { id: `s-tools-${run}`, activeOrganizationId: org, activeWorkspaceId: workspaceId },
    }))
  })

  after(async () => {
    ;(auth.api as { getSession: unknown }).getSession = getSession
    server.close()
    if (flagBefore)
      await prisma.featureFlag.update({
        where: { key: 'tools' },
        data: { workspaceIds: flagBefore.workspaceIds },
      })
    else await prisma.featureFlag.deleteMany({ where: { key: 'tools' } })
    await prisma.toolAccount.deleteMany({ where: { organizationId: org } })
    await prisma.toolState.deleteMany({ where: { organizationId: org } })
    await prisma.connection.deleteMany({ where: { organizationId: org } })
    await prisma.app.deleteMany({ where: { organizationId: org } })
    await prisma.workspace.deleteMany({ where: { organizationId: org } })
    await prisma.libraryObjectFolder.deleteMany({ where: { organizationId: org } })
    await prisma.libraryObject.deleteMany({ where: { organizationId: org } })
    await prisma.auditEntry.deleteMany({ where: { organizationId: org } })
    await prisma.member.deleteMany({ where: { organizationId: org } })
    await prisma.organization.deleteMany({ where: { id: org } })
    await prisma.user.deleteMany({ where: { id: { in: people.map(user) } } })
  })

  test('hidden from people without the feature', async () => {
    await prisma.featureFlag.update({
      where: { key: 'tools' },
      data: { workspaceIds: flagBefore?.workspaceIds ?? [] },
    })
    try {
      assert.equal((await post('/view', { path: TOOL })).status, 404)
    } finally {
      await prisma.featureFlag.update({
        where: { key: 'tools' },
        data: { workspaceIds: [...(flagBefore?.workspaceIds ?? []), workspaceId] },
      })
    }
  })

  test('its page on the sandbox host, with the bridge, and only the folders it reads', async () => {
    const view = await post('/view', { path: `${TOOL}/app.js` })
    assert.equal(view.status, 200)
    assert.equal(view.body.folder, TOOL)
    assert.equal(view.body.manifest.title, 'Clip review')
    assert.deepEqual(
      view.body.manifest.hosts,
      ['https://api.example.com'],
      'an http host is left out',
    )
    assert.match(view.body.url, /\/t\/[^/]+\/index\.html$/)

    const html = await page(view.body.url)
    assert.equal(html.status, 200)
    const text = await html.text()
    assert.ok(text.indexOf('data-brigade-tool-bridge') < text.indexOf('<title>'), 'bridge first')
    const csp = html.headers.get('content-security-policy') ?? ''
    assert.match(csp, /^sandbox allow-scripts/)
    // Scripts from its own files only: no CDN, no eval.
    const token = new URL(view.body.url).pathname.split('/')[2]!
    const scripts = /script-src ([^;]*)/.exec(csp)?.[1] ?? ''
    assert.equal(scripts, `${env.DESIGN_URL}/t/${token}/ 'unsafe-inline'`)
    assert.doesNotMatch(csp, /unsafe-eval/)
    // The bridge carries the key the dashboard is given, and only this address's.
    assert.ok(view.body.bridgeKey)
    assert.ok(text.includes(`data-key="${view.body.bridgeKey}"`))
    assert.match(csp, /connect-src [^;]*https:\/\/api\.example\.com/)
    assert.doesNotMatch(csp, /insecure\.example\.com/)
    assert.equal(html.headers.get('referrer-policy'), 'no-referrer')

    const base = view.body.url.replace(/index\.html$/, '')
    assert.equal(await (await page(`${base}app.js`)).text(), 'console.log(1)')
    const clip = await page(`${base}_library/Film/clips/a.txt`)
    assert.equal(clip.status, 200)
    assert.equal(await clip.text(), 'clip a')
    assert.equal(clip.headers.get('content-security-policy'), 'sandbox', 'never run as a page')
    assert.equal((await page(`${base}_library/Film/secret/b.txt`)).status, 404)
    // A script in a folder it reads is never served as one: it could change without the tool.
    const script = await page(`${base}_library/Film/clips/run.js`)
    assert.equal(script.status, 200)
    assert.match(script.headers.get('content-type') ?? '', /^text\/plain/)
    assert.equal(script.headers.get('x-content-type-options'), 'nosniff')
    // Its own scripts are.
    assert.match((await page(`${base}app.js`)).headers.get('content-type') ?? '', /javascript/)
    assert.equal((await page(`${base}_library/Film/clips/../secret/b.txt`)).status, 404)

    // Not on the API's own host, and a design's address never opens a tool.
    const own = await app.request(new URL(view.body.url).pathname)
    if (designHost !== new URL(env.API_URL).host) assert.equal(own.status, 404)
    assert.equal(
      (await app.request(`/v/${token}/index.html`, { headers: { host: designHost } })).status,
      410,
    )
  })

  test('files: the folders its manifest lists, each with an address on the sandbox host', async () => {
    const files = await post('/files', { path: TOOL, folder: 'Film/clips' })
    assert.equal(files.status, 200)
    const list = files.body as unknown as { path: string; url: string }[]
    assert.deepEqual(
      list.map((f) => f.path),
      ['Film/clips/a.txt', 'Film/clips/run.js'],
    )
    assert.equal(await (await page(list[0]!.url)).text(), 'clip a')
    assert.equal((await post('/files', { path: TOOL, folder: 'Film/secret' })).status, 403)
    assert.equal((await post('/files', { path: TOOL, folder: 'Film' })).status, 403)
  })

  test('state: each person their own, the shared for everyone, written over the version read', async () => {
    const set = (who: Person, shared: boolean, value: unknown, version?: number) =>
      post(
        '/state',
        {
          op: 'set',
          path: TOOL,
          shared,
          key: 'picks',
          value,
          ...(version !== undefined && { version }),
        },
        who,
      )
    const get = async (who: Person, shared: boolean) =>
      (await post('/state', { op: 'get', path: TOOL, shared, key: 'picks' }, who)).body.result

    assert.equal((await set('ada', false, ['a'])).status, 200)
    assert.equal((await set('bob', false, ['b'])).status, 200)
    assert.deepEqual((await get('ada', false)).value, ['a'])
    assert.deepEqual((await get('bob', false)).value, ['b'])
    assert.equal((await get('vic', false)).version, 0, 'none of her own yet')

    const first = await set('ada', true, { a: 'approved' }, 0)
    assert.equal(first.status, 200)
    assert.equal(first.body.result.version, 1)
    // Bob read version 1 too; Ada writes first; his write over 1 is refused, with what is there.
    assert.equal((await set('ada', true, { a: 'approved', b: 'rejected' }, 1)).status, 200)
    const late = await set('bob', true, { a: 'rejected' }, 1)
    assert.equal(late.status, 409)
    assert.equal(late.body.code, 'conflict')
    assert.deepEqual(late.body.current.value, { a: 'approved', b: 'rejected' })
    assert.equal((await set('bob', true, { a: 'approved' }, 0)).status, 409, 'not new any more')

    // A viewer keeps their own, and changes nothing everyone sees.
    assert.equal((await set('vic', false, ['v'])).status, 200)
    assert.equal((await set('vic', true, {})).status, 403)
    assert.deepEqual((await get('vic', true)).value, { a: 'approved', b: 'rejected' })

    const listed = await post('/state', { op: 'list', path: TOOL, shared: true })
    assert.deepEqual(
      (listed.body.result.entries as { key: string }[]).map((e) => e.key),
      ['picks'],
    )
    assert.equal(listed.body.result.next, undefined)
    const big = await set('ada', false, 'x'.repeat(100_001))
    assert.equal(big.status, 413)
  })

  test('accounts: attached by those allowed, used by those who may, while the tool is unchanged', async () => {
    const call = (who: Person, operation: string, input: unknown, extra: object = {}) =>
      post('/call', { path: TOOL, connectionId: shared, operation, input, ...extra }, who)

    // Not attached yet.
    assert.equal((await call('ada', 'notes_search', {})).status, 404)
    const view = await post('/view', { path: TOOL }, 'bob')
    assert.deepEqual(
      (view.body.attachable as { connectionId: string }[]).map((a) => a.connectionId),
      [shared],
      "Bob may attach his own account; not Ada's personal one",
    )

    // Bob, a member, cannot attach Ada's personal one; Ada cannot either for others' use but may for her own.
    assert.equal(
      (await post('/accounts', { path: TOOL, connectionId: personal, access: 'read' }, 'bob'))
        .status,
      403,
    )
    assert.equal(
      (await post('/accounts', { path: TOOL, connectionId: shared, access: 'read' }, 'vic')).status,
      403,
    )
    assert.equal(
      (await post('/accounts', { path: TOOL, connectionId: shared, access: 'read' }, 'bob')).status,
      204,
    )

    // A read goes for anyone who may use the account.
    const read = await call('ada', 'notes_search', { q: 'x' })
    assert.equal(read.status, 200)
    assert.equal(read.body.ok, true)
    assert.match(JSON.stringify(read.body.output), /found 0/)
    assert.equal((await call('vic', 'notes_search', {})).status, 403, 'not for viewers')

    // A write: not on a read-only attachment, and never without the person's confirmation.
    assert.equal((await call('bob', 'notes_add_note', { text: 'hi' })).status, 403)
    assert.equal(
      (await call('bob', 'notes_add_note', { text: 'hi' }, { confirmed: true })).status,
      403,
    )
    assert.equal(
      (await post('/accounts', { path: TOOL, connectionId: shared, access: 'read_write' }, 'bob'))
        .status,
      204,
    )
    assert.equal((await call('bob', 'notes_add_note', { text: 'hi' })).status, 428)
    assert.deepEqual(notes, [], 'nothing written unconfirmed')
    const wrote = await call('bob', 'notes_add_note', { text: 'hi' }, { confirmed: true })
    assert.equal(wrote.status, 200)
    assert.equal(wrote.body.ok, true)
    assert.deepEqual(notes, ['hi'])
    const audited = await prisma.auditEntry.findFirst({
      where: { organizationId: org, action: 'tool.app_write' },
    })
    assert.equal((audited?.data as { operation?: string }).operation, 'notes_add_note')

    // The tool changes: its calls wait until someone who may attach the account allows it again.
    await save(`${TOOL}/app.js`, 'fetch("https://evil.example")')
    const changed = await call('ada', 'notes_search', {})
    assert.equal(changed.status, 409)
    assert.equal(changed.body.code, 'tool_changed')
    const marked = await post('/view', { path: TOOL })
    assert.equal(marked.body.accounts[0].changed, true)
    assert.equal((await post('/accounts/allow', { path: TOOL }, 'vic')).status, 403)
    assert.equal((await post('/accounts/allow', { path: TOOL }, 'bob')).body.allowed, 1)
    assert.equal((await call('ada', 'notes_search', {})).status, 200)
    // The picture alone is not a change.
    await save(`${TOOL}/thumbnail.png`, 'png')
    assert.equal((await call('ada', 'notes_search', {})).status, 200)

    // A personal account works for its owner only.
    assert.equal(
      (await post('/accounts', { path: TOOL, connectionId: personal, access: 'read' }, 'ada'))
        .status,
      204,
    )
    const mine = (who: Person) =>
      post(
        '/call',
        { path: TOOL, connectionId: personal, operation: 'notes_search', input: {} },
        who,
      )
    assert.equal((await mine('ada')).status, 200)
    assert.equal((await mine('bob')).status, 403)
    const bobs = await post('/view', { path: TOOL }, 'bob')
    const personalSeen = (bobs.body.accounts as { connectionId: string; usable: boolean }[]).find(
      (a) => a.connectionId === personal,
    )
    assert.equal(personalSeen?.usable, false)

    // Taken off by those allowed only.
    assert.equal(
      (await post('/accounts/detach', { path: TOOL, connectionId: shared }, 'vic')).status,
      403,
    )
    assert.equal(
      (await post('/accounts/detach', { path: TOOL, connectionId: shared }, 'bob')).status,
      204,
    )
    assert.equal((await call('bob', 'notes_search', {})).status, 404)
  })

  test('a deleted key keeps its version: a write over an older one never lands on the new key', async () => {
    const set = (value: unknown, version?: number) =>
      post('/state', {
        op: 'set',
        path: TOOL,
        shared: true,
        key: 'k',
        value,
        ...(version !== undefined && { version }),
      })
    const first = await set('a', 0)
    assert.equal(first.body.result.version, 1)
    // Bob read version 1; Ada deletes the key and makes it again.
    assert.equal(
      (await post('/state', { op: 'delete', path: TOOL, shared: true, key: 'k', version: 1 }))
        .status,
      200,
    )
    const gone = await post('/state', { op: 'get', path: TOOL, shared: true, key: 'k' })
    assert.equal(gone.body.result.value, null)
    assert.equal(gone.body.result.version, 2)
    assert.equal((await set('new', 0)).status, 409, 'not new: it was, and was deleted')
    const again = await set('new', 2)
    assert.equal(again.status, 200)
    assert.equal(again.body.result.version, 3)
    // Bob's write over version 1 (and his delete) are refused.
    assert.equal((await set('bob', 1)).status, 409)
    assert.equal(
      (await post('/state', { op: 'delete', path: TOOL, shared: true, key: 'k', version: 1 }))
        .status,
      409,
    )
    const now = await post('/state', { op: 'get', path: TOOL, shared: true, key: 'k' })
    assert.equal(now.body.result.value, 'new')
    // A listing leaves deleted keys out.
    await post('/state', { op: 'delete', path: TOOL, shared: true, key: 'k' })
    const listed = await post('/state', { op: 'list', path: TOOL, shared: true, prefix: 'k' })
    assert.deepEqual(listed.body.result.entries, [])
  })

  test('a listing reads values within a budget, page by page', async () => {
    // 15 keys of ~90 KB: about 1.35 MB in all, past one page.
    const big = 'x'.repeat(90_000)
    for (let i = 0; i < 15; i++)
      assert.equal(
        (
          await post(
            '/state',
            {
              op: 'set',
              path: TOOL,
              shared: false,
              key: `big:${String(i).padStart(2, '0')}`,
              value: big,
            },
            'bob',
          )
        ).status,
        200,
      )
    const keys: string[] = []
    let after: string | undefined
    let pages = 0
    do {
      const page = await post(
        '/state',
        { op: 'list', path: TOOL, shared: false, prefix: 'big:', ...(after && { after }) },
        'bob',
      )
      assert.equal(page.status, 200)
      const entries = page.body.result.entries as { key: string; value: string }[]
      assert.ok(JSON.stringify(entries).length <= 1_100_000, 'a page stays within its budget')
      keys.push(...entries.map((e) => e.key))
      after = page.body.result.next
      pages++
    } while (after && pages < 10)
    assert.ok(pages >= 2, 'more than one page')
    assert.equal(keys.length, 15)
    assert.deepEqual(keys, [...keys].sort())
    // The teammate's read stays within its budget too, and says it is cut.
    const { toolStateFor } = await import('../src/tools.js')
    const read = await toolStateFor(db, scope, TOOL, member('bob'))
    assert.ok(read.truncated)
    assert.ok(JSON.stringify(read).length <= 1_100_000)
  })
})
