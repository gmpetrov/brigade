// Local development data. Never run against a shared or production database.
//   pnpm --filter @brigade/api db:seed
// Ada (owner), Bob (admin) and Carol (member) share the sample Acme workspace
// (seed-workspace.ts); Dana has no organization yet, to try onboarding.
import { auth } from '../src/auth.js'
import { prisma } from '../src/db.js'
import { SAMPLE_ORGANIZATION, seedWorkspace } from './seed-workspace.js'

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
