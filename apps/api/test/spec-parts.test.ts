import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import { PROTOCOL_VERSION, SPEC_PARTS_PROTOCOL, ThreadSpec } from '@brigade/contracts'

// A thread spec's large parts named by hash (src/spec-parts.ts), against the API's development
// database (apps/api/.env), in an organization of its own removed at the end; skipped when no
// database answers:
// - packed, a spec keeps its small parts inline and names its large ones, kept once however many
//   specs name them; unpacked, it is the spec it was;
// - a kept command unpacks for a runner before SPEC_PARTS_PROTOCOL, the following teammates too;
// - a runner reads its own workspace's parts, by hash, as hashed; not another's;
// - a prompt dispatched is kept small, and a runner gets it by hash from SPEC_PARTS_PROTOCOL on,
//   whole before; one that cannot be made whole stays pending, never marked sent; one not kept,
//   queued while the computer was off, goes whole;
// - specs naming the same part at once write it once.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

const { prisma } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** A spec as specFor makes one, with a connector catalog of some size. */
const specOf = (sessionId: string) =>
  ThreadSpec.parse({
    sessionId,
    teammate: { id: 't1', name: 'Kai', instructions: '', harness: 'claude_code', model: null },
    permissionMode: 'allow-all',
    account: { id: 'a1', provider: 'claude_code', source: 'brigade' },
    fallbacks: [],
    connectors: [
      {
        connectionId: 'c1',
        kind: 'gmail',
        label: 'Gmail',
        externalAccount: 'ada@example.com',
        scope: 'read',
        operations: Array.from({ length: 40 }, (_, i) => ({
          name: `op_${i}`,
          description: 'An operation with a long description. '.repeat(5),
          write: false,
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        })),
      },
    ],
    skills: [{ name: 'tiny', description: 'small', instructions: 'Say hi.' }],
  })

describe('spec parts', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<
    'org' | 'workspace' | 'other' | 'laptop' | 'runner' | 'owner' | 'session',
    string
  >
  const tokens = { mine: `token-${suffix}`, other: `token-other-${suffix}` }

  before(async () => {
    const { hashToken } = await import('../src/hub.js')
    ids.org = `org-parts-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Parts', slug: `parts-${suffix}` },
    })
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Parts' } })
    ).id
    ids.other = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Other' } })
    ).id
    for (const [workspaceId, token] of [
      [ids.workspace, tokens.mine],
      [ids.other, tokens.other],
    ] as const) {
      const computer = await prisma.computer.create({
        data: { organizationId: ids.org, workspaceId, kind: 'cloud', name: 'Cloud' },
      })
      const runner = await prisma.runner.create({
        data: {
          organizationId: ids.org,
          workspaceId,
          computerId: computer.id,
          tokenHash: hashToken(token),
        },
      })
      if (workspaceId === ids.workspace) {
        ids.laptop = computer.id
        ids.runner = runner.id
      }
    }
    await prisma.user.create({
      data: { id: `owner-${suffix}`, name: 'Ada', email: `owner-${suffix}@test.local` },
    })
    ids.owner = (
      await prisma.member.create({
        data: {
          id: `m-owner-${suffix}`,
          organizationId: ids.org,
          userId: `owner-${suffix}`,
          role: 'owner',
        },
      })
    ).id
    const teammate = await prisma.teammate.create({
      data: { organizationId: ids.org, workspaceId: ids.workspace, name: `Kai ${suffix}` },
    } as never)
    ids.session = (
      await prisma.session.create({
        data: {
          organizationId: ids.org,
          workspaceId: ids.workspace,
          teammateId: (teammate as { id: string }).id,
          startedByMemberId: ids.owner,
          computerId: ids.laptop,
          title: 'parts',
          status: 'idle',
        },
      } as never)
    ).id
  })

  after(async () => {
    await prisma.workspace.deleteMany({ where: { organizationId: ids.org } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({ where: { id: `owner-${suffix}` } })
  })

  /** Sending through the workspace's hub. */
  const dispatcher = async () => {
    const { hubs } = await import('../src/hub.js')
    const hub = hubs.get(ids.workspace)
    return hub.dispatch.bind(hub)
  }
  /** A runner connecting with this protocol: its socket and what it is sent. */
  const connect = async (protocolVersion: number) => {
    const { runnerSocket } = await import('../src/hub.js')
    const handle = runnerSocket({
      id: ids.runner,
      computerId: ids.laptop,
      organizationId: ids.org,
      workspaceId: ids.workspace,
    })
    const sent: { type: string; commandId?: string; thread?: ThreadSpec }[] = []
    const ws = { send: (raw: string) => sent.push(JSON.parse(raw)), close: () => {} }
    handle.onMessage(
      JSON.stringify({ type: 'hello', protocolVersion, version: '0', platform: 'linux-x64' }),
      ws as never,
    )
    for (let i = 0; i < 200 && !sent.some((m) => m.type === 'welcome'); i++)
      await new Promise((resolve) => setTimeout(resolve, 20))
    return { handle, sent }
  }
  const prompt = () => ({
    type: 'thread.prompt' as const,
    commandId: randomUUID(),
    thread: specOf(ids.session),
    then: [],
    text: 'hi',
    memberId: null,
    attachments: [],
  })
  /** Read once the computer is made (before). */
  const computer = () => ({
    id: ids.laptop,
    kind: 'cloud',
    organizationId: ids.org,
    workspaceId: ids.workspace,
  })

  test('a spec names its large parts, kept once, and unpacks as it was', async () => {
    const { packSpec, unpackSpec } = await import('../src/spec-parts.js')
    const whole = specOf('s1')
    const packed = await packSpec(ids.workspace, whole)
    const connectors = JSON.stringify(whole.connectors)
    assert.deepEqual(packed.parts, { connectors: sha256(connectors) })
    assert.deepEqual(packed.connectors, [])
    assert.deepEqual(packed.skills, whole.skills, 'a small part stays inline')
    assert.ok(JSON.stringify(packed).length < 2048, 'what a command carries is small')

    await packSpec(ids.workspace, specOf('s2'))
    assert.equal(await prisma.specPart.count({ where: { workspaceId: ids.workspace } }), 1)
    assert.deepEqual(await unpackSpec(ids.workspace, packed), whole)
    await assert.rejects(unpackSpec(ids.other, packed), /is gone/)
  })

  test('a command unpacks for an older runner, every teammate after the first too', async () => {
    const { packSpec, unpackCommand } = await import('../src/spec-parts.js')
    const first = await packSpec(ids.workspace, specOf('s3'))
    const then = await packSpec(ids.workspace, specOf('s3'))
    const whole = await unpackCommand(ids.workspace, {
      type: 'thread.prompt',
      commandId: 'c',
      thread: first,
      then: [then],
      text: 'hi',
      memberId: null,
      attachments: [],
    })
    assert.equal(whole.thread.parts, undefined)
    assert.equal(whole.thread.connectors.length, 1)
    assert.equal(whole.type === 'thread.prompt' && whole.then[0]!.connectors.length, 1)
  })

  test("a runner reads its workspace's parts by hash, as hashed", async () => {
    const { app } = await import('../src/app.js')
    const { packSpec } = await import('../src/spec-parts.js')
    const packed = await packSpec(ids.workspace, specOf('s4'))
    const hash = packed.parts!.connectors!
    const read = (token: string, path = hash) =>
      app.request(`/runner/spec-parts/${path}`, { headers: { authorization: `Bearer ${token}` } })
    const response = await read(tokens.mine)
    assert.equal(response.status, 200)
    assert.equal(sha256(await response.text()), hash)
    assert.equal((await read(tokens.other)).status, 404, "another workspace's runner")
    assert.equal((await read('nobody')).status, 401)
    assert.equal((await read(tokens.mine, 'not-a-hash')).status, 400)
  })

  test('a prompt is kept small, and sent by hash or whole by the runner it goes to', async () => {
    const dispatch = await dispatcher()
    // A current runner: one before CATALOG_PROTOCOL gets its Apps' operations whole as well.
    const current = await connect(PROTOCOL_VERSION)
    const recent = prompt()
    assert.equal(await dispatch(computer(), recent), 'sent')
    const row = await prisma.runnerCommand.findUniqueOrThrow({ where: { id: recent.commandId } })
    assert.ok(JSON.stringify(row.message).length < 4096, 'kept small')
    const got = current.sent.find((m) => m.commandId === recent.commandId)!
    assert.ok(got.thread?.parts?.connectors, 'named by hash')
    assert.deepEqual(got.thread?.connectors, [])
    current.handle.onClose()

    const old = await connect(SPEC_PARTS_PROTOCOL - 1)
    const before = prompt()
    assert.equal(await dispatch(computer(), before), 'sent')
    const whole = old.sent.find((m) => m.commandId === before.commandId)!
    assert.equal(whole.thread?.parts, undefined)
    assert.equal(whole.thread?.connectors.length, 1, 'whole for a runner before it')
    old.handle.onClose()
  })

  test('a command that cannot be made whole for an older runner stays pending, unsent', async () => {
    const dispatch = await dispatcher()
    const command = prompt()
    // Kept while nothing is connected, then its part is gone (swept, say).
    assert.equal(await dispatch(computer(), command), 'queued')
    await prisma.specPart.deleteMany({ where: { workspaceId: ids.workspace } })
    const old = await connect(SPEC_PARTS_PROTOCOL - 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(old.sent.filter((m) => m.commandId === command.commandId).length, 0)
    const row = await prisma.runnerCommand.findUniqueOrThrow({ where: { id: command.commandId } })
    assert.equal(row.status, 'pending')
    assert.equal(row.sentAt, null, 'never marked sent')
    old.handle.onClose()
    await prisma.runnerCommand.deleteMany({ where: { id: command.commandId } })
  })

  test('a command not kept, queued while offline, goes whole', async () => {
    const dispatch = await dispatcher()
    const terminal = {
      type: 'terminal.open' as const,
      terminalId: randomUUID(),
      thread: specOf(ids.session),
      memberId: ids.owner,
      cols: 80,
      rows: 24,
    }
    assert.equal(await dispatch(computer(), terminal), 'queued')
    const old = await connect(SPEC_PARTS_PROTOCOL - 1)
    for (let i = 0; i < 100 && !old.sent.some((m) => m.type === 'terminal.open'); i++)
      await new Promise((resolve) => setTimeout(resolve, 20))
    const got = old.sent.find((m) => m.type === 'terminal.open')!
    assert.equal(got.thread?.parts, undefined)
    assert.equal(got.thread?.connectors.length, 1)
    old.handle.onClose()
  })

  test('specs naming the same part at once keep it once', async () => {
    const { packSpec } = await import('../src/spec-parts.js')
    const before = await prisma.specPart.count({ where: { workspaceId: ids.other } })
    const specs = Array.from({ length: 5 }, (_, i) => specOf(`s-${i}`))
    const packed = await Promise.all(specs.map((spec) => packSpec(ids.other, spec)))
    assert.equal(new Set(packed.map((p) => p.parts?.connectors)).size, 1)
    assert.equal(await prisma.specPart.count({ where: { workspaceId: ids.other } }), before + 1)
  })
})
