// Local development data. Never run against a shared or production database.
//   pnpm --filter @brigade/api db:seed
// Ada (owner), Bob (admin) and Carol (member) share the sample Acme workspace
// (seed-workspace.ts); Dana has no organization yet, to try onboarding.
import { prisma } from '../src/db.js'

export const DEV_PASSWORD = 'correct-horse-battery'
const DEV_USERS = {
  ada: { name: 'Ada', email: 'ada@example.com' },
  bob: { name: 'Bob', email: 'bob@example.com' },
  carol: { name: 'Carol', email: 'carol@example.com' },
  dana: { name: 'Dana', email: 'dana@example.com' },
}

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error('Refusing to seed a non-local database')
}

// Nothing to add: every account is there, and Ada, Bob or Carol has an organization (the
// sample's, or their own). Said before loading what adding takes, seconds on each preview
// start (scripts/preview/setup.sh runs this every time).
const emails = Object.values(DEV_USERS).map((user) => user.email)
const sharing = [DEV_USERS.ada.email, DEV_USERS.bob.email, DEV_USERS.carol.email]
const [accounts, organized] = await Promise.all([
  prisma.user.count({ where: { email: { in: emails } } }),
  prisma.member.count({ where: { user: { email: { in: sharing } } } }),
])
if (accounts === emails.length && organized) {
  console.log('exists: the dev accounts and their organization')
  await prisma.$disconnect()
  process.exit(0)
}

const { auth } = await import('../src/auth.js')
const { SAMPLE_ORGANIZATION, seedWorkspace } = await import('./seed-workspace.js')

const users = {} as Record<keyof typeof DEV_USERS, { id: string }>
for (const [key, user] of Object.entries(DEV_USERS) as [
  keyof typeof DEV_USERS,
  typeof DEV_USERS.ada,
][]) {
  const existing = await prisma.user.findUnique({ where: { email: user.email } })
  if (existing) {
    console.log(`exists: ${user.email}`)
    users[key] = existing
    continue
  }
  users[key] = (await auth.api.signUpEmail({ body: { ...user, password: DEV_PASSWORD } })).user
  console.log(`created: ${user.email}`)
}

// Ada, Bob or Carol may already have made an organization through onboarding: leave theirs be.
const sample = await prisma.organization.count({ where: { slug: SAMPLE_ORGANIZATION } })
const onboarded = await prisma.member.count({
  where: { userId: { in: [users.ada.id, users.bob.id, users.carol.id] } },
})
if (sample) console.log('exists: sample organization Acme')
else if (onboarded) console.log('skipped: sample organization (Ada, Bob or Carol already has one)')
else await seedWorkspace(users)

await prisma.$disconnect()
// Library saves leave timers for runners; none listen here.
process.exit(0)
