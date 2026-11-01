import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import type { ScheduleOperation } from '@brigade/contracts'

// A teammate's list_apps (src/app-calls.ts), against the API's development database
// (apps/api/.env), in an organization of its own removed at the end; skipped when no database
// answers. Scoped to the person a thread works for, never to the teammate, which works for
// everyone:
// - its accounts here, the workspace's not granted to it, the Apps with no account it may use;
// - another member's own account (reach mine) never shows, even granted to the teammate;
// - a thread several people ask in shows no member's own account at all;
// - a playbook's run has none (it has only the Apps the playbook declares);
// - the kinds it gives are those open_ticket's access ask takes, whatever the database.
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

test("the kinds list_apps gives are open_ticket's, and every App a ticket can ask for", async () => {
  const { askableKinds } = await import('../src/app-calls.js')
  const askable = askableKinds()
  const { appCatalog } = await import('../src/connectors/index.js')
  // The runner's tool as teammates get it: its enum is the one a model reads.
  const { openTicketTool } = await import('../../runner/src/harness/tools.js')
  const schema = (openTicketTool.inputSchema as unknown as { jsonSchema: TicketSchema }).jsonSchema
  const enumKinds = schema.properties.asks.items.properties.app.properties.kind.enum
  assert.deepEqual(
    [...enumKinds].sort(),
    [...askable].sort(),
    "open_ticket's app.kind and the catalog's Apps a ticket can ask for differ: add the new App to both",
  )
  // Only a custom app (webhooks in, no tools) and the Email App (given from its own pages) are left out.
  assert.deepEqual(
    Object.keys(appCatalog)
      .filter((kind) => !(askable as string[]).includes(kind))
      .sort(),
    ['email', 'webhook'],
  )
})

type TicketSchema = {
  properties: {
    asks: { items: { properties: { app: { properties: { kind: { enum: string[] } } } } } }
  }
}

type Reply = { type: string; ok?: boolean; error?: string; output?: unknown }

/** The listing's three groups, by their first words, as lines. */
const groups = (text: string) => {
  const [yours = '', others = '', connectable = ''] = text.split('\n\n')
  const lines = (part: string) => part.split('\n').slice(1)
  return { yours: lines(yours), others: lines(others), connectable: lines(connectable), text }
}

describe("a teammate's list_apps", { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<
    | 'org'
    | 'workspace'
    | 'ada'
    | 'bob'
    | 'carol'
    | 'computer'
    | 'riley'
    | 'project'
    | 'installation',
    string
  >
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }

  /** A thread of Riley's: started by `startedBy`, working for `askedBy` ('*': several people). */
  const thread = async (
    startedBy: string,
    askedBy: string | null,
    extra: { origin?: 'member' | 'trigger'; playbookRunId?: string } = {},
  ) => {
    const session = await db.session.create({
      data: {
        teammateId: ids.riley,
        startedByMemberId: startedBy,
        askedByMemberId: askedBy,
        computerId: ids.computer,
        title: 'Rankings',
        projectId: ids.project,
        origin: extra.origin ?? 'member',
        status: 'running',
        ...(extra.playbookRunId ? { playbookRunId: extra.playbookRunId } : {}),
      } as never,
    })
    await db.threadTeammate.create({
      data: { sessionId: session.id, teammateId: ids.riley } as never,
    })
    return session.id
  }

  /** Riley calls list_apps on its runner's connection. */
  async function listApps(sessionId: string) {
    const { handleScheduleCall } = await import('../src/schedules.js')
    let reply: Reply | undefined
    await handleScheduleCall(
      { computerId: ids.computer, ...scope },
      {
        type: 'schedule.call',
        callId: randomUUID(),
        sessionId,
        teammateId: ids.riley,
        operation: { name: 'list_apps' } as ScheduleOperation,
      },
      (message) => {
        reply = message as Reply
      },
    )
    assert.ok(reply, 'list_apps answers')
    return reply
  }

  const listed = async (sessionId: string) => {
    const reply = await listApps(sessionId)
    assert.equal(reply.ok, true, reply.error)
    assert.equal(typeof reply.output, 'string')
    return groups(reply.output as string)
  }

  /** An App's account, connected by `by`; given to Riley when `grant` says how. An MCP server's by its URL. */
  async function account(input: {
    key?: string
    url?: string
    kind: string
    label: string
    externalAccount: string
    by: string
    reach: 'mine' | 'workspace'
    grant?: 'read' | 'read_write'
    name?: string
  }) {
    const { mcpAppKey, normalUrl } = await import('../src/mcp-servers.js')
    const key = input.url ? mcpAppKey(input.url) : input.key!
    const app =
      (await db.app.findFirst({ where: { key } })) ??
      (await db.app.create({
        data: {
          key,
          name: input.name ?? null,
          createdByMemberId: input.by,
          ...(input.url
            ? {
                mcp: {
                  url: normalUrl(input.url),
                  transport: 'streamable',
                  auth: 'none',
                  prefix: (input.name ?? 'mcp').toLowerCase(),
                  icons: [],
                  description: null,
                  tools: [],
                },
              }
            : {}),
        } as never,
      }))
    const connection = await db.connection.create({
      data: {
        appId: app.id,
        kind: input.kind,
        label: input.label,
        externalAccount: input.externalAccount,
        reach: input.reach,
        createdByMemberId: input.by,
      } as never,
    })
    if (input.grant)
      await db.grant.create({
        data: { teammateId: ids.riley, connectionId: connection.id, scope: input.grant } as never,
      })
    return connection.id
  }

  before(async () => {
    ids.org = `org-apps-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Apps', slug: `apps-${suffix}` },
    })
    for (const [who, role] of [
      ['ada', 'owner'],
      ['bob', 'member'],
      ['carol', 'member'],
    ] as const) {
      await prisma.user.create({
        data: { id: `${who}-${suffix}`, name: who, email: `${who}-${suffix}@test.local` },
      })
      ids[who] = `m-${who}-${suffix}`
      await prisma.member.create({
        data: { id: ids[who], organizationId: ids.org, userId: `${who}-${suffix}`, role },
      })
    }
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Apps' } })
    ).id
    scope = { organizationId: ids.org, workspaceId: ids.workspace }
    db = scoped(scope)
    ids.computer = (
      await db.computer.create({
        data: { kind: 'cloud', name: 'Test', status: 'running' } as never,
      })
    ).id
    ids.riley = (await db.teammate.create({ data: { name: 'Riley' } as never })).id
    ids.project = (await db.project.create({ data: { name: `Web ${suffix}` } as never })).id

    // Shared: Stripe, given to Riley read-only; GitHub, given to nobody.
    await account({
      key: 'stripe',
      kind: 'stripe',
      label: 'Stripe',
      externalAccount: 'acme',
      by: ids.ada,
      reach: 'workspace',
      grant: 'read',
    })
    await account({
      key: 'github',
      kind: 'github',
      label: 'GitHub',
      externalAccount: 'acme-org',
      by: ids.ada,
      reach: 'workspace',
    })
    // Bob's own: Linear, given to Riley; Gmail, not.
    await account({
      key: 'linear',
      kind: 'linear',
      label: 'Linear',
      externalAccount: 'bob-linear',
      by: ids.bob,
      reach: 'mine',
      grant: 'read_write',
    })
    await account({
      key: 'gmail',
      kind: 'gmail',
      label: 'Gmail',
      externalAccount: `bob-${suffix}@acme.test`,
      by: ids.bob,
      reach: 'mine',
    })
    // Carol's own: Gmail, given to Riley (as a teammate works for everyone); Notion, not.
    await account({
      key: 'gmail',
      kind: 'gmail',
      label: 'Gmail',
      externalAccount: `carol-${suffix}@acme.test`,
      by: ids.carol,
      reach: 'mine',
      grant: 'read_write',
    })
    await account({
      key: 'notion',
      kind: 'notion',
      label: 'Notion',
      externalAccount: 'carol-notion',
      by: ids.carol,
      reach: 'mine',
    })
    // An MCP server Ada added, on her own account only; a custom app that only receives webhooks.
    await account({
      url: 'https://sentry.example.com/mcp',
      kind: 'mcp',
      label: 'Sentry',
      externalAccount: 'ada-sentry',
      by: ids.ada,
      reach: 'mine',
      name: 'Sentry',
    })
    await account({
      key: `custom:${suffix}`,
      kind: 'webhook',
      label: 'Typeform',
      externalAccount: 'typeform',
      by: ids.ada,
      reach: 'workspace',
      grant: 'read',
      name: 'Typeform',
    })
    ids.installation = (
      await db.playbookInstallation.create({
        data: {
          playbookKey: 'brigade/test',
          version: '1',
          manifest: {},
          teammateId: ids.riley,
          ownerMemberId: ids.bob,
          createdByMemberId: ids.bob,
        } as never,
      })
    ).id
  })

  after(async () => {
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({
      where: { id: { in: ['ada', 'bob', 'carol'].map((who) => `${who}-${suffix}`) } },
    })
  })

  test("Bob's thread: his accounts and the workspace's, in three groups", async () => {
    const { yours, others, connectable, text } = await listed(await thread(ids.bob, ids.bob))
    assert.deepEqual(yours, ['- Linear · bob-linear: read_write', '- Stripe · acme: read'])
    assert.deepEqual(others, [
      '- GitHub · acme-org: app.kind github, app.account "acme-org"',
      `- Gmail · bob-${suffix}@acme.test: app.kind gmail, app.account "bob-${suffix}@acme.test"`,
    ])
    // An App with an account here is not offered to connect; one with none is, with its kind.
    for (const kind of ['stripe', 'github', 'gmail', 'linear'])
      assert.ok(!connectable.some((l) => l.includes(`(app.kind ${kind})`)), kind)
    assert.ok(connectable.some((l) => /^- Ahrefs \(app\.kind ahrefs\): Research keywords/.test(l)))
    assert.ok(connectable.some((l) => l.startsWith('- Notion (app.kind notion)')))
    // Ada's MCP server is hers alone: offered by its name, never with her account.
    assert.ok(
      connectable.some(
        (l) =>
          l.startsWith('- Sentry (app.kind mcp, what "Sentry", app.server "') &&
          l.endsWith('"): an MCP server added in the workspace'),
      ),
      'by its id',
    )
    assert.doesNotMatch(text, /sentry\.example\.com/, 'never its URL')
    assert.ok(
      connectable.at(-1)!.startsWith('- MCP server (app.kind mcp, with its url): Any MCP server'),
    )
    // A custom app has no tools, and the Email App is not asked for in a ticket.
    assert.doesNotMatch(text, /Typeform|app\.kind webhook|app\.kind email/)
    assert.doesNotMatch(text, /ada-sentry/)
  })

  test("another member's own account never shows, even given to the teammate", async () => {
    for (const sessionId of [
      await thread(ids.bob, ids.bob),
      // An event's thread runs on its starter's accounts: still never Carol's.
      await thread(ids.bob, null, { origin: 'trigger' }),
    ]) {
      const { text } = await listed(sessionId)
      assert.doesNotMatch(text, /carol/)
    }
    // Carol's own thread has hers, and none of Bob's.
    const { yours, others, text } = await listed(await thread(ids.carol, ids.carol))
    assert.ok(yours.includes(`- Gmail · carol-${suffix}@acme.test: read_write`))
    assert.ok(others.some((l) => l.startsWith('- Notion · carol-notion: app.kind notion')))
    assert.doesNotMatch(text, /bob/)
  })

  test('a thread several people ask in shows no member’s own account', async () => {
    for (const sessionId of [
      await thread(ids.bob, '*'),
      // Carol alone asks in a thread Bob started: his accounts are not hers to use.
      await thread(ids.bob, ids.carol),
    ]) {
      const { yours, others, text } = await listed(sessionId)
      assert.deepEqual(yours.slice(0, 1), ['- Stripe · acme: read'])
      assert.match(
        yours[1]!,
        /^Several people ask in this thread, so it uses no member's own account/,
      )
      assert.deepEqual(others, ['- GitHub · acme-org: app.kind github, app.account "acme-org"'])
      assert.doesNotMatch(text, /bob-|carol-|ada-/)
    }
  })

  test("a playbook's run has no list_apps", async () => {
    const run = await db.playbookRun.create({
      data: { installationId: ids.installation } as never,
    })
    const reply = await listApps(
      await thread(ids.bob, null, { origin: 'trigger', playbookRunId: run.id }),
    )
    assert.equal(reply.ok, false)
    assert.match(reply.error!, /only the Apps the playbook declares/)
  })

  /** An MCP server's URL that holds its key in its path, as Zapier's do: one for each server. */
  const keyed = () =>
    `https://mcp.zapier.example/api/mcp/s/key${randomUUID().replace(/-/g, '')}/mcp`
  /** Every MCP server URL the tests below add: none ever shows. */
  const urls: string[] = []
  /** No part of an MCP server's URL in a listing: not whole, nor its host, path or key. */
  const noUrl = (text: string) => {
    for (const raw of urls) {
      const url = new URL(raw)
      const key = url.pathname.split('/').find((part) => part.startsWith('key'))!
      for (const part of [url.href, url.host, url.pathname, key])
        assert.ok(!text.includes(part), `${part} (of ${raw}) shows`)
    }
  }
  /** An account on an MCP server of that name (null: none of its own), at a URL of its own. */
  const server = (
    name: string | null,
    externalAccount: string,
    by: string,
    reach: 'mine' | 'workspace',
  ) => {
    const url = keyed()
    urls.push(url)
    return account({
      url,
      kind: 'mcp',
      label: name ?? 'MCP server',
      externalAccount,
      by,
      reach,
      ...(name ? { name } : {}),
    })
  }
  const appOf = async (connectionId: string) =>
    (await db.connection.findFirstOrThrow({ where: { id: connectionId } })).appId

  /** A ticket of Riley's in the thread, with its asks as Riley's runner makes them of open_ticket's input. */
  async function ticketFor(app: Record<string, unknown>) {
    const { ticketAsks } = await import('../../runner/src/harness/events.js')
    const opened = ticketAsks({
      title: 'Team Notes',
      asks: [{ id: 'a', type: 'access', kind: 'connection', what: 'Team Notes', app }],
    })
    assert.ok(opened, 'open_ticket takes it')
    return opened.asks
  }
  async function answer(sessionId: string, asks: unknown[], connectionId: string) {
    const { answerTicket } = await import('../src/decide.js')
    const { fakeRunner } = await import('./in-hub.js')
    const ticket = await db.ticket.create({
      data: {
        sessionId,
        type: 'request',
        title: 'Team Notes',
        payload: { source: 'harness', requestId: randomUUID(), teammateId: ids.riley, asks },
      } as never,
    })
    const runner = await fakeRunner(scope, ids.computer)
    try {
      // Ada, an owner, gives the account picked in the ticket.
      return await runner.run(() =>
        answerTicket(
          { ...scope, memberId: ids.ada, userId: `ada-${suffix}`, role: 'owner' },
          ticket.id,
          { action: 'answered', replies: { a: { type: 'access', granted: true, connectionId } } },
        ),
      )
    } finally {
      runner.close()
    }
  }
  const given = async () =>
    (
      await db.grant.findMany({
        where: { teammateId: ids.riley, connection: { label: 'Team Notes' } },
      })
    ).map((g) => [g.connectionId, g.scope])

  // Last: the servers they add would show in the listings above.
  test('two MCP servers of one name: the ticket list_apps suggests gives the account it lists', async () => {
    // Staging and production, both "Team Notes", each with an account the workspace shares; a
    // third of that name that only Carol signed in to.
    const staging = await server('Team Notes', 'notes-staging', ids.ada, 'workspace')
    const production = await server('Team Notes', 'notes-production', ids.ada, 'workspace')
    const archive = await server('Team Notes', 'notes-archive', ids.carol, 'mine')
    const sessionId = await thread(ids.bob, ids.bob)
    const { others, connectable, text } = await listed(sessionId)
    assert.deepEqual(
      others.filter((l) => l.includes('Team Notes')),
      [
        `- Team Notes · notes-production: app.kind mcp, what "Team Notes", app.server "${await appOf(production)}", app.account "notes-production"`,
        `- Team Notes · notes-staging: app.kind mcp, what "Team Notes", app.server "${await appOf(staging)}", app.account "notes-staging"`,
      ],
    )
    // Carol's is hers: the server, by its id, never her account.
    assert.ok(
      connectable.includes(
        `- Team Notes (app.kind mcp, what "Team Notes", app.server "${await appOf(archive)}"): an MCP server added in the workspace`,
      ),
    )
    assert.doesNotMatch(text, /notes-archive/)
    noUrl(text)

    // The ticket as Riley writes it from the production line, and its runner opens it.
    const line = others.find((l) => l.includes('app.account "notes-production"'))!
    const id = /app\.server "([^"]+)"/.exec(line)?.[1]
    const asks = await ticketFor({
      kind: 'mcp',
      scope: 'read',
      account: 'notes-production',
      ...(id ? { server: id } : {}),
    })
    await db.account.create({
      data: {
        memberId: ids.bob,
        computerId: ids.computer,
        provider: 'claude_code',
        label: 'Claude',
        status: 'ready',
        isDefault: true,
      } as never,
    })
    await answer(sessionId, asks, production)
    assert.deepEqual(await given(), [[production, 'read']])
  })

  // With the servers the test above adds.
  test('an API from before app.server, which drops it, gives no account rather than the wrong server', async () => {
    const [staging, production] = await db.connection.findMany({
      where: { label: 'Team Notes', reach: 'workspace' },
      orderBy: { createdAt: 'asc' },
    })
    const sessionId = await thread(ids.bob, ids.bob)
    const [ask] = (await ticketFor({
      kind: 'mcp',
      scope: 'read',
      account: 'notes-production',
      server: production!.appId,
    })) as { app: Record<string, unknown> }[]
    // Its Ask schema strips the field it does not know: the url the runner added is left.
    const { server: _dropped, ...older } = ask!.app
    // What its ticket card offers then, by the name: the first server's account. Not given.
    await assert.rejects(answer(sessionId, [{ ...ask, app: older }], staging!.id), {
      message: /Connect the MCP server first/,
    })
    assert.ok(!(await given()).some(([id]) => id === staging!.id), 'not the staging account')
    // As no server has the url it goes by.
    assert.match(String(older.url), /^https:\/\/brigade\.invalid\//)
    // A server no longer in the workspace is said to be gone.
    await assert.rejects(
      answer(
        sessionId,
        await ticketFor({ kind: 'mcp', scope: 'read', server: 'gone' }),
        staging!.id,
      ),
      { message: /no longer in the workspace/ },
    )
  })

  test("no part of an MCP server's URL shows, whatever its name or whose its account", async () => {
    // Shared, under a name of its own or another's or none; Carol's own, under the same.
    await server('Lone Tracker', 'tracker', ids.ada, 'workspace')
    await server('Wiki', 'wiki-one', ids.ada, 'workspace')
    await server('Wiki', 'wiki-two', ids.ada, 'workspace')
    await server(null, 'nameless', ids.ada, 'workspace')
    await server('Ledger', 'carol-ledger', ids.carol, 'mine')
    await server('Wiki', 'carol-wiki', ids.carol, 'mine')
    await server(null, 'carol-nameless', ids.carol, 'mine')
    // One given to Riley too, which it uses here.
    const used = await server('Docs Search', 'docs', ids.ada, 'workspace')
    await db.grant.create({
      data: { teammateId: ids.riley, connectionId: used, scope: 'read' } as never,
    })
    for (const [who, sessionId] of [
      ['Bob, alone', await thread(ids.bob, ids.bob)],
      ['several people', await thread(ids.bob, '*')],
      ['Carol, alone', await thread(ids.carol, ids.carol)],
    ] as const) {
      const { yours, others, connectable, text } = await listed(sessionId)
      assert.ok(yours.includes('- Docs Search · docs: read'), who)
      assert.ok(
        others.some((l) => l.startsWith('- Wiki · wiki-two: app.kind mcp')),
        who,
      )
      assert.ok(
        others.some((l) =>
          l.startsWith('- MCP server · nameless: app.kind mcp, what "MCP server", app.server "'),
        ),
        who,
      )
      noUrl(text)
    }
  })
})
