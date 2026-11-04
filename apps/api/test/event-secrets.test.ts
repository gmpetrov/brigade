// A runner's events are stored with their secrets masked (src/secrets.ts, src/hub/runner-messages.ts),
// against the API's development database (apps/api/.env), in an organization of its own removed at
// the end; skipped when no database answers: what is stored, and what a browser is sent, holds the
// kind of secret in its place, the rest of the event as the runner sent it.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'

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

// Made up, in the shape of a real one; built from parts so no scanner takes this file for a leak.
const neon = ['npg', 'Ab3Cd5Ef7Gh9'].join('_')
const github = ['ghp', 'aB3cD5eF7gH9iJ2kL4mN6pQ8rS1tU0vWxY2z'].join('_')

describe('secrets in stored events', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const org = `org-secrets-${suffix}`
  let scope: { organizationId: string; workspaceId: string }
  let db: ReturnType<typeof scoped>
  let computerId: string
  let sessionId: string

  before(async () => {
    await prisma.organization.create({ data: { id: org, name: 'Secrets', slug: org } })
    await prisma.user.create({
      data: { id: `u-${suffix}`, name: 'Ada', email: `u-${suffix}@test.local` },
    })
    await prisma.member.create({
      data: { id: `m-${suffix}`, organizationId: org, userId: `u-${suffix}`, role: 'owner' },
    })
    const workspaceId = (
      await prisma.workspace.create({ data: { organizationId: org, name: 'Secrets' } })
    ).id
    scope = { organizationId: org, workspaceId }
    db = scoped(scope)
    computerId = (
      await db.computer.create({
        data: { kind: 'member_machine', memberId: `m-${suffix}`, name: 'Mac' },
      } as never)
    ).id
    const teammateId = (await db.teammate.create({ data: { name: `Riley ${suffix}` } } as never)).id
    sessionId = (
      await db.session.create({
        data: {
          teammateId,
          startedByMemberId: `m-${suffix}`,
          computerId,
          title: 'Secrets',
          status: 'running',
          origin: 'member',
        },
      } as never)
    ).id
  })

  after(async () => {
    if (scope) await prisma.workspace.deleteMany({ where: { id: scope.workspaceId } })
    await prisma.member.deleteMany({ where: { organizationId: org } })
    await prisma.organization.deleteMany({ where: { id: org } })
    await prisma.user.deleteMany({ where: { id: `u-${suffix}` } })
  })

  test('a tool’s input and the harness’s raw copy are stored masked, and sent masked', async () => {
    const { fakeRunner } = await import('./in-hub.js')
    const { localHub } = await import('../src/hub/memory-host.js')
    const { onRunnerMessage } = await import('../src/hub/runner-messages.js')
    const runner = await fakeRunner(scope, computerId)
    const hub = localHub(scope.workspaceId)
    const conn = hub.runners.get(computerId)!
    const broadcast: unknown[] = []
    const original = hub.broadcast.bind(hub)
    hub.broadcast = ((message: unknown, ...rest: unknown[]) => {
      broadcast.push(message)
      return (original as (...a: unknown[]) => unknown)(message, ...rest)
    }) as typeof hub.broadcast
    const at = new Date().toISOString()
    const url = `postgres://neondb_owner:${neon}@ep-dry-sky-1.eu-central-1.aws.neon.tech/neondb`
    const events = [
      {
        sessionId,
        seq: 1,
        event: {
          at,
          type: 'tool.started',
          toolCallId: 'c1',
          toolName: 'Bash',
          input: { command: `psql '${url}' -c 'select 1'`, description: 'Count rows' },
        },
      },
      {
        sessionId,
        seq: 2,
        event: {
          at,
          type: 'raw',
          source: 'claude',
          value: {
            type: 'user',
            message: { content: [{ type: 'tool_result', content: `GITHUB_TOKEN=${github}\n` }] },
          },
        },
      },
    ]
    try {
      await runner.run(() => onRunnerMessage(hub, conn, JSON.stringify({ type: 'events', events })))
      await conn.queue
      const rows = await db.sessionEvent.findMany({
        where: { sessionId },
        orderBy: { seq: 'asc' },
      })
      assert.deepEqual(
        rows.map((r) => r.data),
        [
          {
            ...events[0]!.event,
            input: {
              command:
                "psql 'postgres://neondb_owner:[redacted: a Neon password]@ep-dry-sky-1.eu-central-1.aws.neon.tech/neondb' -c 'select 1'",
              description: 'Count rows',
            },
          },
          {
            ...events[1]!.event,
            value: {
              type: 'user',
              message: {
                content: [
                  { type: 'tool_result', content: 'GITHUB_TOKEN=[redacted: a GitHub token]\n' },
                ],
              },
            },
          },
        ],
      )
      const stored = JSON.stringify(rows)
      assert.ok(!stored.includes(neon) && !stored.includes(github), 'no secret stored')
      const sent = JSON.stringify(broadcast)
      assert.ok(sent.includes('[redacted: a Neon password]'), 'the events went to browsers')
      assert.ok(!sent.includes(neon) && !sent.includes(github), 'no secret sent to browsers')
      assert.ok(
        runner.sent.some((m) => m.type === 'ack' && m.seq === 2),
        'acknowledged',
      )
      // A reply's deltas from a runner before MASKED_DELTAS_PROTOCOL, which does not mask them:
      // stored without their text, which the API cannot mask one delta at a time.
      const delta = (seq: number, text: string) => ({
        sessionId,
        seq,
        event: { at, type: 'message.delta', id: 'reply', text },
      })
      const say = (...events: object[]) =>
        runner.run(() => onRunnerMessage(hub, conn, JSON.stringify({ type: 'events', events })))
      const { MASKED_DELTAS_PROTOCOL } = await import('@brigade/contracts')
      conn.protocolVersion = MASKED_DELTAS_PROTOCOL - 1
      await say(
        delta(3, `Your token: ${github.slice(0, 4)}`),
        delta(4, `${github.slice(4)} is set.`),
      )
      await conn.queue
      // One from it on: as it masked them, a secret alone in one masked here as well.
      conn.protocolVersion = MASKED_DELTAS_PROTOCOL
      await say(delta(5, ' Also '), delta(6, `${github} `))
      await conn.queue
      const deltas = await db.sessionEvent.findMany({
        where: { sessionId, type: 'message.delta' },
        orderBy: { seq: 'asc' },
      })
      assert.deepEqual(
        deltas.map((r) => (r.data as { text: string }).text),
        ['', '', ' Also ', '[redacted: a GitHub token] '],
      )
      assert.ok(!JSON.stringify(deltas).includes(github.slice(4, 12)), 'no part of it stored')
    } finally {
      hub.broadcast = original
      for (const timer of conn.retries.values()) clearTimeout(timer)
      runner.close()
    }
  })
})
