// Local development accounts. Never run against a shared or production database.
//   pnpm --filter @brigade/api db:seed
import { auth } from '../src/auth.js'
import { prisma } from '../src/db.js'

export const DEV_PASSWORD = 'correct-horse-battery'
const DEV_USERS = [
  { name: 'Ada', email: 'ada@example.com' },
  { name: 'Bob', email: 'bob@example.com' },
  { name: 'Carol', email: 'carol@example.com' },
]

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error('Refusing to seed a non-local database')
}

for (const user of DEV_USERS) {
  if (await prisma.user.findUnique({ where: { email: user.email } })) {
    console.log(`exists: ${user.email}`)
    continue
  }
  await auth.api.signUpEmail({ body: { ...user, password: DEV_PASSWORD } })
  console.log(`created: ${user.email}`)
}
await prisma.$disconnect()
