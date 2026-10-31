import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// Inviting someone to the organization and their joining (src/routes/members.ts), on the real
// auth (src/auth.ts, better-auth's organization plugin) against the local database of
// apps/api/.env: people sign in with a mailed code, as in production. Without Resend, codes and
// invitation links are logged, which is where the test reads them. Without a database, skipped.
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
process.env.PASSWORD_SIGN_IN = 'false'
process.env.RESEND_API_KEY = ''
delete process.env.TURNSTILE_SECRET_KEY

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select "id" from "Invitation" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { Hono } = await import('hono')
const { HTTPException } = await import('hono/http-exception')
const { auth, authRouteClosed } = await import('../src/auth.js')
const { prisma } = await import('../src/db.js')
const { env } = await import('../src/config.js')
const { members } = await import('../src/routes/members.js')
const { workspaces } = await import('../src/routes/workspaces.js')
const { library } = await import('../src/routes/library.js')
const { invitationMail } = await import('../src/invitation-mail.js')

// The routes as src/app.ts mounts them, with its error answer.
const app = new Hono()
app.on(['GET', 'POST'], '/api/auth/*', (c) =>
  authRouteClosed(c.req.raw)
    ? Response.json({ error: 'Not found' }, { status: 404 })
    : auth.handler(c.req.raw),
)
app.route('/api', workspaces)
app.route('/api', members)
app.route('/api/library', library)
app.onError((error, c) =>
  error instanceof HTTPException
    ? c.json({ error: error.message }, error.status)
    : c.json({ error: String(error) }, 500),
)

const run = randomUUID().slice(0, 8)
const emails: string[] = []
const organizations: string[] = []
const address = (name: string) => {
  const email = `${name}-${run}@example.com`
  emails.push(email)
  return email
}

/** What the API logs while `fn` runs (no Resend here: codes and links). */
async function logged(fn: () => Promise<unknown>) {
  const lines: string[] = []
  const log = console.log
  console.log = (...args: unknown[]) => void lines.push(args.join(' '))
  try {
    await fn()
  } finally {
    console.log = log
  }
  return lines
}

function call(path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) {
  return app.request(`${env.API_URL}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      'content-type': 'application/json',
      origin: env.WEB_URL[0]!,
      ...(init.cookie && { cookie: init.cookie }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  })
}

/** Signed in with a mailed code, as production does: the address is proven. */
async function signIn(email: string) {
  const lines = await logged(async () => {
    const sent = await call('/api/auth/email-otp/send-verification-otp', {
      body: { email, type: 'sign-in' },
    })
    assert.equal(sent.status, 200, await sent.clone().text())
  })
  const otp = lines.find((l) => l.startsWith(`sign-in code for ${email}: `))?.split(': ')[1]
  assert.ok(otp, 'the code is logged')
  const response = await call('/api/auth/sign-in/email-otp', { body: { email, otp } })
  assert.equal(response.status, 200, await response.clone().text())
  return response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
}

/** Someone with an organization of their own and its workspace. */
async function founder(name: string) {
  const cookie = await signIn(address(name))
  const created = await call('/api/auth/organization/create', {
    body: { name: `${name} ${run}`, slug: `${name}-${run}` },
    cookie,
  })
  assert.equal(created.status, 200, await created.clone().text())
  const { id } = (await created.json()) as { id: string }
  organizations.push(id)
  assert.equal((await call('/api/me', { cookie })).status, 200)
  const workspace = await call('/api/workspaces', { body: { name: `${name} HQ` }, cookie })
  assert.equal(workspace.status, 201, await workspace.clone().text())
  return {
    cookie,
    organizationId: id,
    workspaceId: ((await workspace.json()) as { id: string }).id,
  }
}

/** Invites and returns the invitation's id, read from the link the mail carries. */
async function invite(cookie: string, email: string, role = 'member') {
  let response!: Response
  const lines = await logged(async () => {
    response = await call('/api/members/invitations', { body: { email, role }, cookie })
  })
  assert.equal(response.status, 201, await response.clone().text())
  const link = lines
    .find((l) => l.startsWith(`invitation for ${email.toLowerCase()}: `))
    ?.split(': ')[1]
  assert.ok(link, 'the invitation link is logged')
  assert.ok(link.startsWith(`${env.WEB_URL[0]}/invite/`))
  return decodeURIComponent(link.split('/invite/')[1]!)
}

type Me = {
  activeOrganizationId: string | null
  activeWorkspaceId: string | null
  role: string | null
  organizations: { id: string }[]
}
const meOf = async (cookie: string) => (await (await call('/api/me', { cookie })).json()) as Me

let ada: Awaited<ReturnType<typeof founder>>

before(async () => {
  if (skip) return
  ada = await founder('ada')
})

after(async () => {
  if (skip) return
  await prisma.workspace.deleteMany({ where: { organizationId: { in: organizations } } })
  await prisma.organization.deleteMany({ where: { id: { in: organizations } } })
  await prisma.user.deleteMany({ where: { email: { in: emails } } })
  await prisma.verification.deleteMany({ where: { identifier: { contains: run } } })
  await prisma.$disconnect()
})

test('the mail says who invites, to what, and links to the invitation', () => {
  const mail = invitationMail({
    id: 'inv-1',
    email: 'bob@example.com',
    role: 'admin',
    organization: 'Acme',
    inviter: { name: 'Ada', email: 'ada@example.com' },
  })
  assert.deepEqual(mail.to, ['bob@example.com'])
  assert.deepEqual(mail.reply_to, ['ada@example.com'])
  assert.match(mail.subject, /Ada invited you to Acme/)
  assert.match(mail.text, /as an admin/)
  assert.ok(mail.text.includes(`${env.WEB_URL[0]}/invite/inv-1`))
})

test('an invited address joins the organization in its first workspace', { skip }, async () => {
  const bob = address('bob')
  const id = await invite(ada.cookie, bob.toUpperCase())

  const listed = (await (await call('/api/members', { cookie: ada.cookie })).json()) as {
    members: { email: string; role: string }[]
    invitations: { id: string; email: string; role: string }[]
  }
  assert.deepEqual(
    listed.invitations.map((i) => [i.id, i.email, i.role]),
    [[id, bob, 'member']],
  )
  assert.deepEqual(
    listed.members.map((m) => m.role),
    ['owner'],
  )

  // A new person: signed up by the code, no organization yet, and the invitation offered.
  const cookie = await signIn(bob)
  assert.equal((await meOf(cookie)).activeOrganizationId, null)
  const offered = (await (await call('/api/invitations', { cookie })).json()) as { id: string }[]
  assert.deepEqual(
    offered.map((i) => i.id),
    [id],
  )
  const shown = (await (await call(`/api/invitations/${id}`, { cookie })).json()) as {
    forYou: boolean
    organization: string
    invitedBy: string
  }
  assert.equal(shown.forYou, true)
  assert.equal(shown.organization, `ada ${run}`)

  const joined = await call(`/api/invitations/${id}/accept`, { body: {}, cookie })
  assert.equal(joined.status, 200, await joined.clone().text())
  const me = await meOf(cookie)
  assert.equal(me.activeOrganizationId, ada.organizationId)
  assert.equal(me.activeWorkspaceId, ada.workspaceId)
  assert.equal(me.role, 'member')

  const after = (await (await call('/api/members', { cookie: ada.cookie })).json()) as {
    members: { email: string; role: string }[]
    invitations: unknown[]
  }
  assert.deepEqual(
    after.members.map((m) => [m.email, m.role]),
    [
      [emails[0], 'owner'],
      [bob, 'member'],
    ],
  )
  assert.deepEqual(after.invitations, [])
  // Taken once only.
  assert.equal((await call(`/api/invitations/${id}/accept`, { body: {}, cookie })).status, 400)
  // A member sees the members, not the invitations, and cannot invite.
  const asBob = (await (await call('/api/members', { cookie })).json()) as {
    invitations: unknown[]
  }
  assert.deepEqual(asBob.invitations, [])
  const refused = await call('/api/members/invitations', {
    body: { email: address('eve'), role: 'member' },
    cookie,
  })
  assert.equal(refused.status, 403)
  const audited = await prisma.auditEntry.findMany({
    where: {
      organizationId: ada.organizationId,
      action: { in: ['invitation.created', 'member.added'] },
    },
    select: { action: true },
    orderBy: { at: 'asc' },
  })
  // After Ada's own, as the organization's first member.
  assert.deepEqual(audited.map((a) => a.action).slice(-2), ['invitation.created', 'member.added'])
})

test('only the invited address can see or take an invitation', { skip }, async () => {
  const carol = address('carol')
  const id = await invite(ada.cookie, carol)
  const mallory = await signIn(address('mallory'))
  const shown = (await (await call(`/api/invitations/${id}`, { cookie: mallory })).json()) as {
    forYou: boolean
    organization?: string
  }
  assert.equal(shown.forYou, false)
  assert.equal(shown.organization, undefined)
  assert.deepEqual(await (await call('/api/invitations', { cookie: mallory })).json(), [])
  const taken = await call(`/api/invitations/${id}/accept`, { body: {}, cookie: mallory })
  assert.equal(taken.status, 403)
  assert.equal((await meOf(mallory)).activeOrganizationId, null)
})

test('an admin invites members and admins, never an owner', { skip }, async () => {
  const dan = address('dan')
  const id = await invite(ada.cookie, dan, 'admin')
  const cookie = await signIn(dan)
  assert.equal((await call(`/api/invitations/${id}/accept`, { body: {}, cookie })).status, 200)
  assert.equal((await meOf(cookie)).role, 'admin')
  await invite(cookie, address('erin'), 'admin')
  const owner = await call('/api/members/invitations', {
    body: { email: address('frank'), role: 'owner' },
    cookie,
  })
  assert.equal(owner.status, 403)
  assert.equal(
    ((await owner.json()) as { error: string }).error,
    'Only an owner can invite an owner',
  )
})

test('a canceled invitation can no longer be taken', { skip }, async () => {
  const gail = address('gail')
  const id = await invite(ada.cookie, gail)
  const canceled = await call(`/api/members/invitations/${id}`, {
    method: 'DELETE',
    cookie: ada.cookie,
  })
  assert.equal(canceled.status, 204)
  const cookie = await signIn(gail)
  assert.equal((await call(`/api/invitations/${id}`, { cookie })).status, 404)
  assert.equal((await call(`/api/invitations/${id}/accept`, { body: {}, cookie })).status, 400)
})

test('inviting the same address again mails it again, once listed', { skip }, async () => {
  const hal = address('hal')
  const first = await invite(ada.cookie, hal)
  const again = await invite(ada.cookie, hal)
  assert.equal(again, first)
  const open = await prisma.invitation.count({ where: { email: hal, status: 'pending' } })
  assert.equal(open, 1)
  // A member already is refused.
  const member = await call('/api/members/invitations', {
    body: { email: emails[0], role: 'member' },
    cookie: ada.cookie,
  })
  assert.equal(member.status, 400)
})

test('someone in two organizations switches between them', { skip }, async () => {
  const ivy = await founder('ivy')
  const id = await invite(ada.cookie, emails.at(-1)!)
  assert.equal(
    (await call(`/api/invitations/${id}/accept`, { body: {}, cookie: ivy.cookie })).status,
    200,
  )
  assert.equal((await meOf(ivy.cookie)).activeWorkspaceId, ada.workspaceId)
  const back = await call('/api/organizations/switch', {
    body: { organizationId: ivy.organizationId },
    cookie: ivy.cookie,
  })
  assert.equal(back.status, 200)
  const me = await meOf(ivy.cookie)
  assert.equal(me.activeOrganizationId, ivy.organizationId)
  assert.equal(me.activeWorkspaceId, ivy.workspaceId)
  assert.equal(me.organizations.length, 2)
  // Not to one they don't belong to.
  const mallory = await founder('mallory2')
  const refused = await call('/api/organizations/switch', {
    body: { organizationId: ada.organizationId },
    cookie: mallory.cookie,
  })
  assert.equal(refused.status, 404)
})

test('inviting again with another role replaces the open invitation', { skip }, async () => {
  const jo = address('jo')
  const first = await invite(ada.cookie, jo, 'owner')
  const second = await invite(ada.cookie, jo, 'member')
  assert.notEqual(second, first)
  const rows = await prisma.invitation.findMany({
    where: { email: jo },
    select: { id: true, role: true, status: true },
  })
  assert.deepEqual(
    rows.map((r) => [r.id, r.role, r.status]).sort(),
    [
      [first, 'owner', 'canceled'],
      [second, 'member', 'pending'],
    ].sort(),
  )
  const cookie = await signIn(jo)
  assert.equal((await call(`/api/invitations/${first}/accept`, { body: {}, cookie })).status, 400)
  assert.equal((await call(`/api/invitations/${second}/accept`, { body: {}, cookie })).status, 200)
  assert.equal((await meOf(cookie)).role, 'member')
})

test('an address is mailed at most 3 times a day', { skip }, async () => {
  const kim = address('kim')
  for (let i = 0; i < 3; i++) await invite(ada.cookie, kim)
  let refused!: Response
  const lines = await logged(async () => {
    refused = await call('/api/members/invitations', {
      body: { email: kim, role: 'member' },
      cookie: ada.cookie,
    })
  })
  assert.equal(refused.status, 429)
  assert.deepEqual(
    lines.filter((l) => l.startsWith(`invitation for ${kim}`)),
    [],
  )
})

test("the plugin's invitation routes are closed over HTTP", { skip }, async () => {
  for (const path of [
    'invite-member',
    'accept-invitation',
    'reject-invitation',
    'cancel-invitation',
  ]) {
    const response = await call(`/api/auth/organization/${path}`, {
      body: { email: address('lee'), role: 'member', invitationId: 'x' },
      cookie: ada.cookie,
    })
    assert.equal(response.status, 404, path)
  }
  assert.equal(await prisma.invitation.count({ where: { email: { startsWith: 'lee-' } } }), 0)
})

test("auth's rate-limit cleanup leaves the invitation budget alone", { skip }, async () => {
  const { spendInvitation } = await import('../src/invitation-budget.js')
  const email = address('prune')
  const ip = `198.51.100.${200 + Math.floor(Math.random() * 50)}`
  // A sign-in from a visitor Cloudflare names: counted, and its old buckets pruned.
  const login = () =>
    auth.handler(
      new Request(`${env.API_URL}/api/auth/sign-in/email-otp`, {
        method: 'POST',
        headers: {
          origin: env.WEB_URL[0]!,
          'content-type': 'application/json',
          'cf-connecting-ip': ip,
        },
        body: JSON.stringify({ email, otp: '000000' }),
      }),
    )
  try {
    await login()
    for (let i = 0; i < 3; i++) await spendInvitation(ada.organizationId, email)
    // Ten minutes on: the three sendings, and every rate-limit row of this visitor and of the
    // organization's invitations, which the next sign-in's cleanup would prune.
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000
    await prisma.invitationSend.updateMany({
      where: { organizationId: ada.organizationId, email },
      data: { at: new Date(tenMinutesAgo) },
    })
    await prisma.rateLimit.updateMany({
      where: {
        OR: [
          { key: { contains: ip } },
          { key: { startsWith: `invitations:${ada.organizationId}` } },
        ],
      },
      data: { lastRequest: BigInt(tenMinutesAgo) },
    })
    await login()
    await assert.rejects(() => spendInvitation(ada.organizationId, email), /invited 3 times/)
  } finally {
    await prisma.rateLimit.deleteMany({ where: { key: { contains: ip } } })
  }
})

test('sendings at once spend the budget once each', { skip }, async () => {
  const { spendInvitation } = await import('../src/invitation-budget.js')
  const email = address('rush')
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () => spendInvitation(ada.organizationId, email)),
  )
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3)
  assert.equal(
    await prisma.invitationSend.count({ where: { organizationId: ada.organizationId, email } }),
    3,
  )
})

test('a viewer joins, looks around and changes nothing', { skip }, async () => {
  const vic = address('vic')
  const id = await invite(ada.cookie, vic, 'viewer')
  const cookie = await signIn(vic)
  assert.equal((await call(`/api/invitations/${id}/accept`, { body: {}, cookie })).status, 200)
  const me = (await (await call('/api/me', { cookie })).json()) as Me & { aiReady: boolean }
  assert.equal(me.role, 'viewer')
  // Nothing to run: straight into the dashboard, no AI account asked.
  assert.equal(me.aiReady, true)
  assert.equal((await call('/api/members', { cookie })).status, 200)
  // Their own place in it, yes; a change to the workspace, no.
  const order = await call('/api/me/sidebar-order', {
    method: 'PUT',
    body: { list: 'teammates', ids: [] },
    cookie,
  })
  assert.equal(order.status, 204)
  const merge = await call('/api/me/auto-merge', {
    method: 'PUT',
    body: { autoMerge: false },
    cookie,
  })
  assert.equal(merge.status, 403)
  assert.match(((await merge.json()) as { error: string }).error, /view this workspace/)
  const invited = await call('/api/members/invitations', {
    body: { email: address('wes'), role: 'member' },
    cookie,
  })
  assert.equal(invited.status, 403)
  // A document opens to read: no live editing, nothing created for them, no saving.
  const memories = () =>
    prisma.document.count({
      where: { workspaceId: ada.workspaceId, kind: 'workspace_memory' },
    })
  const before = await memories()
  const opened = await call('/api/library/edit', {
    body: { kind: 'workspace_memory' },
    cookie,
  })
  assert.equal(opened.status, 200, await opened.clone().text())
  const session = (await opened.json()) as { readOnly?: boolean; live: unknown; documentId: string }
  assert.equal(session.readOnly, true)
  assert.equal(session.live, null)
  assert.equal(await memories(), before)
  const saved = await call(`/api/library/edit/${session.documentId}`, {
    method: 'PUT',
    body: { text: 'changed' },
    cookie,
  })
  assert.equal(saved.status, 403)
})
