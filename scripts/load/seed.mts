// The load test's workspaces (README.md), written straight to the load test copy's database:
// sign-ups through the API allow 3 per 10 seconds from one address, so a test from one machine
// makes its accounts here and signs up through the API only in its own scenario.
//   cd apps/api && env $(cat <secrets>) npx tsx ../../scripts/load/seed.mts <workspaces> <out.json>
// Each workspace is a copy of the preview's sample (prisma/seed-workspace.ts): three members
// signed in, its cloud computer with a runner token, its threads.
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'

process.env.PASSWORD_SIGN_IN = 'true'
const count = Number(process.argv[2] ?? 10)
const out = process.argv[3] ?? 'workspaces.json'
const run = randomBytes(3).toString('hex')

const { prisma } = await import('../../apps/api/src/db.js')
const { auth } = await import('../../apps/api/src/auth.js')
const { hashToken } = await import('../../apps/api/src/hub.js')
const { seedWorkspace } = await import('../../apps/api/prisma/seed-workspace.js')

const PASSWORD = `load-${randomBytes(12).toString('hex')}`

type Member = { email: string; cookie: string }
const workspaces: {
  workspaceId: string
  computerId: string
  runnerToken: string
  members: Member[]
  threads: { sessionId: string; lastSeq: number }[]
}[] = []

/** The session cookie a browser would hold after signing in. */
async function signIn(email: string) {
  const response = (await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  })) as Response
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .find((c) => c.includes('session_token='))
  if (!cookie) throw new Error(`no session cookie for ${email}`)
  return cookie
}

for (let i = 0; i < count; i++) {
  const users = {} as Record<'ada' | 'bob' | 'carol', { id: string }>
  const emails = {} as Record<'ada' | 'bob' | 'carol', string>
  for (const name of ['ada', 'bob', 'carol'] as const) {
    emails[name] = `${name}-${run}-${i}@loadtest.invalid`
    users[name] = (
      await auth.api.signUpEmail({ body: { name, email: emails[name], password: PASSWORD } })
    ).user
  }
  const slug = `load-${run}-${i}`
  await seedWorkspace(users, { name: `Load ${i}`, slug })
  const organization = await prisma.organization.findUniqueOrThrow({ where: { slug } })
  const workspace = await prisma.workspace.findFirstOrThrow({
    where: { organizationId: organization.id },
  })
  const computer = await prisma.computer.findFirstOrThrow({
    where: { workspaceId: workspace.id },
  })
  // As a runner link names them: its workspace first, so its socket goes to its hub.
  const runnerToken = `${workspace.id}.${randomBytes(24).toString('hex')}`
  await prisma.runner.create({
    data: {
      organizationId: organization.id,
      workspaceId: workspace.id,
      computerId: computer.id,
      tokenHash: hashToken(runnerToken),
      version: 'load-test',
      platform: 'linux',
    },
  })
  const members: Member[] = []
  for (const name of ['ada', 'bob', 'carol'] as const) {
    const cookie = await signIn(emails[name])
    // The workspace each request is scoped to, as POST /api/workspaces/switch sets it.
    const token = decodeURIComponent(cookie.split('=')[1]!).split('.')[0]!
    await prisma.authSession.updateMany({
      where: { token },
      data: { activeWorkspaceId: workspace.id },
    })
    members.push({ email: emails[name], cookie })
  }
  const sessions = await prisma.session.findMany({
    where: { computerId: computer.id },
    select: { id: true },
  })
  const threads = []
  for (const s of sessions) {
    const last = await prisma.sessionEvent.aggregate({
      where: { sessionId: s.id },
      _max: { seq: true },
    })
    threads.push({ sessionId: s.id, lastSeq: last._max.seq ?? 0 })
  }
  workspaces.push({
    workspaceId: workspace.id,
    computerId: computer.id,
    runnerToken,
    members,
    threads,
  })
  console.log(`workspace ${i + 1}/${count}: ${threads.length} threads`)
}

writeFileSync(out, JSON.stringify({ run, workspaces }, null, 1), { mode: 0o600 })
await prisma.$disconnect()
process.exit(0)
