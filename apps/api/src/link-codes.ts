import { randomBytes, randomUUID } from 'node:crypto'
import { defaults } from './config.js'
import { prisma } from './db.js'
import { hashToken } from './hub.js'

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * What a link code grants. A member's machine links as a new computer of that
 * member; a cloud computer links to its existing Computer row.
 */
export type LinkGrant =
  | { kind: 'member_machine'; organizationId: string; workspaceId: string; memberId: string }
  | { kind: 'cloud'; organizationId: string; workspaceId: string; computerId: string }

export const linkIdentifier = (code: string) => `runner-link:${hashToken(code.toUpperCase())}`

/** A one-time code, stored only as a hash, valid for a few minutes. */
export async function issueLinkCode(grant: LinkGrant) {
  const chars = [...randomBytes(8)].map((b) => ALPHABET[b % ALPHABET.length])
  const code = `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`
  const expiresAt = new Date(Date.now() + defaults.runnerLinkCodeMinutes * 60_000)
  await prisma.verification.create({
    data: {
      id: randomUUID(),
      identifier: linkIdentifier(code),
      value: JSON.stringify(grant),
      expiresAt,
    },
  })
  return { code, expiresAt }
}

/** Consume a link code. Returns null if unknown, expired or already used. */
export async function redeemLinkCode(code: string): Promise<LinkGrant | null> {
  const row = await prisma.verification.findFirst({
    where: { identifier: linkIdentifier(code), expiresAt: { gt: new Date() } },
  })
  if (!row) return null
  const { count } = await prisma.verification.deleteMany({ where: { id: row.id } })
  if (count === 0) return null
  const grant = JSON.parse(row.value) as LinkGrant & { kind?: string }
  // Codes issued before cloud computers existed carry no kind.
  return grant.kind ? grant : ({ ...(grant as object), kind: 'member_machine' } as LinkGrant)
}
