// The Email App's background work, each minute: mail kept by the webhook but not delivered yet
// (the API restarted, Resend or a computer was down) is tried again; sent mail whose Message-ID
// Resend has not reported is asked for; domains waiting on their DNS are checked. Each hour,
// mail left in its box past its 30 days goes.
import { prisma } from '../db.js'
import { processMail } from './inbound.js'
import { fillMessageIds } from './outbound.js'
import { checkDomains } from './domains.js'
import { resendConfigured } from './resend.js'

const RETRY_AFTER_MS = 60_000
let ticking = false

async function tick() {
  if (ticking || !resendConfigured()) return
  ticking = true
  try {
    const due = await prisma.mailMessage.findMany({
      where: {
        direction: 'in',
        status: 'pending',
        updatedAt: { lt: new Date(Date.now() - RETRY_AFTER_MS) },
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
      select: { id: true, attempts: true, updatedAt: true },
    })
    for (const row of due) {
      // Each try waits longer: 1, 2, 4… minutes.
      if (Date.now() - row.updatedAt.getTime() < RETRY_AFTER_MS * 2 ** Math.min(row.attempts, 6))
        continue
      await processMail(row.id).catch((error) =>
        console.warn(`mail ${row.id}: still not delivered`, error),
      )
    }
    await fillMessageIds()
    await checkDomains()
  } finally {
    ticking = false
  }
}

/**
 * Mail left in its box past its time: deleted. Mail a thread took goes with the thread. A
 * sign-up's mail stays while its conversation has mail that stays (a reply its thread sent, the
 * answer to it): it marks the conversation as that thread's (src/inbox.ts), whose replies can
 * quote its code.
 */
export async function sweepMail(now = new Date()) {
  return prisma.$executeRaw`
    delete from "MailMessage" m
    where m."expiresAt" < ${now} and m."sessionId" is null
      and not (m."aliasId" is not null and exists (
        select 1 from "MailMessage" o
        where o."workspaceId" = m."workspaceId" and o.box = m.box
          and o."conversationId" = m."conversationId" and o.id <> m.id
          and (o."sessionId" is not null or o."expiresAt" is null or o."expiresAt" >= ${now})))`
}

export function watchMail() {
  setTimeout(
    () => void tick().catch((error) => console.warn(`mail tick failed: ${String(error)}`)),
    15_000,
  )
  setInterval(
    () => void tick().catch((error) => console.warn(`mail tick failed: ${String(error)}`)),
    60_000,
  )
  setInterval(
    () => void sweepMail().catch((error) => console.warn(`mail sweep failed: ${String(error)}`)),
    60 * 60_000,
  )
}
