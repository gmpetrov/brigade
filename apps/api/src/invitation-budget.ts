// Each invitation mails someone outside Brigade: a budget per organization and per address,
// counted in the database (InvitationSend), so neither a loop of Invite and Send again nor a
// restart sends more. Not in better-auth's RateLimit table: its cleanup prunes every row older
// than its own short windows, counts included.
import { HTTPException } from 'hono/http-exception'
import { prisma } from './db.js'

const HOUR = 60 * 60 * 1000

/** At most this many invitation mails in a window, for an organization and for one address. */
export const INVITATION_BUDGETS = {
  organization: { max: 30, window: HOUR },
  address: { max: 3, window: 24 * HOUR },
}

/**
 * Before an invitation is mailed (first or again): counted, or refused once either budget is
 * spent. One organization's sendings at a time, so two at once can't both pass the last place.
 */
export async function spendInvitation(organizationId: string, email: string) {
  const { organization, address } = INVITATION_BUDGETS
  const now = Date.now()
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`invitations:${organizationId}`}, 0))`
    // Past the longest window, a sending counts no more.
    await tx.invitationSend.deleteMany({
      where: { organizationId, at: { lt: new Date(now - address.window) } },
    })
    const [forOrganization, forAddress] = await Promise.all([
      tx.invitationSend.count({
        where: { organizationId, at: { gt: new Date(now - organization.window) } },
      }),
      tx.invitationSend.count({
        where: { organizationId, email, at: { gt: new Date(now - address.window) } },
      }),
    ])
    if (forAddress >= address.max)
      throw new HTTPException(429, {
        message: `${email} was invited ${address.max} times today: try again tomorrow`,
      })
    if (forOrganization >= organization.max)
      throw new HTTPException(429, { message: 'Too many invitations this hour: try again later' })
    await tx.invitationSend.create({ data: { organizationId, email } })
  })
}
