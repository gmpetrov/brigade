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

/** Mail kept by the webhook and not delivered yet, waiting long enough to try again. */
const retrying = (workspaceId?: string) => ({
  direction: 'in' as const,
  status: 'pending' as const,
  updatedAt: { lt: new Date(Date.now() - RETRY_AFTER_MS) },
  ...(workspaceId ? { workspaceId } : {}),
})

/** Workspaces with received mail to try delivering again (src/jobs.ts). */
export async function dueMail() {
  if (!resendConfigured()) return []
  const rows = await prisma.mailMessage.findMany({
    where: retrying(),
    distinct: ['workspaceId'],
    select: { workspaceId: true },
  })
  return rows.map((r) => r.workspaceId)
}

/** Each minute, for one workspace or all: received mail not delivered yet is tried again. */
export async function retryMail(workspaceId?: string) {
  if (!resendConfigured()) return
  const due = await prisma.mailMessage.findMany({
    where: retrying(workspaceId),
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
}

/** Each minute: Message-IDs Resend has not reported are asked for; domains' DNS is checked. */
export async function mailMinute() {
  if (!resendConfigured()) return
  await fillMessageIds()
  await checkDomains()
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
