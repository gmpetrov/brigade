import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import { triggerEvent, type ScheduleOperation } from '@brigade/contracts'

// A teammate's triggers (src/trigger-calls.ts), against the API's development database
// (apps/api/.env), in an organization of its own removed at the end; skipped when no
// database answers:
// - list_triggers shows the App accounts whose events can start a thread, and its own triggers;
// - create_trigger waits for an owner's or admin's approval in a ticket (the thread's starter,
//   a member, cannot give it), then makes the trigger with its instructions, on the starter's
//   accounts, in the thread's project, and keeps a custom app's signing secret in the vault
//   for the teammate alone;
// - declined, nothing is made; refused from a thread an event or a schedule started;
// - each event's thread starts with the instructions, and still reads as a trigger's event.
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

type Reply = {
  type: string
  ok?: boolean
  error?: string
  output?: Record<string, unknown>
  ticketId?: string
  reason?: string
  decision?: { ticketId: string; approved: boolean; memberId: string }
}

describe("a teammate's triggers", { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<
    'org' | 'workspace' | 'owner' | 'bob' | 'computer' | 'riley' | 'project' | 'stripe',
    string
  >
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }
  const as = (memberId: string, role: 'owner' | 'member') => ({
    ...scope,
    memberId,
    role,
    userId: memberId === ids.owner ? `owner-${suffix}` : `bob-${suffix}`,
  })

  /** A thread of Riley's that Bob, a member, started. */
  const thread = async (origin: 'member' | 'trigger' = 'member') => {
    const session = await db.session.create({
      data: {
        teammateId: ids.riley,
        startedByMemberId: ids.bob,
        computerId: ids.computer,
        title: 'Errors',
        projectId: ids.project,
        origin,
        status: 'running',
      } as never,
    })
    await db.threadTeammate.create({
      data: { sessionId: session.id, teammateId: ids.riley } as never,
    })
    return session.id
  }

  /** Riley calls a trigger tool; every message the API sends back, as they come. */
  async function call(sessionId: string, operation: object, replies: Reply[] = []) {
    const { handleScheduleCall } = await import('../src/schedules.js')
    await handleScheduleCall(
      { computerId: ids.computer, ...scope },
      {
        type: 'schedule.call',
        callId: randomUUID(),
        sessionId,
        teammateId: ids.riley,
        operation: operation as ScheduleOperation,
      },
      (message) => replies.push(message as Reply),
    )
    return replies.at(-1)!
  }

  /** The call's ticket, once it waits on it. */
  async function waiting(replies: Reply[]) {
    for (let i = 0; i < 100 && !replies.some((r) => r.type === 'connector.pending'); i++)
      await new Promise((resolve) => setTimeout(resolve, 20))
    const pending = replies.find((r) => r.type === 'connector.pending')
    assert.ok(pending, 'the call waits for a person')
    return pending.ticketId!
  }

  const sentry = {
    name: 'create_trigger',
    customApp: 'Sentry',
    event: 'received',
    options: {},
    label: 'New Sentry errors',
    instructions: 'Find the cause of the error and open a pull request when the fix is small.',
    verification: 'hmac',
    reason: 'Bob asked for each new error to be looked at.',
  }

  before(async () => {
    ids.org = `org-trig-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Triggers', slug: `triggers-${suffix}` },
    })
    for (const [who, role] of [
      ['owner', 'owner'],
      ['bob', 'member'],
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
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Triggers' } })
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
    const app = await db.app.create({
      data: { key: 'stripe', createdByMemberId: ids.owner } as never,
    })
    ids.stripe = (
      await db.connection.create({
        data: {
          appId: app.id,
          kind: 'stripe',
          label: 'Stripe',
          externalAccount: 'acme',
          createdByMemberId: ids.owner,
        } as never,
      })
    ).id
  })

  after(async () => {
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({
      where: { id: { in: [`owner-${suffix}`, `bob-${suffix}`] } },
    })
  })

  test('list_triggers shows the App accounts and their events', async () => {
    const reply = await call(await thread(), { name: 'list_triggers' })
    assert.equal(reply.ok, true)
    const apps = reply.output!.apps as {
      connectionId: string
      app: string
      events: { event: string }[]
    }[]
    const stripe = apps.find((a) => a.connectionId === ids.stripe)
    assert.equal(stripe?.app, 'Stripe · acme')
    assert.ok(stripe!.events.length > 0)
    assert.match(String(reply.output!.customApp), /customApp/)
    assert.deepEqual(reply.output!.yourTriggers, [])
  })

  test('a custom app: approved by an owner, made with its URL and its secret in the vault', async () => {
    const { resolveTicket } = await import('../src/decide.js')
    const sessionId = await thread()
    const replies: Reply[] = []
    const done = call(sessionId, sentry, replies)
    const ticketId = await waiting(replies)
    const ticket = await db.ticket.findFirstOrThrow({ where: { id: ticketId } })
    assert.equal(ticket.type, 'approval')
    assert.equal(ticket.sessionId, sessionId)
    assert.equal((ticket.payload as { triggerAction?: string }).triggerAction, 'create')
    assert.equal((ticket.payload as { app?: string }).app, 'Custom app · Sentry')
    assert.match(replies[0]!.reason!, /Only an owner or admin can allow it/)

    // Bob started the thread, but a trigger is an admin's call.
    await assert.rejects(resolveTicket(as(ids.bob, 'member'), ticketId, { approved: true }), {
      message: /Only an owner or admin/,
    })
    assert.deepEqual(await resolveTicket(as(ids.owner, 'owner'), ticketId, { approved: true }), {
      ok: true,
      live: true,
    })
    const reply = await done
    assert.equal(reply.ok, true, reply.error)
    assert.deepEqual(reply.decision, { ticketId, approved: true, memberId: ids.owner })
    const output = reply.output as {
      triggerId: string
      url: string
      signingSecret: { credentialId: string; how: string }
    }
    assert.match(output.url, /\/hooks\//)
    assert.match(output.signingSecret.how, /X-Brigade-Signature/)
    assert.doesNotMatch(JSON.stringify(output), /bwh_/, 'the secret itself is never in the reply')

    const trigger = await db.trigger.findFirstOrThrow({
      where: { id: output.triggerId },
      include: { connection: true },
    })
    assert.equal(trigger.instructions, sentry.instructions)
    assert.equal(trigger.createdByMemberId, ids.bob, "it runs on the asker's accounts")
    assert.equal(trigger.projectId, ids.project)
    assert.equal(trigger.verification, 'hmac')
    assert.equal(trigger.connection.kind, 'webhook')
    assert.equal(trigger.connection.label, 'Sentry')
    assert.equal(trigger.connection.createdByMemberId, ids.owner)

    // The same secret as the trigger's, which only Riley may use, without asking.
    const { openSecret } = await import('../src/vault.js')
    const credential = await db.credential.findFirstOrThrow({
      where: { id: output.signingSecret.credentialId },
      include: { grants: true },
    })
    assert.equal(credential.access, 'selected')
    assert.deepEqual(
      credential.grants.map((g) => [g.teammateId, g.withoutAsking]),
      [[ids.riley, true]],
    )
    assert.deepEqual(
      (await openSecret<{ value: string }>(db, scope, credential.vaultSecretId)).value,
      (await openSecret<{ secret: string }>(db, scope, trigger.verificationSecretId!)).secret,
    )
    assert.equal((await db.ticket.findFirstOrThrow({ where: { id: ticketId } })).status, 'approved')

    // Listed as its own from then on.
    const listed = await call(sessionId, { name: 'list_triggers' })
    assert.deepEqual(
      (listed.output!.yourTriggers as { triggerId: string; url: string }[]).map((t) => [
        t.triggerId,
        t.url,
      ]),
      [[trigger.id, output.url]],
    )
  })

  test("an App's event, declined: nothing is made", async () => {
    const { resolveTicket } = await import('../src/decide.js')
    const before = await db.trigger.count()
    const replies: Reply[] = []
    const done = call(
      await thread(),
      {
        name: 'create_trigger',
        connectionId: ids.stripe,
        event: Object.keys((await import('../src/connectors/index.js')).triggersOf('stripe'))[0],
        options: {},
        label: 'Payments',
        instructions: 'Thank the customer.',
      },
      replies,
    )
    const ticketId = await waiting(replies)
    await resolveTicket(as(ids.owner, 'owner'), ticketId, { approved: false, reason: 'Not now' })
    const reply = await done
    assert.equal(reply.ok, false)
    assert.match(reply.error!, /declined this trigger: Not now/)
    assert.equal(reply.decision?.approved, false)
    assert.equal(await db.trigger.count(), before)
  })

  test("refused from an event's thread, and when the call cannot be made", async () => {
    const asked = await db.ticket.count()
    const fromEvent = await call(await thread('trigger'), sentry)
    assert.equal(fromEvent.ok, false)
    assert.match(fromEvent.error!, /only from a thread a person started/)

    const sessionId = await thread()
    const both = await call(sessionId, { ...sentry, connectionId: ids.stripe })
    assert.match(both.error!, /either connectionId/)
    const unsigned = await call(sessionId, { ...sentry, verification: undefined })
    assert.match(unsigned.error!, /Give verification/)
    const unknown = await call(sessionId, { ...sentry, customApp: undefined, connectionId: 'nope' })
    assert.match(unknown.error!, /No App account/)
    const event = await call(sessionId, { ...sentry, event: 'payment' })
    assert.match(event.error!, /No event "payment"/)
    assert.equal(await db.ticket.count(), asked, 'no ticket for what cannot be made')
  })

  test("each event's thread starts with the instructions, and still reads as an event", async () => {
    const { eventMessage } = await import('../src/triggers.js')
    const { triggersOf } = await import('../src/connectors/index.js')
    const { text } = eventMessage(
      { label: 'New Sentry errors', instructions: sentry.instructions },
      triggersOf('webhook').received!,
      { externalAccount: null, label: 'Sentry' },
      { id: 'evt_1', type: 'received', payload: { type: 'error', message: 'boom' } },
    )
    assert.ok(
      text.startsWith(`Instructions for each event of this trigger:\n${sentry.instructions}`),
    )
    const event = triggerEvent(text)
    assert.equal(event?.trigger, 'New Sentry errors')
    assert.deepEqual(event?.payload, { type: 'error', message: 'boom' })
  })
})
