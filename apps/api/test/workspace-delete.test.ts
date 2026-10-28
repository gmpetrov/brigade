import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import pg from 'pg'

// Deleting a workspace (src/workspace-delete.ts) and an account (src/account-delete.ts), against
// a real database: the local one of apps/api/.env, in organizations of their own removed at the
// end. Without a database to reach, they are skipped. No R2 here: the bucket is a folder, and
// Stripe is faked where billing calls it.
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
process.env.BUCKET_DIR = mkdtempSync(join(tmpdir(), 'workspace-delete-'))
process.env.PASSWORD_SIGN_IN = 'true'
// Billing on, with a key that reaches nothing: every Stripe call billing makes is faked below.
process.env.STRIPE_SECRET_KEY = 'sk_test_never_called'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_workspace_delete_test'

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select "id" from "WorkspaceCleanup" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { prisma } = await import('../src/db.js')
const billing = await import('../src/billing.js')
const { auth } = await import('../src/auth.js')
const { getObject, putObject, threadFileKey, workspacePrefix } = await import('../src/bucket.js')
const { deleteWorkspace, sweepDeletedWorkspaces } = await import('../src/workspace-delete.js')
const { LATE_UPLOADS_MS } = await import('../src/thread-delete.js')
const { workspaces } = await import('../src/routes/workspaces.js')

// --- Stripe, faked -------------------------------------------------------------------------

type Fake = Record<string, any>
const fake = { subscriptions: [] as Fake[], sessions: [] as Fake[] }
const stripe = billing.stripeClient!
stripe.subscriptions.list = ((params: { customer: string }) =>
  (async function* () {
    for (const subscription of fake.subscriptions)
      if (subscription.customer === params.customer) yield subscription
  })()) as never
stripe.checkout.sessions.list = ((params: { customer: string; status: string }) =>
  (async function* () {
    for (const session of fake.sessions)
      if (session.customer === params.customer && session.status === params.status) yield session
  })()) as never
stripe.checkout.sessions.expire = (async (sessionId: string) => {
  const session = fake.sessions.find((s) => s.id === sessionId)!
  session.status = 'expired'
  return session
}) as never

// --- Fixtures ------------------------------------------------------------------------------

const id = randomUUID().slice(0, 8)
const organizations: string[] = []
const emails: string[] = []
const deletedWorkspaces: string[] = []

/** A person signed up with a password: their user id and their session's cookie. */
async function person(name: string) {
  const email = `${name.toLowerCase()}-${id}@example.com`
  emails.push(email)
  const signedUp = await auth.api.signUpEmail({
    body: { name, email, password: 'correct-horse-battery' },
    asResponse: true,
  })
  const cookie = signedUp.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
  const user = await prisma.user.findUniqueOrThrow({ where: { email } })
  return { userId: user.id, email, cookie }
}

/** An organization with these people in it, and workspaces named so. */
async function organization(people: { userId: string; role: string }[], names: string[]) {
  const organizationId = `org-wsdel-${randomUUID().slice(0, 8)}`
  organizations.push(organizationId)
  await prisma.organization.create({
    data: { id: organizationId, name: `Org ${organizationId}`, slug: organizationId },
  })
  const members: Record<string, string> = {}
  for (const p of people)
    members[p.userId] = (
      await prisma.member.create({
        data: { id: `mem-${randomUUID()}`, organizationId, userId: p.userId, role: p.role },
      })
    ).id
  const made = []
  for (const name of names)
    made.push(await prisma.workspace.create({ data: { organizationId, name } }))
  return { organizationId, members, workspaces: made }
}

/** The person's session works in this workspace. */
async function enter(userId: string, organizationId: string, workspaceId: string) {
  await prisma.authSession.updateMany({
    where: { userId },
    data: { activeOrganizationId: organizationId, activeWorkspaceId: workspaceId },
  })
}

/** A thread in the workspace, started by the member, with a file in its bucket folder. */
async function thread(
  scope: { organizationId: string; workspaceId: string },
  memberId: string,
  status = 'idle',
) {
  const teammate = await prisma.teammate.create({ data: { ...scope, name: 'Riley' } })
  const computer = await prisma.computer.create({
    data: { ...scope, kind: 'member_machine', memberId, name: 'Laptop', status: 'running' },
  })
  const session = await prisma.session.create({
    data: {
      ...scope,
      teammateId: teammate.id,
      computerId: computer.id,
      startedByMemberId: memberId,
      title: 'A thread',
      status,
      origin: 'member',
    } as never,
  })
  const key = threadFileKey(scope, session.id, `${'a'.repeat(64)}.png`)
  await putObject(key, new Uint8Array([1, 2, 3]), 'image/png')
  return { sessionId: session.id, key }
}

const call = (path: string, cookie: string, body: unknown) =>
  workspaces.request(path, {
    method: 'DELETE',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

after(async () => {
  if (skip) return
  await prisma.organization.deleteMany({ where: { id: { in: organizations } } })
  await prisma.user.deleteMany({ where: { email: { in: emails } } })
  await prisma.workspaceCleanup.deleteMany({
    where: {
      OR: [{ organizationId: { in: organizations } }, { workspaceId: { in: deletedWorkspaces } }],
    },
  })
  await prisma.$disconnect()
})

// --- Deleting a workspace ------------------------------------------------------------------

test('only an owner deletes a workspace, typing its name', { skip }, async () => {
  const ada = await person('Ada')
  const bob = await person('Bob')
  const org = await organization(
    [
      { userId: ada.userId, role: 'owner' },
      { userId: bob.userId, role: 'admin' },
    ],
    ['First', 'Second'],
  )
  const [first, second] = org.workspaces
  await enter(ada.userId, org.organizationId, first!.id)
  await enter(bob.userId, org.organizationId, first!.id)

  assert.equal((await call('/workspace', bob.cookie, { name: 'First' })).status, 403)
  assert.equal((await call('/workspace', ada.cookie, { name: 'Second' })).status, 400)
  assert.ok(await prisma.workspace.findUnique({ where: { id: first!.id } }))

  const deleted = await call('/workspace', ada.cookie, { name: 'First' })
  assert.equal(deleted.status, 200)
  deletedWorkspaces.push(first!.id)
  assert.deepEqual(await deleted.json(), { activeWorkspaceId: second!.id, organizationGone: false })
  assert.equal(await prisma.workspace.findUnique({ where: { id: first!.id } }), null)
  // Everyone working in it moves to the organization's other workspace.
  const sessions = await prisma.authSession.findMany({
    where: { userId: { in: [ada.userId, bob.userId] } },
  })
  for (const s of sessions) assert.equal(s.activeWorkspaceId, second!.id)
  // The organization keeps that it went, and by whom.
  const entry = await prisma.auditEntry.findFirst({
    where: { organizationId: org.organizationId, action: 'workspace.deleted' },
  })
  assert.equal(entry?.workspaceId, null)
  assert.equal(entry?.targetId, first!.id)
  assert.equal((entry?.data as { name?: string }).name, 'First')
  assert.ok(await prisma.organization.findUnique({ where: { id: org.organizationId } }))
})

test('not while a teammate works in one of its threads', { skip }, async () => {
  const ada = await person('Ada2')
  const org = await organization([{ userId: ada.userId, role: 'owner' }], ['Busy'])
  const scope = { organizationId: org.organizationId, workspaceId: org.workspaces[0]!.id }
  const { key } = await thread(scope, org.members[ada.userId]!, 'running')
  await assert.rejects(
    deleteWorkspace(scope, { userId: ada.userId, memberId: org.members[ada.userId]! }),
    (error: { status?: number; message?: string }) =>
      error.status === 409 && /working in a thread/.test(error.message ?? ''),
  )
  assert.ok(await prisma.workspace.findUnique({ where: { id: scope.workspaceId } }))
  assert.equal(
    await prisma.workspaceCleanup.findUnique({ where: { workspaceId: scope.workspaceId } }),
    null,
  )
  assert.ok(await getObject(key))
})

test('not while it has Brigade Cloud; its open Checkouts are closed', { skip }, async () => {
  const ada = await person('Ada3')
  const org = await organization([{ userId: ada.userId, role: 'owner' }], ['Billed'])
  const workspaceId = org.workspaces[0]!.id
  const customer = `cus_${id}`
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { stripeCustomerId: customer },
  })
  const open = { id: `cs_${id}`, customer, status: 'open' }
  fake.sessions.push(open)
  const live = { id: `sub_${id}`, customer, status: 'active', metadata: { workspaceId } }
  fake.subscriptions.push(live)
  const by = { userId: ada.userId, memberId: org.members[ada.userId]! }
  await assert.rejects(
    deleteWorkspace({ organizationId: org.organizationId, workspaceId }, by),
    (error: { status?: number; message?: string }) =>
      error.status === 409 &&
      /Cancel Brigade Cloud in Settings › Billing/.test(error.message ?? ''),
  )
  assert.ok(await prisma.workspace.findUnique({ where: { id: workspaceId } }))
  assert.equal(open.status, 'expired')
  // Refused: its closing is lifted, and a Checkout may start again.
  assert.equal(await prisma.billingClosing.count({ where: { workspaceId } }), 0)

  // Once its plan has ended, it goes; its Stripe customer is not touched.
  live.status = 'canceled'
  await deleteWorkspace({ organizationId: org.organizationId, workspaceId }, by)
  deletedWorkspaces.push(workspaceId)
  assert.equal(await prisma.workspace.findUnique({ where: { id: workspaceId } }), null)
  // Its last workspace: the organization went with it.
  assert.equal(await prisma.organization.findUnique({ where: { id: org.organizationId } }), null)
  assert.equal(await prisma.billingClosing.count({ where: { workspaceId } }), 0)
})

test('the promise to empty its folder is kept with the deletion', { skip }, async () => {
  const ada = await person('Ada4')
  const org = await organization([{ userId: ada.userId, role: 'owner' }], ['Files', 'Other'])
  const scope = { organizationId: org.organizationId, workspaceId: org.workspaces[0]!.id }
  const { sessionId } = await thread(scope, org.members[ada.userId]!)
  await prisma.mailAddress.create({
    data: {
      ...scope,
      name: `wsdel-${id}`,
      kind: 'agent',
      publicAddress: `support-${id}@example.com`,
      createdByMemberId: org.members[ada.userId]!,
    },
  })
  const before = Date.now()
  await deleteWorkspace(scope, { userId: ada.userId, memberId: org.members[ada.userId]! })
  deletedWorkspaces.push(scope.workspaceId)
  const row = await prisma.workspaceCleanup.findUnique({
    where: { workspaceId: scope.workspaceId },
  })
  assert.equal(row?.prefix, workspacePrefix(scope))
  assert.ok(row!.notBefore.getTime() >= before)
  assert.equal(await prisma.session.findUnique({ where: { id: sessionId } }), null)
  // Its address's name stays reserved for good; it receives nothing, and its public address is free.
  const address = await prisma.mailAddress.findUnique({ where: { name: `wsdel-${id}` } })
  assert.ok(address?.releasedAt)
  assert.equal(address?.publicAddress, null)
  await prisma.mailAddress.deleteMany({ where: { name: `wsdel-${id}` } })
})

test(
  'the sweep empties the folder in batches, and keeps its promise until empty after the margin',
  { skip },
  async () => {
    const scope = { organizationId: `org-gone-${id}`, workspaceId: `ws-gone-${id}` }
    deletedWorkspaces.push(scope.workspaceId)
    const prefix = workspacePrefix(scope)
    const keys = Array.from({ length: 5 }, (_, i) => `${prefix}attachments/file-${i}`)
    for (const key of keys) await putObject(key, new Uint8Array([i(key)]), 'text/plain')
    const deletedAt = Date.now()
    await prisma.workspaceCleanup.create({
      data: { ...scope, prefix, notBefore: new Date(deletedAt) },
    })
    const row = () =>
      prisma.workspaceCleanup.findUnique({ where: { workspaceId: scope.workspaceId } })
    const left = async () => (await Promise.all(keys.map(getObject))).filter(Boolean).length

    assert.equal(await sweepDeletedWorkspaces(scope.workspaceId, deletedAt, 2), 2)
    assert.equal(await left(), 3)
    assert.equal(await sweepDeletedWorkspaces(scope.workspaceId, deletedAt, 2), 2)
    assert.equal(await sweepDeletedWorkspaces(scope.workspaceId, deletedAt, 2), 1)
    assert.equal(await left(), 0)
    // Empty, but an upload URL issued before the deletion may still land: the row stays.
    assert.ok(await row())
    const late = `${prefix}uploads/late`
    await putObject(late, new Uint8Array([9]), 'text/plain')
    const settled = deletedAt + LATE_UPLOADS_MS + 1
    assert.equal(await sweepDeletedWorkspaces(scope.workspaceId, settled, 2), 1)
    assert.equal(await getObject(late), null)
    // Listed empty after the margin: the promise is kept, the row goes.
    assert.equal(await row(), null)
  },
)

test('a cleanup whose workspace is still there leaves its files alone', { skip }, async () => {
  const ada = await person('Ada5')
  const org = await organization([{ userId: ada.userId, role: 'owner' }], ['Still here'])
  const scope = { organizationId: org.organizationId, workspaceId: org.workspaces[0]!.id }
  const key = `${workspacePrefix(scope)}attachments/kept`
  await putObject(key, new Uint8Array([1]), 'text/plain')
  // As a deletion that failed after keeping its row would leave it.
  await prisma.workspaceCleanup.create({
    data: { ...scope, prefix: workspacePrefix(scope), notBefore: new Date(0) },
  })
  await sweepDeletedWorkspaces(scope.workspaceId, Date.now() + LATE_UPLOADS_MS * 2)
  assert.ok(await getObject(key))
  assert.equal(
    await prisma.workspaceCleanup.findUnique({ where: { workspaceId: scope.workspaceId } }),
    null,
  )
})

// --- Deleting an account -------------------------------------------------------------------

test(
  'an only owner of an organization others are in cannot delete their account',
  { skip },
  async () => {
    const ada = await person('Ada6')
    const bob = await person('Bob6')
    const org = await organization(
      [
        { userId: ada.userId, role: 'owner' },
        { userId: bob.userId, role: 'member' },
      ],
      ['Shared'],
    )
    await enter(ada.userId, org.organizationId, org.workspaces[0]!.id)
    assert.equal((await call('/me', ada.cookie, { email: 'someone@example.com' })).status, 400)
    const refused = await call('/me', ada.cookie, { email: ada.email })
    assert.equal(refused.status, 409)
    assert.match(await refused.text(), /Make someone else an owner of/)
    assert.ok(await prisma.user.findUnique({ where: { id: ada.userId } }))
    assert.ok(await prisma.workspace.findUnique({ where: { id: org.workspaces[0]!.id } }))
  },
)

test(
  'alone in an organization: it goes with the account, each workspace and its files',
  { skip },
  async () => {
    const carol = await person('Carol')
    const org = await organization([{ userId: carol.userId, role: 'owner' }], ['One', 'Two'])
    const [one, two] = org.workspaces
    await enter(carol.userId, org.organizationId, one!.id)
    await thread(
      { organizationId: org.organizationId, workspaceId: one!.id },
      org.members[carol.userId]!,
    )
    const response = await call('/me', carol.cookie, { email: carol.email.toUpperCase() })
    assert.equal(response.status, 204)
    deletedWorkspaces.push(one!.id, two!.id)
    // Signed out in the same answer.
    assert.ok(response.headers.getSetCookie().some((c) => /session_token=;/.test(c)))
    assert.equal(await prisma.user.findUnique({ where: { id: carol.userId } }), null)
    assert.equal(await prisma.organization.findUnique({ where: { id: org.organizationId } }), null)
    assert.equal(await prisma.workspace.count({ where: { organizationId: org.organizationId } }), 0)
    for (const w of [one!, two!])
      assert.ok(await prisma.workspaceCleanup.findUnique({ where: { workspaceId: w.id } }))
    const actions = await prisma.auditEntry.findMany({
      where: { organizationId: org.organizationId, workspaceId: null },
      select: { action: true },
    })
    assert.equal(actions.filter((a) => a.action === 'workspace.deleted').length, 2)
    assert.ok(actions.some((a) => a.action === 'organization.deleted'))
  },
)

test(
  'leaving a shared organization: the threads they started go with their files',
  { skip },
  async () => {
    const ada = await person('Ada7')
    const bob = await person('Bob7')
    const org = await organization(
      [
        { userId: ada.userId, role: 'owner' },
        { userId: bob.userId, role: 'member' },
      ],
      ['Team'],
    )
    const scope = { organizationId: org.organizationId, workspaceId: org.workspaces[0]!.id }
    await enter(bob.userId, org.organizationId, scope.workspaceId)
    const bobs = await thread(scope, org.members[bob.userId]!)
    const adas = await thread(scope, org.members[ada.userId]!)
    // Not while one of theirs is at work.
    await prisma.session.update({ where: { id: bobs.sessionId }, data: { status: 'running' } })
    assert.equal((await call('/me', bob.cookie, { email: bob.email })).status, 409)
    await prisma.session.update({ where: { id: bobs.sessionId }, data: { status: 'idle' } })

    assert.equal((await call('/me', bob.cookie, { email: bob.email })).status, 204)
    assert.equal(await prisma.user.findUnique({ where: { id: bob.userId } }), null)
    assert.equal(await prisma.member.findUnique({ where: { id: org.members[bob.userId]! } }), null)
    assert.equal(await prisma.session.findUnique({ where: { id: bobs.sessionId } }), null)
    assert.equal(await getObject(bobs.key), null)
    // The organization, its workspace and the others' threads stay.
    assert.ok(await prisma.workspace.findUnique({ where: { id: scope.workspaceId } }))
    assert.ok(await prisma.session.findUnique({ where: { id: adas.sessionId } }))
    assert.ok(await getObject(adas.key))
    await prisma.bucketCleanup.deleteMany({ where: { sessionId: bobs.sessionId } })
  },
)

/** A byte for a key, so each file differs. */
function i(key: string) {
  return key.charCodeAt(key.length - 1)
}
