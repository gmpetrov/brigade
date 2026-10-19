// Grouped approvals, against the checkout's local database (apps/api/.env's DATABASE_URL):
// skipped where there is none. Each run makes an organization of its own and removes it.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { playbookApprovalOf, toApprove } from '@brigade/contracts'
import { fromBase64Url, generateVapidKeys, toBase64Url } from '../src/web-push.js'

const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile)
process.env.DATABASE_URL ??= 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
// Pushes on, to a push service of the test's own (below).
const vapidKeys = await generateVapidKeys()
process.env.VAPID_PUBLIC_KEY = vapidKeys.publicKey
process.env.VAPID_PRIVATE_KEY = vapidKeys.privateKey
process.env.VAPID_SUBJECT = 'mailto:test@example.com'

const { prisma, scoped } = await import('../src/db.js')
const { awaitDecision } = await import('../src/connector-calls.js')
const { resolveTicket } = await import('../src/decide.js')
const { sweep } = await import('../src/notifications.js')
const { decidePlaybookApprovals, playbookApprovals, waitingTickets } =
  await import('../src/playbook-approvals.js')
const { templates } = await import('../src/playbooks.js')

const reachable = await prisma.$queryRawUnsafe('select 1').then(
  () => true,
  () => false,
)
const skip = reachable ? false : 'no local database (apps/api/.env)'
const id = () => randomUUID()

// ---------------------------------------------------------------------------
// A push service: records what each device was sent, and reads it as the browser would.
// ---------------------------------------------------------------------------

const received: { path: string; body: Uint8Array }[] = []
const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    received.push({ path: req.url!, body: new Uint8Array(Buffer.concat(chunks)) })
    res.writeHead(201).end()
  })
})

const encoder = new TextEncoder()
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) out.set(p, (at += p.length) - p.length)
  return out
}
const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) =>
  new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info },
      await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']),
      length * 8,
    ),
  )

/** A browser's subscription: its keys, to read what it is sent (RFC 8291). */
async function subscription() {
  const ecdh = { name: 'ECDH', namedCurve: 'P-256' } as const
  const pair = (await crypto.subtle.generateKey(ecdh, true, ['deriveBits'])) as CryptoKeyPair
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const auth = crypto.getRandomValues(new Uint8Array(16))
  return {
    p256dh: toBase64Url(publicKey),
    auth: toBase64Url(auth),
    async read(body: Uint8Array) {
      const salt = body.slice(0, 16)
      const idLength = body[20]!
      const asPublic = body.slice(21, 21 + idLength)
      const asKey = await crypto.subtle.importKey('raw', asPublic, ecdh, false, [])
      const secret = new Uint8Array(
        await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, pair.privateKey, 256),
      )
      const info = concat(encoder.encode('WebPush: info\0'), publicKey, asPublic)
      const ikm = await hkdf(fromBase64Url(this.auth), secret, info, 32)
      const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16)
      const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12)
      const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt'])
      const plain = new Uint8Array(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.slice(21 + idLength)),
      )
      // The message, then the last record's delimiter (2).
      return JSON.parse(new TextDecoder().decode(plain.slice(0, plain.lastIndexOf(2))))
    },
  }
}

// ---------------------------------------------------------------------------
// The workspace: an owner (whose playbook it is), an admin and a member, each with a device.
// ---------------------------------------------------------------------------

type Role = 'owner' | 'admin' | 'member'
let organizationId = ''
let workspaceId = ''
let teammateId = ''
let computerId = ''
let installationId = ''
const members = {} as Record<Role, { id: string; userId: string; device: string }>
const devices = {} as Record<Role, Awaited<ReturnType<typeof subscription>>>
const userIds: string[] = []
const db = () => scoped({ organizationId, workspaceId })
const as = (role: Role) => ({ organizationId, workspaceId, memberId: members[role].id, role })

before(async () => {
  if (!reachable) return
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  organizationId = (
    await prisma.organization.create({
      data: { id: id(), name: 'Grouped approvals', slug: `test-${id()}` },
    })
  ).id
  for (const role of ['owner', 'admin', 'member'] as const) {
    const user = await prisma.user.create({
      data: { id: id(), name: role, email: `${id()}@test.invalid` },
    })
    userIds.push(user.id)
    const member = await prisma.member.create({
      data: { id: id(), organizationId, userId: user.id, role },
    })
    devices[role] = await subscription()
    const device = `/${role}/${id()}`
    await prisma.pushDevice.create({
      data: {
        userId: user.id,
        endpoint: `http://127.0.0.1:${port}${device}`,
        p256dh: devices[role].p256dh,
        auth: devices[role].auth,
      },
    })
    members[role] = { id: member.id, userId: user.id, device }
  }
  workspaceId = (await prisma.workspace.create({ data: { organizationId, name: 'Test' } })).id
  teammateId = (await db().teammate.create({ data: { name: 'Sam' } as never })).id
  computerId = (await db().computer.create({ data: { kind: 'cloud', name: 'Test' } as never })).id
  installationId = (
    await db().playbookInstallation.create({
      data: {
        playbookKey: 'brigade/support-bugs',
        version: '1.0.0',
        manifest: templates().get('brigade/support-bugs')!.manifest as never,
        teammateId,
        ownerMemberId: members.owner.id,
        createdByMemberId: members.owner.id,
        status: 'active',
      } as never,
    })
  ).id
})

after(async () => {
  server.close()
  if (reachable && organizationId) {
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  }
  await prisma.$disconnect()
})

/** A run of the playbook and its thread, started by its owner as its trigger does. */
async function run(title: string) {
  const row = await db().playbookRun.create({ data: { installationId } as never })
  const thread = await db().session.create({
    data: {
      teammateId,
      computerId,
      title,
      origin: 'trigger',
      startedByMemberId: members.owner.id,
      playbookRunId: row.id,
    } as never,
  })
  await db().playbookRun.updateMany({ where: { id: row.id }, data: { rootSessionId: thread.id } })
  return { runId: row.id, threadId: thread.id }
}

/** A reply the run's teammate wants to send, waiting for a person (connector-calls.ts). */
const approval = (r: { runId: string; threadId: string }, to = 'jane@acme.test') =>
  db().ticket.create({
    data: {
      sessionId: r.threadId,
      type: 'approval',
      title: `Sam: gmail send (email to ${to}: "Your refund")`,
      payload: {
        connectionId: 'connection',
        connection: 'support@brigade.test',
        operation: 'gmail_send',
        target: `email to ${to}: "Your refund"`,
        input: { to: [to], subject: 'Your refund', body: 'Hello,\n\nIt is on its way.' },
        playbookInstallationId: installationId,
        playbookActionKey: 'reply',
        playbookRunId: r.runId,
      },
    } as never,
  })

/** A thread no playbook started, and an approval in it. */
async function plainApproval() {
  const thread = await db().session.create({
    data: {
      teammateId,
      computerId,
      title: 'Refund Bob',
      startedByMemberId: members.owner.id,
    } as never,
  })
  const ticket = await db().ticket.create({
    data: {
      sessionId: thread.id,
      type: 'approval',
      title: 'Sam: stripe refund (ch_1)',
      payload: {
        connectionId: 'connection',
        operation: 'stripe_refund',
        target: 'ch_1',
        input: {},
      },
    } as never,
  })
  return { ticket, threadId: thread.id }
}

const payloadOf = async (ticketId: string) =>
  (await db().ticket.findFirst({ where: { id: ticketId } }))!.payload as Record<string, unknown>

/** Every open ticket gone: what one test leaves does not count in the next. */
const clear = () =>
  db().ticket.updateMany({ where: { status: 'open' }, data: { status: 'resolved' } })

/** What each device was sent since `from`, read. */
const pushesSince = async (from: number) =>
  Promise.all(
    received.slice(from).map(async (r) => {
      const role = (['owner', 'admin', 'member'] as const).find(
        (k) => members[k].device === r.path,
      )!
      return { role, message: await devices[role].read(r.body) }
    }),
  )

test('only the approvals of a playbook run group, by their playbook', () => {
  const payload = { playbookInstallationId: 'p1', playbookRunId: 'r1', playbookActionKey: 'reply' }
  assert.deepEqual(playbookApprovalOf({ type: 'approval', payload }), {
    installationId: 'p1',
    runId: 'r1',
    actionKey: 'reply',
  })
  assert.equal(
    playbookApprovalOf({ type: 'approval', payload: { ...payload, playbookActionKey: null } })
      ?.actionKey,
    null,
  )
  // A cap reached in a run, a request to activate it or to let an action act alone: their own.
  assert.equal(playbookApprovalOf({ type: 'cap', payload }), null)
  for (const other of [
    { playbookInstallationId: 'p1', playbookActivation: true },
    { playbookInstallationId: 'p1', playbookActionKey: 'reply', playbookPromotion: {} },
    { ...payload, playbookActivation: true },
    { connectionId: 'c', operation: 'gmail_send' },
  ])
    assert.equal(playbookApprovalOf({ type: 'approval', payload: other }), null)
})

test('a playbook queue is one item: one push, counted once in the badge', { skip }, async () => {
  const from = received.length
  const t0 = new Date(Date.now() + 60 * 60_000)
  const first = await run('Refund for Jane')
  const second = await run('Where is my order')
  await approval(first, 'jane@acme.test')
  await approval(second, 'joe@acme.test')
  await approval(first, 'jane@acme.test')
  // Seen, then sent once it has lasted a minute.
  await sweep(t0, organizationId)
  assert.equal(received.length, from)
  await sweep(new Date(t0.getTime() + 61_000), organizationId)
  const pushes = await pushesSince(from)
  // To the member whose approvals they are (the threads' starter), as each ticket's own would be.
  assert.deepEqual(
    pushes.map((p) => p.role),
    ['owner'],
  )
  const { message } = pushes[0]!
  assert.equal(message.title, `Support and bugs · ${toApprove(3)}`)
  assert.equal(message.badge, 1)
  assert.equal(message.tag, installationId)
  assert.equal(message.url, `/app?workspace=${workspaceId}&approvals=${installationId}`)
  // The group, opened: each with what it will do, its run, and who decides.
  const asOwner = await playbookApprovals(db(), as('owner'), installationId)
  assert.equal(asOwner.installation.name, 'Support and bugs')
  assert.equal(asOwner.items.length, 3)
  assert.deepEqual(
    asOwner.items.map((i) => [i.run.title, i.action.label, i.canDecide]),
    [
      ['Refund for Jane', 'Reply to the customer', true],
      ['Where is my order', 'Reply to the customer', true],
      ['Refund for Jane', 'Reply to the customer', true],
    ],
  )
  assert.deepEqual(asOwner.items[0]!.input, {
    to: ['jane@acme.test'],
    subject: 'Your refund',
    body: 'Hello,\n\nIt is on its way.',
  })
  const asMember = await playbookApprovals(db(), as('member'), installationId)
  assert.ok(asMember.items.every((i) => !i.canDecide))
  await clear()
})

test(
  'a queue sends one push when it fills, none while it stays full, one more once it emptied',
  { skip },
  async () => {
    const from = received.length
    // Past the previous test's hour, so its push does not count toward this one's cap.
    const t0 = Date.now() + 3 * 60 * 60_000
    const at = (minutes: number) => new Date(t0 + minutes * 60_000)
    await sweep(at(0), organizationId)
    const r = await run('Login does not work')
    const a = await approval(r)
    await sweep(at(1), organizationId)
    await sweep(at(2.5), organizationId)
    assert.equal((await pushesSince(from)).length, 1, '0 → 1: one push')
    // Another run's: a thread of its own, the same item.
    const b = await approval(await run('Invoice missing'), 'joe@acme.test')
    await sweep(at(4), organizationId)
    await sweep(at(10), organizationId)
    // Never reminded, however long it waits.
    await sweep(at(5 * 60), organizationId)
    assert.equal((await pushesSince(from)).length, 1, '1 → 2, and later: nothing more')
    // Emptied: nothing to send. Filled again: one push, once it has lasted a minute.
    await db().ticket.updateMany({
      where: { id: { in: [a.id, b.id] } },
      data: { status: 'approved' },
    })
    await sweep(at(5 * 60 + 1), organizationId)
    assert.equal((await pushesSince(from)).length, 1)
    await approval(await run('Export my data'), 'ann@acme.test')
    await sweep(at(5 * 60 + 2), organizationId)
    await sweep(at(5 * 60 + 4), organizationId)
    const pushes = await pushesSince(from)
    assert.equal(pushes.length, 2, 'empty → 1 again: a new push')
    assert.equal(pushes[1]!.message.title, `Support and bugs · ${toApprove(1)}`)
    await clear()
  },
)

test('an approval outside a playbook is its own item, as before', { skip }, async () => {
  const from = received.length
  const t0 = Date.now() + 10 * 60 * 60_000
  const { ticket, threadId } = await plainApproval()
  await sweep(new Date(t0), organizationId)
  await sweep(new Date(t0 + 61_000), organizationId)
  const pushes = await pushesSince(from)
  assert.deepEqual(
    pushes.map((p) => [p.role, p.message.title, p.message.tag, p.message.badge]),
    [['owner', 'Sam needs your approval', threadId, 1]],
  )
  // Not in the playbook's group, and not decided through it.
  assert.equal((await playbookApprovals(db(), as('owner'), installationId)).items.length, 0)
  const bulk = await decidePlaybookApprovals(as('owner'), installationId, {
    ticketIds: [ticket.id],
    approve: true,
  })
  assert.deepEqual(bulk, {
    decided: [],
    failed: [{ ticketId: ticket.id, error: 'Not an open approval of this playbook' }],
  })
  assert.equal((await payloadOf(ticket.id)).decidedInBulk, undefined)
  // Decided on its own, as always: no mark.
  await resolveTicket(as('owner'), ticket.id, { approved: true })
  const decided = await db().ticket.findFirst({ where: { id: ticket.id } })
  assert.equal(decided!.status, 'resolved')
  assert.equal((decided!.payload as Record<string, unknown>).decidedInBulk, undefined)
})

test(
  'approving in bulk decides each one as its own decision would, marked decidedInBulk',
  { skip },
  async () => {
    const r = await run('Three customers, one bug')
    const [a, b, c, single] = [
      await approval(r, 'a@acme.test'),
      await approval(r, 'b@acme.test'),
      await approval(r, 'c@acme.test'),
      await approval(r, 'd@acme.test'),
    ]
    // a and b wait for a person in this process, as live calls do; c's call is gone (a restart).
    const waiting = [awaitDecision(a!.id), awaitDecision(b!.id)]
    const plain = await plainApproval()
    const result = await decidePlaybookApprovals(as('admin'), installationId, {
      ticketIds: [a!.id, b!.id, c!.id, plain.ticket.id],
      approve: true,
    })
    assert.deepEqual(result.decided, [a!.id, b!.id, c!.id])
    assert.deepEqual(
      result.failed.map((f) => f.ticketId),
      [plain.ticket.id],
    )
    for (const decision of await Promise.all(waiting)) assert.equal(decision.approved, true)
    const rows = await db().ticket.findMany({ where: { id: { in: [a!.id, b!.id, c!.id] } } })
    for (const row of rows) {
      assert.equal((row.payload as Record<string, unknown>).decidedInBulk, true)
      assert.equal(row.resolvedByMemberId, members.admin.id)
    }
    assert.deepEqual(
      rows.map((t) => [t.id, t.status]).sort(),
      [
        [a!.id, 'approved'],
        [b!.id, 'approved'],
        [c!.id, 'resolved'],
      ].sort(),
    )
    // The one left is decided on its own: it counts, so no mark.
    const left = await playbookApprovals(db(), as('owner'), installationId)
    assert.deepEqual(
      left.items.map((i) => i.ticketId),
      [single!.id],
    )
    const live = awaitDecision(single!.id)
    await resolveTicket(as('owner'), single!.id, { approved: false })
    assert.equal((await live).approved, false)
    assert.equal((await payloadOf(single!.id)).decidedInBulk, undefined)
    // The plain one is left as it was.
    assert.equal((await db().ticket.findFirst({ where: { id: plain.ticket.id } }))!.status, 'open')
    assert.equal((await payloadOf(plain.ticket.id)).decidedInBulk, undefined)
    await clear()
  },
)

test(
  'a member who may not decide them decides none in bulk, and leaves no mark',
  { skip },
  async () => {
    const r = await run('Cancel my plan')
    const ticket = await approval(r)
    const result = await decidePlaybookApprovals(as('member'), installationId, {
      ticketIds: [ticket.id],
      approve: true,
    })
    assert.deepEqual(result.decided, [])
    assert.match(result.failed[0]!.error, /Only the member who started the thread, or an admin/)
    const row = await db().ticket.findFirst({ where: { id: ticket.id } })
    assert.equal(row!.status, 'open')
    assert.equal((row!.payload as Record<string, unknown>).decidedInBulk, undefined)
    await clear()
  },
)

test(
  'hundreds of approvals from one playbook are one item, and crowd out nothing else',
  { skip },
  async () => {
    const from = received.length
    const t0 = Date.now() + 20 * 60 * 60_000
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000)
    // Oldest: another playbook's approval, then a plain one; then 205 from the busy playbook.
    const other = (
      await db().playbookInstallation.create({
        data: {
          playbookKey: 'brigade/ship-and-tell',
          version: '1.0.0',
          manifest: { name: 'Ship and tell', apps: [], actions: [] },
          teammateId,
          ownerMemberId: members.owner.id,
          createdByMemberId: members.owner.id,
          status: 'active',
        } as never,
      })
    ).id
    const quiet = await run('Release notes')
    const older = await approval(quiet)
    await db().ticket.updateMany({
      where: { id: older.id },
      data: {
        createdAt: ago(120),
        payload: { ...(older.payload as object), playbookInstallationId: other } as never,
      },
    })
    const plain = await plainApproval()
    await db().ticket.updateMany({ where: { id: plain.ticket.id }, data: { createdAt: ago(60) } })
    const busy = await run('Monday morning')
    const template = await approval(busy)
    await db().ticket.createMany({
      data: Array.from({ length: 204 }, (_, i) => ({
        sessionId: busy.threadId,
        type: 'approval' as const,
        title: `Sam: gmail send (${i})`,
        payload: template.payload as never,
        createdAt: new Date(Date.now() - (204 - i) * 1_000),
      })) as never,
    })
    // An archived thread's approval waits on no one: not counted.
    const shelved = await run('Shelved')
    await approval(shelved)
    await db().session.updateMany({
      where: { id: shelved.threadId },
      data: { archivedAt: new Date() },
    })

    const listed = await waitingTickets(as('owner') as never, { all: false, project: {} })
    assert.equal(listed.length, 3)
    assert.deepEqual(
      listed.map((t) => [t.playbook?.name ?? t.title, t.playbook?.count, t.playbook?.yours]),
      [
        ['Support and bugs', 205, 205],
        ['Sam: stripe refund (ch_1)', undefined, undefined],
        ['Ship and tell', 1, 1],
      ],
    )
    // With the decided ones too, every open one is still there.
    const all = await waitingTickets(as('owner') as never, { all: true, project: {} })
    assert.equal(all.filter((t) => t.status === 'open').length, 3)
    // A member who started none of those threads: listed, none of them theirs.
    const asMember = await waitingTickets(as('member') as never, { all: false, project: {} })
    assert.deepEqual(
      asMember.flatMap((t) => (t.playbook ? [[t.playbook.count, t.playbook.yours]] : [])),
      [
        [205, 0],
        [1, 0],
      ],
    )
    // The group opened holds all of them.
    assert.equal(
      (await playbookApprovals(db(), as('owner') as never, installationId)).items.length,
      205,
    )

    // The badge a push carries counts what Home lists: three items.
    await sweep(new Date(t0), organizationId)
    await sweep(new Date(t0 + 61_000), organizationId)
    const pushes = (await pushesSince(from)).filter((p) => p.role === 'owner')
    assert.ok(pushes.length > 0)
    for (const p of pushes) assert.equal(p.message.badge, listed.length)
    // Three new at once: told together, as three things.
    assert.deepEqual(
      pushes.map((p) => p.message.title),
      ['3 things need you'],
    )
    await clear()
  },
)

test('the database groups exactly the tickets playbookApprovalOf groups', { skip }, async () => {
  const r = await run('Variants')
  const base = { playbookInstallationId: installationId, playbookRunId: r.runId }
  const variants: [string, string, Record<string, unknown>][] = [
    ['approval', 'grouped', { ...base, playbookActionKey: 'reply' }],
    ['approval', 'no action', { ...base, playbookActionKey: null }],
    ['approval', 'activation false', { ...base, playbookActivation: false }],
    ['approval', 'activation', { ...base, playbookActivation: true }],
    ['approval', 'promotion', { ...base, playbookPromotion: {} }],
    ['approval', 'skill', { ...base, skillAction: 'add' }],
    ['approval', 'credential', { ...base, credentialAction: 'use' }],
    ['approval', 'no run', { playbookInstallationId: installationId }],
    ['approval', 'run not a string', { ...base, playbookRunId: 1 }],
    ['cap', 'cap', base],
  ]
  for (const [type, title, payload] of variants)
    await db().ticket.create({ data: { sessionId: r.threadId, type, title, payload } as never })
  const listed = await waitingTickets(as('owner') as never, { all: false, project: {} })
  const own = listed.filter((t) => !t.playbook).map((t) => t.title)
  const group = listed.find((t) => t.playbook)
  assert.equal(
    group?.playbook?.count,
    variants.filter(([type, , payload]) => playbookApprovalOf({ type, payload })).length,
  )
  assert.deepEqual(
    own.sort(),
    variants
      .filter(([type, , payload]) => !playbookApprovalOf({ type, payload }))
      .map(([, title]) => title)
      .sort(),
  )
  // By project: these threads are in none.
  const none = await waitingTickets(as('owner') as never, {
    all: false,
    project: { projectId: null },
  })
  assert.equal(none.length, listed.length)
  assert.deepEqual(
    await waitingTickets(as('owner') as never, { all: true, project: { projectId: 'elsewhere' } }),
    [],
  )
  await clear()
})
