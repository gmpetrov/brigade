// Where a guest of Brigade.app came from (docs/analytics.md, "Downloads"). The site's download
// button tells the API where the visit came from (POST /api/downloads, its utm_* and referrer as
// for a sign-up); the API keeps it a few days under a keyed hash of the visitor's IP address. When
// Brigade.app then makes a guest with nothing to say where they came from, a download from the
// same address in those days gives it, marked `fromDownload` (a guess: one address can be several
// people). The address itself is never kept.
import { createHmac } from 'node:crypto'
import { env } from './config.js'
import { prisma } from './db.js'
import { parseSignupSource, type SignupSource } from './signup-source.js'

/** How long a download waits for its app's guest. */
export const DOWNLOAD_DAYS = 3

/** A keyed hash of an IP address, or nothing without one. */
export function visitorOf(ip: string | null | undefined) {
  const address = ip?.trim()
  if (!address) return undefined
  return createHmac('sha256', `download-source:${env.BETTER_AUTH_SECRET}`)
    .update(address)
    .digest('base64url')
}

/** The visitor's IP address, as Cloudflare gives it; none locally. */
export const ipOf = (headers: Headers | undefined) => headers?.get('cf-connecting-ip') ?? undefined

/** Whether a source says nothing of where someone came from. */
export const unknownSource = (source: SignupSource) =>
  source.channel === 'direct' && !source.source && !source.referrer && !source.adClick

/**
 * Keep where a download's visit came from, by its visitor: the latest download's. A visit that
 * says nothing (direct) clears what an earlier one from the address left, so a later guest is
 * not credited to someone else's campaign. Rows older than DOWNLOAD_DAYS go at the same time.
 */
export async function rememberDownload(ip: string | undefined, raw: unknown) {
  const visitor = visitorOf(ip)
  if (!visitor) return false
  const source = parseSignupSource(raw)
  if (unknownSource(source)) {
    await prisma.downloadSource.deleteMany({ where: { visitor } })
    return false
  }
  const { adClick: _, ...kept } = source
  await prisma.downloadSource.upsert({
    where: { visitor },
    create: { visitor, source: kept },
    update: { source: kept, createdAt: new Date() },
  })
  await prisma.downloadSource.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - DOWNLOAD_DAYS * 86_400_000) } },
  })
  return true
}

/**
 * The source of a download from this address in the last DOWNLOAD_DAYS, taken once: claimed
 * and deleted in one statement, so two guests at once never both take it, and a download kept
 * after the claim stays for the next.
 */
export async function takeDownloadSource(ip: string | undefined) {
  const visitor = visitorOf(ip)
  if (!visitor) return undefined
  const since = new Date(Date.now() - DOWNLOAD_DAYS * 86_400_000)
  const rows = await prisma.$queryRaw<{ source: SignupSource }[]>`
    DELETE FROM "DownloadSource"
    WHERE "visitor" = ${visitor} AND "createdAt" >= ${since}
    RETURNING "source"`
  return rows[0]?.source
}
