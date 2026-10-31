// Each invitation mails someone outside Brigade: a budget per organization and per address,
// counted in the database (the RateLimit table, in keys of its own), so neither a loop of
// Invite and Send again nor a restart sends more. A window starts with its first sending.
import { randomUUID } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import { prisma } from './db.js'

const HOUR = 60 * 60 * 1000

/** At most this many invitation mails in a window, for an organization and for one address. */
export const INVITATION_BUDGETS = {
  organization: { max: 30, window: HOUR },
  address: { max: 3, window: 24 * HOUR },
}

/** One more sending in `key`'s window: how many it now holds. */
async function count(key: string, window: number) {
  const now = Date.now()
  const [row] = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimit" ("id", "key", "count", "lastRequest")
    VALUES (${randomUUID()}, ${key}, 1, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "RateLimit"."lastRequest" <= ${now - window} THEN 1
                     ELSE "RateLimit"."count" + 1 END,
      "lastRequest" = CASE WHEN "RateLimit"."lastRequest" <= ${now - window} THEN ${now}
                           ELSE "RateLimit"."lastRequest" END
    RETURNING "count"`
  return Number(row!.count)
}

/** Before an invitation is mailed (first or again): refused once either budget is spent. */
export async function spendInvitation(organizationId: string, email: string) {
  const { organization, address } = INVITATION_BUDGETS
  const [forOrganization, forAddress] = await Promise.all([
    count(`invitations:${organizationId}`, organization.window),
    count(`invitations:${organizationId}:${email.toLowerCase()}`, address.window),
  ])
  if (forAddress > address.max)
    throw new HTTPException(429, {
      message: `${email} was invited ${address.max} times today: try again tomorrow`,
    })
  if (forOrganization > organization.max)
    throw new HTTPException(429, { message: 'Too many invitations this hour: try again later' })
}
