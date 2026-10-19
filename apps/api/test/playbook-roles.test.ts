import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import type { PlaybookManifest } from '@brigade/contracts'

// A playbook's roles (an analytics tool: Mixpanel or an MCP server added by its URL), against the
// API's development database (apps/api/.env), in an organization of its own removed at the end;
// skipped when none answers:
// - an account setting naming a role takes an account of any App it accepts, and no other;
// - a run reaches that account alone: not another Mixpanel, not another MCP server, in the tools
//   its thread gets and when a call is made; a server added by its URL only when a setting picks it;
// - an optional role left without an account blocks nothing;
// - a manifest of Apps by kind alone reads as before.
// The MCP servers are answered here, by a fetch that stands in for them.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

const MANIFEST = {
  id: 'brigade/test-roles',
  name: 'Support',
  version: '1.0.0',
  description: 'Answers the inbox.',
  apps: [
    { kind: 'gmail', access: 'read_write' },
    { role: 'analytics', kinds: ['mixpanel', 'mcp'], access: 'read', optional: true },
  ],
  settings: [
    { key: 'inbox', type: 'account', app: 'gmail' },
    { key: 'analytics', type: 'account', app: 'analytics', optional: true },
  ],
  entries: [],
  skills: [],
  actions: [
    {
      key: 'reply',
      label: 'Reply to the customer',
      tools: ['gmail_send'],
      start: 'auto',
      ceiling: 'auto',
      conditions: [],
    },
    {
      key: 'annotate',
      label: 'Annotate the chart',
      tools: ['mixpanel_annotate', 'posthog_annotate'],
      start: 'ask',
      ceiling: 'auto',
      conditions: [],
    },
  ],
  limits: { runsPerDay: 100 },
  promotion: { decisions: 30, approvedRate: 0.95 },
  metrics: [],
} satisfies PlaybookManifest

/** The same playbook as an older one declared it: Mixpanel by its kind, no account setting. */
const BY_KIND = {
  ...MANIFEST,
  apps: [
    { kind: 'gmail', access: 'read_write' },
    { kind: 'mixpanel', access: 'read', optional: true },
  ],
  settings: [{ key: 'inbox', type: 'account', app: 'gmail' }],
} satisfies PlaybookManifest

const TOOLS = [
  { name: 'query', description: 'Run a query', annotations: { readOnlyHint: true } },
  { name: 'annotate', description: 'Annotate a chart' },
]
const MCP_HOSTS = ['https://mcp.mixpanel.com', 'https://posthog.test', 'https://other.test']

/** A JSON-RPC answer, as a small MCP server would give it. */
function answer(message: { method: string; params?: { name?: string } }) {
  if (message.method === 'initialize')
    return {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'stand-in' },
    }
  if (message.method === 'tools/list') return { tools: TOOLS }
  if (message.method === 'tools/call')
    return { content: [{ type: 'text', text: `called ${message.params?.name}` }] }
  return {}
}

describe('the roles of a playbook', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<
    | 'org'
    | 'workspace'
    | 'owner'
    | 'computer'
    | 'teammate'
    | 'support'
    | 'mixpanel'
    | 'mixpanelOther'
    | 'posthog'
    | 'otherServer'
    | 'installation'
    | 'byKind',
    string
  >
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }
  const runner = () => ({ computerId: ids.computer, ...scope })
  const realFetch = globalThis.fetch

  before(async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (!MCP_HOSTS.some((host) => url.startsWith(host))) return realFetch(input, init)
      if (init?.method !== 'POST') return new Response(null, { status: 405 })
      const message = JSON.parse(String(init.body))
      if (message.id === undefined) return new Response(null, { status: 202 })
      return Response.json({ jsonrpc: '2.0', id: message.id, result: answer(message) })
    }) as typeof fetch

    ids.org = `org-roles-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Roles', slug: `roles-${suffix}` },
    })
    await prisma.user.create({
      data: { id: `owner-${suffix}`, name: 'Ada', email: `owner-${suffix}@test.local` },
    })
    ids.owner = `m-owner-${suffix}`
    await prisma.member.create({
      data: { id: ids.owner, organizationId: ids.org, userId: `owner-${suffix}`, role: 'owner' },
    })
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Roles' } })
    ).id
    scope = { organizationId: ids.org, workspaceId: ids.workspace }
    db = scoped(scope)
    ids.computer = (
      await db.computer.create({
        data: { kind: 'member_machine', memberId: ids.owner, name: 'Laptop' } as never,
      })
    ).id
    await db.account.create({
      data: {
        memberId: ids.owner,
        computerId: ids.computer,
        provider: 'claude_code',
        label: 'Claude',
        status: 'ready',
      } as never,
    })
    ids.teammate = (await db.teammate.create({ data: { name: 'Sam' } as never })).id

    const { sealSecret } = await import('../src/vault.js')
    const token = () =>
      sealSecret(db, scope, {
        accessToken: 'token',
        refreshToken: null,
        expiresAt: Date.now() + 3600_000,
        clientId: 'client',
        tokenEndpoint: 'https://mcp.mixpanel.com/token',
        resource: 'https://mcp.mixpanel.com/mcp',
      })
    const app = (key: string, mcp?: object) =>
      db.app.create({
        data: { key, createdByMemberId: ids.owner, ...(mcp ? { mcp } : {}) } as never,
      })
    const server = (url: string, prefix: string) => ({
      url,
      transport: 'streamable',
      auth: 'none',
      prefix,
      icons: [],
      description: null,
      tools: [],
    })
    const gmail = await app('gmail')
    const mixpanel = await app('mixpanel')
    const posthog = await app('mcp:posthog', server('https://posthog.test/mcp', 'posthog'))
    const other = await app('mcp:other', server('https://other.test/mcp', 'other'))
    const connection = async (
      appId: string,
      kind: string,
      label: string,
      extra: Record<string, unknown> = {},
    ) =>
      (
        await db.connection.create({
          data: {
            appId,
            kind,
            label,
            externalAccount: kind === 'mcp' ? null : label,
            createdByMemberId: ids.owner,
            ...extra,
          } as never,
        })
      ).id
    ids.support = await connection(gmail.id, 'gmail', 'support@acme.test')
    ids.mixpanel = await connection(mixpanel.id, 'mixpanel', 'Acme', {
      vaultSecretId: await token(),
    })
    ids.mixpanelOther = await connection(mixpanel.id, 'mixpanel', 'Side project', {
      vaultSecretId: await token(),
    })
    ids.posthog = await connection(posthog.id, 'mcp', 'PostHog')
    ids.otherServer = await connection(other.id, 'mcp', 'Other server')
    for (const connectionId of [
      ids.support,
      ids.mixpanel,
      ids.mixpanelOther,
      ids.posthog,
      ids.otherServer,
    ])
      await db.grant.create({
        data: { teammateId: ids.teammate, connectionId, scope: 'read_write' } as never,
      })

    const install = async (manifest: PlaybookManifest, settings: Record<string, string>) =>
      (
        await db.playbookInstallation.create({
          data: {
            playbookKey: manifest.id,
            version: manifest.version,
            manifest,
            teammateId: ids.teammate,
            ownerMemberId: ids.owner,
            settings,
            status: 'active',
            createdByMemberId: ids.owner,
          } as never,
        })
      ).id
    ids.installation = await install(MANIFEST, { inbox: ids.support })
    ids.byKind = await install(BY_KIND, { inbox: ids.support })
  })

  after(async () => {
    globalThis.fetch = realFetch
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({ where: { id: `owner-${suffix}` } })
    await prisma.$disconnect()
  })

  /** Its analytics account, by connection id; unset: none picked. */
  const pick = (analytics?: string) =>
    db.playbookInstallation.updateMany({
      where: { id: ids.installation },
      data: { settings: { inbox: ids.support, ...(analytics ? { analytics } : {}) } },
    })

  /** A new run of an installation, its root thread's id. */
  async function runThread(installationId = ids.installation, dryRun = false) {
    const run = await db.playbookRun.create({ data: { installationId, dryRun } as never })
    return (
      await db.session.create({
        data: {
          teammateId: ids.teammate,
          startedByMemberId: ids.owner,
          computerId: ids.computer,
          title: 'Mail from Jane',
          origin: 'trigger',
          playbookRunId: run.id,
        } as never,
      })
    ).id
  }

  /** The accounts a thread's spec hands its runner, with their access. */
  async function connectors(sessionId: string) {
    const { loadThread, specFor } = await import('../src/thread-spec.js')
    const spec = await specFor(db, await loadThread(db, sessionId))
    return Object.fromEntries(spec.connectors.map((c) => [c.connectionId, c.scope]))
  }

  /** A connector call from a thread, as its runner sends it; what the runner heard last. */
  async function call(sessionId: string, connectionId: string, operation: string, input = {}) {
    const { handleConnectorCall } = await import('../src/connector-calls.js')
    const heard: { ok?: boolean; error?: string; output?: unknown }[] = []
    await handleConnectorCall(
      runner(),
      { type: 'connector.call', callId: randomUUID(), sessionId, connectionId, operation, input },
      (message) => heard.push(message as never),
    )
    const row = await db.connectionCall.findFirst({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
    })
    return { ...heard.at(-1)!, row }
  }

  test('an account setting naming a role takes an account of each App it accepts', async () => {
    const { checkSettings } = await import('../src/playbooks.js')
    // By id or by what its row shows, a Mixpanel account or an MCP server.
    assert.deepEqual(await checkSettings(db, MANIFEST, { analytics: ids.mixpanel }), {
      analytics: ids.mixpanel,
    })
    assert.deepEqual(await checkSettings(db, MANIFEST, { analytics: 'side project' }), {
      analytics: ids.mixpanelOther,
    })
    assert.deepEqual(await checkSettings(db, MANIFEST, { analytics: 'PostHog' }), {
      analytics: ids.posthog,
    })
    // Not an account of another App, though the workspace has it.
    await assert.rejects(
      checkSettings(db, MANIFEST, { analytics: 'support@acme.test' }),
      /needs one of the workspace's mixpanel or MCP server accounts: .*Acme/,
    )
    // A plain kind as before: only its own accounts.
    await assert.rejects(checkSettings(db, MANIFEST, { inbox: 'Acme' }), /gmail accounts/)
  })

  test('a run reaches the Mixpanel account picked alone, read-only, and no MCP server', async () => {
    await pick(ids.mixpanel)
    const thread = await runThread()
    assert.deepEqual(await connectors(thread), {
      [ids.support]: 'read_write',
      [ids.mixpanel]: 'read',
    })
    const { loadThread, specFor } = await import('../src/thread-spec.js')
    const spec = await specFor(db, await loadThread(db, thread))
    assert.deepEqual(spec.playbook?.apps, ['gmail', 'analytics'])
    assert.deepEqual(spec.playbook?.roles, [
      { name: 'analytics', kinds: ['mixpanel', 'mcp'], account: 'Acme' },
    ])

    const read = await call(thread, ids.mixpanel, 'mixpanel_query')
    assert.equal(read.ok, true, read.error)
    for (const [connectionId, tool] of [
      [ids.mixpanelOther, 'mixpanel_query'],
      [ids.posthog, 'posthog_query'],
    ] as const) {
      const refused = await call(thread, connectionId, tool)
      assert.equal(refused.ok, false)
      assert.deepEqual(
        [refused.row?.result, refused.row?.error, refused.row?.connectionId],
        ['denied', 'not the account of the playbook', connectionId],
      )
    }
    assert.match(
      (await call(thread, ids.mixpanelOther, 'mixpanel_query')).error ?? '',
      /uses another analytics account than Side project/,
    )
    // Its role reads: a write through the account picked is refused too.
    const write = await call(thread, ids.mixpanel, 'mixpanel_annotate')
    assert.equal(write.ok, false)
    assert.equal(write.row?.error, 'read-only in the playbook')
  })

  test('a run reaches the MCP server picked alone, not another server or Mixpanel', async () => {
    await pick(ids.posthog)
    const thread = await runThread()
    assert.deepEqual(await connectors(thread), {
      [ids.support]: 'read_write',
      [ids.posthog]: 'read',
    })
    const read = await call(thread, ids.posthog, 'posthog_query')
    assert.equal(read.ok, true, read.error)
    assert.equal(read.row?.result, 'ok')
    for (const [connectionId, tool] of [
      [ids.otherServer, 'other_query'],
      [ids.mixpanel, 'mixpanel_query'],
    ] as const) {
      const refused = await call(thread, connectionId, tool)
      assert.equal(refused.ok, false)
      assert.equal(refused.row?.error, 'not the account of the playbook')
    }
    // In a dry run too, before anything is simulated.
    const dry = await runThread(ids.installation, true)
    assert.equal((await call(dry, ids.otherServer, 'other_annotate')).row?.result, 'denied')
    assert.equal((await call(dry, ids.posthog, 'posthog_query')).ok, true)
  })

  test('an optional role left without an account blocks nothing and reaches nothing', async () => {
    await pick()
    const thread = await runThread()
    assert.deepEqual(await connectors(thread), { [ids.support]: 'read_write' })
    assert.equal((await call(thread, ids.mixpanel, 'mixpanel_query')).ok, false)
    assert.equal((await call(thread, ids.posthog, 'posthog_query')).ok, false)

    const { getInstallation } = await import('../src/playbooks.js')
    const { missingApps } = await import('../src/playbook-chat.js')
    const view = await getInstallation(db, ids.installation)
    const analytics = view.apps.find((a) => a.name === 'analytics')
    assert.deepEqual(
      [analytics?.optional, analytics?.picks, analytics?.chosen, analytics?.plain],
      [true, true, null, false],
    )
    assert.deepEqual(missingApps(view.apps), [])
    // The inbox shows as its row does, not as its id.
    assert.equal(view.settings.find((s) => s.key === 'inbox')?.value, 'support@acme.test')

    await pick(ids.posthog)
    const picked = (await getInstallation(db, ids.installation)).apps.find(
      (a) => a.name === 'analytics',
    )
    assert.deepEqual(picked?.chosen, { name: 'PostHog', kind: 'mcp' })
    assert.equal(picked?.status, 'ready')
  })

  test('a manifest of Apps by kind alone reads as before: any Mixpanel granted, no MCP', async () => {
    const thread = await runThread(ids.byKind)
    assert.deepEqual(await connectors(thread), {
      [ids.support]: 'read_write',
      [ids.mixpanel]: 'read',
      [ids.mixpanelOther]: 'read',
    })
    assert.equal((await call(thread, ids.mixpanelOther, 'mixpanel_query')).ok, true)
    const refused = await call(thread, ids.posthog, 'posthog_query')
    assert.equal(refused.row?.error, 'not an App of the playbook')
  })

  test("a tool is an action's only from an App that can have it", async () => {
    const { playbookActionOf } = await import('../src/playbooks.js')
    const actions = [
      ...MANIFEST.actions,
      {
        key: 'merge',
        label: 'Merge',
        tools: ['github_merge_pull_request'],
        start: 'ask' as const,
        ceiling: 'auto' as const,
        conditions: [],
      },
    ]
    assert.equal(playbookActionOf(actions, 'gmail', 'gmail_send'), 'reply')
    assert.equal(playbookActionOf(actions, 'mixpanel', 'mixpanel_annotate'), 'annotate')
    assert.equal(playbookActionOf(actions, 'mcp', 'posthog_annotate'), 'annotate')
    // A server added by its URL whose tool falls in a built-in App's names: an unlisted write.
    assert.equal(playbookActionOf(actions, 'mcp', 'github_merge_pull_request'), null)
    assert.equal(playbookActionOf(actions, 'mcp', 'mixpanel_annotate'), null)
    assert.equal(playbookActionOf(actions, 'mcp', 'posthog_delete'), null)
  })
})
